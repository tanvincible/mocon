/**
 * Sinks never reach the host's code path: a throw or a rejection goes to
 * `onError` with the failing sink and phase named, other sinks still get
 * the lines, nothing is awaited on the request path, and a stalled
 * stderr consumer costs lines rather than the host's CPU.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs, { chmodSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { fold } from "../src/fold.js";
import { fileSink, mocon, memorySink, stderrSink, type Sink, type SinkPhase } from "../src/index.js";
import { assertValidStream, interleaved, sleep } from "./helpers.js";

const caps = { observes_crossings: "all" as const };
/** How long stderrSink waits on a full pipe before it gives a batch up, as the README states. */
const STDERR_PATIENCE_MS = 100;
const child = (name: string): string => fileURLToPath(new URL(`./children/${name}.mjs`, import.meta.url));

/** What a tick-loop child reports for one of its two phases. */
interface Phase {
  us: number;
  wallUs: number;
}

/** What a child that runs the same executions through a stalled sink and through a sink that keeps its lines reports. */
interface Stalled {
  errors: number;
  stalledMs: number;
  controlMs: number;
}

/**
 * The two runs differ only in the sink, and each side is the shortest of
 * several rounds after a warmup, so the ratio is the price of a stalled
 * descriptor and nothing the machine sets. The steady ratio is about six,
 * one failed syscall per batch; a sink that slept a millisecond per write
 * would cost the hundreds this bound is under.
 */
function assertStalledLikeControl(sink: string, stalledMs: number, controlMs: number): void {
  assert.ok(stalledMs <= controlMs * 40, `256 executions through a stalled ${sink} held the request path for ${stalledMs.toFixed(1)} ms against ${controlMs.toFixed(1)} ms into a sink that keeps the line`);
}

/** A named pipe in `dir`, or `undefined` where mkfifo is not available. */
function fifo(dir: string): string | undefined {
  const path = join(dir, "pipe");
  try {
    execFileSync("mkfifo", [path]);
    return path;
  } catch {
    return undefined;
  }
}

test("a sink that throws from write is caught and reported with its phase; the good sink still receives the lines", () => {
  const good = memorySink();
  const bad: Sink = {
    write() {
      throw new Error("disk on fire");
    },
  };
  const errors: Array<{ error: unknown; sink: Sink; lines: number; phase: SinkPhase }> = [];
  const m = mocon({ host: "h", capabilities: caps, sinks: [bad, good], onError: (error, ctx) => errors.push({ error, ...ctx }) });
  const ex = m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t", input: 1 });
  ex.complete();
  assert.equal(good.lines.length, 4, "host, notice, abandoned crossing, complete");
  assert.equal(errors.length, 3, "one report per write: host, notice, and the end batch");
  assert.equal(errors[1]?.lines, 2, "a sink whose declaration write failed is handed the declaration again with the next batch");
  assert.equal(errors[2]?.lines, 3, "the end batch carried the declaration, the abandoned crossing and the complete record");
  assert.equal(errors[0]?.sink, bad);
  assert.equal(errors[0]?.phase, "write");
  assert.equal((errors[0]?.error as Error).message, "disk on fire");
});

test("a sink whose write rejects is reported through onError and never becomes an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const errors: unknown[] = [];
    const rejecting: Sink = { write: () => Promise.reject(new Error("post failed")) };
    const m = mocon({ host: "h", capabilities: caps, sinks: [rejecting], onError: (e) => errors.push(e) });
    m.execution.start({ program: "p", notice: false }).complete();
    await sleep(5);
    assert.equal(errors.length, 2);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an onError that throws is contained", () => {
  const bad: Sink = {
    write() {
      throw new Error("x");
    },
  };
  const m = mocon({
    host: "h",
    capabilities: caps,
    sinks: [bad],
    onError: () => {
      throw new Error("handler broke too");
    },
  });
  m.execution.start({ program: "p" }).complete();
});

test("several sinks in one instance: each is isolated on write, flush and close, and onError names the member", async () => {
  const calls: string[] = [];
  const bad: Sink = {
    write() {
      throw new Error("no");
    },
    flush() {
      throw new Error("flush broke");
    },
    close() {
      throw new Error("close broke");
    },
  };
  const good: Sink = {
    write() {
      calls.push("write");
    },
    flush() {
      calls.push("flush");
    },
    close() {
      calls.push("close");
    },
  };
  const reports: Array<[Sink, SinkPhase]> = [];
  const m = mocon({ host: "h", capabilities: caps, sinks: [bad, good], onError: (_e, ctx) => reports.push([ctx.sink, ctx.phase]) });
  m.execution.start({ program: "p", notice: false }).complete();
  await m.close();
  assert.deepEqual(calls, ["write", "write", "flush", "close"]);
  assert.ok(reports.every(([sink]) => sink === bad));
  assert.deepEqual(
    reports.map(([, phase]) => phase),
    ["write", "write", "flush", "close"],
  );
});

test("memorySink keeps every line in order, and each line parses to a valid record", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: caps, sinks: [sink] });
  m.execution.start({ program: "p", notice: false }).complete({ result: { deep: [1, { two: 2 }] } });
  assert.equal(sink.lines.length, 2);
  assertValidStream(sink.lines);
});

test("close marks the instance closed before it flushes: a write issued during close is dropped and reported, never left in a sink", async () => {
  const buffered: string[] = [];
  const shipped: string[] = [];
  const calls: string[] = [];
  const errors: Array<{ lines: number; phase: SinkPhase }> = [];
  const sink: Sink = {
    write(lines) {
      calls.push("write");
      buffered.push(...lines);
    },
    async flush() {
      calls.push("flush");
      const batch = buffered.splice(0);
      await sleep(5);
      shipped.push(...batch);
    },
    close() {
      calls.push("close");
      throw new Error("close failed");
    },
  };
  const m = mocon({ host: "h", capabilities: caps, sinks: [sink], onError: (_e, ctx) => errors.push({ lines: ctx.lines, phase: ctx.phase }) });
  await m.flush();
  const closing = m.close();
  m.execution.start({ program: "p", notice: false }).complete();
  await closing;
  await m.close();
  m.declare();
  assert.deepEqual(calls, ["write", "flush", "flush", "close"]);
  assert.equal(buffered.length, 0);
  assert.equal(shipped.length, 1, "the host line");
  assert.deepEqual(errors, [
    { lines: 1, phase: "write" },
    { lines: 0, phase: "close" },
    { lines: 1, phase: "write" },
  ]);
});

/* ------------------------------------------------------------------ */
/* fileSink                                                            */
/* ------------------------------------------------------------------ */

test("fileSink appends synchronously to one file opened once, owner-readable by default, and closes once", async () => {
  const previous = process.umask(0o022);
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  const path = join(dir, "mocon.jsonl");
  try {
    const sink = fileSink(path);
    const m = mocon({ host: "h", capabilities: caps, sinks: [sink] });
    const ex = m.execution.start({ program: "p" });
    ex.crossing.start({ target: "t", input: { a: 1 } }).output({ b: 2 });
    ex.complete({ result: "ok" });
    const text = readFileSync(path, "utf8");
    assert.ok(text.endsWith("\n"));
    const lines = text.split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 4);
    assertValidStream(lines);
    assert.equal(statSync(path).mode & 0o077, 0, `stream file mode is 0${(statSync(path).mode & 0o777).toString(8)}`);
    await m.close();
    sink.close?.();
    sink.write(["dropped"]);
    const again = mocon({ host: "h", capabilities: caps, sinks: [fileSink(path)] });
    await again.close();
    assert.equal(readFileSync(path, "utf8").split("\n").filter((l) => l !== "").length, 5, "append mode keeps earlier lines");
  } finally {
    process.umask(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stream written by fileSink from a child process round-trips through fold", () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  const path = join(dir, "mocon.jsonl");
  try {
    const script = `
      import { fileSink, mocon } from "../src/index.ts";
      const m = mocon({ host: "child/host", capabilities: { observes_crossings: "all" }, sinks: [fileSink(${JSON.stringify(path)})] });
      const ex = m.execution.start({ program: "return 1;" });
      ex.instrument((_n, a) => a)("lookup", { id: 7 });
      ex.complete({ result: 1 });
    `;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("./", import.meta.url)), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
    assertValidStream(lines);
    const view = fold(lines);
    assert.deepEqual(view.unresolved, []);
    assert.deepEqual(view.conflicts, []);
    assert.equal(Object.keys(view.crossings).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileSink makes an existing stream file that others can read owner-only before anything is written to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  try {
    const path = join(dir, "existing.jsonl");
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    const sink = fileSink(path);
    assert.equal(statSync(path).mode & 0o777, 0o600, "the mode is tightened when the sink opens the file, before its first line");
    sink.write(['{"kind":"execution","host":"h","id":"e","program":{"value":"api_key=sk-secret"},"start":"2026-09-16T10:00:00Z"}']);
    sink.close?.();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileSink refuses a symbolic link to a file, dangling or not, and creates nothing where it points", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  try {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "original\n", { mode: 0o644 });
    const link = join(dir, "link.jsonl");
    symlinkSync(victim, link);
    assert.throws(() => fileSink(link), (e: unknown) => (e as NodeJS.ErrnoException).code === "ELOOP");
    assert.equal(readFileSync(victim, "utf8"), "original\n", "nothing was appended to the file the link names");
    assert.equal(statSync(victim).mode & 0o777, 0o644, "the file the link names keeps its mode");
    const missing = join(dir, "not-there.txt");
    const dangling = join(dir, "dangling.jsonl");
    symlinkSync(missing, dangling);
    assert.throws(() => fileSink(dangling), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT");
    assert.equal(existsSync(missing), false, "no file was created through the link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileSink follows a symbolic link to a pipe, as /dev/stderr is one", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  try {
    const pipe = fifo(dir);
    if (pipe === undefined) {
      t.skip("mkfifo is not available");
      return;
    }
    const link = join(dir, "stream.jsonl");
    symlinkSync(pipe, link);
    const reader = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const sink = fileSink(link);
      sink.write(['{"kind":"host","host":"h"}']);
      sink.close?.();
      const buf = Buffer.alloc(64);
      assert.equal(buf.toString("utf8", 0, readSync(reader, buf)), '{"kind":"host","host":"h"}\n');
    } finally {
      closeSync(reader);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a batch is written in pieces of about a mebibyte, so no string or buffer the sink builds grows with the batch", () => {
  const real = fs.writeSync;
  const sizes: number[] = [];
  const received: Buffer[] = [];
  fs.writeSync = ((_fd: number, buffer: Buffer, offset: number, length: number) => {
    sizes.push(buffer.length);
    received.push(Buffer.from(buffer.subarray(offset, offset + length)));
    return length;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    const lines = Array.from({ length: 64 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(100_000) }));
    stderrSink().write(lines);
    assert.ok(sizes.length > 1, "the batch was not written in one piece");
    assert.ok(Math.max(...sizes) < (1 << 20) + 200_000, `a piece of ${Math.max(...sizes)} bytes`);
    assert.equal(Buffer.concat(received).toString("utf8"), lines.join("\n") + "\n", "the pieces carry the batch whole and in order");
  } finally {
    fs.writeSync = real;
    syncBuiltinESMExports();
  }
});

test("writes to a pipe whose reader stopped draining do not hold the request path once the stall is known", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  const path = fifo(dir);
  if (path === undefined) {
    t.skip("mkfifo is not available");
    return;
  }
  // A reader that holds the pipe open and never reads.
  const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const sink = fileSink(path);
    let failures = 0;
    const m = mocon({ host: "example/mcp", capabilities: caps, sinks: [sink], onError: () => failures++ });
    const ex = m.execution.start({ program: "p" });
    const filler = "x".repeat(1 << 14);
    for (let i = 0; i < 1000 && failures === 0; i++) ex.crossing.start({ target: "t", input: filler, notice: true });
    assert.ok(failures > 0, "the pipe never filled");
    // The same crossing into a sink that keeps its lines is the control: the two differ only in the descriptor behind them.
    const kept = memorySink();
    const quiet = mocon({ host: "example/mcp", capabilities: caps, sinks: [kept] });
    const quietEx = quiet.execution.start({ program: "p", notice: false });
    const [stalledUs, quietUs] = interleaved(
      () => void ex.crossing.start({ target: "t", input: 1, notice: true }),
      () => {
        quietEx.crossing.start({ target: "t", input: 1, notice: true });
        kept.lines.length = 0;
      },
      15,
      40,
    );
    // A failed write costs one syscall, about ten times what keeping the line costs; a write that slept a millisecond would cost hundreds.
    assert.ok(stalledUs <= quietUs * 40, `a write to the stalled pipe held the request path for ${stalledUs.toFixed(1)} us against ${quietUs.toFixed(1)} us for a sink that keeps the line`);
    sink.close?.();
  } finally {
    closeSync(reader);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* stderrSink                                                          */
/* ------------------------------------------------------------------ */

test("stderrSink writes a stream a parent reading fd 2 can fold", async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", child("stderr-roundtrip")], { stdio: ["ignore", "ignore", "pipe"] });
  let text = "";
  proc.stderr.on("data", (d: Buffer) => (text += d.toString()));
  const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
  assert.equal(code, 0);
  const lines = text.split("\n").filter((l) => l !== "");
  assertValidStream(lines);
  const view = fold(lines);
  assert.deepEqual(view.unresolved, []);
  assert.equal(Object.keys(view.executions).length, 1);
  assert.equal(Object.keys(view.crossings).length, 1);
  assert.equal(view.hosts["child/host"]?.observes_crossings, "all");
});

test("a full pipe is retried in millisecond sleeps up to the patience, then the batch is given up with an error counting the lines lost; once stalled, a write tries once and does not sleep", () => {
  const real = fs.writeSync;
  let calls = 0;
  let sleeping = 0;
  const realWait = Atomics.wait;
  fs.writeSync = ((...args: unknown[]) => {
    calls++;
    if (calls <= 1_000_000) {
      const e = new Error("EAGAIN: resource temporarily unavailable") as NodeJS.ErrnoException;
      e.code = "EAGAIN";
      throw e;
    }
    return args[3] as number;
  }) as typeof fs.writeSync;
  Atomics.wait = ((...args: unknown[]) => {
    sleeping++;
    return realWait.apply(Atomics, args as Parameters<typeof Atomics.wait>);
  }) as typeof Atomics.wait;
  syncBuiltinESMExports();
  const sink = stderrSink();
  try {
    assert.throws(
      () => sink.write(["x", "y"]),
      (e: unknown) => e instanceof Error && (e as NodeJS.ErrnoException).code === "EAGAIN" && e.message.includes("2 of 2 lines were not written"),
    );
    assert.ok(calls <= STDERR_PATIENCE_MS + 2, `the sink called writeSync ${calls} times`);
    assert.ok(sleeping >= STDERR_PATIENCE_MS - 1, `the writer slept ${sleeping} times instead of spinning`);
    calls = 0;
    sleeping = 0;
    assert.throws(() => sink.write(["z"]), (e: unknown) => (e as NodeJS.ErrnoException).code === "EAGAIN");
    assert.equal(calls, 1, "once stalled, a write makes one attempt");
    assert.equal(sleeping, 0, "once stalled, a write does not sleep");
  } finally {
    fs.writeSync = real;
    Atomics.wait = realWait;
    syncBuiltinESMExports();
  }
});

test("stderrSink on a non-blocking piped stderr gives a batch up rather than retrying: a host writing every tick keeps its tick rate while the reader stalls", { skip: process.platform === "win32" }, async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", child("stderr-stall")], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  proc.stderr.pause();
  const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
  proc.stderr.resume();
  assert.equal(code, 0, `the child exited ${code} (signal ${proc.signalCode}): ${stdout}`);
  const { ticks, stalled, control } = JSON.parse(stdout) as { ticks: number; stalled: Phase; control: Phase };
  // The same tick loop against a sink that keeps its lines is the control. A write that waited or spun per tick would
  // stretch each tick from a millisecond to the sink's whole patience, a hundred times the loop's own cost.
  assert.ok(
    stalled.wallUs <= control.wallUs * 10,
    `${ticks} ticks with nowhere to write took ${(stalled.wallUs / 1000).toFixed(0)} ms (${(stalled.us / 1000).toFixed(0)} ms of CPU) against ${(control.wallUs / 1000).toFixed(0)} ms (${(control.us / 1000).toFixed(0)} ms of CPU) into a sink that keeps the line`,
  );
});

test("a stalled reader that comes back finds the writer waiting, not spinning: a 4 MiB burst spends its time asleep, not on the CPU", async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", child("stderr-burst")], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
  setTimeout(() => proc.stderr.resume(), 1000);
  const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
  assert.equal(code, 0, `child exited ${code}: ${out}`);
  const { outcome, wallUs, cpuUs } = JSON.parse(out) as { outcome: string; wallUs: number; cpuUs: number };
  assert.ok(outcome === "written" || outcome === "dropped", outcome);
  // Asleep, the write's CPU is the UTF-8 conversion alone, under a tenth of the time it took; spinning, the two would be equal.
  assert.ok(cpuUs <= wallUs / 2, `the writer spent ${Math.round(cpuUs)} us of CPU in the ${Math.round(wallUs)} us the burst took, waiting for a reader that was not there`);
});

test("stderrSink does not hold the request path while the pipe's reader is stalled: writes return, and the loss reaches onError", { skip: process.platform === "win32" }, async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", child("stderr-stalled-reader")], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  proc.stderr.pause();
  const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
  proc.stderr.resume();
  assert.equal(code, 0, stdout);
  const { errors, stalledMs, controlMs } = JSON.parse(stdout) as Stalled;
  assert.ok(errors > 0, "lines the sink could not deliver are reported through onError so the host can emit a dropped event");
  assertStalledLikeControl("stderrSink", stalledMs, controlMs);
});

test("fileSink on /dev/stderr does not hold the request path while the pipe's reader is stalled", { skip: process.platform === "win32" }, async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", child("filesink-pipe")], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  proc.stderr.pause();
  const exited = new Promise<number | null>((resolve) => proc.on("exit", resolve));
  const verdict = await Promise.race([exited.then((code) => ({ code })), sleep(10_000).then(() => "stuck" as const)]);
  if (verdict === "stuck") {
    proc.kill("SIGKILL");
    await exited;
  }
  proc.stderr.resume();
  assert.notEqual(verdict, "stuck", "256 executions were still blocked in fileSink after 10 s with the reader stalled");
  assert.equal((verdict as { code: number | null }).code, 0, stdout);
  const { stalledMs, controlMs } = JSON.parse(stdout) as Stalled;
  assertStalledLikeControl("fileSink", stalledMs, controlMs);
});

/* ------------------------------------------------------------------ */
/* Isolation                                                           */
/* ------------------------------------------------------------------ */

test("a sink whose declaration write failed receives the declaration again before any record, whether the write threw or rejected", async () => {
  for (const rejects of [false, true]) {
    const accepted: string[] = [];
    let calls = 0;
    const flaky: Sink = {
      write(lines) {
        calls++;
        if (calls === 1) {
          if (rejects) return Promise.reject(new Error("transient failure"));
          throw new Error("transient failure");
        }
        accepted.push(...lines);
        return undefined;
      },
    };
    const m = mocon({ host: "example/mcp", capabilities: caps, sinks: [flaky] });
    await Promise.resolve();
    m.execution.start({ program: "p" }).complete();
    await m.flush();
    const kinds = accepted.map((l) => (JSON.parse(l) as { kind: string }).kind);
    assert.deepEqual(kinds, ["host", "execution", "execution"], `the stream this sink wrote opens with ${kinds.join(", ")}`);
  }
});

test("a sink whose declaration write has not settled yet still gets the declaration first in every batch it accepts", async () => {
  const accepted: string[][] = [];
  let calls = 0;
  let failDeclaration: ((e: Error) => void) | undefined;
  const flaky: Sink = {
    write(batch) {
      calls++;
      // The first POST is still in flight when the next write arrives, and it fails; the next one goes through.
      if (calls === 1) return new Promise<void>((_, reject) => (failDeclaration = reject));
      accepted.push([...batch]);
      return Promise.resolve();
    },
  };
  const m = mocon({ host: "example/mcp", capabilities: caps, sinks: [flaky], onError: () => {} });
  m.execution.start({ program: "p" });
  failDeclaration?.(new Error("collector not reachable yet"));
  await new Promise((resolve) => setImmediate(resolve));
  const kinds = accepted.map((batch) => batch.map((l) => (JSON.parse(l) as { kind: string }).kind));
  assert.equal(kinds.length, 1);
  assert.equal(kinds[0]?.[0], "host", `the stream this sink accepted opens with ${JSON.stringify(kinds)}, and its declaration was lost`);
});

test("a sink whose flush never settles does not keep the other sinks from being closed", async () => {
  let closed = 0;
  const hung: Sink = { write() {}, flush: () => new Promise<void>(() => {}) };
  const healthy: Sink = {
    write() {},
    close() {
      closed++;
    },
  };
  const m = mocon({ host: "h", capabilities: caps, sinks: [hung, healthy] });
  void m.close();
  await sleep(50);
  assert.equal(closed, 1, "the healthy sink's close was never called");
});

test("a sink that edits the batch it was handed cannot change what the next sink receives: the batch is frozen", () => {
  const received: string[][] = [];
  const edits: unknown[] = [];
  const editing: Sink = {
    write(lines) {
      try {
        (lines as string[]).splice(0, lines.length, "{}");
        edits.push("edited");
      } catch (e) {
        edits.push(e);
      }
    },
  };
  const recording: Sink = {
    write(lines) {
      received.push([...lines]);
    },
  };
  const m = mocon({ host: "h", capabilities: caps, sinks: [editing, recording] });
  const ex = m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: 1 });
  ex.complete();
  const last = received.at(-1) ?? [];
  assert.equal(last.length, 2, `the recording sink received ${JSON.stringify(last)}`);
  assert.ok(last.every((line) => line.startsWith('{"kind":')), `the recording sink received ${JSON.stringify(last)}`);
  assert.ok(edits.length > 0 && edits.every((e) => e instanceof TypeError), "every batch a sink is handed is frozen");
});

test("an async onError that rejects does not become an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const failing: Sink = {
      write() {
        throw new Error("sink down");
      },
    };
    const m = mocon({
      host: "h",
      capabilities: caps,
      sinks: [failing],
      onError: async () => {
        throw new Error("the log shipper is down too");
      },
    });
    m.execution.start({ program: "p" }).complete();
    await sleep(20);
  } finally {
    process.off("unhandledRejection", listener);
  }
  assert.deepEqual(unhandled, []);
});

test("a second close returns the first close's promise: it resolves only once the sinks are flushed and closed", async () => {
  let flushed = false;
  let closed = false;
  const slow: Sink = {
    write() {},
    async flush() {
      await sleep(30);
      flushed = true;
    },
    close() {
      closed = true;
    },
  };
  const m = mocon({ host: "h", capabilities: caps, sinks: [slow] });
  const first = m.close();
  assert.equal(m.close(), first);
  await m.close();
  assert.equal(flushed, true, "the second close resolved before the sink was flushed");
  assert.equal(closed, true, "the second close resolved before the sink was closed");
});

/* ------------------------------------------------------------------ */
/* The batch an execution's end writes is the program's to size        */
/* ------------------------------------------------------------------ */

/** The last `n` bytes of a file, without reading a file larger than a string can hold. */
function tail(path: string, n: number): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(n, size));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

test("a program that leaves many calls open when it returns cannot keep its complete record out of the stream", { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  try {
    const path = join(dir, "stream.jsonl");
    const errors: string[] = [];
    const m = mocon({ host: "h", capabilities: caps, sinks: [fileSink(path)], onError: (e) => void errors.push(String(e)) });
    const execution = m.execution.start({ program: "for (let i = 0; i < 28000; i++) callTool(name, args); return 1;" });
    // Both under their default caps: a 4 KiB target and a 16 KiB input, as a program passes them to the bridge.
    const target = "t".repeat(4_000);
    const input = "x".repeat(16_000);
    for (let i = 0; i < 28_000; i++) execution.crossing.start({ target, input });
    execution.complete({ result: 1 });
    const last = tail(path, 4096).trimEnd().split("\n").at(-1) ?? "";
    assert.ok(
      last.startsWith('{"kind":"execution"') && last.includes('"disposition":"completed"'),
      `the stream ends without the complete record (${statSync(path).size} bytes written); the sink reported: ${errors.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same through run and instrument, driven by a program in node:vm whose tool calls never answer", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-"));
  try {
    const path = join(dir, "vm.jsonl");
    const errors: string[] = [];
    const m = mocon({ host: "h", capabilities: caps, sinks: [fileSink(path)], onError: (e) => void errors.push(String(e)) });
    const program = `const big = "x".repeat(16000); for (let i = 0; i < 34000; i++) callTool("slow", big); return "done";`;
    // Every call is left open: the program returns while the bridge's promises are still pending.
    const bridge = (_name: string, _args: unknown): Promise<unknown> => new Promise(() => {});
    const value = await m.execution.run({ program, language: "javascript" }, (ex) =>
      runInNewContext(`(async () => {${program}})()`, { callTool: ex.instrument(bridge) }) as Promise<unknown>,
    );
    assert.equal(value, "done");
    const last = tail(path, 4096).trimEnd().split("\n").at(-1) ?? "";
    assert.ok(
      last.startsWith('{"kind":"execution"') && last.includes('"disposition":"completed"'),
      `the stream ends without the complete record (${statSync(path).size} bytes written); the sink reported: ${errors.join("; ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
