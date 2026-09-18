// Child of sinks.test.ts: one 4 MiB write through stderrSink into a pipe
// nobody reads for a second. Reports what the write did, how long it took
// and how much of that was CPU. A write that waits for room spends its
// time asleep, so its CPU is a fraction of its wall time; one that spun on
// EAGAIN would spend all of it running. The ratio is the assertion, so no
// wall-clock figure of the machine's own is asserted anywhere.
import { stderrSink } from "../../src/index.ts";

process.stderr.write("");
const line = "x".repeat(4 << 20);

// Warm the UTF-8 conversion the write has to do either way.
Buffer.from(line + "\n", "utf8");

const t0 = process.hrtime.bigint();
const c0 = process.cpuUsage();
let outcome = "written";
try {
  stderrSink().write([line]);
} catch (e) {
  outcome = e.code === "EAGAIN" ? "dropped" : "error:" + String(e);
}
const cpu = process.cpuUsage(c0);
const wallUs = Number(process.hrtime.bigint() - t0) / 1000;

process.stdout.write(JSON.stringify({ outcome, wallUs, cpuUs: cpu.user + cpu.system }));
