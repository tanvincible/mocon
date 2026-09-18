import assert from "node:assert/strict";
import { test } from "node:test";
import { exitCode, renderReport, structuralErrors, validateStream } from "../src/validate.js";
import { expectedView, invalid, jsonl, schemaAccepts, streams, UNSAFE } from "./helpers.js";

const T = "2026-09-16T10:00:00Z";
const T1 = "2026-09-16T10:00:01Z";
const ch = (code: number): string => String.fromCharCode(code);

const crossing = (over: Record<string, unknown>, end?: Record<string, unknown>) => ({
  kind: "crossing",
  host: "h",
  id: "c1",
  execution_id: "e1",
  target: "t",
  input: { value: 1 },
  ...(end === undefined ? {} : { end }),
  ...over,
});
const execution = (over: Record<string, unknown>, end?: Record<string, unknown>) => ({
  kind: "execution",
  host: "h",
  id: "e1",
  program: { value: "x" },
  start: T,
  ...(end === undefined ? {} : { end }),
  ...over,
});

test("every golden stream validates with no failures and no lint warnings", () => {
  assert.ok(streams.length >= 23, `${streams.length} golden streams listed`);
  for (const s of streams) {
    const report = validateStream(s.text);
    assert.deepEqual(report.failures, [], s.name);
    assert.deepEqual(report.warnings, [], s.name);
    assert.equal(report.skipped, expectedView(s.name).skipped, s.name);
    assert.equal(report.lines, s.text.split("\n").filter((l) => l.trim() !== "").length, s.name);
    assert.equal(exitCode(report), 0);
  }
});

test("every invalid line is rejected, as a line and as a stream, or is not JSON and so never becomes a record", () => {
  assert.ok(invalid.length >= 9, `${invalid.length} invalid lines listed`);
  for (const f of invalid) {
    const parsed = parseLine(f.text);
    if (parsed === undefined) {
      // check.py answers "correctly rejected (not JSON)" for these. `validate` counts the line as skipped
      // rather than failing it, which core.md 3 requires of every consumer, so the two agree that it is
      // never read as a record. A stream of such lines therefore exits 0, with the count as the evidence.
      const report = validateStream(f.text);
      assert.deepEqual(report.failures, [], f.name);
      assert.equal(report.skipped, 1, `${f.name} is not JSON, so it must be counted as skipped`);
      assert.equal(exitCode(report), 0, f.name);
      continue;
    }
    const errors = structuralErrors(parsed);
    assert.ok(errors.length > 0, `${f.name} should fail`);
    const report = validateStream(f.text);
    assert.equal(report.failures.length, 1, f.name);
    assert.equal(report.failures[0]?.line, 1);
    assert.deepEqual(report.failures[0]?.errors, errors);
    assert.equal(exitCode(report), 1);
    assert.match(renderReport(f.name, report), /-> FAIL$/m);
  }
});

/** One invalid fixture's line, or `undefined` when it is not JSON at all, as `nan-and-infinity` is. */
function parseLine(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

test("the rejection names the rule, the way check.py does", () => {
  const byName = new Map(invalid.filter((f) => parseLine(f.text) !== undefined).map((f) => [f.name, structuralErrors(parseLine(f.text))]));
  assert.deepEqual(byName.get("crossing-without-execution-id"), ["crossing: missing required field: execution_id"]);
  assert.deepEqual(byName.get("disposition-outside-closed-set"), ["execution.end.disposition not in closed set"]);
  assert.deepEqual(byName.get("end-without-disposition"), ["execution.end: missing required field: disposition"]);
  assert.deepEqual(byName.get("hash-wrong-length"), ["crossing.input.hash: does not match sha256:<64 lowercase hex>"]);
  assert.deepEqual(byName.get("missing-host"), ["missing required field: host"]);
  assert.deepEqual(byName.get("observes-crossings-unknown-value"), ["observes_crossings not in closed set"]);
  assert.deepEqual(byName.get("outcome-output-with-error-field"), ["crossing.end.outcome output must not carry end.error"]);
  assert.deepEqual(byName.get("payload-no-value-no-flag"), ["crossing.input: Payload has no value and neither truncated nor redacted is true"]);
  assert.deepEqual(byName.get("timestamp-without-z"), ["execution.start: not RFC 3339 UTC with Z suffix"]);
});

/** Lines spec/schema rejects for a type or a minimum that check.py's built-in checks do not look at, with the error each must produce. */
const typeCases: Array<[string, Record<string, unknown>, string]> = [
  ["crossing.seq as a string", crossing({ seq: "1" }), "crossing.seq: must be a non-negative integer"],
  ["crossing.seq negative", crossing({ seq: -1 }), "crossing.seq: must be a non-negative integer"],
  ["crossing.seq fractional", crossing({ seq: 1.5 }), "crossing.seq: must be a non-negative integer"],
  ["crossing.id as a number", crossing({ id: 42 }), "crossing.id: must be a string"],
  ["crossing.execution_id as a number", crossing({ execution_id: 7 }), "crossing.execution_id: must be a string"],
  ["crossing.target as an object", crossing({ target: { name: "t" } }), "crossing.target: must be a string"],
  ["crossing.context as a string", crossing({ context: "x" }), "crossing.context: must be an object"],
  ["crossing.context.traceparent as a number", crossing({ context: { traceparent: 1 } }), "crossing.context.traceparent: must be a string"],
  ["crossing.ext as null", crossing({ ext: null }), "crossing.ext: must be an object"],
  ["Payload.bytes negative", crossing({ input: { value: 1, bytes: -5 } }), "crossing.input.bytes: must be a non-negative integer"],
  ["Payload.bytes as a string", crossing({ input: { value: 1, bytes: "12" } }), "crossing.input.bytes: must be a non-negative integer"],
  ["Payload.truncated as a string", crossing({ input: { value: "abc", truncated: "yes" } }), "crossing.input.truncated: must be a boolean"],
  ["Payload.redacted as a number", crossing({ input: { value: 1, redacted: 1 } }), "crossing.input.redacted: must be a boolean"],
  ["Payload.hash as an array", crossing({ input: { value: 1, hash: ["sha256:" + "0".repeat(64)] } }), "crossing.input.hash: does not match sha256:<64 lowercase hex>"],
  ["Error.class as a number", crossing({}, { outcome: "error", error: { class: 5 } }), "crossing.end.error.class: must be a string"],
  ["Error.message as an object", crossing({}, { outcome: "error", error: { class: "x", message: { text: "m" } } }), "crossing.end.error.message: must be a string"],
  ["crossing.end.time as a number", crossing({}, { outcome: "abandoned", time: 5 }), "crossing.end.time: not RFC 3339 UTC with Z suffix"],
  ["execution.id as a number", execution({ id: 42 }), "execution.id: must be a string"],
  ["execution.language as a number", execution({ language: 5 }), "execution.language: must be a string"],
  ["execution.context as a string", execution({ context: "session-1" }), "execution.context: must be an object"],
  ["execution.context.session as a number", execution({ context: { session: 12 } }), "execution.context.session: must be a string"],
  ["execution.context.traceparent as an object", execution({ context: { traceparent: { id: 1 } } }), "execution.context.traceparent: must be a string"],
  ["execution.ext as an array", execution({ ext: ["x"] }), "execution.ext: must be an object"],
  ["execution.end.outputs channel as a string", execution({}, { time: T1, disposition: "completed", outputs: { stdout: "hi" } }), "execution.end.outputs.stdout: Payload must be an object"],
  ["host.spec_version not MAJOR.MINOR", { kind: "host", host: "h", spec_version: "one" }, "host.spec_version: must be MAJOR.MINOR"],
  ["host.spec_version as a number", { kind: "host", host: "h", spec_version: 1.0 }, "host.spec_version: must be MAJOR.MINOR"],
  ["host.unmediated_egress as a string", { kind: "host", host: "h", unmediated_egress: "no" }, "host.unmediated_egress: must be a boolean"],
  ["host.attested as a string", { kind: "host", host: "h", attested: "crossing.target" }, "host.attested: must be an array of strings"],
  ["host.attested with a non-string entry", { kind: "host", host: "h", attested: [1] }, "host.attested: must be an array of strings"],
  ["host.ext as a string", { kind: "host", host: "h", ext: "x" }, "host.ext: must be an object"],
];

test("every type case is one spec/schema rejects", () => {
  for (const [name, line] of typeCases) assert.equal(schemaAccepts(line), false, `${name}: the schema must reject this line`);
});

test("a line the schema rejects for a type or a minimum fails validate, naming the field and the rule", () => {
  for (const [name, line, error] of typeCases) assert.deepEqual(structuralErrors(line), [error], name);
  const report = validateStream(jsonl(typeCases.map(([, line]) => line)));
  assert.equal(report.failures.length, typeCases.length, "one failure per schema-invalid line");
  assert.equal(exitCode(report), 1);
});

test("the same shapes with legal types pass, and required fields are checked as own keys", () => {
  const ok = [
    crossing({ seq: 0, context: { traceparent: "00-x" }, ext: {}, input: { value: "abc", truncated: true, redacted: false, bytes: 0, hash: "sha256:" + "a".repeat(64) } }),
    crossing({}, { outcome: "error", time: T1, error: { class: "x", message: "m", value: { redacted: true } } }),
    execution({ language: "js", context: { session: "s", traceparent: "t", other: 1 }, ext: { "a.b": null } }, { time: T1, disposition: "failed", outputs: { stdout: { value: "" } } }),
    { kind: "host", host: "h", spec_version: "12.34", unmediated_egress: false, attested: [], ext: {} },
  ];
  for (const line of ok) {
    assert.equal(schemaAccepts(line), true);
    assert.deepEqual(structuralErrors(line), []);
  }
  // A key inherited through the prototype is not a present field.
  const inherited = Object.create({ execution_id: "e1" }) as Record<string, unknown>;
  Object.assign(inherited, { kind: "crossing", host: "h", id: "c1", target: "t", input: { value: 1 } });
  assert.deepEqual(structuralErrors(inherited), ["crossing: missing required field: execution_id"]);
});

test("malformed lines, non-objects and unknown kinds are counted as skipped, not failed", () => {
  const report = validateStream('{"kind":"host","host":"h"}\nnot json\n[1,2]\n{"kind":"metric","host":"h"}\n\n\n');
  assert.equal(report.lines, 4);
  assert.equal(report.skipped, 3);
  assert.deepEqual(report.failures, []);
  assert.match(renderReport("x", report), /^x: 4 lines, 3 skipped, 0 failed, 0 warnings -> OK$/m);
});

test("lint rules from provenance.md 7 and end.time >= start are warnings, not failures", () => {
  const lines = [
    { kind: "host", host: "h", spec_version: "1.0", observes_crossings: "none", crossing_edge: "invocation", attested: ["crossing.made_up"] },
    { kind: "execution", host: "h", id: "e1", program: { value: "1" }, start: T1, end: { time: T, disposition: "completed" } },
    { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "t", input: { value: 1 } },
  ];
  const report = validateStream(jsonl(lines));
  assert.deepEqual(report.failures, []);
  assert.equal(exitCode(report), 0);
  assert.deepEqual(report.warnings, [
    "execution e1: end.time < start",
    "host h declares crossing_edge without attesting crossing.target",
    "host h declares observes_crossings none but the stream has crossings for it",
    'host h attested entry outside the known list: "crossing.made_up"',
  ]);
  const text = renderReport("x", report);
  assert.match(text, /4 warnings -> OK/);
  assert.match(text, /^    WARN execution e1: end\.time < start$/m);
});

test("a different major version is a warning", () => {
  const report = validateStream('{"kind":"host","host":"h","spec_version":"2.0"}');
  assert.deepEqual(report.warnings, ["host h declares spec_version 2.0; this consumer reads 1.x"]);
});

test("a host redeclared with different values is linted on the declaration that sorts first, whatever the line order", () => {
  const a = { kind: "host", host: "h", observes_crossings: "all", crossing_edge: "invocation", attested: ["crossing.target"] };
  const b = { kind: "host", host: "h", observes_crossings: "none" };
  const c = { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "t", input: { value: 1 } };
  const forward = validateStream(jsonl([a, b, c]));
  const backward = validateStream(jsonl([c, b, a]));
  assert.deepEqual(forward.warnings, backward.warnings);
  assert.equal(forward.warnings.length, 0, "the declaration that sorts first is complete and consistent");
});

test("a failure line names the line number, kind and id", () => {
  const report = validateStream('{"kind":"host","host":"h"}\n\n{"kind":"execution","host":"h","id":"e9","start":"2026-09-16T10:00:00"}');
  assert.equal(report.failures.length, 1);
  assert.match(renderReport("f", report), /^    line 3 execution e9: execution\.start: not RFC 3339 UTC with Z suffix$/m);
});

test("the report never writes a control character from the stream: ids, hosts, channels, versions and attested entries are escaped", () => {
  const ESC = ch(0x1b);
  const BEL = ch(0x07);
  const text = jsonl([
    { kind: "host", host: "h" + ESC + "]0;pwned" + BEL, spec_version: "9." + ch(0x9b) + "1", crossing_edge: "invocation", attested: ["x" + ch(0x2028)] },
    { kind: "execution", host: "h", id: "e1" + ch(0x0d), start: "bad" },
    execution({ id: "e2" + ch(0x202e) }, { time: T1, disposition: "completed", outputs: { ["std" + ESC + "[2K"]: "x" } }),
    { kind: "execution", host: "h", id: "e3" + ESC + "[1A", program: { value: "p" }, start: T1, end: { time: T, disposition: "completed" } },
  ]);
  const out = renderReport("file" + ESC + ".jsonl", validateStream(text));
  const hit = UNSAFE.exec(out.replace(/\n/g, ""));
  assert.equal(hit, null, hit === null ? "" : `U+${hit[0].charCodeAt(0).toString(16).padStart(4, "0")} at offset ${hit.index}`);
  assert.ok(out.includes("\\x1b]0;pwned\\x07"), "the escape is visible, not dropped");
  assert.ok(out.includes("e1\\x0d"));
  assert.ok(out.includes("e2\\u202e"));
  assert.ok(out.includes("std\\x1b[2K"));
});

test("the report for one line stays within a small multiple of that line, however many errors it has and however long its id", () => {
  const outputs: Record<string, number> = {};
  for (let i = 0; i < 2000; i++) outputs["c" + i] = 1;
  const line = JSON.stringify({ kind: "execution", host: "h", id: "i".repeat(20_000), program: { value: "p" }, start: T, end: { time: T1, disposition: "completed", outputs } });
  const report = renderReport("hostile.jsonl", validateStream(line + "\n"));
  assert.ok(report.length < 16 * line.length, `a ${line.length}-character line produced a ${report.length}-character report`);
  assert.match(report, /^ {4}line 1 execution i{64}…: and 1980 more errors$/m);
});

test("a line whose id or kind is nested 20000 deep is reported, not a crash", () => {
  const deep = "[".repeat(20_000) + "]".repeat(20_000);
  const text = `{"kind":"execution","host":"h","id":${deep},"start":"${T}"}\n{"kind":"host","host":${deep}}\n{"kind":${deep},"host":"h"}\n`;
  let out = "";
  assert.doesNotThrow(() => {
    out = renderReport("hostile.jsonl", validateStream(text));
  });
  assert.match(out, /-> FAIL$/m);
});

test("a timestamp that names no instant, such as February 30, fails like one with the wrong shape", () => {
  const report = validateStream(jsonl([execution({ start: "2026-02-30T00:00:00Z" })]));
  assert.deepEqual(report.failures[0]?.errors, ["execution.start: not RFC 3339 UTC with Z suffix"]);
});

test("the report's `lines` counts every non-blank line, not the records kept, which is the one number check.py's header states differently", () => {
  // `mocon validate unknown-kind.jsonl` prints "4 lines, 1 skipped" where check.py prints "3 lines, 1
  // skipped": check.py counts records kept and this counts what it read. Both name the same file, so a
  // reader comparing the two reports needs the definition, and packages/cli/README.md gives it.
  const s = streams.find((f) => f.name === "unknown-kind");
  assert.ok(s !== undefined, "the unknown-kind golden stream is the case both tools print");
  const nonBlank = s.text.split("\n").filter((l) => l.trim() !== "").length;
  const report = validateStream(s.text);
  assert.equal(report.lines, nonBlank, "every non-blank line is counted, skipped ones included");
  assert.equal(report.skipped, 1);
  assert.equal(report.lines - report.skipped, nonBlank - 1, "records kept is lines minus skipped, which is check.py's number");
  assert.match(renderReport("unknown-kind.jsonl", report), new RegExp(`^unknown-kind\\.jsonl: ${nonBlank} lines, 1 skipped, 0 failed, 0 warnings -> OK$`, "m"));
});
