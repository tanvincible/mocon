// Child of sinks.test.ts, run with `node --import tsx`. One console.error,
// as any logging does, makes Node open the piped fd 2 as a libuv pipe
// handle, which sets O_NONBLOCK. It fills the pipe, which the parent never
// reads, and then writes one batch per timer tick, the way a host writes a
// few lines per request and returns to its event loop. A write that gives
// up throws, which the loop absorbs the way an instance's onError would.
//
// The same tick loop then runs against a sink that keeps its lines, which
// is the control: the two phases differ only in the sink, so the CPU the
// child reports for each is the tick loop plus that sink's work. A sink
// that retried a full descriptor instead of giving the batch up would burn
// the tick it is on, and the stalled phase would cost many times the
// control. Both phases are measured over the same number of ticks.
import { memorySink, stderrSink } from "../../src/index.ts";

console.error("probe started");
const TICKS = 600;
const WARMUP = 100;
const line = JSON.stringify({ kind: "host", host: "probe", pad: "x".repeat(1024) });

const stalled = stderrSink();
const control = memorySink();

const write = (sink) => {
  try {
    sink.write([line]);
    return true;
  } catch {
    return false;
  }
};

// Fill the pipe: the first write that gives up marks the descriptor stalled.
while (write(stalled));

/** How long, and how much CPU, this process spends writing one batch per tick, `TICKS` times after `WARMUP` of them. */
function phase(sink, done) {
  let ticks = 0;
  let c0 = process.cpuUsage();
  let t0 = process.hrtime.bigint();
  const tick = () => {
    write(sink);
    control.lines.length = 0;
    ticks++;
    if (ticks === WARMUP) {
      c0 = process.cpuUsage();
      t0 = process.hrtime.bigint();
    }
    if (ticks === WARMUP + TICKS) {
      const cpu = process.cpuUsage(c0);
      done({ us: cpu.user + cpu.system, wallUs: Number(process.hrtime.bigint() - t0) / 1000 });
      return;
    }
    setTimeout(tick, 1);
  };
  tick();
}

phase(stalled, (stalledPhase) => {
  phase(control, (controlPhase) => {
    process.stdout.write(JSON.stringify({ ticks: TICKS, stalled: stalledPhase, control: controlPhase }) + "\n");
  });
});
