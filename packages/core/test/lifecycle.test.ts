/**
 * Handle lifecycles at their edges: a returned value whose `then` read
 * throws, a lazy thenable that must not be subscribed, a rejection the
 * program left unhandled, an `instrument` option that a program's argument
 * makes throw, a settlement that arrives after the host abandoned a
 * crossing by hand, a seq at the safe-integer limit, and options that
 * answer differently on a second read.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { memorySink, mocon, type CrossingEndOptions, type ExecutionEndOptions, type InstrumentOptions } from "../src/index.js";
import { assertValidStream, harness, type Harness, type Rec } from "./helpers.js";

function hostileValues(): Array<[string, () => object]> {
  return [
    [
      "a revoked Proxy",
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
    [
      "an object whose then getter throws",
      () => ({
        get then(): never {
          throw new Error("then");
        },
      }),
    ],
  ];
}

for (const [name, make] of hostileValues()) {
  test(`run returns ${name} from a sync body unchanged and writes the complete record`, () => {
    const h = harness();
    const value = make();
    let out: unknown;
    assert.doesNotThrow(() => {
      out = h.m.execution.run({ program: "p" }, () => value);
    });
    assert.equal(out, value);
    const complete = h.ofKind("execution").filter((r) => "end" in r);
    assert.equal(complete.length, 1, "the execution has its complete record");
  });

  test(`an instrumented bridge returns ${name} unchanged and its crossing settles instead of waiting to be abandoned`, () => {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const value = make();
    const call = ex.instrument((_name: string) => value);
    let out: unknown;
    assert.doesNotThrow(() => {
      out = call("t");
    });
    assert.equal(out, value);
    ex.complete();
    assert.notEqual((h.last("crossing")["end"] as Rec)["outcome"], "abandoned", "the bridge returned, so the host determined an outcome");
  });
}

test("a returned value that is not a native promise is never subscribed, and a promise whose constructor read throws settles the record with that error, as await would", async () => {
  const h = harness();
  let calls = 0;
  const thenable = {
    then(): void {
      calls++;
    },
  };
  const ex = h.m.execution.start({ program: "p", notice: false });
  assert.equal(ex.instrument((_name: string) => thenable)("t"), thenable, "the thenable itself is what the caller gets back");
  h.m.execution.run({ program: "p" }, () => thenable);
  assert.equal(calls, 0, `then was called ${calls} times; a lazy thenable would have done its work once per call`);

  const broken = Promise.resolve(1);
  Object.defineProperty(broken, "constructor", {
    get() {
      throw new Error("constructor broke");
    },
  });
  const out = h.m.execution.run({ program: "p", notice: false }, () => broken);
  assert.equal(out, broken, "returned as it is");
  await assert.rejects(async () => await out, /constructor broke/, "await rejects on it the same way");
  const end = h.last("execution")["end"] as Rec;
  assert.equal(end["disposition"], "failed");
  assert.equal((end["error"] as Rec)["message"], "constructor broke");
});

/* ------------------------------------------------------------------ */

test("an output after the host abandoned the crossing by hand is one late_settlement event", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "slow_tool", input: { q: 1 } });
  c.end({ outcome: "abandoned" });
  c.output({ answer: 42 });
  ex.complete();
  assertValidStream(h.sink.lines);
  const crossings = h.ofKind("crossing");
  assert.equal(crossings.length, 1);
  assert.equal((crossings[0]?.["end"] as Rec)["outcome"], "abandoned", "the crossing record stays abandoned");
  const events = h.ofKind("event");
  assert.equal(events.length, 1, "the settlement that arrived after abandon is recorded, not dropped");
  assert.equal(events[0]?.["name"], "late_settlement");
  assert.equal(events[0]?.["crossing_id"], c.id);
  assert.equal((events[0]?.["data"] as Rec)["outcome"], "output");
});

test("an error after the host abandoned the crossing by hand is one late_settlement event", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "slow_tool", input: 1, start: "2026-09-17T08:59:00Z" });
  c.end({ outcome: "abandoned", time: "2026-09-17T09:00:00Z" });
  c.error(new Error("too late"));
  const events = h.ofKind("event");
  assert.equal(events.length, 1);
  assert.equal((events[0]?.["data"] as Rec)["outcome"], "error");
});

test("an abandoned end on an already abandoned crossing does not swallow the late output or error that follows", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: 1 });
  const d = ex.crossing.start({ target: "u", input: 1 });
  ex.complete();
  c.end({ outcome: "abandoned" });
  c.output("the answer arrived");
  d.end({ outcome: "abandoned", time: "2099-01-01T00:00:00.000Z" });
  d.error(new Error("upstream failed"));
  const events = h.ofKind("event");
  assert.deepEqual(
    events.map((e) => [e["crossing_id"], (e["data"] as Rec)["outcome"]]),
    [
      [c.id, "output"],
      [d.id, "error"],
    ],
  );
  assert.equal(h.ofKind("crossing").length, 2, "an abandoned end on an abandoned crossing writes nothing");
  assertValidStream(h.sink.lines);
});

/* ------------------------------------------------------------------ */

test("a seq at the safe-integer limit is refused, so an automatic seq never repeats", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  assert.throws(() => ex.crossing.start({ target: "a", input: 1, seq: Number.MAX_SAFE_INTEGER }), RangeError);
  ex.crossing.start({ target: "a", input: 1, seq: Number.MAX_SAFE_INTEGER - 1 });
  ex.crossing.start({ target: "b", input: 1 });
  ex.crossing.start({ target: "c", input: 1 });
  ex.complete();
  const seqs = h.ofKind("crossing").map((r) => r["seq"]);
  assert.deepEqual(seqs, [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, undefined], "past the limit an automatic seq is left out rather than repeated");
});

/* ------------------------------------------------------------------ */

const INJECTED = '"}}\n{"kind":"host","host":"h","attested":["crossing.target","crossing.input","crossing.output","crossing.error"]}\n{"x":{"y":"';

function flipping<T extends string>(first: T): () => T {
  let reads = 0;
  return () => (reads++ === 0 ? first : ((first + INJECTED) as T));
}

test("an execution end writes exactly one line whatever the disposition getter returns on a second read", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink] });
  const ex = m.execution.start({ program: "p", notice: false });
  const options = Object.defineProperty({}, "disposition", { get: flipping("completed"), enumerable: true }) as ExecutionEndOptions;
  ex.end(options);
  for (const line of sink.lines) assert.ok(!line.includes("\n"), `a sink received a line with a raw newline: ${JSON.stringify(line).slice(0, 200)}`);
  assertValidStream(sink.lines);
});

test("a crossing end writes exactly one line whatever the outcome getter returns on a second read", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink] });
  const ex = m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: 1 });
  const options = Object.defineProperty({}, "outcome", { get: flipping("abandoned"), enumerable: true }) as CrossingEndOptions;
  c.end(options);
  for (const line of sink.lines) assert.ok(!line.includes("\n"), `a sink received a line with a raw newline: ${JSON.stringify(line).slice(0, 200)}`);
  assertValidStream(sink.lines);
});

/* ------------------------------------------------------------------ */
/* A lazy thenable: subscribing to it would do its work a second time   */
/* ------------------------------------------------------------------ */

interface Counter {
  runs: number;
}

/** Runs its query on every `then` call, as a query builder does. */
function lazyQuery(counter: Counter): PromiseLike<number> {
  return {
    then<A, B>(onValue?: ((v: number) => A | PromiseLike<A>) | null, onError?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      counter.runs++;
      return Promise.resolve(counter.runs).then(onValue, onError);
    },
  };
}

test("a bridge that returns a lazy thenable runs its query once when the program awaits the instrumented call", async () => {
  const counter: Counter = { runs: 0 };
  const bare = await lazyQuery(counter);
  assert.equal(counter.runs, 1, "control: awaiting the thenable directly runs it once");
  assert.equal(bare, 1);

  counter.runs = 0;
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const find = ex.instrument((_target: string) => lazyQuery(counter));
  await find("db.find");
  ex.complete();
  assert.equal(counter.runs, 1, `the query ran ${counter.runs} times behind the instrumented bridge`);
});

test("a run body that returns a lazy thenable runs its query once when the caller awaits run", async () => {
  const counter: Counter = { runs: 0 };
  const h = harness();
  await h.m.execution.run({ program: "p" }, () => lazyQuery(counter));
  assert.equal(counter.runs, 1, `the query ran ${counter.runs} times behind run`);
});

/* ------------------------------------------------------------------ */
/* An unawaited rejection is still the host process's to see           */
/* ------------------------------------------------------------------ */

const coreDir = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** The unhandled rejections a child process saw, so the test runner's own tracking does not see the control one. */
function unhandledIn(body: string): string[] {
  const script = `
import { mocon, memorySink } from ${JSON.stringify(entry)};
const seen = [];
process.on("unhandledRejection", (reason) => seen.push(String(reason && reason.message)));
const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [memorySink()] });
const ex = m.execution.start({ program: "p", notice: false });
${body}
setTimeout(() => console.log(JSON.stringify(seen)), 30);
`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: coreDir, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
}

test("control: an unawaited rejected bridge call raises unhandledRejection", () => {
  assert.deepEqual(unhandledIn(`(async () => { throw new Error("bare bridge"); })();`), ["bare bridge"]);
});

test("an unawaited rejected call through an instrumented bridge still raises unhandledRejection", () => {
  const seen = unhandledIn(`
const call = ex.instrument(async (_name) => { throw new Error("instrumented bridge"); });
call("tool");
`);
  assert.deepEqual(seen, ["instrumented bridge"], "wrapping the bridge swallowed the rejection the program left unhandled");
});

/* ------------------------------------------------------------------ */
/* instrument options are the program's arguments, so they may throw    */
/* ------------------------------------------------------------------ */

interface Request {
  name?: unknown;
  meta?: unknown;
  arguments?: unknown;
}

interface Outcome {
  h: Harness;
  calls: number;
  threw: unknown;
  out: unknown;
}

function callOnce(options: InstrumentOptions<[Request]>, request: Request): Outcome {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  let calls = 0;
  const bridge = ex.instrument((_req: Request) => {
    calls++;
    return "bridge answer";
  }, options);
  let threw: unknown;
  let out: unknown;
  try {
    out = bridge(request);
  } catch (e) {
    threw = e;
  }
  return { h, calls, threw, out };
}

test("a target function that yields a non-string for the program's argument still reaches the bridge and records the crossing", () => {
  const r = callOnce({ target: (req) => req.name as string, input: (req) => req.arguments }, { name: 42, arguments: {} });
  assert.equal(r.threw, undefined, `the wrapper threw ${String(r.threw)}`);
  assert.equal(r.calls, 1, "the bridge was not called");
  assert.equal(r.out, "bridge answer");
  assert.equal(r.h.ofKind("crossing").length, 1, "the invocation went unrecorded");
});

test("an ext function that yields null for the program's argument still reaches the bridge and records the crossing", () => {
  const r = callOnce({ target: "tool", ext: (req) => req.meta as Record<string, string> }, { meta: null });
  assert.equal(r.threw, undefined, `the wrapper threw ${String(r.threw)}`);
  assert.equal(r.calls, 1, "the bridge was not called");
  assert.equal(r.h.ofKind("crossing").length, 1, "the invocation went unrecorded");
});

test("an input function that throws on the program's argument still reaches the bridge and records the crossing", () => {
  const request: Request = {
    name: "tool",
    get arguments(): unknown {
      throw new Error("program getter");
    },
  };
  const r = callOnce({ target: (req) => String(req.name), input: (req) => req.arguments }, request);
  assert.equal(r.calls, 1, `the bridge was not called; the wrapper threw ${String(r.threw)}`);
  assert.equal(r.h.ofKind("crossing").length, 1, "the invocation went unrecorded");
});

test("instrument itself throws only for an option of the wrong shape", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const bridge = (): string => "answer";
  for (const options of [{ target: 1 }, { input: "not a function" }, { ext: "not an object" }, null]) {
    assert.throws(() => ex.instrument(bridge, options as never), TypeError, JSON.stringify(options));
  }
  assert.throws(() => ex.instrument("not a function" as never), TypeError);
});

test("run reads the body's own answer: an envelope host settles failed, not completed", () => {
  const h = harness();
  const out = h.m.execution.run(
    {
      program: "p",
      notice: false,
      end: (v) => ((v as { ok?: boolean }).ok === false ? { disposition: "failed", error: { class: "runtime", message: "envelope" } } : undefined),
    },
    () => ({ ok: false, error: "boom" }),
  );
  assert.deepEqual(out, { ok: false, error: "boom" }, "the body's value reaches the caller unchanged");
  const rec = h.last("execution");
  assert.equal((rec["end"] as Rec)["disposition"], "failed");
  assert.deepEqual((rec["end"] as Rec)["error"], { class: "runtime", message: "envelope" });
  assertValidStream(h.sink.lines);
});

test("run without an end hook, and one whose hook throws, still complete", () => {
  const h = harness();
  h.m.execution.run({ program: "p", notice: false }, () => ({ ok: true }));
  assert.equal((h.last("execution")["end"] as Rec)["disposition"], "completed");
  const g = harness();
  g.m.execution.run({ program: "p", notice: false, end: () => { throw new Error("hook"); } }, () => ({ ok: true }));
  assert.equal((g.last("execution")["end"] as Rec)["disposition"], "completed", "a throwing hook costs the hook, not the record");
  assertValidStream(g.sink.lines);
});

test("a hook answering with a shape the wire refuses costs the hook, and never raises into the caller", () => {
  for (const answer of ["failed", 1, true, { disposition: "exploded" }, { disposition: "failed", error: 7 }]) {
    const h = harness();
    const out = h.m.execution.run({ program: "p", notice: false, end: () => answer as never }, () => ({ ok: true }));
    assert.deepEqual(out, { ok: true }, "the body's value reaches the caller unchanged");
    assert.equal((h.last("execution")["end"] as Rec)["disposition"], "completed");
    assertValidStream(h.sink.lines);
  }
});
