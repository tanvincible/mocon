/**
 * All three OpenTelemetry signals from the same two wrappers, against real SDKs.
 *
 * The point of each is different. Traces show the shape of one run. Metrics answer questions across
 * many runs, and must never be keyed on something the program chose. Log records say a run is in
 * flight right now, which is the one thing a span cannot do, because a span exports only when it ends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Capabilities, codeMode } from "../src/index.js";

const CAPS: Capabilities = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target"] };

function harness(capabilities: Capabilities = CAPS) {
  // The API keeps the first global provider registered and ignores later ones, so each harness
  // clears them first. Real applications register once, which is why this is a test concern only.
  metrics.disable();
  logs.disable();
  const spans = new InMemorySpanExporter();
  const tp = new BasicTracerProvider();
  tp.addSpanProcessor(new SimpleSpanProcessor(spans));

  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 600000,
  });
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

  const records = new InMemoryLogRecordExporter();
  const lp = new LoggerProvider();
  lp.addLogRecordProcessor(new SimpleLogRecordProcessor(records));
  logs.setGlobalLoggerProvider(lp);

  return {
    m: codeMode({ capabilities, tracer: tp.getTracer("t") }),
    spans: () => spans.getFinishedSpans(),
    records: () => records.getFinishedLogRecords(),
    async points() {
      const collected = await reader.collect();
      return collected.resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    },
  };
}

test("one integration produces all three signals", async () => {
  const h = harness();
  h.m.execution.run({ program: "p", tool: "execute", id: "run-1" }, (execution) => {
    execution.instrument((name: string) => ({ rows: 2 }))("inventory_search");
  });

  assert.deepEqual(h.spans().map((s) => s.name), ["execute_tool inventory_search", "execute_code execute"]);
  const names = (await h.points()).map((m) => m.descriptor.name).sort();
  assert.deepEqual(names, ["code_mode.crossing.duration", "code_mode.execution.duration"]);
  assert.deepEqual(h.records().map((r) => r.attributes["event.name"]), ["code_mode.execution.started", "code_mode.execution.ended"]);
});

test("a log record says a run is in flight, which is the one thing a span cannot", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", id: "run-2" });
  // Nothing has ended, so the trace is empty and the run is invisible there.
  assert.equal(h.spans().length, 0);
  const started = h.records();
  assert.equal(started.length, 1);
  assert.equal(started[0]?.attributes["event.name"], "code_mode.execution.started");
  assert.equal(started[0]?.attributes["code_mode.execution.id"], "run-2");
  ex.complete();
  assert.equal(h.spans().length, 1, "and the span turns up once it finishes");
});

test("log records carry the trace and span id, so a query joins them to the spans", () => {
  const h = harness();
  h.m.execution.start({ program: "p" }).complete();
  const span = h.spans()[0];
  for (const r of h.records()) {
    assert.equal(r.attributes["trace_id"], span?.spanContext().traceId);
    assert.equal(r.attributes["span_id"], span?.spanContext().spanId);
  }
});

test("a metric is never keyed on a target the host did not observe", async () => {
  // Attested: the target is a fact, so it is a legitimate dimension.
  const observed = harness();
  observed.m.execution.run({ program: "p" }, (e) => e.instrument((n: string) => 1)("inventory_search"));
  const attested = (await observed.points()).find((m) => m.descriptor.name === "code_mode.crossing.duration");
  assert.equal(attested?.dataPoints[0]?.attributes["gen_ai.tool.name"], "inventory_search");

  // Unattested: the same name is the program's word, so it is dropped rather than counted as fact.
  const claimed = harness({ observes_crossings: "some", unmediated_egress: true, crossing_edge: "invocation" });
  claimed.m.execution.run({ program: "p" }, (e) => e.instrument((n: string) => 1)("inventory_search"));
  const unattested = (await claimed.points()).find((m) => m.descriptor.name === "code_mode.crossing.duration");
  assert.equal("gen_ai.tool.name" in (unattested?.dataPoints[0]?.attributes ?? {}), false);
  assert.equal("code_mode.crossing.outcome" in (unattested?.dataPoints[0]?.attributes ?? {}), false);
});

test("the execution metric is keyed on the disposition, which is a fact on every host", async () => {
  const h = harness({ observes_crossings: "none", unmediated_egress: true });
  h.m.execution.start({ program: "p" }).end({ disposition: "terminated", errorType: "timeout" });
  const m = (await h.points()).find((m) => m.descriptor.name === "code_mode.execution.duration");
  assert.equal(m?.dataPoints[0]?.attributes["code_mode.execution.disposition"], "terminated");
  assert.equal(m?.dataPoints[0]?.attributes["error.type"], "timeout");
  assert.equal(m?.descriptor.unit, "s");
});

test("an abandoned call records no duration, because its duration is made up", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "orders.ship" });
  ex.complete();
  const m = (await h.points()).find((m) => m.descriptor.name === "code_mode.crossing.duration");
  assert.equal(m?.dataPoints.reduce((n, p) => n + (p.value as { count: number }).count, 0) ?? 0, 0);
});

test("a signal can be switched off", async () => {
  const spans = new InMemorySpanExporter();
  const tp = new BasicTracerProvider();
  tp.addSpanProcessor(new SimpleSpanProcessor(spans));
  const records = new InMemoryLogRecordExporter();
  const lp = new LoggerProvider();
  lp.addLogRecordProcessor(new SimpleLogRecordProcessor(records));
  logs.setGlobalLoggerProvider(lp);
  metrics.disable();
  logs.disable();
  const m = codeMode({ capabilities: CAPS, tracer: tp.getTracer("t"), signals: { logs: false, metrics: false } });
  m.execution.start({ program: "p" }).complete();
  assert.equal(spans.getFinishedSpans().length, 1, "traces still come out");
  assert.equal(records.getFinishedLogRecords().length, 0);
});
