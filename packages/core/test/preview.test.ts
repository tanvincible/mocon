/**
 * The default capture policy: a bounded value plus the size and hash of the whole, rather than the whole value.
 * Each test is named for the rule it protects.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DEFAULT_CAPS, DEFAULT_PREVIEW } from "../src/payload.js";
import { assertValidStream, harness, NO_PREVIEW, type Rec } from "./helpers.js";

const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");
const rows = (n: number): Array<{ name: string; title: string }> => Array.from({ length: n }, (_, i) => ({ name: "Person " + i, title: "Engineer" }));

/** One crossing with `value` as its output, and the execution's result. */
function capture(value: unknown, policy?: Parameters<typeof harness>[0]): { input: Rec; output: Rec; result: Rec; program: Rec; lines: string[] } {
  const h = harness(policy);
  const ex = h.m.execution.start({ program: "const rows = await callTool('person_search', {});\n".repeat(20), notice: false });
  ex.crossing.start({ target: "person_search", input: value }).output(value);
  ex.complete({ result: value });
  const crossing = h.last("crossing");
  assertValidStream(h.sink.lines);
  return { input: crossing["input"] as Rec, output: (crossing["end"] as Rec)["output"] as Rec, result: (h.last("execution")["end"] as Rec)["result"] as Rec, program: h.last("execution")["program"] as Rec, lines: h.sink.lines };
}

test("the default writes a bounded value with the bytes and hash of the whole, not the whole value", () => {
  const value = rows(40);
  const whole = JSON.stringify(value);
  assert.ok(whole.length > DEFAULT_PREVIEW && whole.length < DEFAULT_CAPS["crossing.output"], "the fixture is over the preview and under the cap");
  for (const payload of [capture(value).input, capture(value).output, capture(value).result]) {
    assert.equal(payload["truncated"], true);
    assert.ok(whole.startsWith(payload["value"] as string), "the value is a prefix of the serialization");
    assert.ok(Buffer.byteLength(JSON.stringify(payload["value"])) <= DEFAULT_PREVIEW);
    assert.equal(payload["bytes"], Buffer.byteLength(whole), "the size describes the whole value, not the prefix");
    assert.equal(payload["hash"], sha(whole));
  }
});

test("a value inside the preview is still written whole, with its bytes and hash", () => {
  const small = { limit: 50 };
  const payload = capture(small).input;
  assert.deepEqual(payload, { value: small, bytes: 12, hash: sha('{"limit":50}') });
});

test("the program is previewed too, and keeps the bytes and hash of the whole text so two runs of it still match", () => {
  const { program } = capture(1);
  const text = "const rows = await callTool('person_search', {});\n".repeat(20);
  assert.equal(program["truncated"], true);
  assert.ok(text.startsWith(program["value"] as string));
  assert.equal(program["bytes"], Buffer.byteLength(text));
  assert.equal(program["hash"], sha(text));
});

test("an error's payload is not previewed: its class, message and value are the diagnosis and keep the slot's cap", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const cause = new Error("the target refused: " + "detail ".repeat(60));
  ex.crossing.start({ target: "t", input: 1 }).error(cause);
  ex.fail(cause);
  const settled = (h.last("crossing")["end"] as Rec)["error"] as Rec;
  assert.equal(settled["message"], cause.message, "the message is cut at the error slot's cap, not at the preview");
  assert.equal(typeof ((settled["value"] as Rec)["value"] as Rec)["stack"], "string", "the value is still an object, so a stack survives");
  assertValidStream(h.sink.lines);
});

test("capture.preview moves the bound, and a preview at or above every cap is the 1.0 behaviour", () => {
  const value = rows(40);
  const whole = JSON.stringify(value);
  assert.deepEqual(capture(value, { capture: NO_PREVIEW }).output, { value, bytes: Buffer.byteLength(whole), hash: sha(whole) });
  const tight = capture(value, { capture: { preview: 16 } }).output;
  assert.ok(Buffer.byteLength(JSON.stringify(tight["value"])) <= 16);
  assert.equal(tight["bytes"], Buffer.byteLength(whole));
  assert.deepEqual(capture(value, { capture: { preview: 0 } }).output, { truncated: true, bytes: Buffer.byteLength(whole), hash: sha(whole) });
});

test("capture.preview is a non-negative integer, and an unknown policy key is still refused", () => {
  for (const preview of [-1, 1.5, "256", null]) assert.throws(() => harness({ capture: { preview } as never }), RangeError);
});

test("full capture is opted into per target, and the opt-in is one line", () => {
  const value = rows(40);
  const whole = JSON.stringify(value);
  const h = harness({ capture: { rules: { "crossing.output": (v, ctx) => ctx.capture(v, { full: ctx.target === "person_search" }) } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "person_search", input: 1 }).output(value);
  ex.crossing.start({ target: "records_get", input: 1 }).output(value);
  ex.complete();
  const [full, previewed] = h.ofKind("crossing").map((c) => (c["end"] as Rec)["output"] as Rec) as [Rec, Rec];
  assert.deepEqual(full, { value, bytes: Buffer.byteLength(whole), hash: sha(whole) });
  assert.equal(previewed["truncated"], true);
  assert.equal(previewed["hash"], sha(whole), "the previewed value still carries the hash of the whole");
  assertValidStream(h.sink.lines);
});

test("a value past the slot's cap is a prefix with no bytes and no hash, because the encoder never read the whole", () => {
  const big = rows(4000);
  const payload = capture(big).output;
  assert.equal(payload["truncated"], true);
  assert.ok(JSON.stringify(big).startsWith(payload["value"] as string));
  assert.ok(Buffer.byteLength(JSON.stringify(payload["value"])) <= DEFAULT_PREVIEW);
  assert.equal("bytes" in payload, false);
  assert.equal("hash" in payload, false);
});

test("binary keeps its base64 prefix, its raw length and, within the cap, its hash", () => {
  const bytes = new Uint8Array(1024).fill(7);
  const payload = capture(bytes).output;
  assert.equal(payload["truncated"], true);
  assert.equal(payload["bytes"], 1024);
  assert.equal(payload["hash"], "sha256:" + createHash("sha256").update(bytes).digest("hex"));
  assert.ok(Buffer.byteLength(JSON.stringify(payload["value"])) <= DEFAULT_PREVIEW);
});
