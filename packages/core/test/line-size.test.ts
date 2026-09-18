/**
 * core.md 3: lines SHOULD be under 1 MiB. A cap bounds what its value adds
 * to a line as written, escapes included, and the payloads of a complete
 * execution record share one budget with the line's head, in the order
 * error, result, outputs. So under the default caps no line this package
 * writes passes 1 MiB, whatever the program's text holds and however many
 * output channels the host passes, apart from what the host itself
 * supplies: host string, ids, language, context, error class, channel
 * names and ext.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertValidStream, harness, type Rec } from "./helpers.js";

const MiB = 1 << 20;
const KiB = 1 << 10;

function largest(lines: readonly string[]): number {
  return Math.max(...lines.map((l) => Buffer.byteLength(l)));
}

for (const [name, char] of [
  ["quote characters", '"'],
  ["newlines", "\n"],
  ["control characters", String.fromCharCode(1)],
] as const) {
  test(`a program of ${name} within the default program cap stays under 1 MiB on the wire`, () => {
    const h = harness();
    h.m.execution.start({ program: char.repeat(700 * KiB) }).complete();
    assert.ok(largest(h.sink.lines) < MiB, `largest line is ${largest(h.sink.lines)} bytes`);
    assertValidStream(h.sink.lines);
  });
}

test("a complete execution with a large program, a result, an error and twelve output channels stays under 1 MiB", () => {
  const h = harness();
  const fill = "a".repeat(64 * KiB);
  const outputs: Record<string, string> = {};
  for (let i = 0; i < 12; i++) outputs["channel" + i] = fill;
  h.m.execution.start({ program: "a".repeat(760 * KiB), notice: false }).fail(new Error("e".repeat(64 * KiB)), { result: fill, outputs });
  const line = h.sink.lines.at(-1) as string;
  assert.ok(Buffer.byteLength(line) < MiB, `the complete record is ${Buffer.byteLength(line)} bytes`);
  const end = (JSON.parse(line) as Rec)["end"] as Rec;
  assert.equal(Object.keys(end["outputs"] as Rec).length, 12, "every channel is still recorded, cut to what the line has left");
  assertValidStream(h.sink.lines);
});
