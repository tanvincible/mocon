/**
 * Drives the TypeScript emitter (packages/typescript/src) through parity/scenario.json and prints a
 * canonical JSON dump of every span, plus the metric points, on stdout.
 *
 * Read-only against packages/typescript: it imports the source and nothing else.
 *
 *   node --import tsx packages/python/parity/emit.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { metrics } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { codeMode } from "../../typescript/src/index.js";

const scenario = JSON.parse(readFileSync(fileURLToPath(new URL("./scenario.json", import.meta.url)), "utf8"));

/** The two scenario directives, expanded before anything sees the value. */
function expand(v) {
  if (Array.isArray(v)) return v.map(expand);
  if (v !== null && typeof v === "object") {
    if (typeof v["$repeat"] === "object" && v["$repeat"] !== null) return v["$repeat"].unit.repeat(v["$repeat"].times);
    if (typeof v["$number"] === "string") return { nan: NaN, inf: Infinity, "-inf": -Infinity }[v["$number"]];
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = expand(x);
    return out;
  }
  return v;
}

const has = (o, k) => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
/** Only pass what the scenario names: an absent key must stay `undefined`, not become `null`. */
const pick = (o, pairs) => {
  const out = {};
  for (const [to, from] of pairs) if (has(o, from)) out[to] = expand(o[from]);
  return out;
};
const hr = (ns) => [Math.floor(ns / 1e9), ns % 1e9];

function canonValue(v) {
  if (Array.isArray(v)) return ["array", v.map(canonValue)];
  switch (typeof v) {
    case "string":
      return ["str", v];
    case "boolean":
      return ["bool", v];
    case "number":
      // What the OTLP transformer keys on: an integral number travels as intValue, anything else as
      // doubleValue. So the distinction is real on the wire and is recorded here.
      return [Number.isInteger(v) ? "int" : "double", String(v)];
    default:
      return ["other", String(v)];
  }
}

function canonSpan(span, index, base) {
  const ids = new Map(index);
  const ns = (t) => t[0] * 1e9 + t[1];
  const attributes = {};
  for (const key of Object.keys(span.attributes).sort()) attributes[key] = canonValue(span.attributes[key]);
  const parent = span.parentSpanContext?.spanId ?? span.parentSpanId;
  return {
    name: span.name,
    kind: ["INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"][span.kind],
    status: { code: ["UNSET", "OK", "ERROR"][span.status.code], description: span.status.message ?? null },
    parent: parent === undefined ? "root" : (ids.get(parent) ?? "root"),
    start_offset_ns: ns(span.startTime) - base,
    end_offset_ns: ns(span.endTime) - base,
    events: span.events.map((e) => e.name),
    attributes,
  };
}

const out = { cases: [] };

for (const c of scenario.cases) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const metricExporter = new InMemoryMetricExporter(0);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 2 ** 30 });
  const meterProvider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(meterProvider);

  const cap = c.capture;
  const m = codeMode({
    capabilities: c.capabilities,
    tracer: provider.getTracer("parity"),
    capture: { values: cap.values, cap: cap.cap, programCap: cap.program_cap, measure: cap.measure },
  });

  const e = c.execution;
  const execution = m.execution.start({
    ...pick(e, [
      ["program", "program"],
      ["language", "language"],
      ["kind", "kind"],
      ["tool", "tool"],
      ["toolCallId", "tool_call_id"],
      ["conversationId", "conversation_id"],
      ["sessionId", "session_id"],
      ["id", "execution_id"],
      ["attributes", "attributes"],
    ]),
    startTime: hr(e.start_ns),
  });

  for (const x of c.crossings) {
    const crossing = execution.crossing.start({
      ...pick(x, [
        ["target", "target"],
        ["input", "input"],
        ["id", "call_id"],
        ["seq", "seq"],
        ["toolType", "tool_type"],
        ["kind", "kind"],
        ["name", "name"],
        ["dispatched", "dispatched"],
        ["attributes", "attributes"],
      ]),
      ...(has(x, "mcp_method") ? { mcp: { method: x.mcp_method, session: x.mcp_session, resourceUri: x.mcp_resource_uri } } : {}),
      startTime: hr(x.start_ns),
    });
    if (has(x, "settle")) {
      const s = x.settle;
      crossing.end({
        ...pick(s, [
          ["outcome", "outcome"],
          ["output", "output"],
          ["errorType", "error_type"],
          ["message", "message"],
          ["errorBody", "error_body"],
          ["dispatched", "dispatched"],
          ["attributes", "attributes"],
        ]),
        ...(has(s, "end_ns") ? { endTime: hr(s.end_ns) } : {}),
      });
    }
  }

  const end = c.end;
  execution.end({
    ...pick(end, [
      ["disposition", "disposition"],
      ["errorType", "error_type"],
      ["message", "message"],
      ["result", "result"],
      ["outputs", "outputs"],
      ["errorBody", "error_body"],
      ["attributes", "attributes"],
    ]),
    endTime: hr(end.end_ns),
  });

  const spans = exporter.getFinishedSpans();
  const index = spans.map((s, i) => [s.spanContext().spanId, i]);
  const base = e.start_ns;
  await reader.forceFlush();
  const points = [];
  for (const rm of metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        for (const p of metric.dataPoints) {
          const attributes = {};
          for (const key of Object.keys(p.attributes).sort()) attributes[key] = canonValue(p.attributes[key]);
          points.push({ instrument: metric.descriptor.name, unit: metric.descriptor.unit, attributes, count: p.value.count, sum: Number(p.value.sum.toFixed(6)) });
        }
      }
    }
  }
  points.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  await meterProvider.shutdown();

  out.cases.push({ name: c.name, spans: spans.map((s) => canonSpan(s, index, base)), metrics: points });
}

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
