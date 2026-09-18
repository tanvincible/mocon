/**
 * map.ts line by line, the rules of otel-mapping.md one at a time:
 * line handling and the skip reasons, status codes, crossing timing,
 * value encoding, the cap, the traceparent link, provenance labels under
 * each attestation, span names, the declaration's version, integers past
 * 2^53, unknown attested entries and the traceparent's case.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostLine } from "@mocon/core";
import { otlpSink } from "../src/index.js";
import { truncateUtf8 } from "../src/map.js";
import type { AnyValue } from "../src/map.js";
import { attrs, crossing, declared, EMPTY, execution, EXECUTION_ID, fakeFetch, HOST, mapped, spanOf, type Rec } from "./helpers.js";

/** Every attribute of a one-line result's span, with its typed value. */
const rawAttrs = (line: string): Record<string, AnyValue> => Object.fromEntries(spanOf(mapped(line).request).attributes.map((kv) => [kv.key, kv.value]));

test("line handling: skip reasons, and a host line with neither span nor reason", () => {
  assert.deepEqual(mapped("{not json"), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped("[1,2]"), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped({ kind: "metric", host: HOST, id: "x" }), { request: EMPTY, skipped: "unknown_kind" });
  assert.deepEqual(mapped({ kind: "metric" }), { request: EMPTY, skipped: "unknown_kind" });
  assert.deepEqual(mapped({ kind: "execution", id: "x", start: "2026-09-16T10:00:00Z", end: {} }), { request: EMPTY, skipped: "malformed" }, "no host");
  assert.deepEqual(mapped({ kind: "host", host: HOST }), { request: EMPTY });
  assert.deepEqual(mapped(JSON.stringify(declared([]))), { request: EMPTY });
  assert.deepEqual(mapped({ kind: "host" }), { request: EMPTY, skipped: "malformed" });
  const { end: _end, ...notice } = execution();
  assert.deepEqual(mapped(notice), { request: EMPTY, skipped: "notice" });
  assert.deepEqual(mapped(execution({ end: "soon" })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(execution({}, { disposition: "crashed" })), { request: EMPTY, skipped: "bad_enum" });
  assert.deepEqual(mapped(crossing({}, { outcome: "ok" })), { request: EMPTY, skipped: "bad_enum" });
  assert.deepEqual(mapped(execution({ program: undefined })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(execution({ start: undefined })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(execution({}, { time: undefined })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(crossing({ input: undefined })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(crossing({ target: 7 })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(execution({ start: "2026-09-16 10:00:00" })), { request: EMPTY, skipped: "bad_timestamp" });
  assert.deepEqual(mapped(execution({ start: "2026-09-16T10:00:00.000+02:00" })), { request: EMPTY, skipped: "bad_timestamp" });
  assert.deepEqual(mapped(execution({}, { time: "2026-13-16T10:00:00Z" })), { request: EMPTY, skipped: "bad_timestamp" });
  assert.deepEqual(mapped(crossing({ start: "yesterday" })), { request: EMPTY, skipped: "bad_timestamp" });
  assert.deepEqual(mapped(crossing({}, { time: 1 })), { request: EMPTY, skipped: "bad_timestamp" });
});

test("a raw string and its parsed form map identically; unknown top-level keys are not exported", () => {
  const line = execution({ "x-debug": { trace: true } });
  const fromObject = mapped(line);
  const fromString = mapped(JSON.stringify(line));
  assert.deepEqual(fromString, fromObject);
  assert.ok(!spanOf(fromObject.request).attributes.some((a) => a.key.includes("x-debug")));
});

test("timestamps become unix nanosecond strings with nine fractional digits preserved", () => {
  const span = spanOf(mapped(execution({ start: "2026-09-16T10:00:00.123456789Z" }, { time: "1970-01-01T00:00:00.5Z" })).request);
  assert.equal(span.startTimeUnixNano, "1789552800123456789");
  assert.equal(span.endTimeUnixNano, "500000000");
  const epoch = spanOf(mapped(execution({ start: "1970-01-01T00:00:00Z" })).request);
  assert.equal(epoch.startTimeUnixNano, "0");
  const before = spanOf(mapped(execution({ start: "1969-12-31T23:59:59Z" })).request);
  assert.equal(before.startTimeUnixNano, "-1000000000");
  const leap = spanOf(mapped(execution({ start: "2024-02-29T23:59:59Z" })).request);
  assert.equal(leap.startTimeUnixNano, String(Date.UTC(2024, 1, 29, 23, 59, 59) / 1000) + "000000000");
});

test("execution span: shape, status per disposition, and the cancelled exception", () => {
  const completed = spanOf(mapped(execution(), declared(["crossing.target", "crossing.input"])).request);
  assert.equal(completed.name, "mocon.execution");
  assert.equal(completed.kind, 1);
  assert.equal(completed.traceId, EXECUTION_ID);
  assert.equal(completed.spanId, "4edd2d736dd0892d");
  assert.equal(completed.parentSpanId, undefined);
  assert.equal(completed.links, undefined);
  assert.deepEqual(completed.status, { code: 1 });
  const a = attrs(completed);
  assert.equal(a["mocon.host"], HOST);
  assert.equal(a["mocon.host.spec_version"], "1.0");
  assert.equal(a["mocon.host.observes_crossings"], "all");
  assert.equal(a["mocon.host.unmediated_egress"], false);
  assert.equal(a["mocon.host.crossing_edge"], "invocation");
  assert.deepEqual(a["mocon.host.attested"], ["crossing.target", "crossing.input"]);
  assert.equal(a["mocon.execution.id"], EXECUTION_ID);
  assert.equal(a["mocon.execution.disposition"], "completed");
  assert.equal(a["gen_ai.operation.name"], "execute_tool");
  assert.equal(a["mocon.program.value"], "return 1");
  assert.equal(a["mocon.program.bytes"], "8");
  assert.equal(a["mocon.provenance.program.value"], "P");
  assert.ok(!("mocon.execution.language" in a));
  assert.ok(!("mocon.provenance.execution.language" in a));
  assert.ok(!("mocon.provenance.ext.p" in a), "no ext keys, no array");

  assert.deepEqual(spanOf(mapped(execution({}, { disposition: "failed", error: { class: "runtime", message: "boom" } })).request).status, { code: 2, message: "failed" });
  assert.deepEqual(spanOf(mapped(execution({}, { disposition: "terminated", error: { class: "timeout" } })).request).status, { code: 2, message: "terminated" });
  assert.deepEqual(spanOf(mapped(execution({}, { disposition: "terminated", error: { class: "cancelled" } })).request).status, { code: 0 });
  assert.deepEqual(spanOf(mapped(execution({}, { disposition: "abandoned" })).request).status, { code: 0 });
});

test("execution span: error, outputs, context and ext attributes with their labels", () => {
  const line = execution(
    { language: "python", context: { session: "s-1" }, ext: { "vendor.exit_code": 1, "vendor.meta": { a: [1, null] }, "vendor.flag": true, "vendor.note": "x" } },
    {
      disposition: "failed",
      error: { class: "runtime", message: "boom", value: { value: { name: "Error" }, bytes: 16, hash: "sha256:" + "3".repeat(64) } },
      outputs: { stdout: { value: "hi\n", bytes: 3, hash: "sha256:" + "4".repeat(64) }, files: { redacted: true } },
    },
  );
  const a = attrs(spanOf(mapped(line).request));
  assert.equal(a["mocon.execution.language"], "python");
  assert.equal(a["mocon.provenance.execution.language"], "P");
  assert.equal(a["mocon.context.session"], "s-1");
  assert.ok(!("mocon.provenance.context.session" in a), "session is host-observed");
  assert.equal(a["mocon.execution.error.class"], "runtime");
  assert.equal(a["mocon.provenance.execution.error.class"], "P");
  assert.equal(a["mocon.execution.error.message"], "boom");
  assert.equal(a["mocon.provenance.execution.error.message"], "P");
  assert.equal(a["mocon.execution.error.value.value"], '{"name":"Error"}');
  assert.equal(a["mocon.execution.error.value.bytes"], "16");
  assert.equal(a["mocon.provenance.execution.error.value.value"], "P");
  assert.equal(a["mocon.execution.outputs.stdout.value"], "hi\n");
  assert.equal(a["mocon.provenance.execution.outputs.stdout.value"], "P");
  assert.equal(a["mocon.execution.outputs.files.redacted"], true);
  assert.ok(!("mocon.execution.outputs.files.value" in a));
  assert.ok(!("mocon.provenance.execution.outputs.files.value" in a), "no label without a value");
  assert.equal(a["mocon.ext.vendor.exit_code"], "1");
  assert.equal(a["mocon.ext.vendor.meta"], '{"a":[1,null]}');
  assert.equal(a["mocon.ext.vendor.flag"], true);
  assert.equal(a["mocon.ext.vendor.note"], "x");
  assert.deepEqual(a["mocon.provenance.ext.p"], ["vendor.exit_code", "vendor.meta", "vendor.flag", "vendor.note"]);
  assert.ok(!("mocon.provenance.ext.vendor.note" in a), "ext keys get no per-key label");

  const attested = attrs(spanOf(mapped(line, declared(["execution.error.class"])).request));
  assert.ok(!("mocon.provenance.execution.error.class" in attested), "attested class is host-observed");
  assert.equal(attested["mocon.provenance.execution.error.message"], "P");
});

test("the declaration is applied only to its own host string, and unknown closed-set values drop one attribute each", () => {
  const other = { ...declared([]), host: "other/host" } as HostLine;
  const a = attrs(spanOf(mapped(execution(), other).request));
  assert.ok(!Object.keys(a).some((k) => k.startsWith("mocon.host.")));

  const odd = declared(["crossing.target", "made.up"], { observes_crossings: "most", crossing_edge: "edge", unmediated_egress: "no" });
  const b = attrs(spanOf(mapped(execution(), odd).request));
  assert.equal(b["mocon.host.spec_version"], "1.0");
  assert.ok(!("mocon.host.observes_crossings" in b));
  assert.ok(!("mocon.host.crossing_edge" in b));
  assert.ok(!("mocon.host.unmediated_egress" in b));
  assert.deepEqual(b["mocon.host.attested"], ["crossing.target"], "an entry this version does not know is ignored");
  const c = attrs(spanOf(mapped(crossing(), odd).request));
  assert.ok(!("mocon.provenance.crossing.target" in c), "the known entry still applies");

  const empty = attrs(spanOf(mapped(execution(), declared([])).request));
  assert.deepEqual(empty["mocon.host.attested"], [], "declared empty is an empty array");
  const absent = attrs(spanOf(mapped(execution(), { kind: "host", host: HOST }).request));
  assert.ok(!("mocon.host.attested" in absent), "not declared is absent");
});

test("traceparent: the execution nests under the caller and links to its derived trace; the crossing uses its own line's value", () => {
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const ex = spanOf(mapped(execution({ context: { traceparent: tp } })).request);
  assert.equal(ex.traceId, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(ex.parentSpanId, "b7ad6b7169203331");
  assert.deepEqual(ex.links, [{ traceId: EXECUTION_ID, spanId: "4edd2d736dd0892d" }]);
  assert.equal(attrs(ex)["mocon.context.traceparent"], tp);

  const copied = spanOf(mapped(crossing({ context: { traceparent: tp } })).request);
  assert.equal(copied.traceId, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(copied.parentSpanId, "4edd2d736dd0892d");
  assert.equal(attrs(copied)["mocon.context.traceparent"], tp);

  const notCopied = spanOf(mapped(crossing()).request);
  assert.equal(notCopied.traceId, EXECUTION_ID, "a crossing without the value keeps the derived trace id");
  assert.ok(!("mocon.context.traceparent" in attrs(notCopied)));

  const malformed = "00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01";
  const ignored = spanOf(mapped(execution({ context: { traceparent: malformed } })).request);
  assert.equal(ignored.traceId, EXECUTION_ID);
  assert.equal(ignored.parentSpanId, undefined);
  assert.equal(ignored.links, undefined);
  assert.equal(attrs(ignored)["mocon.context.traceparent"], malformed, "still carried verbatim");
});

test("crossing span: shape, status per outcome, output only under output and error only under error", () => {
  const span = spanOf(mapped(crossing({ seq: 3 })).request);
  assert.equal(span.name, "company_identify");
  assert.equal(span.kind, 3);
  assert.equal(span.traceId, EXECUTION_ID);
  assert.equal(span.spanId, "1a2b3c4d5e6f7081");
  assert.equal(span.parentSpanId, "4edd2d736dd0892d");
  assert.equal(span.startTimeUnixNano, "1789552800118000000");
  assert.equal(span.endTimeUnixNano, "1789552800402000000");
  assert.deepEqual(span.status, { code: 1 });
  const a = attrs(span);
  assert.equal(a["mocon.execution.id"], EXECUTION_ID);
  assert.equal(a["mocon.crossing.id"], "1a2b3c4d5e6f7081");
  assert.equal(a["mocon.crossing.target"], "company_identify");
  assert.equal(a["mocon.crossing.seq"], "3");
  assert.equal(a["mocon.crossing.outcome"], "output");
  assert.ok(!("mocon.crossing.timing" in a));
  assert.equal(a["mocon.crossing.input.value"], '{"query":"acme.example"}');
  assert.equal(a["mocon.crossing.output.value"], '{"id":8842}');
  assert.equal(a["gen_ai.operation.name"], "execute_tool");
  assert.equal(a["gen_ai.tool.name"], "company_identify");
  assert.equal(a["gen_ai.tool.call.id"], "1a2b3c4d5e6f7081");
  assert.ok(!Object.keys(a).some((k) => k.startsWith("mocon.host.")), "no mocon.host.* on a crossing");

  const error = spanOf(
    mapped(crossing({}, { outcome: "error", output: undefined, error: { class: "conflict", message: "409", value: { value: { ok: false, status: 409 } } } })).request,
  );
  assert.deepEqual(error.status, { code: 2, message: "error" });
  const e = attrs(error);
  assert.equal(e["mocon.crossing.error.class"], "conflict");
  assert.equal(e["mocon.crossing.error.message"], "409");
  assert.equal(e["mocon.crossing.error.value.value"], '{"ok":false,"status":409}');
  assert.ok(!("mocon.crossing.output.value" in e));

  const abandoned = spanOf(mapped(crossing({}, { outcome: "abandoned", output: undefined, time: undefined })).request);
  assert.deepEqual(abandoned.status, { code: 0 });
  assert.equal(attrs(abandoned)["mocon.crossing.timing"], "start_only");
  assert.ok(!("mocon.crossing.output.value" in attrs(abandoned)));
});

test("crossing timing: start_only, end_only and none are zero-duration and say so", () => {
  const startOnly = spanOf(mapped(crossing({}, { time: undefined })).request);
  assert.equal(startOnly.startTimeUnixNano, "1789552800118000000");
  assert.equal(startOnly.endTimeUnixNano, "1789552800118000000");
  assert.equal(attrs(startOnly)["mocon.crossing.timing"], "start_only");

  const endOnly = spanOf(mapped(crossing({ start: undefined })).request);
  assert.equal(endOnly.startTimeUnixNano, "1789552800402000000");
  assert.equal(endOnly.endTimeUnixNano, "1789552800402000000");
  assert.equal(attrs(endOnly)["mocon.crossing.timing"], "end_only");

  const none = spanOf(mapped(crossing({ start: undefined }, { time: undefined }), undefined, { now: () => 1789574700000 }).request);
  assert.equal(none.startTimeUnixNano, "1789574700000000000");
  assert.equal(none.endTimeUnixNano, "1789574700000000000");
  assert.equal(attrs(none)["mocon.crossing.timing"], "none");
});

test("provenance labels follow the attested list", () => {
  const line = crossing({ seq: 1 }, { outcome: "error", output: undefined, error: { class: "refused", message: "no", value: { value: 1 } } });
  const bare = attrs(spanOf(mapped(line).request));
  assert.equal(bare["mocon.provenance.crossing.target"], "P");
  assert.equal(bare["mocon.provenance.crossing.seq"], "P");
  assert.equal(bare["mocon.provenance.crossing.outcome"], "P");
  assert.equal(bare["mocon.provenance.crossing.input.value"], "P");
  assert.equal(bare["mocon.provenance.crossing.error.class"], "P");
  assert.equal(bare["mocon.provenance.crossing.error.message"], "P");
  assert.equal(bare["mocon.provenance.crossing.error.value.value"], "P");

  const full = attrs(spanOf(mapped(line, declared(["crossing.target", "crossing.input", "crossing.output", "crossing.error"])).request));
  assert.ok(!Object.keys(full).some((k) => k.startsWith("mocon.provenance.crossing.target")));
  assert.ok(!("mocon.provenance.crossing.seq" in full));
  assert.ok(!("mocon.provenance.crossing.outcome" in full));
  assert.ok(!("mocon.provenance.crossing.input.value" in full));
  assert.equal(full["mocon.provenance.crossing.error.class"], "T");
  assert.equal(full["mocon.provenance.crossing.error.message"], "T");
  assert.equal(full["mocon.provenance.crossing.error.value.value"], "T");

  const output = attrs(spanOf(mapped(crossing(), declared(["crossing.output"])).request));
  assert.equal(output["mocon.provenance.crossing.output.value"], "T");
  assert.equal(output["mocon.provenance.crossing.target"], "P");

  const noValue = attrs(spanOf(mapped(crossing({ input: { redacted: true, bytes: 24, hash: "sha256:" + "1".repeat(64) } })).request));
  assert.equal(noValue["mocon.crossing.input.redacted"], true);
  assert.equal(noValue["mocon.crossing.input.bytes"], "24");
  assert.ok(!("mocon.crossing.input.value" in noValue));
  assert.ok(!("mocon.provenance.crossing.input.value" in noValue), "no label for an attribute that is not present");
});

test("value encoding per otel-mapping.md 8.2", () => {
  const payloads = {
    s: { value: "text" },
    b: { value: false },
    i: { value: 42 },
    neg: { value: -7 },
    big: { value: 2 ** 62 },
    unsafe: { value: 2 ** 53 + 2 },
    huge: { value: 1e300 },
    edge: { value: 2 ** 63 },
    d: { value: 1.5 },
    o: { value: { b: 1, a: "é", n: null } },
    arr: { value: [1, "two"] },
    nul: { value: null },
    flags: { value: "x", truncated: false, redacted: false },
  };
  const span = spanOf(mapped(execution({}, { outputs: payloads })).request);
  const raw = Object.fromEntries(span.attributes.map((kv) => [kv.key, kv.value]));
  const p = (name: string): unknown => raw["mocon.execution.outputs." + name + ".value"];
  assert.deepEqual(p("s"), { stringValue: "text" });
  assert.deepEqual(p("b"), { boolValue: false });
  assert.deepEqual(p("i"), { intValue: "42" });
  assert.deepEqual(p("neg"), { intValue: "-7" });
  assert.deepEqual(p("big"), { intValue: "4611686018427388000" }, "the digits the line carries, which JSON.stringify wrote for 2^62");
  assert.deepEqual(p("unsafe"), { intValue: "9007199254740994" });
  assert.deepEqual(p("huge"), { doubleValue: 1e300 });
  assert.deepEqual(p("edge"), { doubleValue: 2 ** 63 }, "2^63 is outside int64");
  assert.deepEqual(p("d"), { doubleValue: 1.5 });
  assert.deepEqual(p("o"), { stringValue: '{"b":1,"a":"é","n":null}' }, "compact, key order as received, non-ASCII unescaped");
  assert.deepEqual(p("arr"), { stringValue: '[1,"two"]' });
  assert.deepEqual(p("nul"), { stringValue: "null" }, "a present null value is a value");
  assert.deepEqual(raw["mocon.execution.outputs.flags.truncated"], { boolValue: false }, "a false flag is copied when present");
  assert.deepEqual(raw["mocon.execution.outputs.flags.redacted"], { boolValue: false });
  assert.equal(raw["mocon.execution.outputs.s.truncated"], undefined, "an absent flag stays absent");
});

test("the cap keeps a code point boundary, sets the right truncated flag, and leaves ids, hashes, enums and gen_ai names alone", () => {
  const long = "é".repeat(10) + "😀" + "z".repeat(100);
  const line = crossing(
    { target: long, ext: { "v.note": long, "v.n": 5 }, input: { value: long, bytes: 1, hash: "sha256:" + "1".repeat(64), truncated: false } },
    { outcome: "error", output: undefined, error: { class: "capability_error", message: long, value: { value: { text: long } } } },
  );
  const span = spanOf(mapped(line, undefined, { cap: 21 }).request);
  const a = attrs(span);
  assert.equal(a["mocon.crossing.target"], "é".repeat(10), "20 bytes fit, the 4-byte emoji does not");
  assert.equal(a["mocon.crossing.target.truncated"], true);
  assert.equal(a["mocon.crossing.input.value"], "é".repeat(10));
  assert.equal(a["mocon.crossing.input.truncated"], true, "the Payload's own flag, overriding the host's false");
  assert.equal(a["mocon.crossing.input.bytes"], "1", "bytes and hash are the host's");
  assert.equal(a["mocon.crossing.input.hash"], "sha256:" + "1".repeat(64));
  assert.equal(a["mocon.crossing.error.message"], "é".repeat(10));
  assert.equal(a["mocon.crossing.error.message.truncated"], true);
  assert.equal(a["mocon.crossing.error.value.value"], '{"text":"' + "é".repeat(5) + "é");
  assert.equal(a["mocon.crossing.error.value.truncated"], true);
  assert.equal(a["mocon.ext.v.note"], "é".repeat(10));
  assert.equal(a["mocon.ext.v.note.truncated"], true);
  assert.equal(a["mocon.ext.v.n"], "5");
  assert.ok(!("mocon.ext.v.n.truncated" in a));
  assert.equal(a["gen_ai.tool.name"], long, "uncut");
  assert.equal(a["mocon.crossing.id"], "1a2b3c4d5e6f7081");
  assert.equal(a["mocon.crossing.outcome"], "error");
  assert.equal(span.name, long, "span names follow the 128 code point rule, not the cap");

  const exact = attrs(spanOf(mapped(crossing({ target: "abc" }), undefined, { cap: 3 }).request));
  assert.equal(exact["mocon.crossing.target"], "abc");
  assert.ok(!("mocon.crossing.target.truncated" in exact), "a value that fits exactly is not cut");
});

test("span names: the target cut to 128 code points, mocon.crossing for an empty target", () => {
  const long = "😀".repeat(200);
  const span = spanOf(mapped(crossing({ target: long })).request);
  assert.equal([...span.name].length, 128);
  assert.equal(attrs(span)["mocon.crossing.target"], long, "the attribute is uncut");
  const empty = spanOf(mapped(crossing({ target: "" })).request);
  assert.equal(empty.name, "mocon.crossing");
  assert.equal(attrs(empty)["mocon.crossing.target"], "");
  assert.equal(attrs(empty)["gen_ai.tool.name"], "");
});

test("hashed ids on the wire: a native execution id and a native crossing id", () => {
  const span = spanOf(mapped(crossing({ id: "call-7", execution_id: "run-42" })).request);
  assert.equal(span.traceId, "9517adfb3444518031fe879bc136c334");
  assert.equal(span.spanId, "dcbb7a0fe90e11fd");
  assert.equal(span.parentSpanId, "81712fb065e103b6");
  const a = attrs(span);
  assert.equal(a["mocon.crossing.id"], "call-7", "attributes carry the ids as written");
  assert.equal(a["gen_ai.tool.call.id"], "call-7");
});

/* ------------------------------------------------------------------ */
/* otel-mapping.md 3: a missing required field is malformed; an unknown */
/* closed-set value is bad_enum                                        */
/* ------------------------------------------------------------------ */

test("a complete line with no end.disposition or end.outcome is missing a required field: malformed, not bad_enum", () => {
  assert.deepEqual(mapped(execution({}, { disposition: undefined })), { request: EMPTY, skipped: "malformed" });
  assert.deepEqual(mapped(crossing({}, { outcome: undefined, output: undefined })), { request: EMPTY, skipped: "malformed" });
});

test("a present closed-set value outside the set is bad_enum whatever its type, and wins over a missing field, because end then reads as absent", () => {
  for (const value of ["success", "", "Completed", 1, null, true, ["completed"], { completed: true }]) {
    assert.deepEqual(mapped(execution({}, { disposition: value })), { request: EMPTY, skipped: "bad_enum" }, JSON.stringify(value));
    assert.deepEqual(mapped(crossing({}, { outcome: value })), { request: EMPTY, skipped: "bad_enum" }, JSON.stringify(value));
  }
  assert.deepEqual(mapped(execution({ program: undefined }, { disposition: "crashed", time: undefined })), { request: EMPTY, skipped: "bad_enum" });
});

/* ------------------------------------------------------------------ */
/* otel-mapping.md 8.2 and 10: key order as received                   */
/* ------------------------------------------------------------------ */

test("object values keep the key order the line carried, array-index keys included, in payloads, errors and ext", () => {
  const raw =
    `{"kind":"crossing","host":"${HOST}","id":"1a2b3c4d5e6f7081","execution_id":"${EXECUTION_ID}",` +
    '"target":"t","input":{"value":{"b":1,"10":2,"a":3},"bytes":20,"hash":"sha256:' +
    "1".repeat(64) +
    '"},"ext":{"v.meta":{"z":true,"7":null},"9":1,"v.a":"x"},' +
    '"end":{"outcome":"error","error":{"class":"c","value":{"value":[{"x":1,"2":2}]}}}}';
  const a = attrs(spanOf(mapped(raw).request));
  assert.equal(a["mocon.crossing.input.value"], '{"b":1,"10":2,"a":3}');
  assert.equal(a["mocon.crossing.error.value.value"], '[{"x":1,"2":2}]');
  assert.equal(a["mocon.ext.v.meta"], '{"z":true,"7":null}');
  assert.deepEqual(a["mocon.provenance.ext.p"], ["v.meta", "9", "v.a"], "ext keys listed in the line's order");
});

test("output channels are exported in the line's order", () => {
  const raw = JSON.stringify(execution()).replace('"disposition":"completed"', '"disposition":"completed","outputs":{"stdout":{"value":"a"},"2":{"value":"b"},"files":{"redacted":true}}');
  const keys = spanOf(mapped(raw).request)
    .attributes.map((kv) => kv.key)
    .filter((k) => k.startsWith("mocon.execution.outputs."));
  assert.deepEqual(keys, ["mocon.execution.outputs.stdout.value", "mocon.execution.outputs.2.value", "mocon.execution.outputs.files.redacted"]);
});

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

test("a number past the double range is a double of infinity in proto3 JSON, never a double of null", () => {
  const raw = JSON.stringify(crossing({ ext: { "v.big": 0, "v.small": 0, "v.nested": 0 } })).replace('"v.big":0', '"v.big":1e400').replace('"v.small":0', '"v.small":-1e400').replace('"v.nested":0', '"v.nested":[1e400]');
  const span = spanOf(mapped(raw).request);
  const raws = Object.fromEntries(span.attributes.map((kv) => [kv.key, kv.value]));
  assert.deepEqual(raws["mocon.ext.v.big"], { doubleValue: "Infinity" });
  assert.deepEqual(raws["mocon.ext.v.small"], { doubleValue: "-Infinity" });
  assert.deepEqual(raws["mocon.ext.v.nested"], { stringValue: "[null]" }, "inside a JSON text, what JSON.stringify writes");
});

/* ------------------------------------------------------------------ */
/* core.md 11: another major version                                   */
/* ------------------------------------------------------------------ */

test("a declaration of another major version is not applied: no mocon.host.* and baseline provenance labels", () => {
  const attested = ["crossing.target", "crossing.input", "crossing.output"];
  for (const spec_version of ["2.0", "0.9", "10.0", "", "1x.0", 1]) {
    const d = declared(attested, { spec_version }) as HostLine;
    const ex = attrs(spanOf(mapped(execution(), d).request));
    assert.ok(!Object.keys(ex).some((k) => k.startsWith("mocon.host.")), String(spec_version));
    const c = attrs(spanOf(mapped(crossing(), d).request));
    assert.equal(c["mocon.provenance.crossing.target"], "P", String(spec_version));
    assert.equal(c["mocon.provenance.crossing.output.value"], "P");
  }
  for (const spec_version of ["1.0", "1.7", "1", undefined]) {
    const d = declared(attested, { spec_version }) as HostLine;
    const c = attrs(spanOf(mapped(crossing(), d).request));
    assert.ok(!("mocon.provenance.crossing.target" in c), String(spec_version));
    assert.equal(c["mocon.provenance.crossing.output.value"], "T");
  }
});

/* ------------------------------------------------------------------ */
/* Options and the cap                                                 */
/* ------------------------------------------------------------------ */

// A cap that is not a non-negative integer is refused by `otlpSink`, where the option enters the package; sink.test.ts holds that.
test("a cap of zero keeps nothing, and a clock that is not a function is refused", () => {
  assert.equal(attrs(spanOf(mapped(crossing(), undefined, { cap: 0 }).request))["mocon.crossing.target"], "", "a cap of zero keeps nothing");
  assert.throws(() => mapped(crossing(), undefined, { now: 5 as unknown as () => number }), TypeError);
});

test("truncateUtf8 cuts on a code point boundary: never half a surrogate pair, and a lone surrogate counts three bytes", () => {
  assert.equal(truncateUtf8("ab😀", 5), "ab", "the 4-byte pair does not fit in 3");
  assert.equal(truncateUtf8("ab😀", 6), "ab😀");
  assert.equal(truncateUtf8("é😀é", 5), "é");
  assert.equal(truncateUtf8("a\ud800b", 4), "a\ud800");
  assert.equal(truncateUtf8("a\ud800b", 3), "a");
  assert.equal(truncateUtf8("\ude00\ud83d", 3), "\ude00", "a low surrogate before a high one is two lone surrogates");
  assert.equal(truncateUtf8("€€", 5), "€");
  assert.equal(truncateUtf8("", 0), "");
  assert.equal(truncateUtf8("abc", 0), "");
  const s = "😀".repeat(1000);
  for (let cap = 0; cap < 20; cap++) {
    const cut = truncateUtf8(s, cap);
    assert.equal(cut.length % 2, 0, "whole pairs only");
    assert.ok(Buffer.byteLength(cut) <= cap && Buffer.byteLength(cut) > cap - 4);
  }
});

test("an integer past 2^53 but within int64 keeps its digits, in ext, in a Payload value, and at the int64 bounds", () => {
  const withExt = JSON.stringify(execution()).replace('"kind":"execution"', '"kind":"execution","ext":{"vendor.native_id":1234567890123456789}');
  assert.deepEqual(rawAttrs(withExt)["mocon.ext.vendor.native_id"], { intValue: "1234567890123456789" });
  const base = JSON.stringify(crossing({}, { output: { value: 0 } }));
  for (const digits of ["9007199254740993", "9223372036854775807", "-9223372036854775808"]) {
    assert.deepEqual(rawAttrs(base.replace('"output":{"value":0}', `"output":{"value":${digits}}`))["mocon.crossing.output.value"], { intValue: digits });
  }
  assert.deepEqual(rawAttrs(base.replace('"output":{"value":0}', '"output":{"value":9223372036854775808}'))["mocon.crossing.output.value"], { doubleValue: 9223372036854775808 }, "past int64, a double");
  const nested = base.replace('"output":{"value":0}', '"output":{"value":{"id":1234567890123456789,"n":[9007199254740993]}}');
  assert.deepEqual(rawAttrs(nested)["mocon.crossing.output.value"], { stringValue: '{"id":1234567890123456789,"n":[9007199254740993]}' }, "inside a JSON text, the digits the line carried");
});

/* ------------------------------------------------------------------ */
/* Declarations and trace context                                      */
/* ------------------------------------------------------------------ */

test("mocon.host.attested carries only the entries this version knows (otel-mapping.md 3), through the mapping and the sink", async () => {
  const declaration = declared(["crossing.target", "ext.segments", "crossing.everything"]);
  assert.deepEqual(attrs(spanOf(mapped(execution(), declaration).request))["mocon.host.attested"], ["crossing.target"]);
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  await sink.write([JSON.stringify(declared(["execution.error.class", "vendor.unknown"])), JSON.stringify(execution())]);
  await sink.flush();
  const span = f.calls[0]?.body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.ok(span !== undefined);
  assert.deepEqual(attrs(span)["mocon.host.attested"], ["execution.error.class"]);
});

test("a traceparent with upper-case hex version or flag digits is well formed (otel-mapping.md 4.1): the spans land in the caller's trace", () => {
  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const PARENT = "00f067aa0ba902b7";
  for (const traceparent of [`00-${TRACE}-${PARENT}-0A`, `0A-${TRACE}-${PARENT}-01`]) {
    const span = spanOf(mapped(execution({ context: { traceparent } })).request);
    assert.equal(span.traceId, TRACE, traceparent);
    assert.equal(span.parentSpanId, PARENT, traceparent);
    assert.equal(spanOf(mapped(crossing({ context: { traceparent } })).request).traceId, TRACE, traceparent);
  }
  assert.notEqual(spanOf(mapped(execution({ context: { traceparent: `FF-${TRACE}-${PARENT}-01` } })).request).traceId, TRACE, "version ff in either case is not well formed");
});

test("otel-mapping.md 3 with core.md 5.5: a line whose end.error carries no class is skipped as malformed, not exported without one", () => {
  const noClass = [{ message: "boom" }, { value: { value: 1 } }, "boom", null, { class: 7 }];
  for (const error of noClass) {
    const ex = mapped(execution({}, { disposition: "failed", error }));
    assert.deepEqual(ex, { request: EMPTY, skipped: "malformed" }, `execution end.error ${JSON.stringify(error)} produced ${JSON.stringify(ex.request)}`);
    const c = mapped(crossing({}, { outcome: "error", output: undefined, error }));
    assert.deepEqual(c, { request: EMPTY, skipped: "malformed" }, `crossing end.error ${JSON.stringify(error)} produced ${JSON.stringify(c.request)}`);
  }
  // An error under an outcome that does not carry one is not this line's error, so it is left alone.
  assert.equal(mapped(crossing({}, { outcome: "output", output: { value: 1 }, error: { message: "boom" } })).skipped, undefined);
});
