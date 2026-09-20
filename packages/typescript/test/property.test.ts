/**
 * Section 10 as a PROPERTY over the whole public surface, rather than one function at a time.
 *
 * Every earlier hostile test picked a function, attacked it, and was fixed at that one call site.
 * That is how one time coercion came to sit on five entry points at once, and how a fix landed on
 * the execution span and silently skipped the crossing. This enumerates instead: every place a host
 * can hand the emitter a program-authored value, crossed with every shape of hostile value,
 * asserting the two things section 10 actually promises.
 *
 *   1. Nothing raises into the caller. Telemetry costs the value, never the request.
 *   2. A span is still exported. A contained fault must not become a silently missing span.
 *
 * And one thing no test compared before: the same duration is published twice, as the span's own
 * start and end and as a histogram value, from two conversions of one caller input. They must agree.
 *
 * A new entry point belongs in `ENTRY_POINTS`. A new way to be hostile belongs in `VALUES`.
 *
 * Not in scope: the emitter's own arguments. `program` must be a string and `instrument` must be
 * given a function, and both are refused with a `TypeError` at the boundary. Those come from the
 * host's own code, not from the program, and refusing them early is how a host finds its own bug.
 * Section 10 is about the VALUES flowing through, which the host did not write and cannot vet.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Capabilities, type CodeMode, codeMode } from "../src/index.js";

const CAPS: Capabilities = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation" };

/** Each returns a value that is hostile in a different way. Fresh per probe: several are stateful. */
const VALUES: Array<[string, () => unknown]> = [
  ["a throwing toJSON", () => ({ toJSON() { throw new Error("toJSON"); } })],
  ["a throwing getter", () => Object.defineProperty({}, "x", { get() { throw new Error("get"); }, enumerable: true })],
  ["a Proxy whose ownKeys throws", () => new Proxy({}, { ownKeys() { throw new Error("ownKeys"); } })],
  ["a Proxy whose get throws", () => new Proxy({ a: 1 }, { get() { throw new Error("get"); } })],
  ["a cycle", () => { const c: Record<string, unknown> = {}; c["self"] = c; return c; }],
  ["a cyclic error", () => { const e = new Error("e") as Error & Record<string, unknown>; e["self"] = e; return e; }],
  ["an error from another realm", () => vm.runInNewContext("new Error('foreign')") as unknown],
  ["a throwing toString", () => ({ toString() { throw new Error("toString"); } })],
  ["a throwing valueOf", () => ({ valueOf() { throw new Error("valueOf"); } })],
  ["a bigint, which JSON refuses", () => ({ n: 1n })],
  ["NaN", () => NaN],
  ["a string far past every cap", () => "x".repeat(5_000_000)],
];

/** Times a host can supply that are not readable as one. */
const TIMES: Array<[string, unknown]> = [
  ["a Date from another realm", vm.runInNewContext("new Date(Date.now() - 3000)")],
  ["NaN", NaN],
  ["a throwing valueOf", { valueOf() { throw new Error("valueOf"); } }],
  ["an [NaN, 0] pair", [NaN, 0]],
  ["a pair of the wrong length", [5]],
  ["null", null],
  ["past the Date range", 1e300],
];

function fresh(): { m: CodeMode; spans: () => ReadableSpan[] } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  return {
    m: codeMode({ capabilities: CAPS, capture: { values: true }, tracer: provider.getTracer("t") }),
    spans: () => exporter.getFinishedSpans() as ReadableSpan[],
  };
}

/** A bridge that throws an error CARRYING the value, which is how one reaches the error path. */
function raiseThrough(ex: ReturnType<CodeMode["execution"]["start"]>, payload: unknown): void {
  const call = ex.instrument(() => {
    const e = new Error("bridge failed") as Error & Record<string, unknown>;
    e["payload"] = payload;
    throw e;
  }, { target: "t" });
  try {
    call();
  } catch {
    // The bridge's own error, rethrown to the caller as it must be.
  }
}

type Probe = [string, (m: CodeMode) => void];

const ENTRY_POINTS: Probe[] = [];
for (const [name, make] of VALUES) {
  ENTRY_POINTS.push(
    [`execution result <- ${name}`, (m) => m.execution.start({ program: "p" }).complete({ result: make() })],
    [`execution fail cause <- ${name}`, (m) => m.execution.start({ program: "p" }).fail(make())],
    [`output channel <- ${name}`, (m) => m.execution.start({ program: "p" }).complete({ outputs: { stdout: make() } })],
    [`crossing input <- ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); ex.crossing.start({ target: "t", input: make() }).output(1); ex.complete(); }],
    [`crossing error cause <- ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); ex.crossing.start({ target: "t" }).error(make()); ex.complete(); }],
    [`crossing output <- ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); ex.crossing.start({ target: "t" }).output(make()); ex.complete(); }],
    [`bridge argument <- ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); ex.instrument((_x: unknown) => 1)(make()); ex.complete(); }],
    [`bridge raises carrying ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); raiseThrough(ex, make()); ex.complete(); }],
    [`host attribute <- ${name}`, (m) => m.execution.start({ program: "p", attributes: { own: make() } as never }).complete()],
  );
}
for (const [name, time] of TIMES) {
  ENTRY_POINTS.push(
    [`execution startTime <- ${name}`, (m) => m.execution.start({ program: "p", startTime: time as never }).complete()],
    [`execution endTime <- ${name}`, (m) => m.execution.start({ program: "p" }).complete({ endTime: time as never })],
    [`crossing startTime <- ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); ex.crossing.start({ target: "t", startTime: time as never }).output(1); ex.complete(); }],
    [`crossing endTime <- ${name}`, (m) => { const ex = m.execution.start({ program: "p" }); ex.crossing.start({ target: "t" }).output(1, { endTime: time as never }); ex.complete(); }],
  );
}
ENTRY_POINTS.push(
  ["an instrument target derive that throws", (m) => { const ex = m.execution.start({ program: "p" }); ex.instrument((_x: unknown) => 1, { target: () => { throw new Error("derive"); } })(1); ex.complete(); }],
  ["an instrument input derive that throws", (m) => { const ex = m.execution.start({ program: "p" }); ex.instrument((_x: unknown) => 1, { target: "t", input: () => { throw new Error("derive"); } })(1); ex.complete(); }],
  ["an instrument end hook that throws", (m) => { const ex = m.execution.start({ program: "p" }); ex.instrument((_x: unknown) => 1, { target: "t", end: () => { throw new Error("hook"); } })(1); ex.complete(); }],
  ["an end hook answering a shape the span refuses", (m) => { const ex = m.execution.start({ program: "p" }); ex.instrument((_x: unknown) => 1, { target: "t", end: () => ({ outcome: "exploded" }) as never })(1); ex.complete(); }],
);

for (const [where, run] of ENTRY_POINTS) {
  test(`section 10 holds for ${where}`, () => {
    const h = fresh();
    run(h.m);
    assert.ok(h.spans().length > 0, "contained the fault but lost the span");
  });
}

test("the matrix is not empty, so the probes above are not vacuous", () => {
  assert.ok(ENTRY_POINTS.length >= 100, `only ${ENTRY_POINTS.length} probes`);
});

/**
 * The span and its histogram read one instant. They were converted separately, so a time only one
 * of them could read made them disagree by the whole interval, on the crossing, for a whole round
 * after the execution was fixed.
 */
for (const [name, time] of TIMES) {
  for (const kind of ["execution", "crossing"] as const) {
    test(`a ${kind} span and its histogram agree on ${name}`, async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 600000 })] });
      metrics.disable();
      metrics.setGlobalMeterProvider(meterProvider);

      const m = codeMode({ capabilities: CAPS, tracer: provider.getTracer("t") });
      const ex = m.execution.start({ program: "p" });
      if (kind === "crossing") {
        ex.crossing.start({ target: "t" }).output(1, { endTime: time as never });
        ex.complete();
      } else {
        ex.complete({ endTime: time as never });
      }

      await meterProvider.forceFlush();
      const wanted = kind === "execution" ? "code_mode.execution.duration" : "code_mode.crossing.duration";
      const points = metricExporter
        .getMetrics()
        .flatMap((r) => r.scopeMetrics)
        .flatMap((s) => s.metrics)
        .filter((d) => d.descriptor.name === wanted)
        .flatMap((d) => d.dataPoints);
      const span = exporter.getFinishedSpans().find((s) => s.name.startsWith(kind === "execution" ? "execute_code" : "execute_tool")) as ReadableSpan;
      const spanSeconds = span.duration[0] + span.duration[1] / 1e9;
      const histogram = (points[0]?.value as { sum: number } | undefined)?.sum;

      assert.ok(Number.isFinite(spanSeconds), `span duration was ${spanSeconds}`);
      assert.ok(histogram !== undefined && Number.isFinite(histogram), `histogram was ${histogram}`);
      assert.ok(Math.abs(spanSeconds - histogram) < 1e-3, `span ${spanSeconds}s against histogram ${histogram}s`);
      await meterProvider.shutdown();
      metrics.disable();
    });
  }
}
