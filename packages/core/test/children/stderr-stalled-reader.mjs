// Child of sinks.test.ts: 256 executions through stderrSink while the
// parent holds the pipe without reading, against the same 256 through a
// sink that keeps its lines. The two rounds differ only in the sink, so
// the ratio the parent asserts is the price of a stalled descriptor and
// nothing the machine sets. Reports how many writes were reported lost and
// the shortest each round took, over several rounds after a warmup.
import { memorySink, mocon, stderrSink } from "../../src/index.ts";

process.stderr.write("");
let errors = 0;
const program = "x".repeat(4096);
const caps = { observes_crossings: "all" };
const stalled = mocon({ host: "h", capabilities: caps, sinks: [stderrSink()], onError: () => errors++ });
const kept = memorySink();
const control = mocon({ host: "h", capabilities: caps, sinks: [kept] });

/** Milliseconds 256 executions hold the request path. */
const round = (m) => {
  const t0 = performance.now();
  for (let i = 0; i < 256; i++) m.execution.start({ program, notice: false }).complete();
  const ms = performance.now() - t0;
  kept.lines.length = 0;
  return ms;
};

for (let i = 0; i < 2; i++) {
  round(stalled);
  round(control);
}
let stalledMs = Infinity;
let controlMs = Infinity;
for (let i = 0; i < 7; i++) {
  stalledMs = Math.min(stalledMs, round(stalled));
  controlMs = Math.min(controlMs, round(control));
}
process.stdout.write(JSON.stringify({ errors, stalledMs, controlMs }) + "\n");
