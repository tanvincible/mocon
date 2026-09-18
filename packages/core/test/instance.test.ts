/**
 * The instance runtime on its own: the sink fan-out behind `emit`, the
 * declaration, flush and close phases, the closed state, and the promise
 * helpers the wrappers use.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createRuntime, follow, watch } from "../src/instance.js";
import { Capturer } from "../src/payload.js";
import type { Sink, SinkPhase } from "../src/types.js";

const DECLARATION = '{"kind":"host","host":"h"}';

function recording(): { sink: Sink; lines: string[]; calls: string[] } {
  const lines: string[] = [];
  const calls: string[] = [];
  return {
    lines,
    calls,
    sink: {
      write: (batch) => {
        calls.push("write");
        lines.push(...batch);
      },
      flush: () => void calls.push("flush"),
      close: () => void calls.push("close"),
    },
  };
}

test("declare writes the declaration to every sink; emit hands each batch to every sink in order, unchanged", () => {
  const a = recording();
  const b = recording();
  const runtime = createRuntime("h", DECLARATION, [a.sink, b.sink], new Capturer(undefined), undefined);
  assert.equal(runtime.inst.inert, false);
  assert.equal(runtime.inst.host, "h");
  assert.equal(runtime.inst.hostText, '"h"');
  runtime.declare();
  runtime.inst.emit(["one", "two"]);
  runtime.inst.emit(["three"]);
  for (const r of [a, b]) {
    assert.deepEqual(r.lines, [DECLARATION, "one", "two", "three"]);
    assert.deepEqual(r.calls, ["write", "write", "write"], "one write per batch");
  }
});

test("an instance with no sinks is inert: declare writes nothing and close resolves", async () => {
  const runtime = createRuntime("h", DECLARATION, [], new Capturer(undefined), undefined);
  assert.equal(runtime.inst.inert, true);
  runtime.declare();
  await runtime.flush();
  await runtime.close();
});

test("flush and close reach every sink once, and a write after close is dropped and reported per sink with its phase", async () => {
  const a = recording();
  const b = recording();
  const reports: Array<[Sink, number, SinkPhase]> = [];
  const runtime = createRuntime("h", DECLARATION, [a.sink, b.sink], new Capturer(undefined), (_e, ctx) => reports.push([ctx.sink, ctx.lines, ctx.phase]));
  runtime.declare();
  await runtime.flush();
  await runtime.close();
  await runtime.close();
  runtime.inst.emit(["late", "later"]);
  for (const r of [a, b]) assert.deepEqual(r.calls, ["write", "flush", "flush", "close"]);
  assert.deepEqual(reports, [
    [a.sink, 2, "write"],
    [b.sink, 2, "write"],
  ]);
});

test("watch attaches to a native promise from any realm through the intrinsic then, and leaves every other value, a thenable included, untouched", async () => {
  const seen: unknown[] = [];
  let reads = 0;
  const thenable = {
    get then() {
      reads++;
      return () => void seen.push("called");
    },
  };
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  for (const v of [null, undefined, 1, "then", {}, { then: 1 }, thenable, proxy]) assert.equal(watch(v, () => void seen.push("wrong")), false);
  assert.equal(reads, 0, "a thenable's then is never read");

  const own = Promise.reject(new Error("own realm"));
  own.then = () => {
    throw new Error("a then the promise carries is never called");
  };
  assert.equal(watch(own, (e) => void seen.push((e as Error).message)), true);
  const foreign = runInNewContext("Promise.resolve(7)") as Promise<number>;
  assert.equal(watch(foreign, () => void seen.push("wrong"), () => void seen.push("foreign value")), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["own realm", "foreign value"]);

  const constructorThrows = Promise.resolve(1);
  Object.defineProperty(constructorThrows, "constructor", {
    get() {
      throw new Error("no constructor");
    },
  });
  assert.equal(watch(constructorThrows, (e) => void seen.push((e as Error).message)), true);
  assert.equal(seen.at(-1), "no constructor", "the throw await would reject with reaches onError");
});

test("follow records a native promise's outcome and returns the derived promise, which settles the same way; anything else is recorded at once and returned as it is", async () => {
  const seen: unknown[] = [];
  const record = {
    value: (v: unknown) => void seen.push(["value", v]),
    error: (e: unknown) => void seen.push(["error", (e as Error).message]),
  };
  const lazy = { then: () => void seen.push(["then called"]) };
  assert.equal(follow(lazy, record.value, record.error), lazy);
  assert.equal(follow(3, record.value, record.error), 3);
  assert.deepEqual(seen, [
    ["value", lazy],
    ["value", 3],
  ]);

  const fulfilled = Promise.resolve("ok");
  const derived = follow(fulfilled, record.value, record.error);
  assert.notEqual(derived, fulfilled);
  assert.equal(await derived, "ok");
  const boom = new Error("boom");
  await assert.rejects(follow(Promise.reject(boom), record.value, record.error), (e) => e === boom);
  assert.deepEqual(seen.slice(2), [
    ["value", "ok"],
    ["error", "boom"],
  ]);
});
