/**
 * The instance clock: the text `toISOString` produces, the per-second
 * prefix cache across a rollover, millisecond padding, and monotonicity.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createClock } from "../src/time.js";

function withNow<T>(readings: number[], body: () => T): T {
  const real = Date.now;
  let i = 0;
  Date.now = () => readings[Math.min(i++, readings.length - 1)] as number;
  try {
    return body();
  } finally {
    Date.now = real;
  }
}

test("a reading is what toISOString produces, at every millisecond width", () => {
  const base = Date.UTC(2026, 8, 17, 9, 0, 0, 0);
  const millis = [0, 7, 42, 999];
  const clock = createClock();
  const readings = withNow(
    millis.map((ms) => base + ms),
    () => millis.map(() => clock()),
  );
  assert.deepEqual(
    readings,
    millis.map((ms) => new Date(base + ms).toISOString()),
  );
  assert.match(clock(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the cached second prefix rolls over on the second boundary", () => {
  const t = Date.UTC(2026, 11, 31, 23, 59, 59, 998);
  const clock = createClock();
  const [a, b, c] = withNow([t, t + 1, t + 2], () => [clock(), clock(), clock()]);
  assert.equal(a, "2026-12-31T23:59:59.998Z");
  assert.equal(b, "2026-12-31T23:59:59.999Z");
  assert.equal(c, "2027-01-01T00:00:00.000Z");
});

test("a reading is never earlier than the one before, even when the wall clock steps back", () => {
  const t = Date.UTC(2026, 8, 17, 10, 0, 0, 500);
  const clock = createClock();
  const readings = withNow([t, t - 2000, t - 1, t + 1], () => [clock(), clock(), clock(), clock()]);
  assert.deepEqual(readings, [
    "2026-09-17T10:00:00.500Z",
    "2026-09-17T10:00:00.500Z",
    "2026-09-17T10:00:00.500Z",
    "2026-09-17T10:00:00.501Z",
  ]);
  const real = createClock();
  let last = real();
  for (let i = 0; i < 10_000; i++) {
    const now = real();
    assert.ok(now >= last);
    last = now;
  }
});
