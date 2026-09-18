#!/usr/bin/env python3
"""mocon conformance suite runner: validate | view | order | permute [N] | invalid | lint | all.

Runs on the standard library alone, but `jsonschema` is a real requirement
(`requirements.txt`): without it the schema pass is skipped and only the built-in
structural checks run. Those checks are written to be independently sufficient for
the rules listed in README section 4, so `invalid/` is rejected either way; the
notice printed at the top of a degraded run says which path you got.

See conformance/README.md for the view format and what each command asserts."""
import glob, json, os, random, re, sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
STREAMS = os.path.join(HERE, "streams")
EXPECTED = os.path.join(HERE, "expected")
INVALID = os.path.join(HERE, "invalid")
SCHEMA_DIR = os.path.join(HERE, "..", "schema")

# \Z, not $: Python's $ also matches just before a trailing newline, so a hash or
# timestamp with "\n" glued on passes a $-anchored pattern here while every
# ECMA-262 validator (ajv, the TypeScript helpers) rejects it. See README section 4.
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z\Z")
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}\Z")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\Z")
DISPOSITIONS = {"completed", "failed", "terminated", "abandoned"}
OUTCOMES = {"output", "error", "abandoned"}
OBSERVES = {"all", "some", "none"}
EDGES = {"invocation", "dispatch"}
ATTESTED = {"crossing.target", "crossing.input", "crossing.output", "crossing.error", "execution.error.class",
            "ext.declared"}
# core.md 5.1.1 and extensions/links.md. Closed to hosts, growing by minor version, so an
# unknown value is a lint warning and never a validation failure -- the same treatment
# ATTESTED gets, and the reason none of these has an invalid/ fixture.
AGGS = {"sum", "last", "none"}
CARDS = {"low", "high"}
LINK_RELS = {"retry_of", "replay_of", "forked_from", "continues"}
LINK_COUNTS = {"additive", "duplicate"}
LINK_KINDS = {"execution", "crossing"}
# core.md 3: reserved to the specification. No host authors these, so the declaration
# lint never asks for them.
RESERVED_EXT = "mocon."
# core.md 3: the only characters that make a line blank. Not the language's own
# trim/strip set, which differs between Python and JavaScript (U+001C, U+0085,
# U+2028 and friends), and which would make `skipped` implementation-defined.
BLANK = " \t\r\n"

try:
    import jsonschema
    import jsonschema.validators
    from referencing import Registry, Resource
    HAVE_JSONSCHEMA = True
except ImportError:
    HAVE_JSONSCHEMA = False

NOTICE = ("notice: jsonschema not importable; schema validation skipped, structural checks only.\n"
          "        This is the degraded run. Install it with `pip install -r requirements.txt`.")


class SuiteScopeError(Exception):
    """Two (host, id) keys project onto one bare id. This suite's view is keyed by
    bare id and is defined only for a single-host stream (README, 'Id scope'); a
    consumer merging hosts keys on (host, id), as packages/core's fold does."""


def canon(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def is_str(v):
    return isinstance(v, str)


def is_bool(v):
    return isinstance(v, bool)


def is_uint(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def is_obj(v):
    return isinstance(v, dict)


def field(o, key, ok, what, where):
    """One error for an optional field present with the wrong type. Absent is fine."""
    return [] if key not in o or ok(o[key]) else [f"{where}.{key}: must be {what}"]


def closed_error(o, key, allowed, label):
    """core.md 8's closed sets. The isinstance guard comes first so that a dict or
    list in the field is an error, not a TypeError out of the membership test."""
    if key not in o:
        return []
    v = o[key]
    return [] if isinstance(v, str) and v in allowed else [f"{label} not in closed set"]


def payload_errors(p, where):
    if not isinstance(p, dict):
        return [f"{where}: Payload must be an object"]
    e = [] if ("value" in p or p.get("truncated") is True or p.get("redacted") is True) \
        else [f"{where}: Payload has no value and neither truncated nor redacted is true"]
    e += field(p, "truncated", is_bool, "a boolean", where)
    e += field(p, "redacted", is_bool, "a boolean", where)
    e += field(p, "bytes", is_uint, "a non-negative integer", where)
    e += field(p, "hash", is_str, "a string", where)
    if is_str(p.get("hash")) and not HASH_RE.match(p["hash"]):
        e.append(f"{where}.hash: does not match sha256:<64 lowercase hex>")
    return e


def error_errors(x, where):
    if not isinstance(x, dict):
        return [f"{where}: Error must be an object"]
    errs = [] if "class" in x else [f"{where}: missing required field: class"]
    errs += field(x, "class", is_str, "a string", where)
    errs += field(x, "message", is_str, "a string", where)
    if "value" in x:
        errs += payload_errors(x["value"], where + ".value")
    return errs


def ts_errors(o, key, where):
    if key not in o:
        return []
    v = o[key]
    return [] if is_str(v) and TS_RE.match(v) else [f"{where}.{key}: not RFC 3339 UTC with Z suffix"]


def context_errors(o, where):
    if "context" not in o:
        return []
    c = o["context"]
    if not isinstance(c, dict):
        return [f"{where}.context: must be an object"]
    return (field(c, "session", is_str, "a string", where + ".context")
            + field(c, "traceparent", is_str, "a string", where + ".context"))


def require(obj, keys, label):
    return [f"{label}: missing required field: {k}" for k in keys if k not in obj]


def dimensions_errors(o):
    """core.md 5.1.1. Structure only: membership in `agg`/`card` grows by minor
    version, so an unknown value there is cmd_lint's business, not a rejection."""
    if "dimensions" not in o:
        return []
    d = o["dimensions"]
    if not is_obj(d):
        return ["host.dimensions: must be an object"]
    errs = []
    for key, entry in d.items():
        where = f"host.dimensions.{key}"
        if not is_obj(entry):
            errs.append(f"{where}: must be an object")
            continue
        if "agg" not in entry:
            errs.append(f"{where}: missing required field: agg")
        errs += field(entry, "agg", is_str, "a string", where)
        errs += field(entry, "unit", is_str, "a string", where)
        errs += field(entry, "card", is_str, "a string", where)
        errs += field(entry, "name", is_str, "a string", where)
        errs += field(entry, "observed", is_bool, "a boolean", where)
    return errs


def links_errors(o, label):
    """extensions/links.md 2. Structure only, for the same reason: `rel` and `counts`
    grow by minor version. `kind` does not -- it names a core record kind."""
    if "links" not in o:
        return []
    v = o["links"]
    if not isinstance(v, list):
        return [f"{label}.links: must be an array"]
    errs = []
    for i, entry in enumerate(v):
        where = f"{label}.links[{i}]"
        if not is_obj(entry):
            errs.append(f"{where}: must be an object")
            continue
        errs += require(entry, ("rel", "kind", "id", "counts"), where)
        errs += field(entry, "rel", is_str, "a string", where)
        errs += field(entry, "id", is_str, "a string", where)
        errs += field(entry, "counts", is_str, "a string", where)
        errs += field(entry, "host", is_str, "a string", where)
        errs += field(entry, "execution_id", is_str, "a string", where)
        errs += closed_error(entry, "kind", LINK_KINDS, f"{where}.kind")
    return errs


def structural_errors(o):
    """core.md 3, 5, 7, 8; provenance.md 4. Required keys per kind, the type of every
    core field, closed enums, end completeness, the Payload rule, the timestamp Z
    suffix, the hash and spec_version patterns. Total: it returns errors for any
    parsed JSON object rather than raising on one."""
    errs, kind = [], o.get("kind")
    label = kind if is_str(kind) else "line"
    if not is_str(o.get("host")):
        errs.append("missing required field: host")
    errs += field(o, "ext", is_obj, "an object", label)
    if kind == "host":
        # spec_version has an "absent reads as" default (core.md 5.1) and is not required.
        errs += closed_error(o, "observes_crossings", OBSERVES, "observes_crossings")
        errs += closed_error(o, "crossing_edge", EDGES, "crossing_edge")
        errs += field(o, "unmediated_egress", is_bool, "a boolean", "host")
        errs += field(o, "spec_version", is_str, "a string", "host")
        if is_str(o.get("spec_version")) and not VERSION_RE.match(o["spec_version"]):
            errs.append("host.spec_version: must be MAJOR.MINOR")
        if "attested" in o and not (isinstance(o["attested"], list) and all(is_str(x) for x in o["attested"])):
            errs.append("host.attested: must be an array of strings")
        errs += dimensions_errors(o)
        # attested membership is open (core.md 8): unknown entries are ignored, not
        # rejected. See cmd_lint for the provenance.md 7 warning on an unknown entry.
    elif kind == "execution":
        errs += require(o, ("id", "start"), "execution")
        errs += field(o, "id", is_str, "a string", "execution")
        errs += field(o, "language", is_str, "a string", "execution")
        errs += context_errors(o, "execution")
        errs += links_errors(o, "execution")
        if "program" in o:
            errs += payload_errors(o["program"], "execution.program")
        errs += ts_errors(o, "start", "execution")
        if "end" in o:
            end = o["end"]
            if not is_obj(end):
                errs.append("execution.end: must be an object")
            else:
                errs += require(end, ("time", "disposition"), "execution.end")
                if "program" not in o:
                    errs.append("execution: missing required field: program")
                errs += ts_errors(end, "time", "execution.end")
                errs += closed_error(end, "disposition", DISPOSITIONS, "execution.end.disposition")
                if "result" in end:
                    errs += payload_errors(end["result"], "execution.end.result")
                if "error" in end:
                    errs += error_errors(end["error"], "execution.end.error")
                if "outputs" in end and not is_obj(end["outputs"]):
                    errs.append("execution.end.outputs: must be an object")
                for ch, p in (end["outputs"] if is_obj(end.get("outputs")) else {}).items():
                    errs += payload_errors(p, f"execution.end.outputs.{ch}")
    elif kind == "crossing":
        errs += require(o, ("id", "execution_id", "target", "input"), "crossing")
        errs += field(o, "id", is_str, "a string", "crossing")
        errs += field(o, "execution_id", is_str, "a string", "crossing")
        errs += field(o, "target", is_str, "a string", "crossing")
        errs += field(o, "seq", is_uint, "a non-negative integer", "crossing")
        errs += context_errors(o, "crossing")
        errs += links_errors(o, "crossing")
        if "input" in o:
            errs += payload_errors(o["input"], "crossing.input")
        errs += ts_errors(o, "start", "crossing")
        if "end" in o:
            end = o["end"]
            if not is_obj(end):
                errs.append("crossing.end: must be an object")
            else:
                errs += ts_errors(end, "time", "crossing.end")
                oc = end.get("outcome")
                if "outcome" not in end:
                    errs.append("crossing.end: missing required field: outcome")
                errs += closed_error(end, "outcome", OUTCOMES, "crossing.end.outcome")
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
    for fname in ("line.json", "host.json", "execution.json", "crossing.json", "payload.json", "error.json",
                  "links.json"):
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


def _not_json(name):
    raise ValueError(f"{name} is not JSON")


# NaN, Infinity and -Infinity are Python extensions to JSON, not JSON (core.md 3).
DECODER = json.JSONDecoder(parse_constant=_not_json)


def parse_lines(lines):
    """core.md 3: skip and count blank, malformed, and unknown-kind lines, and lines
    with no string `host` or (except on a host record) no string `id` — a record a
    consumer cannot key is one it cannot hold."""
    records, skipped = [], 0
    for i, line in enumerate(lines):
        if i == 0:
            line = line.lstrip("﻿")  # a byte-order mark opening the stream (core.md 3)
        line = line.strip(BLANK)
        if not line:
            continue
        try:
            obj = DECODER.decode(line)
        except ValueError:
            skipped += 1
            continue
        if not isinstance(obj, dict) or obj.get("kind") not in ("host", "execution", "crossing"):
            skipped += 1
            continue
        if not is_str(obj.get("host")) or (obj["kind"] != "host" and not is_str(obj.get("id"))):
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
    """core.md 4.3's tie-break: the record whose canonical JSON sorts first."""
    return sorted(entries, key=lambda t: t[0])[0][1]


def end_unreadable(o):
    """core.md 8: an unknown value in a closed field makes the containing object
    absent. For an execution or a crossing that object is `end`, so the record
    counts as a start notice. A missing closed field is unreadable for the same
    reason: there is no value to read."""
    if "end" not in o:
        return False
    end = o["end"]
    if not is_obj(end):
        return True
    key, allowed = ("disposition", DISPOSITIONS) if o.get("kind") == "execution" else ("outcome", OUTCOMES)
    return not (is_str(end.get(key)) and end[key] in allowed)


def readable(o):
    """The record as core.md 8 makes a consumer read it: any object carrying an
    unknown closed-set value removed. Returns (record, flagged)."""
    if o.get("kind") == "host":
        drop = [k for k, allowed in (("observes_crossings", OBSERVES), ("crossing_edge", EDGES))
                if k in o and not (is_str(o[k]) and o[k] in allowed)]
        return ({k: v for k, v in o.items() if k not in drop}, True) if drop else (o, False)
    if end_unreadable(o):
        return {k: v for k, v in o.items() if k != "end"}, True
    return o, False


def build_view(records):
    """core.md 4, the supersede rule, applied statefully to produce one canonical
    view, over records read as core.md 8 requires."""
    host_lines, exec_lines, cross_lines = {}, {}, {}
    for raw in records:
        o, _ = readable(raw)
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
        out, unresolved, owner = {}, [], {}
        for (host, id_), lines in lines_map.items():
            if owner.setdefault(id_, host) != host:
                raise SuiteScopeError(
                    f"{kind} id {id_!r} is used by both host {owner[id_]!r} and host {host!r}")
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
        print(NOTICE)
    for path in stream_files():
        records, skipped = parse_lines(open(path).readlines())
        bad = []
        for o in records:
            try:
                e = all_errors(o, schemas, registry)
            except Exception as exc:  # a validator fault is this line's verdict, not the run's end
                e = [f"checker fault: {type(exc).__name__}: {exc}"]
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
        try:
            actual = view_for(open(path).readlines())
        except SuiteScopeError as exc:
            print(f"{name}: FAIL - {exc}")
            ok = False
            continue
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
        try:
            base = view_for(raw)
            for i in range(n):
                shuffled = raw[:]
                random.shuffle(shuffled)
                if view_for(shuffled) != base:
                    print(f"FAIL permute {os.path.basename(path)} iteration {i}")
                    ok = False
            doubled = view_for(raw + raw)
        except SuiteScopeError as exc:
            print(f"FAIL permute {os.path.basename(path)}: {exc}")
            ok = False
            continue
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
    if not HAVE_JSONSCHEMA:
        print(NOTICE)
    for path in sorted(glob.glob(os.path.join(INVALID, "*.jsonl"))):
        name = os.path.basename(path)[:-6]
        line = open(path).read().strip()
        try:
            obj = DECODER.decode(line)
        except ValueError:
            print(f"{name}: correctly rejected (not JSON)")
            continue
        if not isinstance(obj, dict):
            print(f"{name}: correctly rejected (not a JSON object)")
            continue
        errs = all_errors(obj, schemas, registry)
        if not errs:
            print(f"{name}: FAIL - fixture validated but should have been rejected")
            ok = False
            continue
        # core.md 8: a consumer that receives one of these anyway must read the
        # offending object as absent, so a bad `end` leaves the record unresolved
        # rather than shown with a disposition it must never display (core.md 4.5).
        if obj.get("kind") in ("execution", "crossing") and end_unreadable(obj):
            v = build_view([obj])
            if not v["unresolved"]:
                print(f"{name}: FAIL - rejected, but the view still reads it as a complete record")
                ok = False
                continue
        print(f"{name}: correctly rejected")
    return ok


def warn(base_name, msg):
    print(f"WARN {base_name}: {msg}")
    return 1


def cmd_order():
    """core.md 10's two file-order obligations. They are the only emitter rules no
    canonical view can express, because core.md 4.4 requires the same view for any
    permutation of a stream; this command therefore reads each stream in file order
    and is the check README section 5 point (3) cites."""
    problems = 0
    for path in stream_files():
        base_name = os.path.basename(path)
        records, _ = parse_lines(open(path).readlines())
        first = {}
        for o in records:
            first.setdefault(o["host"], o["kind"])
        for host, kind in first.items():
            if kind != "host":
                problems += warn(base_name, f"host {host}: first line for this host string is a "
                                            f"{kind} record, not its declaration (core.md 10)")
        closed_at = {(o["host"], o["id"]): i for i, o in enumerate(records)
                     if o["kind"] == "execution" and is_obj(o.get("end"))}
        for i, o in enumerate(records):
            if o["kind"] != "crossing" or not is_obj(o.get("end")):
                continue
            if o["end"].get("outcome") != "abandoned":
                continue
            j = closed_at.get((o["host"], o.get("execution_id")))
            if j is not None and i > j:
                problems += warn(base_name, f"crossing {o['id']}: abandoned record follows its "
                                            f"execution's complete record (core.md 10)")
    print("order: OK" if problems == 0 else f"order: {problems} problem(s)")
    return problems == 0


def is_finite_number(v):
    """core.md 5.1.1: `sum` and `last` apply only to a finite JSON number. A bool is
    not one (Python says otherwise), and 1e400 parses to an infinity, which is not one
    either even though the line that carried it was legal JSON (core.md 3)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def declaration_warnings(records, decls, warn_):
    """core.md 5.1.1 and provenance.md 7's declaration rules. One pass over the
    records already parsed, plus the declarations already folded.

    `ext-key-undeclared` is scoped to namespaces the host already declares a key in.
    That is what makes it runnable by the two hosts core.md licenses that cannot
    satisfy an unscoped rule: a relay forwarding another vendor's keys verbatim
    (core.md 2, 3), which cannot declare keys it did not author, and a host that has
    not adopted declarations at all, which is not nagged for a feature it is not
    using. A host that has started declaring still gets told about the key it forgot,
    which is the drift the rule exists to catch."""
    problems = 0
    for host, decl in sorted(decls.items()):
        dims = decl.get("dimensions")
        dims = dims if is_obj(dims) else {}
        attested = decl.get("attested") or []
        observed_keys = {k for k, e in dims.items() if is_obj(e) and e.get("observed") is True}
        if observed_keys and "ext.declared" not in attested:
            problems += warn_(f"host {host} declares {len(observed_keys)} observed dimension(s) "
                              f"without attesting ext.declared; consumers read those keys as P")
        if "ext.declared" in attested and not observed_keys:
            problems += warn_(f"host {host} attests ext.declared but no dimension carries observed: true")
        for key, e in sorted(dims.items()):
            if not is_obj(e):
                continue
            if is_str(e.get("agg")) and e["agg"] not in AGGS:
                problems += warn_(f"host {host} dimension {key!r} agg outside the known list: {e['agg']!r}")
            if is_str(e.get("card")) and e["card"] not in CARDS:
                problems += warn_(f"host {host} dimension {key!r} card outside the known list: {e['card']!r}")

    # Namespaces the host claims: the prefix before the first "." of each declared key.
    claimed = {h: {k.split(".", 1)[0] for k in (d.get("dimensions") or {}) if is_str(k) and "." in k}
               for h, d in decls.items() if is_obj(d.get("dimensions"))}
    undeclared, mismatched = {}, {}
    for o in records:
        host, kind = o.get("host"), o.get("kind")
        dims = (decls.get(host) or {}).get("dimensions")
        dims = dims if is_obj(dims) else {}
        for key, value in (o["ext"] if is_obj(o.get("ext")) else {}).items():
            entry = dims.get(key) if is_str(key) else None
            if not is_obj(entry) or not is_str(entry.get("agg")) or entry["agg"] not in AGGS:
                if key.startswith(RESERVED_EXT) or not is_str(key) or "." not in key:
                    continue
                if key.split(".", 1)[0] in claimed.get(host, set()):
                    undeclared[(host, key)] = undeclared.get((host, key), 0) + 1
                continue
            # A null is "no value", not a wrong value (core.md 5.1.1): absent from every
            # total, and not a mismatch, so a legitimately nullable key does not warn.
            if entry["agg"] in ("sum", "last") and value is not None and not is_finite_number(value):
                mismatched[(host, key)] = mismatched.get((host, key), 0) + 1
    for (host, key), n in sorted(undeclared.items()):
        problems += warn_(f"host {host} emits undeclared ext key {key!r} in a namespace it declares ({n}x)")
    for (host, key), n in sorted(mismatched.items()):
        problems += warn_(f"host {host} dimension {key!r} is aggregatable but carried a non-number ({n}x)")

    for o in records:
        if not isinstance(o.get("links"), list):
            continue
        for e in o["links"]:
            if not is_obj(e):
                continue
            if is_str(e.get("rel")) and e["rel"] not in LINK_RELS:
                problems += warn_(f"{o['kind']} {o.get('id')} link rel outside the known list: {e['rel']!r}")
            if is_str(e.get("counts")) and e["counts"] not in LINK_COUNTS:
                problems += warn_(f"{o['kind']} {o.get('id')} link counts outside the known list: {e['counts']!r}")
            same_host = e.get("host", o.get("host")) == o.get("host")
            if same_host and e.get("kind") == o.get("kind") and e.get("id") == o.get("id"):
                problems += warn_(f"{o['kind']} {o.get('id')} link names the record carrying it")
    return problems


def cmd_lint():
    """provenance.md 7's lint rules, plus core.md 7's end.time >= start. These are
    warnings about streams core.md calls legal, so `all` prints them without
    failing on them (provenance.md 7 says as much for the third rule)."""
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
        problems += declaration_warnings(records, decls, lambda m: warn(base_name, m))
        for o in records:
            end = o.get("end") if is_obj(o.get("end")) else {}
            if o.get("kind") in ("execution", "crossing") and is_str(o.get("start")) and is_str(end.get("time")):
                a = datetime.fromisoformat(o["start"].replace("Z", "+00:00"))
                b = datetime.fromisoformat(end["time"].replace("Z", "+00:00"))
                if b < a:
                    problems += warn(base_name, f"{o['kind']} {o.get('id')} end.time < start")
        for host, decl in decls.items():
            # Only "dispatch" is contradictory unattested: it names what the host itself
            # sent. An "invocation" record is the program's view by definition (core.md
            # 5.1), which provenance.md 4 lets a host report without attesting.
            if decl.get("crossing_edge") == "dispatch" and "crossing.target" not in (decl.get("attested") or []):
                problems += warn(base_name, f"host {host} declares crossing_edge \"dispatch\" without attesting crossing.target")
            if decl.get("observes_crossings") == "none" and crossings_by_host.get(host):
                problems += warn(base_name, f"host {host} observes_crossings none but stream has crossings")
            for a in (decl.get("attested") or []):
                if a not in ATTESTED:
                    problems += warn(base_name, f"host {host} attested entry outside the known list: {a!r}")
    print("lint: OK (no warnings)" if problems == 0 else
          f"lint: {problems} warning(s) (warnings only; provenance.md 7 forbids failing a stream on one)")
    return True  # provenance.md 7: "a runner MUST NOT fail a stream on one"


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "all"
    if cmd == "validate":
        ok = cmd_validate()
    elif cmd == "view":
        ok = cmd_view()
    elif cmd == "order":
        ok = cmd_order()
    elif cmd == "permute":
        ok = cmd_permute(int(args[1]) if len(args) > 1 else 5)
    elif cmd == "invalid":
        ok = cmd_invalid()
    elif cmd == "lint":
        ok = cmd_lint()
    elif cmd == "all":
        ok = cmd_validate()
        ok = cmd_view() and ok
        ok = cmd_order() and ok
        ok = cmd_permute(5) and ok
        ok = cmd_invalid() and ok
        cmd_lint()  # warnings only: a lint warning does not make a legal stream a failure
    else:
        print(__doc__)
        sys.exit(2)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
