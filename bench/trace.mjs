/**
 * What `@mocon/trace` costs on a request path, against the floor of the OpenTelemetry SDK producing
 * the same spans with no emitter at all. The difference between the two is what this package adds;
 * the floor itself is what any OpenTelemetry instrumentation pays and is not ours to reduce.
 *
 * Each case runs several rounds and reports the median, because a single round of a microbenchmark
 * this small is dominated by garbage collection and by whichever case the JIT saw first.
 */

import { SpanKind } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { codeMode } from "../packages/trace/dist/index.js";

const drop = { export(_spans, done) { done({ code: 0 }); }, shutdown() { return Promise.resolve(); } };
const provider = new BasicTracerProvider();
// BatchSpanProcessor, not SimpleSpanProcessor. Simple retains every span it exports, about 1 KB
// each, so a loop this size measures that retention rather than anything here and eventually
// exhausts the heap. Batch is also what production runs.
provider.addSpanProcessor(new BatchSpanProcessor(drop));
const tracer = provider.getTracer("bench");

const CAPS = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation" };
const CROSSINGS = 8;
const ITERATIONS = 20000;
const ROUNDS = 3;
const program = "await callTool('person_search', { limit: 50 });\n".repeat(8);
const payload = { rows: Array.from({ length: 20 }, (_, i) => ({ name: "Person " + i, title: "Engineer" })) };
const ATTRS = {
  "gen_ai.operation.name": "execute_code",
  "code_mode.observes_crossings": "all",
  "code_mode.unmediated_egress": false,
  "code_mode.crossing_edge": "invocation",
  "code_mode.attested": [],
  "code_mode.program.hash": "sha256:" + "0".repeat(64),
};

/** The floor: the same spans, the same attribute count, straight from the SDK. */
function otelOnly() {
  const execution = tracer.startSpan("execute_code execute", { kind: SpanKind.SERVER, attributes: ATTRS });
  for (let i = 0; i < CROSSINGS; i++) {
    const crossing = tracer.startSpan("execute_tool person_search", { kind: SpanKind.CLIENT, attributes: ATTRS });
    crossing.setAttributes({ "code_mode.crossing.outcome": "output" });
    crossing.end();
  }
  execution.setAttributes({ "code_mode.execution.disposition": "completed" });
  execution.end();
}

function emitter(capture) {
  const m = codeMode({ capabilities: CAPS, capture, tracer });
  return () => m.execution.run({ program, tool: "execute" }, (execution) => {
    const bridge = execution.instrument((name, args) => payload);
    for (let i = 0; i < CROSSINGS; i++) bridge("person_search", { limit: 50 });
    return payload;
  });
}

function median(once) {
  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < 3000; i++) once();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) once();
    rounds.push(Number(process.hrtime.bigint() - t0) / ITERATIONS);
  }
  rounds.sort((a, b) => a - b);
  return rounds[Math.floor(ROUNDS / 2)];
}

const cases = [
  ["the OpenTelemetry SDK alone", otelOnly],
  ["emitter, values off (the default)", emitter(undefined)],
  ["emitter, values on, 1.2 KB payloads", emitter({ values: true })],
];

console.log(`one execution and ${CROSSINGS} crossings, ${ROUNDS} rounds of ${ITERATIONS}, spans dropped at the exporter\n`);
let floor = 0;
for (const [label, once] of cases) {
  const ns = median(once);
  if (!floor) floor = ns;
  const over = label.startsWith("the OpenTelemetry") ? "" : `   ${(ns / floor).toFixed(2)}x the floor, +${((ns - floor) / 1000 / (CROSSINGS + 1)).toFixed(2)} us/span`;
  console.log(`${label.padEnd(38)} ${(ns / 1000).toFixed(1).padStart(7)} us/execution   ${(ns / 1000 / (CROSSINGS + 1)).toFixed(2).padStart(6)} us/span${over}`);
}
