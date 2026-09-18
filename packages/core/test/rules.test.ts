/**
 * A Payload that did not come out of the encoder, the one a capture rule
 * returned, is read once, checked, and written from the fields that were
 * read, with `value` through the default encoder under the slot's cap. It
 * is never serialized as an object, so its own `toJSON` never runs and a
 * `value` that serializes to nothing never leaves the record without one:
 * such a Payload is written as `{"redacted":true}`. A rule that returns
 * what `ctx.capture` gave it writes exactly what the default encoder
 * writes, its `mocon.encoding` note included.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { memorySink, mocon, type Payload } from "../src/index.js";
import { assertValidStream, harness, lineErrors, type Rec } from "./helpers.js";

test("a rule that keeps the raw value writes a valid Payload when the program passes a function, a symbol or a toJSON that yields nothing", () => {
  const h = harness({ capture: { rules: { "crossing.input": (v) => ({ value: v }) as never } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: string, _arg: unknown) => "ok");
  call("t", () => 1);
  call("t", Symbol("s"));
  call("t", { toJSON: () => undefined });
  ex.complete();
  for (const line of h.ofKind("crossing")) assert.deepEqual(line["input"], { redacted: true });
  assertValidStream(h.sink.lines);
});

test("a rule's Payload is written as the Payload that was checked, not as what its toJSON returns", () => {
  const h = harness({ capture: { rules: { "crossing.output": (v) => v as never } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: string, out: unknown) => out);
  call("t", { value: 1, toJSON: () => "forged" });
  call("t", { redacted: true, toJSON: () => 5 });
  ex.complete();
  const [first, second] = h.ofKind("crossing").map((line) => (line["end"] as Rec)["output"]);
  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(second, { redacted: true });
  assertValidStream(h.sink.lines);
});

test("a rule that wraps a program value whose toJSON yields undefined writes a valid Payload, and a pass-through rule never throws into the host", () => {
  const sink = memorySink();
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink], capture: { rules: { result: (v) => ({ value: v as never }), "crossing.input": (v) => v as never } } });
  const ex = m.execution.start({ program: "return x", notice: false });
  const tool = ex.instrument((_name: string, _args: unknown) => 1);
  assert.doesNotThrow(() => tool("t", { value: 1, toJSON: () => "not a payload" }));
  ex.complete({ result: { toJSON: () => undefined } });
  for (const line of sink.lines) assert.deepEqual(lineErrors(JSON.parse(line) as unknown), [], line);
});

const unserializable: Array<[string, unknown]> = [
  ["a function", () => 1],
  ["a symbol", Symbol("s")],
  ["an object whose toJSON returns undefined", { toJSON: () => undefined }],
];

for (const [name, value] of unserializable) {
  test(`a crossing output rule returning { value: ${name} } writes { redacted: true }`, () => {
    const h = harness({ capture: { rules: { "crossing.output": () => ({ value }) as unknown as Payload } } });
    const ex = h.m.execution.start({ program: "p", notice: false });
    ex.crossing.start({ target: "t", input: 1 }).output(5);
    assertValidStream(h.sink.lines);
    assert.deepEqual((h.last("crossing")["end"] as Rec)["output"], { redacted: true });
  });

  test(`a program rule returning { value: ${name} } writes a valid Payload on the notice and the complete record`, () => {
    const h = harness({ capture: { rules: { program: () => ({ value }) as unknown as Payload } } });
    h.m.execution.start({ program: "p" }).complete();
    assertValidStream(h.sink.lines);
    for (const line of h.ofKind("execution")) assert.deepEqual(line["program"], { redacted: true });
  });
}

test("a rule's Payload is written from the fields read, never from what its toJSON returns", () => {
  const h = harness({
    capture: {
      rules: {
        "crossing.input": () => ({ value: 1, toJSON: () => "forged" }) as unknown as Payload,
        "crossing.output": () => ({ redacted: true, toJSON: () => [1] }) as unknown as Payload,
      },
    },
  });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: "the real input" }).output("the real output");
  ex.complete();
  const crossing = h.last("crossing");
  assert.deepEqual(crossing["input"], { value: 1 });
  assert.deepEqual((crossing["end"] as Rec)["output"], { redacted: true });
  assertValidStream(h.sink.lines);
});

test("a rule that delegates a binary output to ctx.capture writes the Payload and the mocon.encoding note the default encoder writes", () => {
  const bytes = Buffer.from("hello");
  const plain = harness();
  const ruled = harness({ capture: { rules: { "crossing.output": (v, ctx) => ctx.capture(v) } } });
  for (const h of [plain, ruled]) {
    const ex = h.m.execution.start({ program: "p", notice: false });
    ex.crossing.start({ target: "t", input: null }).output(bytes);
    ex.complete();
  }
  const expected = plain.last("crossing");
  const actual = ruled.last("crossing");
  assert.deepEqual((actual["end"] as Rec)["output"], (expected["end"] as Rec)["output"]);
  assert.deepEqual(actual["ext"], expected["ext"]);
  assert.deepEqual(actual["ext"], { "mocon.encoding": { output: "base64" } });
});

test("core.md 5.4: binary a rule puts in a Payload of its own is written as base64 with the mocon.encoding note, not as bare base64", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const hand = (): Payload => ({ value: png, redacted: true }) as never;
  const h = harness({ capture: { rules: { "crossing.output": hand, result: hand } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "render", input: 1 }).output("the real image");
  ex.complete({ result: "the real image" });
  const crossing = h.last("crossing");
  const execution = h.last("execution");
  assert.equal(((crossing["end"] as Rec)["output"] as Rec)["value"], png.toString("base64"), "the rule's binary travels as base64");
  assert.deepEqual(crossing["ext"], { "mocon.encoding": { output: "base64" } }, `crossing ext: ${JSON.stringify(crossing["ext"])}`);
  assert.equal(((execution["end"] as Rec)["result"] as Rec)["value"], png.toString("base64"));
  assert.deepEqual(execution["ext"], { "mocon.encoding": { result: "base64" } }, `execution ext: ${JSON.stringify(execution["ext"])}`);
  assertValidStream(h.sink.lines);
});

test("a result rule that delegates a binary result to ctx.capture keeps the note, and the Payload it returns is frozen", () => {
  let returned: Payload | undefined;
  const h = harness({ capture: { rules: { result: (v, ctx) => (returned = ctx.capture(v)) } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.complete({ result: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(h.last("execution")["ext"], { "mocon.encoding": { result: "base64" } });
  assert.ok(returned !== undefined && Object.isFrozen(returned));
});

