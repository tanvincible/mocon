/**
 * `hash-only` reads a value in full, but not without bound: the walk stops
 * at 8 MiB of serialization or 256 levels of nesting and redacts the slot
 * instead, so a value a program builds for free cannot exhaust the host's
 * heap. Three such values, each fatal to an unbounded walk:
 *
 * - `new Array(2 ** 32 - 1)`, which would be written as `null,` until the
 *   heap is gone;
 * - `{ toJSON() { return { a: this } } }`, which nests forever;
 * - an array whose element's `toJSON` pushes another element, which never
 *   ends if the array's length is read again on every step.
 *
 * An out-of-memory abort is uncatchable, so each case runs in a child with
 * a 64 MB heap, where it would arrive in about a second.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { harness, type Rec } from "./helpers.js";

const child = fileURLToPath(new URL("./children/hash-only-walk.mjs", import.meta.url));

function runChild(name: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--max-old-space-size=64", "--import", "tsx", child, name], { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

test("the child harness hashes an ordinary value under hash-only within the small heap", () => {
  const r = runChild("plain");
  assert.equal(r.status, 0, r.stderr);
  const input = JSON.parse(r.stdout) as Rec;
  assert.equal(input["redacted"], true);
  assert.equal(input["bytes"], Buffer.byteLength('{"a":[1,2,3]}'));
});

for (const name of ["sparse", "selfNesting", "growing"]) {
  test(`hash-only on a program-built value (${name}) redacts the slot instead of aborting the host process`, () => {
    const r = runChild(name);
    assert.equal(r.signal, null, `the child was killed by ${r.signal}`);
    assert.equal(r.status, 0, `the host process exited with status ${r.status} (134 is V8's fatal out-of-memory abort): ${r.stderr.slice(0, 400)}`);
    const input = JSON.parse(r.stdout) as Rec;
    assert.equal(input["redacted"], true);
  });
}

test("hash-only redacts a string whose serialization passes 8 MiB although its length in units is under it", () => {
  const h = harness({ capture: { rules: { "crossing.input": "hash-only" } } });
  const ex = h.m.execution.start({ program: "p", notice: false });
  // Six bytes of serialization per UTF-16 unit: the ceiling counts the bytes written, not the characters read.
  const value = String.fromCharCode(1).repeat(2_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 8 << 20, "control: the serialization is past the ceiling");
  ex.crossing.start({ target: "t", input: value, notice: true });
  const input = h.last("crossing")["input"] as Rec;
  assert.deepEqual(input, { redacted: true }, `hash-only described ${String(input["bytes"])} bytes past the 8 MiB ceiling`);
});
