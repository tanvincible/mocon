/**
 * Whole records, idempotence, notices and wrappers: the rules core.md 4,
 * 5.3, 7 and 10 put on an emitter, the handle contract in types.ts, and
 * what a settle call may never do: consume state before it validates,
 * throw into the program, or lose a record.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fold } from "../src/fold.js";
import { mocon, memorySink, type Attestation, type Capabilities, type Ext, type Payload, type Sink } from "../src/index.js";
import { assertValidStream, harness, SYNC_BRIDGE, sleep, type Rec } from "./helpers.js";

function cyclic(): Rec {
  const o: Rec = {};
  o["self"] = o;
  return o;
}

test("a complete record carries every field the notice carried, and every field the record has", () => {
  const h = harness();
  const ex = h.m.execution.start({
    program: "return 1;",
    language: "javascript",
    context: { session: "s-1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    ext: { "v.start": 1, "v.both": "start" },
  });
  ex.complete({ result: 1, outputs: { stdout: "x" }, ext: { "v.end": 2, "v.both": "end" } });
  assertValidStream(h.sink.lines);
  const [notice, complete] = h.ofKind("execution") as [Rec, Rec];
  for (const key of ["kind", "host", "id", "program", "language", "start", "context"]) {
    assert.deepEqual(complete[key], notice[key], key);
  }
  assert.deepEqual(complete["ext"], { "v.start": 1, "v.both": "end", "v.end": 2 }, "settle ext merged over start ext, settle key wins");
  const end = complete["end"] as Rec;
  assert.deepEqual(Object.keys(end), ["time", "disposition", "result", "outputs"]);
  assert.equal("end" in notice, false);
});

test("end is idempotent: the first settlement writes, every later one is ignored", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.fail(new Error("first"));
  ex.complete({ result: "second" });
  ex.end({ disposition: "terminated" });
  ex.fail("fourth");
  const completes = h.ofKind("execution");
  assert.equal(completes.length, 1);
  assert.equal(((completes[0] as Rec)["end"] as Rec)["disposition"], "failed");
});

test("a crossing settles once; output, error and end after the first call are ignored", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: 1 });
  c.output("one");
  c.error(new Error("two"));
  c.end({ outcome: "abandoned" });
  c.output("four");
  ex.complete();
  const crossings = h.ofKind("crossing");
  assert.equal(crossings.length, 1);
  assert.equal(((crossings[0] as Rec)["end"] as Rec)["outcome"], "output");
  assert.equal(h.ofKind("execution").filter((r) => "end" in r).length, 1);
  assert.equal(h.ofKind("crossing").filter((r) => (r["end"] as Rec)["outcome"] === "abandoned").length, 0, "the execution end abandoned nothing");
});

test("a settlement that arrives after the execution abandoned the crossing is recorded as a late_settlement event, and the crossing stays abandoned", async () => {
  const h = harness();
  let release: (v: string) => void = () => undefined;
  const bridge = (_name: string): Promise<string> => new Promise((resolve) => (release = resolve));
  const ex = h.m.execution.start({ program: "p", notice: false });
  const callTool = ex.instrument(bridge);
  const pending = callTool("slow");
  const c = ex.crossing.start({ target: "manual", input: 1 });
  ex.end({ disposition: "terminated", error: { class: "timeout" } });
  const count = h.sink.lines.length;
  release("late value");
  assert.equal(await pending, "late value", "the caller still receives the value");
  await sleep(0);
  c.error(new Error("late failure"));
  c.output("ignored: one late settlement per crossing is observed");
  assert.equal(h.sink.lines.length, count + 2);
  assertValidStream(h.sink.lines);
  const [output, error] = h.ofKind("event") as [Rec, Rec];
  assert.equal(output["name"], "late_settlement");
  assert.equal(output["execution_id"], ex.id);
  assert.equal(typeof output["crossing_id"], "string");
  assert.deepEqual(((output["data"] as Rec)["payload"] as Rec)["value"], "late value");
  assert.equal((output["data"] as Rec)["outcome"], "output");
  assert.equal(error["crossing_id"], c.id);
  assert.equal(((error["data"] as Rec)["payload"] as Rec)["message"], "late failure");
  assert.equal((error["data"] as Rec)["outcome"], "error");
  for (const crossing of h.ofKind("crossing")) assert.deepEqual(crossing["end"], { outcome: "abandoned" });
  const view = fold(h.sink.lines);
  assert.equal(view.skipped, 2, "a core consumer skips the event lines and counts them");
  assert.deepEqual(view.unresolved, []);
});

test("start notices: execution on by default, crossing off by default, both switchable", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  const quiet = ex.crossing.start({ target: "a", input: null });
  const loud = ex.crossing.start({ target: "b", input: null, notice: true });
  assert.equal(h.ofKind("execution").length, 1);
  assert.equal(h.ofKind("crossing").length, 1);
  assert.equal(h.last("crossing")["id"], loud.id);
  assert.equal("end" in h.last("crossing"), false);
  quiet.output(1);
  loud.output(2);
  ex.complete();
  assertValidStream(h.sink.lines);
  const h2 = harness();
  h2.m.execution.start({ program: "p", notice: false }).complete();
  assert.equal(h2.ofKind("execution").length, 1);
});

test("core.md 10: a crossing of a notice: false handle never reaches the stream before an execution record of its dispatch", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: 1 }).output("first");
  ex.crossing.start({ target: "u", input: 2, notice: true });
  // The execution never ends: what the stream holds now is all a consumer will ever see of this dispatch.
  const kinds = h.records().map((r) => r["kind"]);
  const execution = kinds.indexOf("execution");
  assert.notEqual(execution, -1, `crossings of this dispatch are on the stream with no execution record: ${JSON.stringify(kinds)}`);
  assert.ok(execution < kinds.indexOf("crossing"), `the stream opens ${JSON.stringify(kinds)}`);
  assert.equal(h.ofKind("execution").length, 1, "the notice goes out once, with the first crossing line, not before every one");
  const notice = h.ofKind("execution")[0] as Rec;
  assert.equal(notice["id"], ex.id);
  assert.equal(h.sink.lines.indexOf(JSON.stringify(notice)), 1, "the notice goes out in the crossing's own batch, ahead of it");
  assertValidStream(h.sink.lines);
});

/* ------------------------------------------------------------------ */
/* instrument                                                          */
/* ------------------------------------------------------------------ */

test("instrument keeps a synchronous bridge synchronous and rethrows the same error object", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  class BridgeError extends Error {
    override name = "BridgeError";
  }
  const boom = new BridgeError("boom");
  const bridge = function (this: { tag: string }, name: string, args: { n: number }): string {
    if (name === "fail") throw boom;
    return `${this.tag}:${name}:${args.n}`;
  };
  const owner = { tag: "owner", call: ex.instrument(bridge) };
  const out: unknown = owner.call("ok", { n: 3 });
  assert.equal(out, "owner:ok:3", "the return value is unchanged and not wrapped in a promise");
  assert.throws(() => owner.call("fail", { n: 0 }), (e: unknown) => e === boom && e instanceof BridgeError);
  ex.complete();
  const [c1, c2] = h.ofKind("crossing") as [Rec, Rec];
  assert.equal(c1["target"], "ok");
  assert.deepEqual((c1["input"] as Rec)["value"], { n: 3 });
  assert.equal(((c1["end"] as Rec)["output"] as Rec)["value"], "owner:ok:3");
  const err = (c2["end"] as Rec)["error"] as Rec;
  assert.equal(err["class"], "capability_error");
  assert.equal(err["message"], "boom");
  const value = (err["value"] as Rec)["value"] as Rec;
  assert.equal(value["name"], "BridgeError");
  assert.equal(typeof value["stack"], "string");
});

test("instrument keeps an asynchronous bridge asynchronous and rejects with the same error object", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const boom = new TypeError("async boom");
  const bridge = async (name: string, ...rest: unknown[]): Promise<unknown> => {
    await sleep(1);
    if (name === "fail") throw boom;
    return rest;
  };
  const callTool = ex.instrument(bridge);
  const p = callTool("ok", 1, 2);
  assert.ok(p instanceof Promise);
  assert.deepEqual(await p, [1, 2]);
  await assert.rejects(callTool("fail"), (e: unknown) => e === boom);
  ex.complete();
  const [c1, c2] = h.ofKind("crossing") as [Rec, Rec];
  assert.deepEqual((c1["input"] as Rec)["value"], [1, 2], "several remaining arguments are recorded as the array");
  assert.deepEqual((c2["input"] as Rec)["value"], [], "no remaining arguments is an empty array");
  assert.equal(((c2["end"] as Rec)["error"] as Rec)["message"], "async boom");
  assert.equal((c1["end"] as Rec)["outcome"], "output");
});

test("instrument follows a native promise from any realm and returns the promise its then derives; any other thenable is returned as it is and recorded as the output", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  let thens = 0;
  const settlesTo = <T>(value: T): PromiseLike<T> => ({
    then: ((resolve: (v: T) => void) => {
      thens++;
      resolve(value);
    }) as unknown as PromiseLike<T>["then"],
  });
  const lazy = settlesTo(42);
  const returned = ex.instrument((_name: string) => lazy)("x");
  assert.equal(returned, lazy, "the very object the bridge returned");
  assert.equal(thens, 0, "the wrapper never calls its then");
  assert.equal(await returned, 42);
  assert.equal(thens, 1, "only the caller's await runs it");
  const ran = settlesTo(7);
  assert.equal(h.m.execution.run({ program: "p", notice: false }, () => ran), ran);
  assert.equal(thens, 1);

  const promise = Object.assign(Promise.resolve(1), { cancel: () => "cancelled" });
  const derived = ex.instrument((_name: string) => promise)("x");
  assert.ok(derived instanceof Promise && derived !== promise, "a native promise comes back as the promise its then derives");
  assert.equal(await derived, 1);
  const foreign = ex.instrument((_name: string) => runInNewContext("Promise.resolve('from vm')") as Promise<string>)("x");
  assert.equal(await foreign, "from vm");
  ex.complete();
  const outputs = h.ofKind("crossing").map((c) => [(c["end"] as Rec)["outcome"], ((c["end"] as Rec)["output"] as Rec)["value"]]);
  assert.deepEqual(outputs, [
    ["output", {}],
    ["output", 1],
    ["output", "from vm"],
  ]);
  assert.deepEqual((h.ofKind("execution").find((r) => "end" in r)!["end"] as Rec)["result"], { value: {}, bytes: 2, hash: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" });
});

test("the wrapper carries the bridge's name, length and own properties", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  function callTool(name: string, args: unknown): unknown {
    return [name, args];
  }
  (callTool as unknown as Rec)["schema"] = { input: "object" };
  const wrapped = ex.instrument(callTool);
  assert.equal(wrapped.name, "callTool");
  assert.equal(wrapped.length, 2);
  assert.deepEqual((wrapped as unknown as Rec)["schema"], { input: "object" });
  assert.throws(() => ex.instrument(42 as never), TypeError);
});

test("instrument options: target and input functions, ext, and a non-string first argument that reaches the bridge unchanged", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const client = { callTool: (params: { name: string; arguments: unknown }) => ({ echoed: params.arguments }) };
  const seen: unknown[] = [];
  const plain = ex.instrument((name: unknown, args: unknown) => {
    seen.push(name);
    return [name, args];
  });
  (plain as (name: unknown, args: unknown) => unknown)({ name: "x", arguments: {} }, 1);
  (plain as (name: unknown, args: unknown) => unknown)(42, {});
  (plain as (name: unknown, args: unknown) => unknown)({ toString: () => { throw new Error("no"); } }, {});
  assert.equal(seen.length, 3, "the bridge itself decides what a non-string tool name means");
  const wrapped = ex.instrument(client.callTool, {
    target: (params) => `crm/${params.name}`,
    input: (params) => params.arguments,
    ext: (params) => ({ "mcp.name": params.name }),
  });
  wrapped({ name: "lookup", arguments: { id: 7 } });
  const fixed = ex.instrument((a: number, b: number) => a + b, { target: "add", ext: { "v.k": 1 } });
  fixed(1, 2);
  const single = ex.instrument((a: number) => a * 2, { target: "double" });
  single(4);
  ex.complete();
  const [o, n, t, c1, c2, c3] = h.ofKind("crossing") as [Rec, Rec, Rec, Rec, Rec, Rec];
  assert.equal(o["target"], "[object]", "an object names the call by its type: coercing it would run its own toString");
  assert.equal(n["target"], "42");
  assert.equal(t["target"], "[object]", "a toString that would throw is never reached either");
  assert.equal(c1["target"], "crm/lookup");
  assert.deepEqual((c1["input"] as Rec)["value"], { id: 7 });
  assert.deepEqual(c1["ext"], { "mcp.name": "lookup" });
  assert.equal(c2["target"], "add");
  assert.deepEqual((c2["input"] as Rec)["value"], [1, 2]);
  assert.deepEqual(c2["ext"], { "v.k": 1 });
  assert.deepEqual((c3["input"] as Rec)["value"], 4, "a single argument is unwrapped");
  assertValidStream(h.sink.lines);
});

test("instrument returns the bridge's value even when its own bookkeeping meets an ext the serialization rejects", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const sync = ex.instrument((_name: string) => "sync value", { ext: { "v.cycle": cyclic() as never } });
  assert.equal(sync("t"), "sync value");
  const async = ex.instrument(async (_name: string) => "async value", { ext: () => ({ "v.big": 1n as never }) });
  assert.equal(await async("t"), "async value");
  ex.complete();
  assertValidStream(h.sink.lines);
  for (const c of h.ofKind("crossing")) {
    assert.equal((c["end"] as Rec)["outcome"], "output");
    assert.deepEqual(c["ext"], { "mocon.ext": { redacted: true } });
  }
});

test("run settles with the body's return value, keeps its shape, and lets the body's own settlement win", async () => {
  const h = harness();
  const sync = h.m.execution.run({ program: "a", notice: false }, () => 42);
  assert.equal(sync, 42);
  const value = await h.m.execution.run({ program: "b", notice: false }, async () => "later");
  assert.equal(value, "later");
  const boom = new Error("body");
  await assert.rejects(
    h.m.execution.run({ program: "c", notice: false }, async () => {
      throw boom;
    }),
    (e: unknown) => e === boom,
  );
  h.m.execution.run({ program: "d", notice: false }, (ex) => {
    ex.end({ disposition: "abandoned" });
    return "ignored";
  });
  const ends = h.ofKind("execution").map((r) => (r["end"] as Rec)["disposition"]);
  assert.deepEqual(ends, ["completed", "completed", "failed", "abandoned"]);
  assert.equal((((h.ofKind("execution")[0] as Rec)["end"] as Rec)["result"] as Rec)["value"], 42);
  assert.equal("result" in ((h.ofKind("execution")[3] as Rec)["end"] as Rec), false);
});

test("run and instrument settle as failed with the body's exact error even when that error resists the cause rule", async () => {
  const h = harness();
  const hostile = {
    get message(): string {
      throw new Error("getter");
    },
  };
  let caught: unknown;
  try {
    h.m.execution.run({ program: "p", notice: false }, () => {
      throw hostile;
    });
  } catch (e) {
    caught = e;
  }
  assert.equal(caught, hostile);
  assert.equal((h.last("execution")["end"] as Rec)["disposition"], "failed");
  const ex = h.m.execution.start({ program: "p", notice: false });
  assert.throws(() => ex.instrument((_n: string) => { throw hostile; })("t"), (e: unknown) => e === hostile);
  await assert.rejects(ex.instrument(async (_n: string) => { throw hostile; })("t"), (e: unknown) => e === hostile);
  ex.complete();
  assert.deepEqual(h.ofKind("crossing").map((c) => (c["end"] as Rec)["outcome"]), ["error", "error"]);
  assertValidStream(h.sink.lines);
});

test("fail: an Error thrown inside node:vm is recorded with name, message and stack like any other Error", async () => {
  const h = harness();
  await assert.rejects(
    h.m.execution.run({ program: "p", notice: false }, () => runInNewContext("(async () => { throw new TypeError('sandbox boom'); })()", {})),
    (e: unknown) => (e as Error).message === "sandbox boom",
  );
  const error = (h.last("execution")["end"] as Rec)["error"] as Rec;
  assert.equal(error["message"], "sandbox boom");
  const value = (error["value"] as Rec)["value"] as Rec;
  assert.equal(value["name"], "TypeError");
  assert.equal(typeof value["stack"], "string");
});

/* ------------------------------------------------------------------ */
/* Settlement is validated first and atomic                            */
/* ------------------------------------------------------------------ */

test("crossing.end validates the outcome before it touches state, with and without sinks: a rejected call leaves the crossing open", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const retried = ex.crossing.start({ target: "retried", input: 1 });
  const orphaned = ex.crossing.start({ target: "orphaned", input: 1, notice: true });
  assert.throws(() => retried.end({ outcome: "done" } as never), RangeError);
  assert.throws(() => orphaned.end({ outcome: "done" } as never), RangeError);
  assert.throws(() => retried.end({ outcome: "output", time: "yesterday" }), RangeError);
  assert.throws(() => retried.end({ outcome: "error", error: { class: 3 as never } }), TypeError);
  assert.throws(() => retried.output(1, { ext: 5 as never }), TypeError);
  retried.output("valid after the rejected calls");
  ex.complete();
  const outcomes = Object.fromEntries(h.ofKind("crossing").filter((c) => "end" in c).map((c) => [c["target"], (c["end"] as Rec)["outcome"]]));
  assert.deepEqual(outcomes, { retried: "output", orphaned: "abandoned" });
  assert.deepEqual(fold(h.sink.lines).unresolved, []);
  const inert = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [] });
  const c = inert.execution.start({ program: "p" }).crossing.start({ target: "t", input: 1 });
  assert.throws(() => c.end({ outcome: "done" } as never), RangeError, "an inert instance rejects it too");
});

test("execution.end validates before it touches state: a rejected call leaves the handle and its open crossings as they were", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: 1 });
  assert.throws(() => ex.end({ disposition: "done" as never }), RangeError);
  assert.throws(() => ex.complete({ time: "2026-09-16 10:00:00Z" }), RangeError);
  assert.throws(() => ex.complete({ ext: [] as never }), TypeError);
  assert.throws(() => ex.end({ disposition: "failed", error: { class: "x", message: 42 as never } }), TypeError);
  assert.throws(() => ex.fail("e", { class: 3 as never }), TypeError);
  assert.throws(() => ex.complete({ outputs: null as never }), TypeError);
  assert.throws(() => ex.complete({ outputs: "stdout" as never }), TypeError);
  ex.complete();
  assert.equal(h.ofKind("execution").length, 1);
  assert.equal(h.ofKind("crossing").length, 1, "the open crossing was abandoned by the valid call");
  assert.deepEqual((h.last("crossing")["end"] as Rec)["outcome"], "abandoned");
});

test("an ext the serialization rejects never throws, never loses a record and never takes a sibling down", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false, ext: { "v.cycle": cyclic() as never } });
  ex.crossing.start({ target: "before", input: 1 });
  ex.crossing.start({ target: "poison", input: 1, ext: { "v.cycle": cyclic() as never } });
  const c = ex.crossing.start({ target: "settled", input: 1 });
  assert.doesNotThrow(() => c.output(1, { ext: { "v.k": { toJSON: () => { throw new Error("from the value"); } } } as unknown as Ext }));
  ex.crossing.start({ target: "after", input: 1 });
  assert.doesNotThrow(() => ex.complete({ ext: { "v.n": 1n } as unknown as Ext }));
  assertValidStream(h.sink.lines);
  assert.deepEqual(h.ofKind("crossing").map((r) => r["target"]), ["settled", "before", "poison", "after"]);
  assert.deepEqual(h.ofKind("execution").map((r) => "end" in r), [false, true], "the notice the first crossing line brought, and the complete record");
  assert.deepEqual(h.last("execution")["ext"], { "mocon.ext": { redacted: true } });
  assert.deepEqual(h.last("crossing")["ext"], undefined, "a sibling's ext is its own");
  const loud = harness();
  assert.doesNotThrow(() => loud.m.execution.start({ program: "p", ext: { "v.cycle": cyclic() as never } }).complete());
  assertValidStream(loud.sink.lines);
});

/* ------------------------------------------------------------------ */
/* Across turns                                                        */
/* ------------------------------------------------------------------ */

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

test("a handle started again from an execution's own id, start and fields continues it: the notice repeats byte for byte, and one key per record", () => {
  const h = harness();
  const began = new Date(Date.now() - 1000).toISOString();
  const execution = { id: "run-1", start: began, program: "p", language: "python", context: { traceparent: TP }, ext: { "v.a": 1 } };
  const called = new Date(Date.now() - 500).toISOString();
  // Turn 1: the execution starts and a call begins; what the next turn needs is plain data the host already holds.
  const first = h.m.execution.start(execution);
  const call = { id: first.crossing.start({ target: "lookup", input: { q: 1 }, start: called, notice: true }).id, target: "lookup", input: { q: 1 }, seq: 1, start: called };
  const state = JSON.parse(JSON.stringify({ execution, call })) as { execution: typeof execution; call: typeof call };
  // Turn 2: the call settles and the execution ends.
  const second = h.m.execution.start({ ...state.execution, notice: false });
  second.crossing.start(state.call).output({ found: true });
  const unnumbered = second.crossing.start({ target: "later", input: 1 });
  second.complete({ result: "done" });

  assertValidStream(h.sink.lines);
  const notices = h.sink.lines.filter((l) => l.startsWith('{"kind":"execution"') && !l.includes('"end":'));
  assert.equal(notices.length, 2, "the second handle's first crossing line brought its notice");
  assert.equal(notices[0], notices[1], "and it is the first turn's notice, byte for byte");
  const view = fold(h.sink.lines);
  assert.deepEqual(view.conflicts, []);
  assert.deepEqual(view.unresolved, []);
  const settled = view.crossings[`example/mcp\0${state.call.id}`] as unknown as Rec;
  assert.equal(settled["start"], called, "the fields given at initiation are repeated");
  assert.equal(settled["seq"], 1);
  assert.deepEqual(settled["context"], { traceparent: TP });
  assert.equal((settled["end"] as Rec)["outcome"], "output");
  assert.equal(view.crossings[`example/mcp\0${unnumbered.id}`]?.seq, 2, "the handle's own numbering continues past the seq the turn passed, so it never repeats one");
  const complete = view.executions["example/mcp\0run-1"] as unknown as Rec;
  assert.equal(complete["start"], began);
  assert.deepEqual(complete["ext"], { "v.a": 1 });
  assert.equal((complete["end"] as Rec)["disposition"], "completed");
});

test("idempotence is per handle: two handles started from the same execution both write a complete record, which the host's settle path must prevent", () => {
  const h = harness();
  const execution = { id: "run-2", start: new Date().toISOString(), program: "p", notice: false };
  h.m.execution.start(execution).complete({ result: "a" });
  h.m.execution.start(execution).complete({ result: "b" });
  assert.deepEqual(fold(h.sink.lines).conflicts, [{ kind: "execution", host: "example/mcp", id: "run-2" }]);
});

test("core.md 10: one handle never writes a second complete record for a crossing it settled or abandoned, and carries no way to reopen one", () => {
  for (const close of ["settle", "end"] as const) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const c = ex.crossing.start({ target: "t", input: 1 });
    // The handle offers no ref and no resume: a closed crossing is reopened only by starting one with the same id (see README, Across turns).
    assert.equal((c as unknown as Rec)["ref"], undefined, "a crossing handle carries a ref again");
    assert.equal((ex.crossing as unknown as Rec)["resume"], undefined, "the crossing namespace carries a resume again");
    if (close === "settle") c.output(1);
    else ex.complete();
    c.output(2);
    c.error(new Error("later still"));
    const completes = h.ofKind("crossing").filter((r) => r["id"] === c.id && "end" in r);
    assert.equal(completes.length, 1, `after ${close}, the handle wrote ${completes.length} complete records: ${JSON.stringify(completes.map((r) => r["end"]))}`);
    // core.md 5.3: a settlement of an abandoned crossing is an event, never a second record for the key.
    const events = h.ofKind("event").filter((r) => r["crossing_id"] === c.id);
    assert.equal(events.length, close === "end" ? 1 : 0, JSON.stringify(events));
    assert.deepEqual(fold(h.sink.lines).conflicts, []);
    assertValidStream(h.sink.lines);
  }
});

/* ------------------------------------------------------------------ */
/* Scalars at the boundary                                             */
/* ------------------------------------------------------------------ */

test("seq counts from 1 on a started handle, continues past a host-supplied value, and is validated", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "a", input: 1, seq: 1 }).output(1);
  ex.crossing.start({ target: "b", input: 1 }).output(1);
  ex.crossing.start({ target: "c", input: 1, seq: 10 }).output(1);
  ex.crossing.start({ target: "d", input: 1 }).output(1);
  ex.crossing.start({ target: "e", input: 1, seq: 3 }).output(1);
  ex.crossing.start({ target: "f", input: 1 }).output(1);
  for (const seq of [NaN, Infinity, -1, 1.5, "2"]) {
    assert.throws(() => ex.crossing.start({ target: "t", input: 1, seq: seq as never }), RangeError, `seq ${String(seq)}`);
  }
  ex.complete();
  assert.deepEqual(
    h.ofKind("crossing").map((r) => r["seq"]),
    [1, 2, 10, 11, 3, 12],
  );
  assertValidStream(h.sink.lines);
});

test("a non-string id, language, session, traceparent, class or target is rejected before any state changes", () => {
  const cases: Array<[string, (m: ReturnType<typeof harness>["m"]) => void]> = [
    ["program", (m) => m.execution.start({ program: 42 as never })],
    ["execution id", (m) => m.execution.start({ program: "p", id: 42 as never })],
    ["language", (m) => m.execution.start({ program: "p", language: 7 as never })],
    ["context.session", (m) => m.execution.start({ program: "p", context: { session: 5 as never } })],
    ["context.traceparent", (m) => m.execution.start({ program: "p", context: { traceparent: 9 as never } })],
    ["context", (m) => m.execution.start({ program: "p", context: "s" as never })],
    ["ext", (m) => m.execution.start({ program: "p", ext: "s" as never })],
    ["crossing target", (m) => m.execution.start({ program: "p" }).crossing.start({ target: 1 as never, input: 1 })],
    ["crossing id", (m) => m.execution.start({ program: "p" }).crossing.start({ target: "t", input: 1, id: 7 as never })],
    ["crossing ext", (m) => m.execution.start({ program: "p" }).crossing.start({ target: "t", input: 1, ext: [] as never })],
  ];
  for (const [name, run] of cases) {
    const h = harness();
    assert.throws(() => run(h.m), TypeError, name);
    assertValidStream(h.sink.lines);
  }
});

test("a host-supplied start or time that is not RFC 3339 UTC with Z is rejected (core.md 7)", () => {
  const bad = ["yesterday", "2026-09-16T10:00:00.000", "2026-09-16 10:00:00Z", "2026-09-16T10:00:00.000+02:00", ""];
  const h = harness();
  for (const t of bad) {
    assert.throws(() => h.m.execution.start({ program: "p", notice: false, start: t }), RangeError, `start ${JSON.stringify(t)}`);
    const ex = h.m.execution.start({ program: "p", notice: false, start: "2026-09-16T09:00:00Z" });
    assert.throws(() => ex.complete({ time: t }), RangeError, `end.time ${JSON.stringify(t)}`);
    assert.throws(() => ex.crossing.start({ target: "t", input: 1, start: t }), RangeError, `crossing start ${JSON.stringify(t)}`);
    const c = ex.crossing.start({ target: "t", input: 1, start: "2026-09-16T10:00:00Z" });
    assert.throws(() => c.output(1, { time: t }), RangeError, `crossing end.time ${JSON.stringify(t)}`);
    c.output(1, { time: "2026-09-16T10:00:00.123456789Z" });
    ex.complete({ time: "2026-09-16T10:00:01Z" });
  }
  assertValidStream(h.sink.lines);
});

test("end.time is never earlier than start on the library's own clock, even when Date.now steps backwards", () => {
  const realNow = Date.now;
  let now = Date.UTC(2026, 8, 17, 10, 0, 0, 500);
  Date.now = () => now;
  try {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const c = ex.crossing.start({ target: "t", input: 1 });
    now -= 2000;
    c.output(1);
    ex.complete();
    const crossing = h.last("crossing");
    const execution = h.last("execution");
    assert.ok(((crossing["end"] as Rec)["time"] as string) >= (crossing["start"] as string), "crossing end.time >= start");
    assert.ok(((execution["end"] as Rec)["time"] as string) >= (execution["start"] as string), "execution end.time >= start");
  } finally {
    Date.now = realNow;
  }
});

test("traceparent is copied onto every crossing line; session is not", () => {
  const h = harness();
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const ex = h.m.execution.start({ program: "p", notice: false, context: { session: "s", traceparent: tp } });
  ex.crossing.start({ target: "a", input: 1 }).output(1);
  ex.complete();
  assert.deepEqual(h.last("crossing")["context"], { traceparent: tp });
  assert.deepEqual(h.last("execution")["context"], { session: "s", traceparent: tp });
  const h2 = harness();
  const ex2 = h2.m.execution.start({ program: "p", notice: false, context: { session: "s" } });
  ex2.crossing.start({ target: "a", input: 1 }).output(1);
  ex2.complete();
  assert.equal("context" in h2.last("crossing"), false);
});

test("a crossing opened after the execution ended is not tracked and is written when it settles", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.complete();
  const late = ex.crossing.start({ target: "late", input: 1 });
  assert.equal(h.ofKind("crossing").length, 0);
  late.output("x");
  assert.equal(h.ofKind("crossing").length, 1);
  assert.equal((h.last("crossing")["end"] as Rec)["outcome"], "output");
  assert.equal(h.ofKind("event").length, 0, "it was never abandoned, so its settlement is not late");
});

test("an outputs channel named __proto__ is written as an own key of the line", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.complete({ outputs: JSON.parse('{"__proto__":"leaked","stdout":"ok"}') as Record<string, unknown> });
  const outputs = (h.last("execution")["end"] as Rec)["outputs"] as Rec;
  assert.deepEqual(Object.keys(outputs), ["__proto__", "stdout"]);
  assert.equal(Object.getPrototypeOf(outputs), Object.prototype);
});

/* ------------------------------------------------------------------ */
/* Instance                                                            */
/* ------------------------------------------------------------------ */

test("declare writes the host line again byte for byte, with the version this package implements and the host's ext", () => {
  const h = harness();
  h.m.declare();
  assert.equal(h.sink.lines.length, 2);
  assert.equal(h.sink.lines[0], h.sink.lines[1]);
  assert.equal(
    h.sink.lines[0],
    '{"kind":"host","host":"example/mcp","spec_version":"1.0","observes_crossings":"all","unmediated_egress":false,"crossing_edge":"invocation","attested":["crossing.target","crossing.input"]}',
  );
  const ext = { "vendor.build": "1.2.3", "vendor.region": "eu-west-1" };
  const withExt = harness({ capabilities: { observes_crossings: "all", ext } });
  assert.equal(withExt.sink.lines[0], '{"kind":"host","host":"example/mcp","spec_version":"1.0","observes_crossings":"all","ext":{"vendor.build":"1.2.3","vendor.region":"eu-west-1"}}');
  assertValidStream(withExt.sink.lines);
  for (const spec_version of ["0.9", "2.0", "one"]) {
    const knob = harness({ capabilities: { observes_crossings: "all", spec_version } as never });
    assert.equal((knob.records()[0] as Rec)["spec_version"], "1.0", `a library that implements 1.0 declares 1.0, not ${spec_version}`);
  }
});

test("schema/host.json: capabilities.ext that does not serialize to an object is refused, never written as the host line's ext", () => {
  for (const ext of [{ toJSON: () => "vendor-build-42" }, new Date(0), [1, 2]]) {
    const sink = memorySink();
    assert.throws(
      () => mocon({ host: "example/mcp", capabilities: { observes_crossings: "all", ext: ext as never }, sinks: [sink] }),
      TypeError,
      `${JSON.stringify(ext)} was accepted, and the host line reads ${JSON.stringify((JSON.parse(sink.lines[0] ?? "{}") as Rec)["ext"])}`,
    );
  }
});

test("an instance with no sinks is inert but still mints ids and validates", () => {
  const m = mocon({ host: "h", capabilities: { observes_crossings: "none" }, sinks: [] });
  const ex = m.execution.start({ program: "p" });
  assert.match(ex.id, /^[0-9a-f]{32}$/);
  const c = ex.crossing.start({ target: "t", input: { big: "x".repeat(10) } });
  assert.match(c.id, /^[0-9a-f]{16}$/);
  c.output(1);
  ex.complete();
  c.output(2);
  m.declare();
  assert.throws(() => m.execution.start({ program: "p", start: "now" }), RangeError);
});

test("configuration errors surface at construction", () => {
  const sinks: Sink[] = [memorySink()];
  assert.throws(() => mocon({ host: "", capabilities: { observes_crossings: "all" }, sinks }), TypeError);
  assert.throws(() => mocon({ host: "h", capabilities: { observes_crossings: "most" as "all" }, sinks }), RangeError);
  assert.throws(() => mocon({ host: "h", capabilities: { observes_crossings: "all", attested: ["ext.magic" as "crossing.input"] }, sinks }), RangeError);
  assert.throws(() => mocon({ host: "h", capabilities: { observes_crossings: "all", crossing_edge: "middle" as never }, sinks }), RangeError);
  assert.throws(() => mocon({ host: "h", capabilities: { observes_crossings: "all", unmediated_egress: "no" as never }, sinks }), TypeError);
  assert.throws(() => mocon({ host: "h", capabilities: { observes_crossings: "all", ext: [] as never }, sinks }), TypeError);
  assert.throws(() => mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: {} as never }), TypeError);
});

test("core.md 5.1: each capability is read once, so the declaration carries the value the closed-set check saw and never a second reading", () => {
  /** A capabilities object whose `key` answers the first read with `member` and every later one with `after`. */
  const shifting = (key: string, member: unknown, after: unknown): Capabilities => {
    let read = 0;
    const caps: Record<string, unknown> = { observes_crossings: "all" };
    Object.defineProperty(caps, key, { enumerable: true, configurable: true, get: () => (read++ === 0 ? member : after) });
    return caps as unknown as Capabilities;
  };
  const shifts: Array<[key: string, member: unknown, after: unknown]> = [
    ["observes_crossings", "all", "most"],
    ["unmediated_egress", true, "false"],
    ["crossing_edge", "invocation", "sideways"],
    ["attested", ["crossing.target"], [7]],
  ];
  for (const [key, member, after] of shifts) {
    const sink = memorySink();
    mocon({ host: "example/mcp", capabilities: shifting(key, member, after), sinks: [sink] });
    const line = JSON.parse(sink.lines[0] ?? "{}") as Rec;
    assert.deepEqual(line[key], member, `${key} passed the check as ${JSON.stringify(member)} and the declaration reads ${JSON.stringify(line[key])}`);
    assertValidStream(sink.lines);
  }
  // The entries too: the array is copied once and the copy is both checked and written.
  const entries: unknown[] = [undefined];
  let read = 0;
  Object.defineProperty(entries, 0, { enumerable: true, configurable: true, get: () => (read++ === 0 ? "crossing.target" : 7) });
  const sink = memorySink();
  mocon({ host: "example/mcp", capabilities: { observes_crossings: "all", attested: entries as Attestation[] }, sinks: [sink] });
  assert.deepEqual((JSON.parse(sink.lines[0] ?? "{}") as Rec)["attested"], ["crossing.target"]);
  assertValidStream(sink.lines);
});

test("ids are unique across instances and within one", () => {
  const a = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [] });
  const b = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [] });
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    seen.add(a.execution.start({ program: "" }).id);
    seen.add(b.execution.start({ program: "" }).id);
  }
  assert.equal(seen.size, 1000);
});
