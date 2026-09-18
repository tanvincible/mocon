/**
 * The cause rule (types.ts, cause.ts): what `fail(cause)` and
 * `error(cause)` write for each shape of cause, and that nothing a
 * program can throw makes the rule itself throw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { errorInput } from "../src/cause.js";
import { assertValidStream, harness, type Rec } from "./helpers.js";

/** The plain object the cause rule makes of a native error. */
const plain = (value: unknown): Rec => value as Rec;

const throwingMessage = (): object => ({
  get message() {
    throw new Error("getter");
  },
});

test("Error, primitive, nullish and plain object causes", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const inner = new RangeError("inner");
  ex.crossing.start({ target: "a", input: 1 }).error(new Error("outer", { cause: inner }));
  ex.crossing.start({ target: "b", input: 1 }).error("just text");
  ex.crossing.start({ target: "c", input: 1 }).error(null);
  ex.crossing.start({ target: "d", input: 1 }).error({ isError: true, content: [], message: "tool said no" }, { class: "refused" });
  ex.crossing.start({ target: "e", input: 1 }).error({ ok: false, status: 503 });
  ex.crossing.start({ target: "f", input: 1 }).error(Symbol("sym"));
  ex.fail(42, { class: "resource_limit" });
  assertValidStream(h.sink.lines);
  const errors = h.ofKind("crossing").map((r) => (r["end"] as Rec)["error"] as Rec);
  const [a, b, c, d, e, f] = errors as [Rec, Rec, Rec, Rec, Rec, Rec];
  assert.equal(a["message"], "outer");
  const av = (a["value"] as Rec)["value"] as Rec;
  assert.equal(av["name"], "Error");
  assert.equal((av["cause"] as Rec)["name"], "RangeError");
  assert.equal((av["cause"] as Rec)["message"], "inner");
  assert.deepEqual(b, { class: "capability_error", message: "just text" });
  assert.deepEqual(c, { class: "capability_error" });
  assert.equal(d["class"], "refused");
  assert.equal(d["message"], "tool said no");
  assert.deepEqual((d["value"] as Rec)["value"], { isError: true, content: [], message: "tool said no" });
  assert.equal("message" in e, false);
  assert.deepEqual((e["value"] as Rec)["value"], { ok: false, status: 503 });
  assert.deepEqual(f, { class: "capability_error", message: "Symbol(sym)" });
  assert.deepEqual((h.last("execution")["end"] as Rec)["error"], { class: "resource_limit", message: "42" });
});

test("an Error's own enumerable properties survive in value: an MCP error's code and data, a system error's errno and syscall", () => {
  class McpError extends Error {
    code: number;
    data: unknown;
    constructor(code: number, message: string, data: unknown) {
      super(message);
      this.name = "McpError";
      this.code = code;
      this.data = data;
    }
  }
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: 1 }).error(new McpError(-32602, "Invalid params", { field: "query" }));
  ex.fail(Object.assign(new Error("open failed"), { code: "ENOENT", errno: -2, syscall: "open", inner: new TypeError("nested") }));
  const crossingValue = (((h.last("crossing")["end"] as Rec)["error"] as Rec)["value"] as Rec)["value"] as Rec;
  const executionValue = (((h.last("execution")["end"] as Rec)["error"] as Rec)["value"] as Rec)["value"] as Rec;
  assert.equal(crossingValue["name"], "McpError");
  assert.equal(crossingValue["code"], -32602);
  assert.deepEqual(crossingValue["data"], { field: "query" });
  assert.equal(executionValue["code"], "ENOENT");
  assert.equal(executionValue["syscall"], "open");
  assert.equal((executionValue["inner"] as Rec)["name"], "TypeError", "a nested error in an own property is converted too");
  assertValidStream(h.sink.lines);
});

test("an Error whose message is not a string gets no message field, so the line validates", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: 1 }).error(Object.assign(new Error("x"), { message: 42 as unknown as string }));
  ex.fail(Object.assign(new Error("y"), { message: { nested: true } as unknown as string }));
  assertValidStream(h.sink.lines);
  assert.equal("message" in ((h.last("crossing")["end"] as Rec)["error"] as Rec), false);
});

test("an Error from another realm (node:vm) keeps its name, message and stack", () => {
  const foreign = runInNewContext("new TypeError('boom')") as Error;
  assert.equal(foreign instanceof Error, false, "precondition: a vm Error is not an instance of the host's Error");
  assert.ok(types.isNativeError(foreign));
  const out = errorInput({ class: "runtime", cause: foreign });
  assert.equal(out.message, "boom");
  const value = plain(out.value);
  assert.equal(value["name"], "TypeError");
  assert.equal(typeof value["stack"], "string");
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: 1 }).error(runInNewContext("new RangeError('vm range')", {}));
  ex.complete();
  const error = (h.last("crossing")["end"] as Rec)["error"] as Rec;
  assert.equal(error["message"], "vm range");
  assert.equal(((error["value"] as Rec)["value"] as Rec)["name"], "RangeError");
});

test("the rule never throws: throwing getters, throwing traps, a throwing stack, and a 200k-deep cause chain", () => {
  const stackless = new Error("x");
  Object.defineProperty(stackless, "stack", {
    get() {
      throw new Error("no stack");
    },
  });
  let chain: Error = new Error("root");
  for (let i = 0; i < 200_000; i++) chain = new Error("link", { cause: chain });
  const cyclic = new Error("a");
  cyclic.cause = cyclic;
  const hostile: unknown[] = [
    throwingMessage(),
    new Proxy({}, { getPrototypeOf: () => { throw new Error("no prototype for you"); } }),
    new Proxy({}, { get: () => { throw new Error("no get"); }, ownKeys: () => { throw new Error("no keys"); } }),
    stackless,
    chain,
    cyclic,
    Object.defineProperty(new Error("own"), "bad", {
      enumerable: true,
      get(): number {
        throw new Error("own getter");
      },
    }),
  ];
  for (const cause of hostile) {
    let out: ReturnType<typeof errorInput> | undefined;
    assert.doesNotThrow(() => {
      out = errorInput({ class: "runtime", cause });
    });
    assert.equal(out?.class, "runtime");
  }
  const stackOut = plain(errorInput({ class: "runtime", cause: stackless }).value);
  assert.equal(stackOut["message"], "x", "a throwing stack costs only the stack");
  assert.equal("stack" in stackOut, false);
  let depth = 0;
  for (let v: Rec | undefined = plain(errorInput({ class: "runtime", cause: chain }).value); v !== undefined; v = v["cause"] as Rec | undefined) depth++;
  assert.equal(depth, 33, "the chain is cut after 32 levels below the error itself");
  assert.equal("cause" in plain(errorInput({ class: "runtime", cause: cyclic }).value), false, "a cycle is cut");

  const h = harness();
  for (const cause of hostile) {
    const ex = h.m.execution.start({ program: "p", notice: false });
    const c = ex.crossing.start({ target: "t", input: 1 });
    assert.doesNotThrow(() => c.error(cause));
    assert.doesNotThrow(() => ex.fail(cause));
    assert.equal((h.last("crossing")["end"] as Rec)["outcome"], "error");
    assert.equal((h.last("execution")["end"] as Rec)["disposition"], "failed");
  }
  assertValidStream(h.sink.lines);
});

test("end applies the rule to error.cause, the way fail and error do, and a message or value given beside the cause wins", () => {
  const caught = new Error("outer", { cause: new RangeError("root") });
  const h = harness();
  const errorOf = (kind: string): Rec => (h.last(kind)["end"] as Rec)["error"] as Rec;

  const viaShorthand = h.m.execution.start({ program: "p", notice: false });
  viaShorthand.crossing.start({ target: "t", input: 1 }).error(caught, { class: "refused" });
  viaShorthand.fail(caught, { class: "cancelled" });
  const [crossingByShorthand, executionByShorthand] = [errorOf("crossing"), errorOf("execution")];

  const viaEnd = h.m.execution.start({ program: "p", notice: false });
  viaEnd.crossing.start({ target: "t", input: 1 }).end({ outcome: "error", error: { class: "refused", cause: caught } });
  viaEnd.end({ disposition: "terminated", error: { class: "cancelled", cause: caught } });
  assert.deepEqual(errorOf("crossing"), crossingByShorthand);
  assert.deepEqual(errorOf("execution"), executionByShorthand);
  assert.equal((((errorOf("execution")["value"] as Rec)["value"] as Rec)["cause"] as Rec)["name"], "RangeError");

  h.m.execution.start({ program: "p", notice: false }).end({ disposition: "terminated", error: { class: "cancelled", message: "user cancelled", cause: 42 } });
  assert.deepEqual(errorOf("execution"), { class: "cancelled", message: "user cancelled" });
  h.m.execution.start({ program: "p", notice: false }).end({ disposition: "failed", error: { class: "runtime", value: { code: 7 }, cause: new Error("e") } });
  assert.equal(errorOf("execution")["message"], "e");
  assert.deepEqual((errorOf("execution")["value"] as Rec)["value"], { code: 7 });

  let read = 0;
  const watched = {
    get message(): string {
      read++;
      return "m";
    },
  };
  const open = h.m.execution.start({ program: "p", notice: false });
  assert.throws(() => open.end({ disposition: "failed", error: { class: 5 as unknown as string, cause: watched } }), TypeError);
  assert.equal(read, 0, "the class is checked before the cause is read");
  open.end({ disposition: "failed", error: { class: "runtime", cause: watched } });
  assert.equal(errorOf("execution")["message"], "m", "the rejected call left the handle open");
  assertValidStream(h.sink.lines);
});
