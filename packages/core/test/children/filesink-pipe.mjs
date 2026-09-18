// Child of sinks.test.ts, run with `node --import tsx`. Points fileSink at
// this process's own stderr, a pipe the parent holds without reading,
// after one console.error has made Node set O_NONBLOCK on it. Runs the
// same 256 executions through a sink that keeps its lines as the control,
// so the parent asserts a ratio and not a wall-clock figure.
import { fileSink, memorySink, mocon } from "../../src/index.ts";

console.error("probe started");
let errors = 0;
const program = "x".repeat(4096);
const caps = { observes_crossings: "all" };
const stalled = mocon({ host: "h", capabilities: caps, sinks: [fileSink("/dev/stderr")], onError: () => errors++ });
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
