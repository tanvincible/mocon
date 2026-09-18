/**
 * Conformance against spec/conformance. The three OTLP fixtures, each
 * compared to the converted stream after both sides are canonicalized the
 * way otlp/README.md section 3 says, converted line by line through
 * the mapping and through `otlpSink`. Every golden stream through the sink:
 * one span per complete line, ids that tie each crossing to its execution,
 * and no span for anything unresolved. Every invalid line, with the
 * outcome otel-mapping.md 3 gives it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { otlpSink, type ExportTraceServiceRequest, type SkipReason } from "../src/index.js";
import { attrs, canonicalize, convertStream, EMPTY, fakeFetch, invalidLines, mapped, mergeRequests, readOtlpFixture, readStreamLines, spanOf, spansOf, streamNames, type Rec } from "./helpers.js";

/** The constant receipt time no-timing-blob-ref.json was built with, so its two synthesized spans compare exactly. */
const RECEIPT = Date.parse("2026-09-16T16:05:00.000Z");

async function throughSink(lines: readonly string[]): Promise<{ request: ExportTraceServiceRequest; posts: number; sink: ReturnType<typeof otlpSink> }> {
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  for (const line of lines) await sink.write([line]);
  await sink.flush();
  return { request: mergeRequests(f.calls.map((c) => c.body)), posts: f.calls.length, sink };
}

test("sync-bridge: the converted stream equals the fixture", async () => {
  const lines = readStreamLines("sync-bridge");
  const expected = canonicalize(readOtlpFixture("sync-bridge"));
  const viaToOtlp = convertStream(lines);
  assert.deepEqual(canonicalize(viaToOtlp.request), expected);
  assert.deepEqual(viaToOtlp.skipped, ["notice"], "the start notice is the only line without a span or a host");
  const viaSink = await throughSink(lines);
  assert.deepEqual(canonicalize(viaSink.request), expected);
  assert.equal(viaSink.posts, 3, "one POST per line that produced a span; none for the host line or the notice");
});

test("unresolved: zero spans, ever", async () => {
  const lines = readStreamLines("unresolved");
  const expected = canonicalize(readOtlpFixture("unresolved"));
  const viaToOtlp = convertStream(lines);
  assert.deepEqual(canonicalize(viaToOtlp.request), expected);
  assert.deepEqual(viaToOtlp.request, EMPTY);
  const viaSink = await throughSink(lines);
  assert.deepEqual(canonicalize(viaSink.request), expected);
  assert.equal(viaSink.posts, 0);
});

test("no-timing-blob-ref: synthesized zero-duration crossings, exact under the fixture's receipt time, and under the sink's own clock except for those times", async () => {
  const lines = readStreamLines("no-timing-blob-ref");
  const expected = canonicalize(readOtlpFixture("no-timing-blob-ref"));
  assert.deepEqual(canonicalize(convertStream(lines, { now: () => RECEIPT }).request), expected);

  const before = Date.now();
  const viaSink = await throughSink(lines);
  const after = Date.now();
  const crossings = spansOf(viaSink.request).filter((s) => s.kind === 3);
  assert.equal(crossings.length, 2);
  for (const span of crossings) {
    assert.equal(span.startTimeUnixNano, span.endTimeUnixNano);
    const ms = Number(BigInt(span.startTimeUnixNano) / 1000000n);
    assert.ok(ms >= before && ms <= after, "placed at the sink's receipt time");
    assert.equal(attrs(span)["mocon.crossing.timing"], "none");
  }
  const fixed = String(RECEIPT) + "000000";
  for (const span of crossings) span.startTimeUnixNano = span.endTimeUnixNano = fixed;
  assert.deepEqual(canonicalize(viaSink.request), expected, "README section 3 item 4: every other field compares exactly");
});

test("a fixture stream converts the same whatever order its lines arrive in, except for host attributes a late declaration cannot add", () => {
  const lines = readStreamLines("sync-bridge");
  const expected = canonicalize(convertStream(lines).request);
  const reversedButDeclared = [lines[0] as string, ...lines.slice(1).reverse()];
  assert.deepEqual(canonicalize(convertStream(reversedButDeclared).request), expected);

  const declarationLast = [...lines.slice(1), lines[0] as string];
  const late = convertStream(declarationLast).request;
  const execution = spansOf(late).find((s) => s.kind === 1);
  assert.ok(execution !== undefined);
  assert.ok(!execution.attributes.some((a) => a.key.startsWith("mocon.host.")), "no mocon.host.* before the declaration");
  assert.ok(execution.attributes.some((a) => a.key === "mocon.host"), "mocon.host itself is always present");
  const crossing = spanOf(late);
  assert.ok(crossing.attributes.some((a) => a.key === "mocon.provenance.crossing.target"), "attested reads as [] before the declaration");
});

test("every golden stream through the sink: one span per complete line, crossings tied to their execution, nothing for a notice", async () => {
  const names = streamNames();
  assert.equal(names.length, 23);
  for (const name of names) {
    const lines = readStreamLines(name);
    const records = lines.map((l) => JSON.parse(l) as Rec);
    const complete = records.filter((r) => (r["kind"] === "execution" || r["kind"] === "crossing") && "end" in r);
    const notices = records.filter((r) => (r["kind"] === "execution" || r["kind"] === "crossing") && !("end" in r));
    const { request, sink } = await throughSink(lines);
    const spans = spansOf(request);
    assert.equal(spans.length, complete.length, `${name}: one span per complete line`);
    assert.equal(sink.skipped.notice, notices.length, `${name}: every notice counted`);
    assert.equal(sink.skipped.unknown_kind, records.filter((r) => !["host", "execution", "crossing"].includes(r["kind"] as string)).length, name);
    for (const reason of ["malformed", "bad_enum", "bad_timestamp"] as const) assert.equal(sink.skipped[reason], 0, `${name}: ${reason}`);

    const executions = new Map(spans.filter((s) => s.kind === 1).map((s) => [attrs(s)["mocon.execution.id"] as string, s]));
    for (const span of spans.filter((s) => s.kind === 3)) {
      const parent = executions.get(attrs(span)["mocon.execution.id"] as string);
      if (parent === undefined) continue;
      assert.equal(span.parentSpanId, parent.spanId, `${name}: a crossing's parent is its execution's span`);
      const link = parent.links?.[0];
      assert.ok(span.traceId === parent.traceId || span.traceId === link?.traceId, `${name}: a crossing sits in its execution's trace or the one its link leads to`);
    }
    const spanned = spans.filter((s) => s.kind === 1).map((s) => attrs(s)["mocon.execution.id"] as string);
    const ended = complete.filter((r) => r["kind"] === "execution").map((r) => r["id"] as string);
    assert.deepEqual(spanned.sort(), ended.sort(), `${name}: an execution span only for a complete execution line, a conflicting re-send included`);
  }
});

test("every invalid line: skipped and counted by otel-mapping.md 3's reason, or mapped when the mapping does not read the broken field", () => {
  const expected: Record<string, SkipReason | "host" | "span"> = {
    "crossing-without-execution-id": "malformed",
    "disposition-outside-closed-set": "bad_enum",
    "end-without-disposition": "malformed",
    "missing-host": "malformed",
    // A notice: dropped before any time is read.
    "timestamp-without-z": "notice",
    // A declaration: the unknown closed-set value costs its one attribute.
    "observes-crossings-unknown-value": "host",
    // Copied verbatim and never recomputed (8.1).
    "hash-wrong-length": "span",
    // The error field is read only under outcome error (7.2).
    "outcome-output-with-error-field": "span",
    // The mapping writes what the Payload has and does not validate its shape.
    "payload-no-value-no-flag": "span",
  };
  const lines = invalidLines();
  assert.deepEqual(lines.map(([name]) => name).sort(), Object.keys(expected).sort());
  for (const [name, line] of lines) {
    const result = mapped(line);
    const outcome = result.skipped ?? (result.request.resourceSpans.length === 0 ? "host" : "span");
    assert.equal(outcome, expected[name], name);
  }

  const find = (name: string): string => lines.find(([n]) => n === name)?.[1] as string;
  const declaration = JSON.parse(find("observes-crossings-unknown-value"));
  const execution = attrs(spanOf(mapped(readStreamLines("sync-bridge")[4] as string, { ...declaration, host: "example/mcp" }).request));
  assert.equal(execution["mocon.host.spec_version"], "1.0");
  assert.ok(!("mocon.host.observes_crossings" in execution));
  const hash = attrs(spanOf(mapped(find("hash-wrong-length")).request));
  assert.equal(hash["mocon.crossing.input.hash"], "sha256:deadbeef");
  const both = attrs(spanOf(mapped(find("outcome-output-with-error-field")).request));
  assert.ok(!Object.keys(both).some((k) => k.startsWith("mocon.crossing.error")));
  const bare = attrs(spanOf(mapped(find("payload-no-value-no-flag")).request));
  assert.ok(!("mocon.crossing.input.value" in bare) && !("mocon.provenance.crossing.input.value" in bare));
});

test("every invalid line through one sink write: the counters by reason, and one POST with the lines that map", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  await sink.write(invalidLines().map(([, line]) => line));
  assert.deepEqual(sink.skipped, { notice: 1, malformed: 3, unknown_kind: 0, bad_enum: 1, bad_timestamp: 0 });
  assert.equal(f.calls.length, 1);
  assert.equal(spansOf(f.calls[0]?.body as ExportTraceServiceRequest).length, 3);
});
