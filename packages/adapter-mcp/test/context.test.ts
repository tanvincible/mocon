import assert from "node:assert/strict";
import { test } from "node:test";
import { contextFromMcp } from "../src/index.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

test("contextFromMcp reads sessionId and _meta.traceparent verbatim", () => {
  assert.deepEqual(contextFromMcp({ sessionId: "s-1", _meta: { traceparent: TP } }), { session: "s-1", traceparent: TP });
});

test("contextFromMcp omits what is absent", () => {
  assert.deepEqual(contextFromMcp({}), {});
  assert.deepEqual(contextFromMcp({ sessionId: "s-1" }), { session: "s-1" });
  assert.deepEqual(contextFromMcp({ _meta: { traceparent: TP } }), { traceparent: TP });
  assert.deepEqual(contextFromMcp({ _meta: { progressToken: 7 } }), {});
});

test("contextFromMcp copies a malformed traceparent and drops a non-string one", () => {
  assert.deepEqual(contextFromMcp({ _meta: { traceparent: "not-a-header" } }), { traceparent: "not-a-header" });
  assert.deepEqual(contextFromMcp({ _meta: { traceparent: 42 } }), {});
  assert.deepEqual(contextFromMcp({ sessionId: 7 as unknown as string }), {});
});

test("contextFromMcp relays a value of up to 256 characters and drops a longer one whole, never a prefix", () => {
  const atCap = "t".repeat(256);
  const overCap = "t".repeat(257);
  assert.deepEqual(contextFromMcp({ sessionId: atCap, _meta: { traceparent: atCap } }), { session: atCap, traceparent: atCap });
  assert.deepEqual(contextFromMcp({ sessionId: overCap, _meta: { traceparent: overCap } }), {});
  assert.deepEqual(contextFromMcp({ sessionId: "s-1", _meta: { traceparent: TP + "-".repeat(1 << 20) } }), { session: "s-1" }, "one oversized field costs only that field");
});

test("contextFromMcp tolerates a _meta that is null or not an object", () => {
  assert.deepEqual(contextFromMcp({ _meta: null as unknown as undefined }), {});
  assert.deepEqual(contextFromMcp({ _meta: "traceparent" as unknown as undefined }), {});
});
