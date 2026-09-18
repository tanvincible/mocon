import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel, parseTime, payloadFlags } from "../src/model.js";
import { jsonl, stream } from "./helpers.js";

const T = (s: number): string => new Date(Date.UTC(2026, 8, 16, 10, 0, s)).toISOString();
const host = { kind: "host", host: "h", observes_crossings: "all" };
const exec = (id: string, start: string, over: Record<string, unknown> = {}) => ({ kind: "execution", host: "h", id, program: { value: id }, start, ...over });
const done = (id: string, start: string, end: string, over: Record<string, unknown> = {}) => exec(id, start, { end: { time: end, disposition: "completed" }, ...over });
const cross = (id: string, over: Record<string, unknown> = {}) => ({ kind: "crossing", host: "h", id, execution_id: "e1", target: id, input: { value: 1 }, end: { outcome: "output" }, ...over });
const order = (text: string): string[] => buildModel(text).sessions[0]!.executions[0]!.crossings.map((c) => String(c.record.id));

test("crossings order by seq, then host-clock start, then id; line order never matters", () => {
  const lines = [
    host,
    done("e1", T(0), T(9)),
    cross("z-no-seq-no-start"),
    cross("a-no-seq-no-start"),
    cross("late-start", { start: T(5) }),
    cross("early-start", { start: T(1) }),
    cross("seq-2", { seq: 2, start: T(0) }),
    cross("seq-1-late", { seq: 1, start: T(8) }),
    cross("seq-1-early", { seq: 1, start: T(2) }),
  ];
  const expected = ["seq-1-early", "seq-1-late", "seq-2", "early-start", "late-start", "a-no-seq-no-start", "z-no-seq-no-start"];
  assert.deepEqual(order(jsonl(lines)), expected);
  assert.deepEqual(order(jsonl([...lines].reverse())), expected);
});

test("executions order by start, then host, then id, and sessions by their first execution's start", () => {
  const lines = [
    done("b", T(5), T(6), { context: { session: "s2" } }),
    done("a", T(5), T(6), { context: { session: "s2" } }),
    done("x", T(1), T(2), { context: { session: "s1" } }),
    done("bad-start", "not a time", T(2), { context: { session: "s2" } }),
    done("none", T(3), T(4)),
    { kind: "crossing", host: "h", id: "c", execution_id: "ghost", target: "t", input: { value: 1 } },
  ];
  const model = buildModel(jsonl(lines));
  assert.deepEqual(
    model.sessions.map((s) => [s.session, s.executions.map((e) => e.id)]),
    [
      ["s1", ["x"]],
      [null, ["none", "ghost"]],
      ["s2", ["a", "b", "bad-start"]],
    ],
  );
  const ghost = model.sessions[1]!.executions[1]!;
  assert.equal(ghost.record, null, "an execution only crossings name has no record");
  assert.equal(ghost.running, false);
  assert.equal(ghost.crossings[0]!.running, true);
});

test("durations come from host-clock times only, and a running record has none", () => {
  const model = buildModel(jsonl([host, done("e1", T(0), T(2)), exec("e2", T(3)), cross("c1", { start: T(0), end: { outcome: "output", time: T(1) } }), cross("c2", { start: T(0), end: undefined })]));
  const [e1, e2] = model.sessions[0]!.executions;
  assert.equal(e1!.durationMs, 2000);
  assert.equal(e2!.running, true);
  assert.equal(e2!.durationMs, null);
  const [c1, c2] = e1!.crossings;
  assert.equal(c1!.durationMs, 1000);
  assert.equal(c2!.running, true);
  assert.equal(c2!.durationMs, null);
  assert.equal(model.unresolved.length, 2);
});

test("core.md 8: an end outside its closed set reads as absent, is flagged, and never shows as a state", () => {
  const lines = [
    { kind: "host", host: "h", spec_version: "1.0", observes_crossings: "most", crossing_edge: "sideways", attested: ["crossing.target"] },
    { kind: "execution", host: "h", id: "e1", program: { value: "x" }, start: T(0), end: { time: T(1), disposition: "success", result: { value: 1 } } },
    { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "t", input: { value: 1 }, start: T(0), end: { time: T(1), outcome: "ok", output: { value: 2 } } },
  ];
  const model = buildModel(jsonl(lines));
  const ex = model.sessions[0]!.executions[0]!;
  assert.equal(ex.running, true, "end reads as absent, so the record is unresolved");
  assert.equal(ex.durationMs, null);
  assert.equal(ex.record?.end, undefined);
  const c = ex.crossings[0]!;
  assert.equal(c.running, true);
  assert.equal(c.durationMs, null);
  assert.equal(model.flagged, 3, "two ends and one declaration");
  assert.deepEqual(model.hosts, [{ kind: "host", host: "h", spec_version: "1.0", attested: ["crossing.target"] }]);
});

test("a declaration key that does not hold a value of its type reads as absent", () => {
  const model = buildModel(jsonl([{ kind: "host", host: "h", spec_version: 1, unmediated_egress: "false", attested: ["crossing.input", 7, null], ext: { a: 1 } }]));
  assert.deepEqual(model.hosts, [{ kind: "host", host: "h", attested: ["crossing.input"], ext: { a: 1 } }]);
  assert.deepEqual(buildModel(jsonl([{ kind: "host", host: "h", attested: "crossing.target" }])).hosts, [{ kind: "host", host: "h" }]);
});

test("records whose (host, id) keys collide in the fold stay consistent: one entry, never an invariant failure", () => {
  const NUL = String.fromCharCode(0);
  const lines = [
    { kind: "execution", host: "a" + NUL + "b", id: "c", program: { value: "1" }, start: T(0), end: { time: T(1), disposition: "completed" } },
    { kind: "execution", host: "a", id: "b" + NUL + "c", program: { value: "2" }, start: T(0) },
  ];
  const model = buildModel(jsonl(lines));
  assert.equal(model.executions, 1);
  assert.equal(model.sessions[0]!.executions[0]!.running, false);
});

test("a target, execution id, class or time that String() cannot convert is shown as JSON, not a crash", () => {
  const bad = JSON.parse('{"toString":null}') as unknown;
  const lines = [
    { kind: "execution", host: "h", id: "e1", program: { value: "p" }, start: bad, language: bad, context: { traceparent: bad }, end: { time: T(1), disposition: "failed", error: { class: bad, message: bad } } },
    { kind: "crossing", host: "h", id: "c1", execution_id: bad, target: bad, input: { value: 1 }, start: bad, end: { outcome: "error", error: { class: bad } } },
  ];
  const model = buildModel(jsonl(lines));
  assert.equal(model.sessions.flatMap((s) => s.executions).length, 2);
});

test(
  "a host or execution id that String() cannot convert does not stop the model",
  () => {
    buildModel(jsonl([{ kind: "execution", host: { toString: null }, id: "e1", program: { value: "p" }, start: T(0) }]));
    buildModel(jsonl([{ kind: "crossing", host: "h", id: [{ toString: null }], execution_id: "e1", target: "t", input: { value: 1 } }]));
  },
);

test("the golden streams count what the fold counts and flag nothing", () => {
  const model = buildModel(stream("abandoned-at-end").text);
  assert.equal(model.flagged, 0);
  assert.equal(model.crossings, model.sessions.reduce((n, s) => n + s.executions.reduce((m, e) => m + e.crossings.length, 0), 0));
});

test("parseTime and payloadFlags accept anything a malformed line can carry", () => {
  assert.equal(parseTime("2026-09-16T10:00:00Z"), Date.UTC(2026, 8, 16, 10));
  for (const v of [undefined, null, 5, "yesterday", {}, []]) assert.equal(parseTime(v), null);
  // Date.parse reads text no timestamp is long enough to need, and the cost of refusing it grows with its length.
  assert.equal(parseTime(`2026-09-16T10:00:00.${"0".repeat(50)}Z`), null, "past the longest text Date.parse reads as a time");
  assert.equal(parseTime("2026-09-16T10:00:00.123456789Z"), Date.UTC(2026, 8, 16, 10) + 123, "nanoseconds still parse");
  assert.deepEqual(payloadFlags({ value: "x", truncated: true, bytes: 900 }), ["truncated", "900 bytes"]);
  assert.deepEqual(payloadFlags({ redacted: true, bytes: 12, hash: "sha256:" }), ["redacted", "12 bytes"]);
  assert.deepEqual(payloadFlags({ value: 1, bytes: 1 }), [], "the size is noted only when the value was cut or withheld");
  for (const v of [undefined, null, 5, "x", [true]]) assert.deepEqual(payloadFlags(v), []);
});

test("building the model grows linearly with the stream, so folding it again on every view.json request stays cheap", () => {
  const streamOf = (n: number): string => {
    const lines: unknown[] = [host];
    for (let i = 0; i < n; i++) {
      lines.push(done(`e${i}`, T(i % 60), T((i % 60) + 1), { context: { session: `s${i % 50}` } }));
      lines.push({ kind: "crossing", host: "h", id: `c${i}`, execution_id: `e${i % 100}`, target: "t", input: { value: i }, seq: i, start: T(i % 60), end: { outcome: "output", time: T((i % 60) + 1) } });
    }
    return jsonl(lines);
  };
  // The fastest of several rounds, not their middle: a scheduler can only ever make a round slower.
  const best = (text: string, rounds: number): number => {
    let min = Infinity;
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now();
      buildModel(text);
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };
  const small = streamOf(500);
  const large = streamOf(8_000);
  best(small, 1);
  best(large, 1);
  const ratio = best(large, 3) / best(small, 7);
  // Sixteen times the lines: a healthy run measures about 19, quadratic work would measure 256, and the bound is five times the healthy
  // reading. Both numbers come from the same run on the same machine, so a busy one moves them together and fails nothing.
  assert.ok(ratio < 100, `sixteen times the lines took ${ratio.toFixed(1)}x as long`);
});
