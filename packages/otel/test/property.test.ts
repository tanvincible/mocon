/**
 * Properties over generated input. Ids are a function of the host and the
 * ids on the line and nothing else, verbatim ids are kept, hashed ids do
 * not collide. A raw line and its parsed form map to the same request.
 * Every value is encoded as otel-mapping.md 8.2 says, checked against a
 * reference written from the generated text. Mapping never throws, for any
 * text and any object.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { HostLine } from "@mocon/core";
import { crossingSpanIdOf, executionSpanIdOf, traceIdOf } from "../src/ids.js";
import { otlpSink } from "../src/index.js";
import type { AnyValue } from "../src/map.js";
import { crossing, declared, execution, fakeFetch, int64Of, mapped, readStreamLines, render, spanOf, spansOf, streamNames, tree, type Rec } from "./helpers.js";

const RUNS = { numRuns: 300 };
const NOW = { now: () => 1789574700000 };
const hex = (length: number): fc.Arbitrary<string> => fc.stringMatching(new RegExp(`^[0-9a-f]{${length}}$`));
const anyId = fc.oneof(fc.string(), fc.string({ unit: "binary" }), hex(16), hex(32), fc.constantFrom("0".repeat(16), "0".repeat(32)));

/* ------------------------------------------------------------------ */
/* Ids                                                                 */
/* ------------------------------------------------------------------ */

test("ids depend on the host and the line's ids only: the same across runs, declarations, options, and every other field", () => {
  fc.assert(
    fc.property(fc.string(), anyId, anyId, fc.jsonValue(), fc.jsonValue(), fc.nat(64), (host, executionId, crossingId, input, ext, cap) => {
      const ex = spanOf(mapped(execution({ host, id: executionId })).request);
      const exAgain = spanOf(mapped(JSON.stringify(execution({ host, id: executionId, language: "x", ext: { "v.x": ext } }, { disposition: "failed" })), declared(["crossing.target"], { host }), { cap }).request);
      assert.equal(ex.traceId, exAgain.traceId);
      assert.equal(ex.spanId, exAgain.spanId);
      assert.equal(ex.traceId, traceIdOf(host, executionId));
      assert.equal(ex.spanId, executionSpanIdOf(host, executionId));

      const c = spanOf(mapped(crossing({ host, id: crossingId, execution_id: executionId, input: { value: input } }), undefined, NOW).request);
      const cAgain = spanOf(mapped(crossing({ host, id: crossingId, execution_id: executionId, target: "other", start: undefined }, { outcome: "abandoned", output: undefined, time: undefined }), undefined, NOW).request);
      assert.equal(c.spanId, cAgain.spanId);
      assert.equal(c.spanId, crossingSpanIdOf(host, crossingId));
      assert.equal(c.parentSpanId, ex.spanId, "a crossing's parent is its execution's span, from its own line");
      assert.equal(c.traceId, ex.traceId, "and it sits in the same trace");
    }),
    RUNS,
  );
});

test("a well-shaped id is kept verbatim, anything else is hashed to lowercase hex of OTLP width", () => {
  fc.assert(
    fc.property(fc.string(), anyId, (host, id) => {
      const trace = traceIdOf(host, id);
      const span = crossingSpanIdOf(host, id);
      assert.match(trace, /^[0-9a-f]{32}$/);
      assert.match(span, /^[0-9a-f]{16}$/);
      assert.match(executionSpanIdOf(host, id), /^[0-9a-f]{16}$/);
      assert.equal(trace === id, /^[0-9a-f]{32}$/.test(id) && id !== "0".repeat(32));
      assert.equal(span === id, /^[0-9a-f]{16}$/.test(id) && id !== "0".repeat(16));
    }),
    { numRuns: 1000 },
  );
});

test("hashed ids of distinct (host, id) pairs are distinct, and the NUL separator keeps a host and an id from trading characters", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (h1, i1, h2, i2) => {
      fc.pre(h1 !== h2 || i1 !== i2);
      fc.pre(!h1.includes("\0") && !h2.includes("\0"));
      assert.notEqual(executionSpanIdOf(h1, i1), executionSpanIdOf(h2, i2));
      assert.notEqual(crossingSpanIdOf(h1, "x" + i1), crossingSpanIdOf(h2, "x" + i2));
      assert.notEqual(executionSpanIdOf(h1, i1), crossingSpanIdOf(h1, i1), "an execution and a crossing with one id differ");
    }),
    { numRuns: 1000 },
  );
  assert.notEqual(traceIdOf("ab", "c"), traceIdOf("a", "bc"));
});

/* ------------------------------------------------------------------ */
/* A raw line and its parsed form                                      */
/* ------------------------------------------------------------------ */

const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined });
const payload = fc.record({ value: fc.jsonValue(), truncated: fc.boolean(), redacted: fc.boolean(), bytes: fc.nat(), hash: fc.string() }, { requiredKeys: [] });
const errorObject = fc.record({ class: fc.string(), message: fc.string(), value: payload }, { requiredKeys: [] });
const ext = optional(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 4 }));
const time = fc.constantFrom("2026-09-16T10:00:00Z", "2026-09-16T10:00:00.123456789Z", "1969-12-31T23:59:59.5Z", "2026-02-30T00:00:00Z", "soon");

const executionLine = fc.record({
  kind: fc.constant("execution"),
  host: fc.string(),
  id: anyId,
  program: payload,
  language: optional(fc.string()),
  context: optional(fc.record({ session: fc.string(), traceparent: fc.oneof(fc.string(), fc.constant("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")) }, { requiredKeys: [] })),
  start: time,
  end: optional(
    fc.record({
      time,
      disposition: fc.constantFrom("completed", "failed", "terminated", "abandoned", "crashed"),
      result: optional(payload),
      outputs: optional(fc.dictionary(fc.string(), payload, { maxKeys: 3 })),
      error: optional(errorObject),
    }),
  ),
  ext,
});

const crossingLine = fc.record({
  kind: fc.constant("crossing"),
  host: fc.string(),
  id: anyId,
  execution_id: anyId,
  target: fc.string(),
  input: payload,
  seq: optional(fc.oneof(fc.nat(), fc.double())),
  start: optional(time),
  end: optional(
    fc.record(
      { time, outcome: fc.constantFrom("output", "error", "abandoned", "ok"), output: payload, error: errorObject },
      { requiredKeys: ["outcome"] },
    ),
  ),
  ext,
});

const hostLine = fc.record({
  kind: fc.constant("host"),
  host: fc.string(),
  spec_version: fc.constantFrom("1.0", "1.3", "2.0"),
  observes_crossings: fc.constantFrom("all", "some", "none", "most"),
  attested: fc.subarray(["crossing.target", "crossing.input", "crossing.output", "crossing.error", "execution.error.class", "made.up"]),
});

/* ------------------------------------------------------------------ */
/* otel-mapping.md 8.2 against a reference                             */
/* ------------------------------------------------------------------ */

/** What 8.2 says a JSON value becomes, read off the generated text. */
function reference(t: ReturnType<typeof tree.generate>["value"]): AnyValue {
  if (typeof t === "string") return { stringValue: t };
  if (typeof t === "boolean") return { boolValue: t };
  if (t !== null && !Array.isArray(t) && "number" in t) {
    const exact = int64Of(t.number);
    if (exact !== undefined) return { intValue: exact.toString() };
    const n = Number(t.number);
    if (Number.isInteger(n) && n >= -(2 ** 63) && n < 2 ** 63) return { intValue: BigInt(n).toString() };
    return { doubleValue: Number.isFinite(n) ? n : n > 0 ? "Infinity" : "-Infinity" };
  }
  return { stringValue: render(t, true) };
}

test("every JSON value a line can carry is encoded as 8.2 says, in a payload and in ext, key order and int64 bounds included", () => {
  fc.assert(
    fc.property(tree, tree, (value, extValue) => {
      const line = JSON.stringify(crossing({ ext: { "v.a": 0 } }, { output: { value: 0 } }))
        // A replacer function, so a `$` pattern in a generated key is text, not a substitution.
        .replace('"output":{"value":0}', () => `"output":{"value":${render(value)}}`)
        .replace('"v.a":0', () => `"v.a":${render(extValue)}`);
      const raw = Object.fromEntries(spanOf(mapped(line).request).attributes.map((kv) => [kv.key, kv.value]));
      assert.deepEqual(raw["mocon.crossing.output.value"], reference(value));
      assert.deepEqual(raw["mocon.ext.v.a"], reference(extValue));
    }),
    { numRuns: 500 },
  );
});

/* ------------------------------------------------------------------ */
/* Totality                                                            */
/* ------------------------------------------------------------------ */

const goldenLines = streamNames().flatMap(readStreamLines);

/** A golden line with one span of its text replaced, which reaches every branch a malformed line can. */
const mutatedLine = fc.tuple(fc.constantFrom(...goldenLines), fc.nat(), fc.nat(40), fc.oneof(fc.string(), fc.jsonValue().map((v) => JSON.stringify(v)))).map(([l, at, length, insert]) => {
  const i = at % (l.length + 1);
  return l.slice(0, i) + insert + l.slice(i + length);
});

test("mapping never throws: any text, any golden line with a span of it replaced, any generated record", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" }), mutatedLine, fc.oneof(executionLine, crossingLine, hostLine).map((r) => JSON.stringify(r))), (text) => {
      const result = mapped(text, undefined, { now: () => 0, cap: 16 });
      assert.ok(result.skipped !== undefined || spansOf(result.request).length <= 1);
    }),
    { numRuns: 1000 },
  );
});

test("a sink write never throws, and counts every line that is not a declaration or a span", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.oneof(mutatedLine, fc.oneof(executionLine, crossingLine, hostLine).map((r) => JSON.stringify(r))), { maxLength: 8 }), async (lines) => {
      const f = fakeFetch();
      const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
      const pending = sink.write(lines);
      const posted = f.calls.flatMap((c) => spansOf(c.body)).length;
      const counted = Object.values(sink.skipped).reduce((a, b) => a + b, 0);
      const declarations = lines.filter((l) => {
        try {
          const parsed = JSON.parse(l) as Rec;
          return parsed !== null && typeof parsed === "object" && parsed["kind"] === "host" && typeof parsed["host"] === "string";
        } catch {
          return false;
        }
      }).length;
      assert.equal(posted + counted + declarations, lines.length);
      assert.equal(pending === undefined, posted === 0);
      await pending;
    }),
    RUNS,
  );
});
