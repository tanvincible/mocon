/**
 * Performance shapes that belong in `npm test`. Mapping runs inside the
 * sink's `write`, which the emitter calls on the host's request path, so
 * what must hold is that the cost stays proportional to the line: a write
 * costs a small multiple of the mapping it does, a 1 KiB value a small
 * multiple of a one-byte value, a 5 MB value the same per byte as a 50 KB
 * one, and a 200,000-deep value the same per level as a 2,000-deep one.
 *
 * Every bound is a ratio between two measurements taken in the same run on
 * the same machine, each the fastest of several rounds after a warmup, and
 * every bound is at least five times what a healthy run measures. A busy
 * machine moves both numbers and fails nothing; work gone quadratic moves
 * one of them by far more than the bound. An absolute microsecond figure
 * is a reading of one machine and is not asserted here: the ones worth
 * keeping are in the README, with the machine that produced them, and
 * `bench/hot-path.mjs` gates the emitter's.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { otlpSink, type FetchLike } from "../src/index.js";
import { crossing, mapped, spanOf } from "./helpers.js";

/** A collector that answers at once and costs the measurement nothing of its own: a stand-in that read the body would be timed along with the sink. */
const quiet: FetchLike = async () => ({ ok: true, status: 200, body: null });

/**
 * Microseconds per call of each function: the fastest round, after a
 * warmup round that is not measured. The fastest round is the one the
 * machine interfered with least, which is the reading that depends on this
 * code alone. The functions are timed round by round in turn, so a machine
 * that slows down partway through slows all of them.
 */
function fastest(fns: Array<() => void>, perRound: number, rounds = 7): number[] {
  const best = fns.map(() => Infinity);
  for (let r = 0; r <= rounds; r++) {
    fns.forEach((fn, i) => {
      const t0 = process.hrtime.bigint();
      for (let k = 0; k < perRound; k++) fn();
      const micros = Number(process.hrtime.bigint() - t0) / perRound / 1000;
      if (r > 0 && micros < (best[i] as number)) best[i] = micros;
    });
  }
  return best;
}

/** A complete crossing line whose output value is the given JSON text. */
const lineWith = (valueText: string): string => JSON.stringify(crossing({}, { output: { value: 0 } })).replace('"output":{"value":0}', `"output":{"value":${valueText}}`);
const items = (n: number, extraKey = ""): string => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: "item " + i }))).replaceAll('{"id"', `{${extraKey}"id"`);

/** A line that maps to a span, so a measurement below cannot be timing the skip path. */
function measurable(line: string): string {
  assert.equal(spanOf(mapped(line).request).name, "company_identify");
  return line;
}

test("a sink write costs a small multiple of the mapping it does, and a 1 KiB value a small multiple of a one-byte value", async () => {
  const kib = measurable(lineWith(JSON.stringify({ text: "x".repeat(1000) })));
  const byte = measurable(lineWith(JSON.stringify({ text: "x" })));
  const [one, thousand] = fastest([() => mapped(byte), () => mapped(kib)], 200, 9) as [number, number];
  // A thousand bytes more to parse, write and hand back: a line of this size is almost all fixed cost, so a healthy run measures about 1.2.
  assert.ok(thousand / one < 6, `mapping: ${one.toFixed(1)} us for one byte, ${thousand.toFixed(1)} us for 1 KiB, ${(thousand / one).toFixed(2)}x`);

  // The synchronous part of a write, the part on the request path, in rounds that stay under the in-flight bound.
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: quiet });
  let write = Infinity;
  for (let r = 0; r <= 12; r++) {
    const pending: Array<void | Promise<void>> = [];
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 50; k++) pending.push(sink.write([kib]));
    const micros = Number(process.hrtime.bigint() - t0) / 50 / 1000;
    if (r > 0 && micros < write) write = micros;
    await Promise.all(pending);
  }
  // The write maps the line, serializes the request and starts the POST: a healthy run measures about 1.7 times the mapping alone.
  assert.ok(write / thousand < 10, `write: ${write.toFixed(1)} us against ${thousand.toFixed(1)} us of mapping, ${(write / thousand).toFixed(2)}x`);
});

test("mapping cost is proportional to line size: a 5 MB value costs per byte what a 50 KB value costs, with and without array-index keys", () => {
  for (const extraKey of ["", '"7":0,']) {
    const small = measurable(lineWith(items(1_500, extraKey)));
    const large = measurable(lineWith(items(150_000, extraKey)));
    const [s, l] = fastest([() => mapped(small), () => mapped(large)], 1, 3) as [number, number];
    // A hundred times the bytes: a healthy run measures about 1.2 per byte, 1.7 with the array-index keys that cost a second parse, and quadratic work would measure about 100.
    const ratio = l / large.length / (s / small.length);
    assert.ok(ratio < 10, `${extraKey === "" ? "plain" : "array-index keys"}: ${s.toFixed(0)} us for ${small.length} bytes, ${l.toFixed(0)} us for ${large.length} bytes, per-byte ratio ${ratio.toFixed(2)}`);
  }
});

test("mapping cost is proportional to nesting depth: a 200,000-deep value costs per level what a 2,000-deep value costs", () => {
  const SHALLOW = 2_000;
  const DEEP = 200_000;
  for (const [open, close] of [
    ["[", "]"],
    ['{"1":', "}"],
  ] as const) {
    const at = (depth: number): string => lineWith(open.repeat(depth) + "0" + close.repeat(depth));
    // Both map in full, past the depth `JSON.stringify` can recurse to, which is what makes the deep reading a reading of this code.
    const shallow = measurable(at(SHALLOW));
    const deep = measurable(at(DEEP));
    const [s, d] = fastest([() => mapped(shallow), () => mapped(deep)], 1, 3) as [number, number];
    // A hundred times the depth: a healthy run measures about 2 per level, quadratic work would measure about 100.
    const ratio = d / DEEP / (s / SHALLOW);
    assert.ok(ratio < 10, `${open}: ${(s / 1000).toFixed(1)} ms at depth ${SHALLOW}, ${(d / 1000).toFixed(1)} ms at depth ${DEEP}, per-level ratio ${ratio.toFixed(2)}`);
  }
});
