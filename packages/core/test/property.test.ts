/**
 * Properties over generated values: the capture never throws for any
 * JSON-like or hostile value; `bytes`, `hash` and a truncated `value`
 * agree with `JSON.stringify` for any JSON value and any cap; `fold` is
 * permutation-invariant over the golden streams and over generated
 * streams; the cause rule never throws; and a random schedule of
 * crossings keeps every invariant.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import { errorInput } from "../src/cause.js";
import { fold } from "../src/fold.js";
import { InvariantError } from "../src/index.js";
import { Encoder } from "../src/payload.js";
import { assertValidStream, harness, readStream, streamNames, type Rec } from "./helpers.js";

const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");
const RUNS = { numRuns: 200 };

/* ------------------------------------------------------------------ */
/* Arbitraries                                                         */
/* ------------------------------------------------------------------ */

/** Any JSON value, with strings that include every kind of character, and keys that include prototype members. */
const json: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: false }),
    fc.integer(),
    fc.string(),
    fc.string({ unit: "binary" }),
    fc.string({ unit: "grapheme" }),
    fc.array(tie("value"), { maxLength: 6 }),
    fc.dictionary(fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom("__proto__", "constructor", "toString", "", "1", "10", "2")), tie("value"), { maxKeys: 6 }),
  ),
})).value;

/** Values a program can hand a bridge: JSON, plus everything JSON.stringify treats specially or that can run code. */
const hostile: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    json,
    fc.constant(undefined),
    fc.constant(() => 1),
    fc.constant(Symbol("s")),
    fc.bigInt(),
    fc.date(),
    fc.uint8Array({ maxLength: 40 }),
    fc.constant(new ArrayBuffer(8)),
    fc.constant(Buffer.from("bytes")),
    fc.constant(new Number(3)),
    fc.constant(new String("boxed")),
    fc.constant(Object(1n)),
    fc.constant(new Map([["k", 1]])),
    fc.constant(Object.create(null)),
    tie("value").map((v) => ({ toJSON: () => v })),
    tie("value").map((v) => ({ toJSON: () => { throw new Error("toJSON"); }, v })),
    tie("value").map((v) => ({ get g() { return v; }, plain: 1 })),
    fc.constant({ get g(): number { throw new Error("getter"); } }),
    fc.constant(new Proxy({ a: 1 }, { get: () => { throw new Error("trap"); } })),
    fc.constant(new Proxy({}, { ownKeys: () => { throw new Error("keys"); } })),
    fc.constant(new Proxy({}, { getPrototypeOf: () => { throw new Error("proto"); } })),
    fc.constant((() => { const o: Rec = {}; o["self"] = o; return o; })()),
    fc.constant((() => { const a: unknown[] = []; a.push(a); return a; })()),
    fc.constant((() => { let v: unknown = 0; for (let i = 0; i < 20_000; i++) v = [v]; return v; })()),
    fc.constant((() => { const o: Rec = {}; for (let i = 0; i < 5000; i++) o["k" + i] = i; return o; })()),
    fc.constant("x".repeat(200_000)),
    fc.constant(runInNewContext('({ n: new Number(3), s: new String("ab"), b: new Uint8Array([1, 2]).buffer, e: new TypeError("vm") })') as unknown),
    fc.constant(Object.assign(() => 1, { toJSON: () => "from a function" })),
    fc.constant(JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}') as unknown),
    fc.constant((() => { let n = 0; return { get liar() { return n++ % 2 === 0 ? "small" : "x".repeat(1 << 20); } }; })()),
    fc.constant((() => { let n = 0; return { toJSON: () => (n++ % 2 === 0 ? { small: 1 } : "x".repeat(1 << 20)) }; })()),
    fc.constant({ toJSON: () => undefined }),
    fc.constant({ nested: { toJSON: () => 10n } }),
    fc.constant(new Proxy([1, 2, 3], {})),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 4 }), tie("value"), { maxKeys: 4 }),
  ),
})).value;

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

test("capture never throws for any JSON-like or hostile value, and every line it writes validates", () => {
  const h = harness({ capture: { caps: { "crossing.input": 512, "crossing.output": 512, result: 512, error: 256 } } });
  fc.assert(
    fc.property(hostile, hostile, (input, output) => {
      const ex = h.m.execution.start({ program: "p", notice: false });
      const c = ex.crossing.start({ target: "t", input });
      c.output(output);
      ex.crossing.start({ target: "u", input }).error(output);
      ex.complete({ result: output, outputs: { stdout: input } });
      h.sink.lines.length = 0;
    }),
    RUNS,
  );
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "t", input: hostile }).output(1);
  ex.complete();
  assertValidStream(h.sink.lines);
  const sample = harness({ capture: { caps: { "crossing.input": 64 } } });
  fc.assert(
    fc.property(hostile, (input) => {
      const ex2 = sample.m.execution.start({ program: "p", notice: false });
      ex2.crossing.start({ target: "t", input }).output(1);
      ex2.complete();
      assertValidStream(sample.sink.lines.slice(1));
      const payload = sample.last("crossing")["input"] as Rec;
      assert.ok(payload["value"] !== undefined || payload["truncated"] === true || payload["redacted"] === true, JSON.stringify(payload));
      sample.sink.lines.length = 1;
    }),
    { numRuns: 150 },
  );
});

test("bytes and hash describe JSON.stringify's text, a truncated value is a prefix of it, and both agree for any JSON value and any cap", () => {
  const encoder = new Encoder(4096);
  fc.assert(
    fc.property(json, fc.integer({ min: 1, max: 300 }), (value, cap) => {
      const full = JSON.stringify(value) ?? "null";
      const fullBytes = Buffer.byteLength(full);
      const e = encoder.encode(value, cap, true);
      if (fullBytes <= cap) {
        assert.equal(e.truncated, false);
        assert.equal(e.valueText, full);
        assert.equal(e.bytes, fullBytes);
        assert.equal("sha256:" + e.hash, sha(full));
      } else {
        assert.equal(e.truncated, true);
        if (e.valueText !== undefined) {
          const prefix = JSON.parse(e.valueText) as string;
          assert.ok(full.startsWith(prefix), `${JSON.stringify(prefix)} is not a prefix of ${JSON.stringify(full)}`);
          const bytes = Buffer.byteLength(e.valueText);
          assert.ok(bytes <= cap, `${bytes} bytes on the wire for cap ${cap}`);
          assert.ok(bytes > cap - 6 || JSON.stringify(value).length > 64 * cap, `the prefix stopped at ${bytes} bytes, short of cap ${cap}`);
        }
        if (e.bytes !== undefined) {
          assert.equal(e.bytes, fullBytes);
          assert.equal("sha256:" + e.hash, sha(full));
        }
      }
    }),
    { numRuns: 500 },
  );
});

test("through the public API, bytes is the byte length of the text hash was taken over, for any JSON value", () => {
  const h = harness();
  fc.assert(
    fc.property(json, (value) => {
      const ex = h.m.execution.start({ program: "p", notice: false });
      ex.crossing.start({ target: "t", input: value }).output(value);
      ex.complete({ result: value });
      const line = h.last("crossing");
      const full = JSON.stringify(value) ?? "null";
      for (const p of [line["input"], (line["end"] as Rec)["output"], (h.last("execution")["end"] as Rec)["result"]] as Rec[]) {
        if (p["truncated"] === true) {
          assert.ok(full.startsWith(p["value"] as string));
          if (p["bytes"] !== undefined) assert.equal(p["hash"], sha(full));
        } else {
          assert.deepEqual(p["value"], JSON.parse(full));
          assert.equal(p["bytes"], Buffer.byteLength(full));
          assert.equal(p["hash"], sha(full));
        }
      }
      h.sink.lines.length = 1;
    }),
    RUNS,
  );
});

/* ------------------------------------------------------------------ */
/* fold                                                                */
/* ------------------------------------------------------------------ */

test("fold gives the same view for any permutation of any golden stream, with or without duplicates", () => {
  for (const name of streamNames()) {
    const lines = readStream(name).split("\n").filter((l) => l.trim() !== "");
    const base = fold(lines);
    fc.assert(
      fc.property(fc.shuffledSubarray(lines, { minLength: lines.length }), fc.subarray(lines), (permutation, dupes) => {
        assert.deepEqual(fold(permutation), base);
        const withDupes = fold([...permutation, ...dupes]);
        assert.deepEqual({ ...withDupes, skipped: base.skipped }, base);
      }),
      { numRuns: 25 },
    );
  }
});

const generatedLine: fc.Arbitrary<string> = fc
  .record({
    kind: fc.constantFrom("host", "execution", "crossing", "metric"),
    host: fc.constantFrom("a", "b", "__proto__"),
    id: fc.constantFrom("1", "2", "constructor"),
    ended: fc.boolean(),
    disposition: fc.constantFrom("completed", "failed", "bogus"),
    outcome: fc.constantFrom("output", "error", "abandoned", "bogus"),
    observes: fc.constantFrom("all", "none", "bogus", undefined),
    extra: fc.option(fc.dictionary(fc.string({ maxLength: 3 }), fc.integer(), { maxKeys: 2 }), { nil: undefined }),
    junk: fc.boolean(),
  })
  .map(({ kind, host, id, ended, disposition, outcome, observes, extra, junk }) => {
    if (junk) return "not json at all";
    const rec: Rec = { kind, host };
    if (kind === "host") {
      if (observes !== undefined) rec["observes_crossings"] = observes;
    } else if (kind === "execution") {
      Object.assign(rec, { id, program: { value: "p" }, start: "2026-09-16T10:00:00Z" });
      if (ended) rec["end"] = { time: "2026-09-16T10:00:01Z", disposition };
    } else if (kind === "crossing") {
      Object.assign(rec, { id, execution_id: "1", target: "t", input: { value: 1 } });
      if (ended) rec["end"] = { outcome };
    } else {
      rec["id"] = id;
    }
    if (extra !== undefined) rec["ext"] = extra;
    return JSON.stringify(rec);
  });

test("fold gives the same view for any permutation of a generated stream, and every key it reports exists", () => {
  fc.assert(
    fc.property(fc.array(generatedLine, { maxLength: 24 }), fc.nat(), (lines, seed) => {
      const base = fold(lines);
      const shuffled = [...lines];
      let s = seed;
      for (let j = shuffled.length - 1; j > 0; j--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const k = s % (j + 1);
        [shuffled[j], shuffled[k]] = [shuffled[k] as string, shuffled[j] as string];
      }
      assert.deepEqual(fold(shuffled), base);
      for (const ref of [...base.unresolved, ...base.conflicts]) {
        if (ref.kind === "host") assert.ok(ref.host in base.hosts);
        else assert.ok(ref.host + "\0" + ref.id in (ref.kind === "execution" ? base.executions : base.crossings));
      }
      for (const key of Object.keys(base.executions)) {
        const end = (base.executions[key] as unknown as Rec)["end"] as Rec | undefined;
        assert.ok(end === undefined || ["completed", "failed", "terminated", "abandoned"].includes(String(end["disposition"])), "no unknown disposition survives");
      }
      for (const key of Object.keys(base.crossings)) {
        const end = (base.crossings[key] as unknown as Rec)["end"] as Rec | undefined;
        assert.ok(end === undefined || ["output", "error", "abandoned"].includes(String(end["outcome"])), "no unknown outcome survives");
      }
    }),
    { numRuns: 300 },
  );
});

/* ------------------------------------------------------------------ */
/* cause                                                               */
/* ------------------------------------------------------------------ */

const hostileCause: fc.Arbitrary<unknown> = fc.oneof(
  hostile,
  fc.string().map((m) => new Error(m)),
  fc.string().map((m) => new RangeError(m, { cause: new TypeError("inner") })),
  fc.string().map((m) => Object.assign(new Error(m), { code: -32602, data: { m } })),
  fc.constant(Object.assign(new Error("x"), { message: 42 })),
  fc.constant((() => { const e = new Error("stackless"); Object.defineProperty(e, "stack", { get() { throw new Error("no stack"); } }); return e; })()),
  fc.constant((() => { const e = new Error("cyclic"); e.cause = e; return e; })()),
  fc.constant((() => { let e: Error = new Error("root"); for (let i = 0; i < 5000; i++) e = new Error("link", { cause: e }); return e; })()),
  fc.constant(Object.defineProperty(new Error("own"), "bad", { enumerable: true, get() { throw new Error("own getter"); } })),
);

test("the cause rule never throws and always yields the given class, for any hostile cause", () => {
  const h = harness();
  fc.assert(
    fc.property(hostileCause, fc.constantFrom("runtime", "validation", "refused"), (cause, cls) => {
      const out = errorInput({ class: cls, cause });
      assert.equal(out.class, cls);
      assert.ok(out.message === undefined || typeof out.message === "string");
      const ex = h.m.execution.start({ program: "p", notice: false });
      ex.crossing.start({ target: "t", input: 1 }).error(cause, { class: cls });
      ex.fail(cause, { class: cls });
      assertValidStream(h.sink.lines.slice(1));
      h.sink.lines.length = 1;
    }),
    RUNS,
  );
});

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

/** The seq a crossing handle was opened with, which its lines carry. */
const seqOf = (c: unknown): number => (c as { fields: { seq: number } }).fields.seq;

type Op =
  | { op: "start"; notice: boolean; seq: number | undefined }
  | { op: "settle"; which: number; how: "output" | "error" | "abandoned" }
  | { op: "end"; disposition: "completed" | "failed" | "terminated" | "abandoned" }
  | { op: "call"; async: boolean; fail: boolean }
  | { op: "reenter"; which: number; inner: "settle" | "end" | "open" };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("start" as const), notice: fc.boolean(), seq: fc.option(fc.nat({ max: 20 }), { nil: undefined }) }),
  fc.record({ op: fc.constant("settle" as const), which: fc.nat({ max: 8 }), how: fc.constantFrom("output" as const, "error" as const, "abandoned" as const) }),
  fc.record({ op: fc.constant("end" as const), disposition: fc.constantFrom("completed" as const, "failed" as const, "terminated" as const, "abandoned" as const) }),
  fc.record({ op: fc.constant("call" as const), async: fc.boolean(), fail: fc.boolean() }),
  fc.record({ op: fc.constant("reenter" as const), which: fc.nat({ max: 8 }), inner: fc.constantFrom("settle" as const, "end" as const, "open" as const) }),
);

test("a random schedule of crossings, settlements, wrapped calls and ends keeps every invariant", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
      const h = harness();
      const ex = h.m.execution.start({ program: "p" });
      const bridge = ex.instrument((_name: string, fail: boolean, async: boolean) => {
        if (async) return fail ? Promise.reject(new Error("async fail")) : Promise.resolve("async ok");
        if (fail) throw new Error("sync fail");
        return "sync ok";
      });
      const crossings: Array<ReturnType<typeof ex.crossing.start>> = [];
      const pending: Promise<unknown>[] = [];
      let ended = false;
      let endedAt = -1;
      // Every seq given so far, the host's own and the handle's: an automatic seq must exceed all of them.
      let highest = 0;
      // Crossings the schedule itself ended as abandoned; every other abandoned record belongs to the execution's end.
      const abandonedByHand = new Set<string>();
      for (const [i, step] of ops.entries()) {
        try {
          if (step.op === "start") {
            const c = ex.crossing.start({ target: "t" + i, input: { i }, notice: step.notice, seq: step.seq });
            const seq = seqOf(c);
            if (step.seq === undefined) assert.ok(seq > highest, `automatic seq ${seq} after ${highest}`);
            highest = Math.max(highest, seq);
            crossings.push(c);
          } else if (step.op === "settle") {
            const c = crossings[step.which % Math.max(1, crossings.length)];
            if (c === undefined) continue;
            if (step.how === "output") c.output({ ok: true });
            else if (step.how === "error") c.error(new Error("e"));
            else {
              abandonedByHand.add(c.id);
              c.end({ outcome: "abandoned" });
            }
          } else if (step.op === "end") {
            if (!ended) {
              ended = true;
              endedAt = h.sink.lines.length;
            }
            ex.end({ disposition: step.disposition });
          } else if (step.op === "reenter") {
            // Program code inside the settled value settles the same crossing, ends the execution, or opens another crossing.
            const c = crossings[step.which % Math.max(1, crossings.length)];
            if (c === undefined) continue;
            let opened: ReturnType<typeof ex.crossing.start> | undefined;
            c.output({
              get inner() {
                if (step.inner === "settle") c.output("from inside");
                else if (step.inner === "end") {
                  if (!ended) {
                    ended = true;
                    endedAt = h.sink.lines.length;
                  }
                  ex.end({ disposition: "terminated" });
                } else opened = ex.crossing.start({ target: "inner" + i, input: 1 });
                return 1;
              },
            });
            if (opened !== undefined) {
              highest = Math.max(highest, seqOf(opened));
              crossings.push(opened);
            }
          } else {
            highest++;
            const r = bridge("call" + i, step.fail, step.async);
            if (r instanceof Promise) pending.push(r.catch(() => undefined));
          }
        } catch (e) {
          assert.ok(!(e instanceof InvariantError), `an invariant fired: ${(e as Error).message}`);
          assert.ok(e instanceof Error && e.message.endsWith("fail"), `only the bridge's own errors surface, not ${String(e)}`);
        }
      }
      await Promise.all(pending);
      if (!ended) {
        endedAt = h.sink.lines.length;
        ex.complete();
      }
      assertValidStream(h.sink.lines);
      const view = fold(h.sink.lines);
      assert.deepEqual(view.conflicts, [], "no key ever gets two complete records");
      const executions = h.ofKind("execution").filter((r) => "end" in r);
      assert.equal(executions.length, 1, "exactly one complete execution record");
      const completeIndex = h.sink.lines.findIndex((l) => l.includes('"kind":"execution"') && l.includes('"end"'));
      const records = h.records();
      for (let j = 0; j < completeIndex; j++) {
        const r = records[j] as Rec;
        if (r["kind"] === "crossing" && (r["end"] as Rec | undefined)?.["outcome"] === "abandoned" && !abandonedByHand.has(r["id"] as string)) {
          assert.ok(j >= endedAt, "abandoned records belong to the end batch");
        }
      }
      for (let j = completeIndex + 1; j < records.length; j++) {
        const r = records[j] as Rec;
        const lateOpened = r["kind"] === "crossing" && ((r["end"] as Rec | undefined)?.["outcome"] !== "abandoned" || abandonedByHand.has(r["id"] as string));
        assert.ok(r["kind"] === "event" || lateOpened, "after the complete record only crossings opened after the end, and events, follow");
      }
      const before = new Set(records.slice(0, completeIndex + 1).filter((r) => r["kind"] === "crossing").map((r) => r["id"]));
      for (const ref of view.unresolved) assert.ok(!before.has(ref.id), `crossing ${ref.id} opened before the end is unresolved`);
      for (const event of h.ofKind("event")) {
        assert.equal(event["name"], "late_settlement");
        const abandoned = records.find((r) => r["kind"] === "crossing" && r["id"] === event["crossing_id"] && (r["end"] as Rec | undefined)?.["outcome"] === "abandoned");
        assert.ok(abandoned !== undefined, "a late settlement names an abandoned crossing");
      }
    }),
    { numRuns: 150 },
  );
});
