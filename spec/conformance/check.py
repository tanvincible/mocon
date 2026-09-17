#!/usr/bin/env python3
"""mocon conformance suite runner: validate | view | permute [N] | invalid | lint | all.
Stdlib only; uses jsonschema when importable (a notice is printed otherwise).
See conformance/README.md for the view format and what each command asserts."""
import glob, json, os, random, re, sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
STREAMS = os.path.join(HERE, "streams")
EXPECTED = os.path.join(HERE, "expected")
INVALID = os.path.join(HERE, "invalid")
SCHEMA_DIR = os.path.join(HERE, "..", "schema")

TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$")
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
DISPOSITIONS = {"completed", "failed", "terminated", "abandoned"}
OUTCOMES = {"output", "error", "abandoned"}
OBSERVES = {"all", "some", "none"}
EDGES = {"invocation", "dispatch"}
ATTESTED = {"crossing.target", "crossing.input", "crossing.output", "crossing.error", "execution.error.class"}

try:
    import jsonschema
    import jsonschema.validators
    from referencing import Registry, Resource
    HAVE_JSONSCHEMA = True
except ImportError:
    HAVE_JSONSCHEMA = False


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def payload_errors(p, where):
    if not isinstance(p, dict):
        return [f"{where}: Payload must be an object"]
    e = [] if ("value" in p or p.get("truncated") is True or p.get("redacted") is True) \
        else [f"{where}: Payload has no value and neither truncated nor redacted is true"]
    if "hash" in p and not HASH_RE.match(str(p["hash"])):
        e.append(f"{where}.hash: does not match sha256:<64 lowercase hex>")
    return e


def error_errors(x, where):
    if not isinstance(x, dict):
        return [f"{where}: Error must be an object"]
    errs = [] if "class" in x else [f"{where}: missing required field: class"]
    if "value" in x:
        errs += payload_errors(x["value"], where + ".value")
    return errs


def ts_errors(o, key, where):
    return [f"{where}.{key}: not RFC 3339 UTC with Z suffix"] if key in o and not TS_RE.match(str(o[key])) else []


def require(obj, keys, label):
    return [f"{label}: missing required field: {k}" for k in keys if k not in obj]


def structural_errors(o):
    """core.md 3, 5, 8; provenance.md 4. Required keys per kind, closed enums,
    end completeness, the Payload rule, timestamp Z suffix, hash pattern."""
    errs, kind = [], o.get("kind")
    if not isinstance(o.get("host"), str):
        errs.append("missing required field: host")
    if kind == "host":
        # spec_version has an "absent reads as" default (core.md 5.1) and is not required.
        if "observes_crossings" in o and o["observes_crossings"] not in OBSERVES:
            errs.append("observes_crossings not in closed set")
        if "crossing_edge" in o and o["crossing_edge"] not in EDGES:
            errs.append("crossing_edge not in closed set")
        # attested is an open list (core.md 8): unknown entries are ignored, not rejected.
        # See cmd_lint for the provenance.md 7 warning on an unknown entry.
    elif kind == "execution":
        errs += require(o, ("id", "start"), "execution")
        if "program" in o:
            errs += payload_errors(o["program"], "execution.program")
        errs += ts_errors(o, "start", "execution")
        if "end" in o:
            end = o["end"]
            errs += require(end, ("time", "disposition"), "execution.end")
            if "program" not in o:
                errs.append("execution: missing required field: program")
            errs += ts_errors(end, "time", "execution.end")
            if "disposition" in end and end["disposition"] not in DISPOSITIONS:
                errs.append("execution.end.disposition not in closed set")
            if "result" in end:
                errs += payload_errors(end["result"], "execution.end.result")
            if "error" in end:
                errs += error_errors(end["error"], "execution.end.error")
            for ch, p in (end.get("outputs") or {}).items():
                errs += payload_errors(p, f"execution.end.outputs.{ch}")
    elif kind == "crossing":
        errs += require(o, ("id", "execution_id", "target", "input"), "crossing")
        if "input" in o:
            errs += payload_errors(o["input"], "crossing.input")
        errs += ts_errors(o, "start", "crossing")
        if "end" in o:
            end = o["end"]
            errs += ts_errors(end, "time", "crossing.end")
            oc = end.get("outcome")
            if "outcome" not in end:
                errs.append("crossing.end: missing required field: outcome")
            elif oc not in OUTCOMES:
                errs.append("crossing.end.outcome not in closed set")
            if oc == "output" and "error" in end:
                errs.append("crossing.end.outcome output must not carry end.error")
            if oc == "error" and "output" in end:
                errs.append("crossing.end.outcome error must not carry end.output")
            if oc == "abandoned" and ("output" in end or "error" in end):
                errs.append("crossing.end.outcome abandoned must not carry output or error")
            if "output" in end:
                errs += payload_errors(end["output"], "crossing.end.output")
            if "error" in end:
                errs += error_errors(end["error"], "crossing.end.error")
    else:
        errs.append(f"unknown kind: {kind!r}")
    return errs


def load_schemas():
    """Returns (schemas by $id, a referencing.Registry over all of them) so that
    each schema's own $ref to a sibling file (host.json, payload.json, ...)
    resolves without the deprecated, scope-stateful RefResolver."""
    schemas = {}
    for fname in ("line.json", "host.json", "execution.json", "crossing.json", "payload.json", "error.json"):
        s = json.load(open(os.path.join(SCHEMA_DIR, fname)))
        schemas[s["$id"]] = s
    registry = Registry().with_resources((uri, Resource.from_contents(s)) for uri, s in schemas.items())
    return schemas, registry


def schema_errors(o, schemas, registry):
    fname = {"host": "host.json", "execution": "execution.json", "crossing": "crossing.json"}.get(o.get("kind"))
    if fname is None:
        return []
    schema_id = f"https://github.com/tanvincible/mocon/spec/1.0/schema/{fname}"
    validator = jsonschema.Draft202012Validator(schemas[schema_id], registry=registry)
    return [e.message for e in validator.iter_errors(o)]


def all_errors(o, schemas, registry):
    errs = structural_errors(o)
    if HAVE_JSONSCHEMA:
        errs += [f"schema: {m}" for m in schema_errors(o, schemas, registry)]
    return errs


def parse_lines(lines):
    """core.md 3: skip and count blank, malformed, and unknown-kind lines."""
    records, skipped = [], 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            skipped += 1
            continue
        if not isinstance(obj, dict) or obj.get("kind") not in ("host", "execution", "crossing"):
            skipped += 1
            continue
        records.append(obj)
    return records, skipped


def dedupe(lines):
    """Distinct-by-canonical-JSON, order-independent (a set has no first element)."""
    seen, out = set(), []
    for o in lines:
        c = canon(o)
        if c not in seen:
            seen.add(c)
            out.append((c, o))
    return out


def pick(entries):
    """Deterministic tie-break among distinct candidates: see README 'Conflicts and order'."""
    return sorted(entries, key=lambda t: t[0])[0][1]


def build_view(records):
    """core.md 4, the supersede rule, applied statefully to produce one canonical view."""
    host_lines, exec_lines, cross_lines = {}, {}, {}
    for o in records:
        k = o.get("kind")
        if k == "host":
            host_lines.setdefault(o.get("host"), []).append(o)
        elif k == "execution":
            exec_lines.setdefault((o.get("host"), o.get("id")), []).append(o)
        elif k == "crossing":
            cross_lines.setdefault((o.get("host"), o.get("id")), []).append(o)

    hosts, conflicts = {}, []
    for host, lines in host_lines.items():
        distinct = dedupe(lines)
        if len(distinct) > 1:
            conflicts.append({"kind": "host", "host": host, "id": None})
        hosts[host] = pick(distinct)

    def resolve(lines_map, kind):
        out, unresolved = {}, []
        for (host, id_), lines in lines_map.items():
            completes = dedupe([o for o in lines if "end" in o])
            notices = dedupe([o for o in lines if "end" not in o])
            if completes:
                if len(completes) > 1:
                    conflicts.append({"kind": kind, "host": host, "id": id_})
                out[id_] = pick(completes)
            elif notices:
                unresolved.append({"kind": kind, "host": host, "id": id_})
                out[id_] = pick(notices)
        return out, unresolved

    executions, eu = resolve(exec_lines, "execution")
    crossings, cu = resolve(cross_lines, "crossing")
    unresolved = sorted(eu + cu, key=lambda r: (r["kind"], r["host"], r["id"]))
    conflicts = sorted(conflicts, key=lambda r: (r["kind"], r["host"], r["id"] or ""))
    return {"hosts": hosts, "executions": executions, "crossings": crossings,
            "unresolved": unresolved, "conflicts": conflicts, "skipped": None}


def view_for(raw_lines):
    records, skipped = parse_lines(raw_lines)
    v = build_view(records)
    v["skipped"] = skipped
    return v


def stream_files():
    return sorted(glob.glob(os.path.join(STREAMS, "*.jsonl")))


def cmd_validate():
    ok = True
    schemas, registry = load_schemas() if HAVE_JSONSCHEMA else (None, None)
    if not HAVE_JSONSCHEMA:
        print("notice: jsonschema not importable; schema validation skipped, structural checks only")
    for path in stream_files():
        records, skipped = parse_lines(open(path).readlines())
        bad = []
        for o in records:
            e = all_errors(o, schemas, registry)
            if e:
                bad.append((o.get("kind"), o.get("id"), e))
        print(f"{os.path.basename(path)}: {len(records)} lines, {skipped} skipped -> {'FAIL' if bad else 'OK'}")
        for kind, id_, e in bad:
            print(f"    {kind} {id_}: {e}")
        ok = ok and not bad
    return ok


def cmd_view():
    ok = True
    for path in stream_files():
        name = os.path.basename(path)[:-6]
        exp_path = os.path.join(EXPECTED, name + ".json")
        actual = view_for(open(path).readlines())
        if not os.path.exists(exp_path):
            print(f"{name}: FAIL - no expected/{name}.json")
            ok = False
            continue
        expected = json.load(open(exp_path))
        if actual != expected:
            print(f"{name}: FAIL - view mismatch")
            print(f"    actual:   {canon(actual)}")
            print(f"    expected: {canon(expected)}")
            ok = False
        else:
            print(f"{name}: OK")
    return ok


def cmd_permute(n):
    ok = True
    for path in stream_files():
        raw = open(path).readlines()
        base = view_for(raw)
        for i in range(n):
            shuffled = raw[:]
            random.shuffle(shuffled)
            if view_for(shuffled) != base:
                print(f"FAIL permute {os.path.basename(path)} iteration {i}")
                ok = False
        doubled = view_for(raw + raw)
        same = ({k: v for k, v in doubled.items() if k != "skipped"} ==
                {k: v for k, v in base.items() if k != "skipped"})
        if not same or doubled["skipped"] != base["skipped"] * 2:
            print(f"FAIL concat-self {os.path.basename(path)}")
            ok = False
    print("permute: OK" if ok else "permute: FAILED")
    return ok


def cmd_invalid():
    ok = True
    schemas, registry = load_schemas() if HAVE_JSONSCHEMA else (None, None)
    for path in sorted(glob.glob(os.path.join(INVALID, "*.jsonl"))):
        name = os.path.basename(path)[:-6]
        line = open(path).read().strip()
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            print(f"{name}: FAIL - fixture itself is not valid JSON")
            ok = False
            continue
        errs = all_errors(obj, schemas, registry)
        if errs:
            print(f"{name}: correctly rejected")
        else:
            print(f"{name}: FAIL - fixture validated but should have been rejected")
            ok = False
    return ok


def warn(base_name, msg):
    print(f"WARN {base_name}: {msg}")
    return 1


def cmd_lint():
    """provenance.md 7 lint rules, plus core.md 7's end.time >= start and the
    crossing.end output/error-match-outcome rule, applied across streams/*."""
    problems = 0
    for path in stream_files():
        base_name = os.path.basename(path)
        records, _ = parse_lines(open(path).readlines())
        decls, crossings_by_host = {}, {}
        for o in records:
            if o.get("kind") == "host":
                decls.setdefault(o["host"], o)
            elif o.get("kind") == "crossing":
                crossings_by_host.setdefault(o.get("host"), []).append(o)
        for o in records:
            end = o.get("end") or {}
            if o.get("kind") in ("execution", "crossing") and "start" in o and "time" in end:
                a = datetime.fromisoformat(str(o["start"]).replace("Z", "+00:00"))
                b = datetime.fromisoformat(str(end["time"]).replace("Z", "+00:00"))
                if b < a:
                    problems += warn(base_name, f"{o['kind']} {o.get('id')} end.time < start")
        for host, decl in decls.items():
            if decl.get("crossing_edge") and "crossing.target" not in (decl.get("attested") or []):
                problems += warn(base_name, f"host {host} declares crossing_edge without attesting crossing.target")
            if decl.get("observes_crossings") == "none" and crossings_by_host.get(host):
                problems += warn(base_name, f"host {host} observes_crossings none but stream has crossings")
            for a in (decl.get("attested") or []):
                if a not in ATTESTED:
                    problems += warn(base_name, f"host {host} attested entry outside the known list: {a!r}")
    print("lint: OK (no warnings)" if problems == 0 else f"lint: {problems} warning(s)")
    return problems == 0


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "all"
    if cmd == "validate":
        ok = cmd_validate()
    elif cmd == "view":
        ok = cmd_view()
    elif cmd == "permute":
        ok = cmd_permute(int(args[1]) if len(args) > 1 else 5)
    elif cmd == "invalid":
        ok = cmd_invalid()
    elif cmd == "lint":
        ok = cmd_lint()
    elif cmd == "all":
        ok = cmd_validate()
        ok = cmd_view() and ok
        ok = cmd_permute(5) and ok
        ok = cmd_invalid() and ok
        ok = cmd_lint() and ok
    else:
        print(__doc__)
        sys.exit(2)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
