"""Are the two emitters the same emitter?

Runs packages/typescript (TypeScript) and packages/python (Python) over parity/scenario.json, then diffs
the canonical span dumps attribute by attribute. Nothing is normalised except what MUST differ: span
and trace ids, and a minted execution id. Timestamps are fixed by the scenario, so start, end and
duration are compared rather than waved through.

    node --import tsx packages/python/parity/emit.mjs        # the TypeScript side alone
    .venv/bin/python packages/python/parity/emit.py          # the Python side alone
    .venv/bin/python packages/python/parity/parity.py        # both, and the diff

Exit status is 0 when the two emit the same telemetry and 1 when they do not.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PYTHON = ROOT / ".venv" / "bin" / "python"

MINTED = "<minted>"


def emit(argv: list[str]) -> dict[str, Any]:
    done = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
    if done.returncode != 0:
        sys.stderr.write(done.stderr)
        raise SystemExit(f"emitter failed: {' '.join(argv)}")
    return json.loads(done.stdout)


def normalise(dump: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    """The only normalisation: an execution id the host did not supply is minted at random."""
    supplied = {c["name"]: "execution_id" in c["execution"] for c in scenario["cases"]}
    for case in dump["cases"]:
        if supplied.get(case["name"], True):
            continue
        for span in case["spans"]:
            if "code_mode.execution.id" in span["attributes"]:
                span["attributes"]["code_mode.execution.id"] = ["str", MINTED]
    return dump


def diff_case(ts: dict[str, Any], py: dict[str, Any], out: list[str]) -> None:
    name = ts["name"]
    if len(ts["spans"]) != len(py["spans"]):
        out.append(f"[{name}] span COUNT differs: typescript {len(ts['spans'])}, python {len(py['spans'])}")
    for i, (a, b) in enumerate(zip(ts["spans"], py["spans"])):
        where = f"[{name}] span {i} ({a['name'] if a['name'] == b['name'] else a['name'] + ' / ' + b['name']})"
        for field in ("name", "kind", "parent", "start_offset_ns", "end_offset_ns", "events"):
            if a[field] != b[field]:
                out.append(f"{where} {field}: typescript {a[field]!r}, python {b[field]!r}")
        if a["status"] != b["status"]:
            out.append(f"{where} status: typescript {a['status']!r}, python {b['status']!r}")
        keys = sorted(set(a["attributes"]) | set(b["attributes"]))
        for key in keys:
            x, y = a["attributes"].get(key), b["attributes"].get(key)
            if x == y:
                continue
            if y is None:
                out.append(f"{where} attribute MISSING IN PYTHON: {key} = {show(x)} in typescript")
            elif x is None:
                out.append(f"{where} attribute MISSING IN TYPESCRIPT: {key} = {show(y)} in python")
            else:
                out.append(f"{where} attribute {key}:\n    typescript {show(x)}\n    python     {show(y)}")
    if ts["metrics"] != py["metrics"]:
        out.append(f"[{name}] metric points differ:\n    typescript {json.dumps(ts['metrics'])}\n    python     {json.dumps(py['metrics'])}")


def show(v: Any) -> str:
    kind, value = v[0], v[1]
    text = json.dumps(value, ensure_ascii=False) if isinstance(value, str) else json.dumps(value)
    if len(text) > 300:
        text = text[:300] + f"... ({len(text)} chars)"
    return f"{kind}:{text}"


def attribute(case: dict[str, Any], span: int, key: str) -> Any:
    got = case["spans"][span]["attributes"].get(key)
    return None if got is None else got[1]


def probes(ts: dict[str, Any], py: dict[str, Any]) -> tuple[list[str], list[str]]:
    """The two places most likely to diverge silently."""
    hashes, cuts = [], []
    for a, b in zip(ts["cases"], py["cases"]):
        name = a["name"]
        ha, hb = attribute(a, -1, "code_mode.program.hash"), attribute(b, -1, "code_mode.program.hash")
        mark = "AGREE" if ha == hb else "DIFFER"
        hashes.append(f"  {name:<20} {mark}\n    typescript {ha}\n    python     {hb}")

        for i, (sa, sb) in enumerate(zip(a["spans"], b["spans"])):
            na = json.loads(sa["attributes"]["code_mode.capture"][1]) if "code_mode.capture" in sa["attributes"] else {}
            nb = json.loads(sb["attributes"]["code_mode.capture"][1]) if "code_mode.capture" in sb["attributes"] else {}
            for key in sorted(set(na) | set(nb)):
                ea, eb = na.get(key, {}), nb.get(key, {})
                if not (ea.get("truncated") or eb.get("truncated") or ea.get("redacted") or eb.get("redacted")):
                    continue
                verdict = "AGREE" if ea == eb and attribute(a, i, key) == attribute(b, i, key) else "DIFFER"
                cuts.append(
                    f"  {name}/span {i}/{key}: {verdict}\n"
                    f"    note  ts {json.dumps(ea, sort_keys=True)}\n"
                    f"          py {json.dumps(eb, sort_keys=True)}\n"
                    f"    value ts {show(sa['attributes'][key]) if key in sa['attributes'] else '(absent)'}\n"
                    f"          py {show(sb['attributes'][key]) if key in sb['attributes'] else '(absent)'}"
                )
    return hashes, cuts


def main() -> int:
    scenario = json.loads((HERE / "scenario.json").read_text(encoding="utf-8"))
    ts = normalise(emit(["node", "--import", "tsx", str(HERE / "emit.mjs")]), scenario)
    py = normalise(emit([str(PYTHON), str(HERE / "emit.py")]), scenario)

    (HERE / "out-typescript.json").write_text(json.dumps(ts, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (HERE / "out-python.json").write_text(json.dumps(py, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    out: list[str] = []
    names = [c["name"] for c in ts["cases"]]
    if names != [c["name"] for c in py["cases"]]:
        out.append(f"case list differs: {names} vs {[c['name'] for c in py['cases']]}")
    else:
        for a, b in zip(ts["cases"], py["cases"]):
            diff_case(a, b, out)

    print("=" * 78)
    print("DIFFERENCES")
    print("=" * 78)
    print("\n".join(out) if out else "  none: the two emitters produced identical telemetry.")

    hashes, cuts = probes(ts, py)
    print("\n" + "=" * 78)
    print("PROBE 1  code_mode.program.hash, same program text")
    print("=" * 78)
    print("\n".join(hashes))
    print("\n" + "=" * 78)
    print("PROBE 2  truncation: same value, same cap, same cut and same whole")
    print("=" * 78)
    print("\n".join(cuts) if cuts else "  nothing was truncated or redacted in this scenario.")

    print(f"\n{len(out)} difference(s). Dumps written to parity/out-typescript.json and parity/out-python.json.")
    return 1 if out else 0


if __name__ == "__main__":
    raise SystemExit(main())
