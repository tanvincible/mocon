/**
 * core.md 7: timestamps are RFC 3339 strings in UTC, and within one record
 * `end.time >= start` MUST hold. A time the host gives must name an
 * instant that exists, as @mocon/otel requires of the lines it maps. A
 * default `end.time` is the clock's reading or the record's own `start`,
 * whichever is later, compared to nine fractional digits, so a `start` the
 * host gave from a clock that runs ahead of this one never ends up after
 * the end.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, type Rec } from "./helpers.js";

const impossible = ["2026-02-30T00:00:00Z", "2026-09-17T25:00:00Z", "2026-09-17T10:61:00Z", "2026-13-01T00:00:00Z", "2026-09-17T10:00:61Z"];

for (const time of impossible) {
  test(`execution.start and a settle call refuse ${time}`, () => {
    const h = harness();
    assert.throws(() => h.m.execution.start({ program: "p", start: time }), RangeError);
    const ex = h.m.execution.start({ program: "p", notice: false });
    const c = ex.crossing.start({ target: "t", input: 1 });
    assert.throws(() => c.output(1, { time }), RangeError);
    assert.throws(() => ex.complete({ time }), RangeError);
  });
}

const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** Unix nanoseconds of a timestamp with up to nine fractional digits. */
const nanos = (s: string): bigint => {
  const [whole = "", frac = ""] = s.slice(0, -1).split(".");
  return BigInt(Date.parse(whole + "Z")) * 1_000_000n + BigInt((frac + "000000000").slice(0, 9));
};

test("an execution continued from a start ahead of this process's clock ends no earlier than it started", () => {
  const h = harness();
  const start = ahead(5000);
  h.m.execution.start({ program: "p", id: "e-ahead", start, notice: false }).complete();
  const end = (h.last("execution")["end"] as Rec)["time"] as string;
  assert.equal(end, start, "the start is written as the end when the clock reads earlier");
});

test("an execution started with the host's own start reading ends no earlier than it started", () => {
  const h = harness();
  const start = ahead(5000);
  h.m.execution.start({ program: "p", start, notice: false }).complete();
  const end = (h.last("execution")["end"] as Rec)["time"] as string;
  assert.ok(nanos(end) >= nanos(start), `start ${start}, end.time ${end}`);
});

test("a crossing opened with the host's own start reading settles no earlier than it started", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const start = ahead(5000);
  ex.crossing.start({ target: "t", input: 1, start }).output(2);
  const end = (h.last("crossing")["end"] as Rec)["time"] as string;
  assert.ok(nanos(end) >= nanos(start), `start ${start}, end.time ${end}`);
});

test("same clock, same millisecond: a host start reading with nine fractional digits is not followed by an end.time truncated below it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-17T09:00:00.123Z") });
  const h = harness();
  const start = "2026-09-17T09:00:00.123456789Z";
  h.m.execution.start({ program: "p", start, notice: false }).complete();
  const end = (h.last("execution")["end"] as Rec)["time"] as string;
  assert.ok(nanos(end) >= nanos(start), `start ${start}, end.time ${end}`);
});

function withClockBehind<T>(ms: number, run: () => T): T {
  const real = Date.now;
  Date.now = () => real() - ms;
  try {
    return run();
  } finally {
    Date.now = real;
  }
}

test("a handle and a crossing continued on a clock behind the starts they were given never write end.time before start", () => {
  // Turn 1 ran on a host whose clock is ahead; turn 2 continues the same ids and starts here.
  const started = { execution: ahead(5_000), crossing: ahead(6_000) };
  const h = harness();
  withClockBehind(5_000, () => {
    const far = h.m.execution.start({ program: "p", id: "e1", start: started.execution, notice: false });
    far.crossing.start({ target: "t", input: 1, id: "c1", start: started.crossing, seq: 1 }).output(2);
    far.complete();
  });
  for (const kind of ["execution", "crossing"]) {
    const line = h.last(kind);
    const end = (line["end"] as Rec)["time"] as string;
    assert.ok(nanos(end) >= nanos(line["start"] as string), `${kind}: start ${String(line["start"])}, end.time ${end}`);
  }
});

/** Calls `settle`; passes when it refused with a RangeError, or when the record it wrote has `end.time >= start`. */
function assertEndNotBeforeStart(h: ReturnType<typeof harness>, kind: string, settle: () => void): void {
  const before = h.sink.lines.length;
  try {
    settle();
  } catch (e) {
    assert.ok(e instanceof RangeError, `refused with ${String(e)}, not a RangeError`);
    return;
  }
  const written = h.sink.lines
    .slice(before)
    .map((l) => JSON.parse(l) as Rec)
    .filter((r) => r["kind"] === kind && r["end"] !== undefined);
  assert.equal(written.length, 1, `the settle call neither refused the time nor wrote one ${kind} record`);
  const record = written[0] as Rec;
  const start = record["start"] as string;
  const end = (record["end"] as Rec)["time"] as string;
  assert.ok(nanos(end) >= nanos(start), `core.md 7: ${kind} start ${start}, end.time ${end}`);
}

test("a host-given execution end.time earlier than the record's start is never written", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", start: "2026-09-17T10:00:00.000Z", notice: false });
  assertEndNotBeforeStart(h, "execution", () => ex.complete({ time: "2026-09-17T09:59:59.999Z" }));
});

test("a host-given crossing end.time earlier than the crossing's own start is never written", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const given = ex.crossing.start({ target: "t", input: 1, start: "2026-09-17T10:00:05.000Z" });
  assertEndNotBeforeStart(h, "crossing", () => given.output(2, { time: "2026-09-17T10:00:04.000Z" }));
  const clocked = ex.crossing.start({ target: "t", input: 1 });
  assertEndNotBeforeStart(h, "crossing", () => clocked.error(new Error("x"), { time: "2000-01-01T00:00:00Z" }));
});
