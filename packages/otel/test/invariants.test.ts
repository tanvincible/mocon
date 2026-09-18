/**
 * One test per invariant in the README's Invariants section, named after
 * it. Each asserts the property over the spans the mapping and the sink
 * actually produce, for every golden stream and for lines built to press
 * on it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { otlpSink, type ExportTraceServiceRequest } from "../src/index.js";
import { attrs, crossing, execution, fakeFetch, mapped, ok, readStreamLines, spanOf, spansOf, streamNames, type Response } from "./helpers.js";

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ENDED = new Set(["completed", "failed", "terminated", "abandoned", "output", "error"]);

test("one span per complete line", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  for (const name of streamNames()) {
    const lines = readStreamLines(name);
    const complete = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => (r["kind"] === "execution" || r["kind"] === "crossing") && r["end"] !== undefined).length;
    const before = f.calls.length;
    await sink.write(lines);
    const posted = f.calls.slice(before).flatMap((c) => spansOf(c.body));
    assert.equal(posted.length, complete, name);
  }
  assert.equal(spansOf(mapped(readStreamLines("sync-bridge")[2] as string).request).length, 1);
});

test("span ids are lowercase hex of OTLP width", async () => {
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const built = [execution(), execution({ id: "run-42" }), execution({ context: { traceparent: tp } }), crossing(), crossing({ id: "call-7", execution_id: "Run-42" })];
  const spans = built.map((line) => spanOf(mapped(line).request));
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  for (const name of streamNames()) await sink.write(readStreamLines(name));
  for (const call of f.calls) spans.push(...spansOf(call.body));
  assert.ok(spans.length > built.length, "the golden streams produced spans");
  for (const span of spans) {
    assert.match(span.traceId, TRACE_ID);
    assert.match(span.spanId, SPAN_ID);
    if (span.parentSpanId !== undefined) assert.match(span.parentSpanId, SPAN_ID);
    for (const link of span.links ?? []) {
      assert.match(link.traceId, TRACE_ID);
      assert.match(link.spanId, SPAN_ID);
    }
  }
});

test("a span carries its own line's end: never a disposition or outcome for a record that has not ended", async () => {
  const unresolved = readStreamLines("unresolved");
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  assert.equal(sink.write(unresolved), undefined);
  await sink.flush();
  assert.equal(f.calls.length, 0, "no span, and so no disposition, for an execution that never ended");
  for (const disposition of ["completed", "failed", "terminated", "abandoned"]) {
    assert.equal(attrs(spanOf(mapped(execution({}, { disposition })).request))["mocon.execution.disposition"], disposition);
  }
  for (const outcome of ["output", "error", "abandoned"]) {
    assert.equal(attrs(spanOf(mapped(crossing({}, { outcome, output: outcome === "output" ? { value: 1 } : undefined, error: outcome === "error" ? { class: "x" } : undefined })).request))["mocon.crossing.outcome"], outcome);
  }
  for (const name of streamNames()) await sink.write(readStreamLines(name));
  for (const call of f.calls) {
    for (const span of spansOf(call.body)) {
      const carried = attrs(span)[span.kind === 1 ? "mocon.execution.disposition" : "mocon.crossing.outcome"];
      assert.ok(typeof carried === "string" && ENDED.has(carried), `${span.name} carries ${JSON.stringify(carried)}`);
    }
  }
});

test("the sink holds declarations for at most 256 host strings", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  const lines: string[] = [];
  for (let i = 0; i < 1000; i++) lines.push(JSON.stringify({ kind: "host", host: "h" + i, spec_version: "1.0", observes_crossings: "all" }));
  assert.doesNotThrow(() => sink.write(lines));
  await sink.write([JSON.stringify(execution({ host: "h999" }))]);
  assert.ok(!spanOf(f.calls[0]?.body as ExportTraceServiceRequest).attributes.some((a) => a.key.startsWith("mocon.host.")));
});

test("the sink holds at most 64 POSTs in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let concurrent = 0;
  let peak = 0;
  const f = fakeFetch(async (): Promise<Response> => {
    peak = Math.max(peak, ++concurrent);
    await gate;
    concurrent--;
    return ok();
  });
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  const line = JSON.stringify(execution());
  const writes = Array.from({ length: 100 }, () => Promise.resolve(sink.write([line])).catch(() => "dropped"));
  release();
  const outcomes = await Promise.all(writes);
  assert.equal(peak, 64);
  assert.equal(outcomes.filter((o) => o === "dropped").length, 36);
});
