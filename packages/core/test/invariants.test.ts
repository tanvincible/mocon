/**
 * One test per invariant in the README's Invariants section, named after
 * it. Each shows the invariant holding through the public API, including
 * when program code re-enters the handle from inside a capture, and, for
 * an invariant checked at runtime, then forces the internal state it
 * guards to show that the check fires, with an InvariantError carrying its
 * code.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crossing } from "../src/crossing.js";
import { Execution } from "../src/execution.js";
import { InvariantError, mocon, type ExecutionHandle, type Sink } from "../src/index.js";
import { createRuntime } from "../src/instance.js";
import { Capturer, Encoder, payloadWire } from "../src/payload.js";
import { assertValidStream, harness, lineErrors, type Rec } from "./helpers.js";

const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");

function isInvariant(e: unknown): boolean {
  return e instanceof InvariantError && e.code === "ERR_MOCON_INVARIANT" && e.name === "InvariantError" && e.message.startsWith("mocon invariant: ");
}

/** The internals a test reaches past the handle types for. */
const internal = (ex: ExecutionHandle): Execution => ex as unknown as Execution;

test("InvariantError is exported, named, and tagged with a code", () => {
  const e = new InvariantError("x");
  assert.ok(isInvariant(e));
  assert.ok(e instanceof Error);
});

test("a crossing ends at most once", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });

  const twice = ex.crossing.start({ target: "twice", input: 1 });
  twice.output(1);
  twice.error(new Error("second"));
  twice.end({ outcome: "abandoned" });

  // A getter inside the output settles the same crossing first; the outer call finds it settled and writes nothing.
  const reentered = ex.crossing.start({ target: "reentered", input: 1 });
  reentered.output({
    get inner() {
      reentered.output("from the getter");
      return 1;
    },
  });

  // A getter inside the output ends the execution, which abandons the crossing; the outer call becomes a late settlement.
  const racing = ex.crossing.start({ target: "racing", input: 1 });
  racing.output({
    get inner() {
      ex.end({ disposition: "terminated", error: { class: "timeout" } });
      return 1;
    },
  });
  racing.output("ignored");

  assertValidStream(h.sink.lines);
  const complete = h.ofKind("crossing").filter((c) => "end" in c);
  const only = (target: string): Rec => {
    const found = complete.filter((c) => c["target"] === target);
    assert.equal(found.length, 1, `${target}: one complete record`);
    return found[0] as Rec;
  };
  only("twice");
  assert.deepEqual((only("reentered")["end"] as Rec)["output"], { value: "from the getter", bytes: 17, hash: sha('"from the getter"') });
  assert.deepEqual(only("racing")["end"], { outcome: "abandoned" });
  const events = h.ofKind("event");
  assert.equal(events.length, 1, "the racing settlement is one late_settlement event");
  assert.equal(events[0]?.["crossing_id"], racing.id);

  assert.throws(() => (twice as unknown as Crossing).abandon(), isInvariant, "abandoning a settled crossing is a second end");
});

test("abandon precedes execution end", () => {
  const batches: string[][] = [];
  const sink: Sink = { write: (lines) => void batches.push([...lines]) };
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink] });
  const ex = m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: string) => new Promise(() => undefined));
  call("pending");
  ex.crossing.start({ target: "open", input: 1 });
  let lateId: string | undefined;
  ex.complete({
    result: {
      // Program code inside the result opens a crossing while the end is being built; it is abandoned in the same batch.
      get inner() {
        lateId = ex.crossing.start({ target: "during end", input: 1 }).id;
        return 1;
      },
    },
  });
  const end = batches.at(-1) as string[];
  const kinds = end.map((l) => JSON.parse(l) as Rec).map((r) => [r["kind"], r["target"] ?? (r["end"] as Rec)["disposition"], (r["end"] as Rec)["outcome"]]);
  assert.deepEqual(kinds, [
    ["crossing", "pending", "abandoned"],
    ["crossing", "open", "abandoned"],
    ["crossing", "during end", "abandoned"],
    ["execution", "completed", undefined],
  ]);
  assert.equal(JSON.parse(end[2] as string)["id"], lateId);
  assertValidStream(batches.flat());

  const forced = m.execution.start({ program: "p", notice: false });
  const stuck = forced.crossing.start({ target: "t", input: 1 });
  // A crossing that does not leave the open set when abandoned would leave the complete record written over an open crossing.
  (stuck as unknown as { abandon: () => string }).abandon = () => "{}";
  assert.throws(() => forced.complete(), isInvariant);
});

test("abandon precedes execution end: a crossing whose own input capture ended the execution is abandoned before the complete record", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: string, _args: unknown) => "answered");
  call("person_search", {
    // Program code inside the input ends the execution while that input is being captured, before the
    // crossing would have been tracked if it were tracked after the capture.
    get filter() {
      ex.end({ disposition: "terminated" });
      return 1;
    },
  });

  assertValidStream(h.sink.lines);
  const records = h.records();
  assert.deepEqual(
    records.map((r) => [r["kind"], r["target"] ?? r["name"], (r["end"] as Rec | undefined)?.["outcome"] ?? (r["end"] as Rec | undefined)?.["disposition"]]),
    [
      ["host", undefined, undefined],
      ["crossing", "person_search", "abandoned"],
      ["execution", undefined, "terminated"],
      ["event", "late_settlement", undefined],
    ],
    "the crossing is accounted for before the execution's complete record, and its settlement is an event after it",
  );
  assert.deepEqual((records[1] as Rec)["input"], { redacted: true }, "the input the capture never returned");
});

test("an execution ends at most once", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.complete({
    result: {
      // Program code inside the result ends the execution first; the outer end finds it ended and writes nothing.
      get inner() {
        ex.fail(new Error("from the getter"));
        return 1;
      },
    },
  });
  ex.end({ disposition: "terminated" });
  const completes = h.ofKind("execution");
  assert.equal(completes.length, 1);
  assert.equal((completes[0]?.["end"] as Rec)["disposition"], "failed");

  assert.throws(() => (internal(ex) as unknown as { close(): string[] }).close(), isInvariant);
});

test("no crossing is tracked after its execution ended, so none it tracked is recorded after the complete record", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  let release: (v: string) => void = () => undefined;
  const call = ex.instrument((_name: string) => new Promise<string>((resolve) => (release = resolve)));
  const pending = call("slow");
  ex.complete();
  const afterEnd = ex.crossing.start({ target: "after", input: 1, notice: true });
  ex.end({ disposition: "abandoned" });
  release("late");
  await pending;
  afterEnd.output("settles on its own");

  const records = h.records();
  const completeAt = records.findIndex((r) => r["kind"] === "execution");
  const tail = records.slice(completeAt + 1);
  assert.deepEqual(
    tail.map((r) => [r["kind"], r["target"] ?? r["name"], (r["end"] as Rec | undefined)?.["outcome"]]),
    [
      ["crossing", "after", undefined],
      ["event", "late_settlement", undefined],
      ["crossing", "after", "output"],
    ],
    "after the complete record: the untracked crossing's own lines and the tracked one's late settlement as an event",
  );
});

test("a complete record carries every required field", () => {
  const h = harness({ capture: { caps: { "crossing.output": 16 } } });
  const ex = h.m.execution.start({ program: "p", language: "javascript", context: { session: "s" }, notice: false });
  ex.crossing.start({ target: "", input: undefined, id: "" }).output("x".repeat(100));
  ex.crossing.start({ target: "t", input: new Uint8Array(4) }).error(new Error("e"));
  ex.crossing.start({ target: "t", input: 1, start: "2026-09-17T09:00:00Z" }).end({ outcome: "abandoned", time: "2026-09-17T09:00:01Z" });
  ex.crossing.start({ target: "t", input: null });
  ex.fail(new Error("x"), { result: 1, outputs: { stdout: "" } });
  // A second handle for the same dispatch, continued from the fields the host already holds: an empty id, a crossing id of its own.
  const continued = h.m.execution.start({ program: "p", id: "", start: "2026-09-17T09:00:00Z", notice: false });
  continued.crossing.start({ target: "t", input: 1, id: "c" }).output(1);
  continued.end({ disposition: "abandoned" });
  for (const line of h.sink.lines) {
    const r = JSON.parse(line) as Rec;
    if (!("end" in r)) continue;
    assert.deepEqual(lineErrors(r), [], line.slice(0, 80));
    const required = r["kind"] === "execution" ? ["kind", "host", "id", "program", "start"] : ["kind", "host", "id", "execution_id", "target", "input"];
    for (const key of required) assert.ok(key in r, `${String(r["kind"])} complete record carries ${key}`);
  }
});

test("bytes equals the byte length of the serialization the hash is taken over", () => {
  const h = harness();
  const values: unknown[] = ["", "é😀\n\"", 0, -1.5e-7, true, null, [1, "two", { three: [3] }], { "": { é: "😀".repeat(40) } }, new Date(0), { n: new Number(3) }];
  const ex = h.m.execution.start({ program: "é😀 program", notice: false });
  for (const v of values) ex.crossing.start({ target: "t", input: v }).output(v);
  ex.complete({ result: values });
  const payloads: Array<[Rec, string]> = [];
  for (const r of h.records()) {
    // The start notice this handle owed is written with the first crossing line; only a complete record carries an outcome.
    if (r["end"] === undefined) continue;
    if (r["kind"] === "crossing") {
      const original = JSON.stringify((r["input"] as Rec)["value"]);
      payloads.push([r["input"] as Rec, original], [(r["end"] as Rec)["output"] as Rec, original]);
    } else if (r["kind"] === "execution") {
      payloads.push([r["program"] as Rec, "é😀 program"], [(r["end"] as Rec)["result"] as Rec, JSON.stringify(values)]);
    }
  }
  for (const [p, text] of payloads) {
    assert.equal(p["bytes"], Buffer.byteLength(text), text.slice(0, 40));
    assert.equal(p["hash"], sha(text), text.slice(0, 40));
  }

  const write = Buffer.prototype.write;
  Buffer.prototype.write = function (this: Buffer, ...args: unknown[]): number {
    return (write as (...a: unknown[]) => number).apply(this, args) - 1;
  } as typeof write;
  try {
    assert.throws(() => new Encoder(64).known('"abc"', 64, true), isInvariant, "a write that stopped short unseen");
    assert.throws(() => new Capturer(undefined).value("result", "abc"), isInvariant, "the capture does not hide the failure as a redaction");
  } finally {
    Buffer.prototype.write = write;
  }
});

test("truncated implies value is a string prefix", () => {
  const h = harness({ capture: { caps: { program: 8, "crossing.input": 8, "crossing.output": 8, result: 8, outputs: 8, error: 8 } } });
  const long = { list: [1, 2, 3], text: "é😀".repeat(10) };
  const ex = h.m.execution.start({ program: "é😀".repeat(10), notice: false });
  ex.crossing.start({ target: "t", input: long }).output("😀".repeat(10));
  ex.crossing.start({ target: "t", input: [1, 2, 3, 4, 5] }).output(new Uint8Array(64));
  ex.fail({ big: "x".repeat(20) }, { result: long, outputs: { stdout: "\n".repeat(20) } });
  const checked: string[] = [];
  const check = (p: Rec, full: string): void => {
    assert.equal(p["truncated"], true);
    assert.equal(typeof p["value"], "string");
    assert.ok(full.startsWith(p["value"] as string), `${JSON.stringify(p["value"])} is not a prefix of ${full.slice(0, 30)}`);
    assert.ok(Buffer.byteLength(p["value"] as string) <= 8);
    checked.push(full);
  };
  const [c1, c2] = h.ofKind("crossing") as [Rec, Rec];
  check(c1["input"] as Rec, JSON.stringify(long));
  check((c1["end"] as Rec)["output"] as Rec, JSON.stringify("😀".repeat(10)));
  check(c2["input"] as Rec, JSON.stringify([1, 2, 3, 4, 5]));
  check((c2["end"] as Rec)["output"] as Rec, '"' + Buffer.alloc(64).toString("base64") + '"');
  const e = h.last("execution");
  check(e["program"] as Rec, "é😀".repeat(10));
  const end = e["end"] as Rec;
  check(end["result"] as Rec, JSON.stringify(long));
  check((end["outputs"] as Rec)["stdout"] as Rec, JSON.stringify("\n".repeat(20)));
  check((end["error"] as Rec)["value"] as Rec, JSON.stringify({ big: "x".repeat(20) }));
  assert.equal(checked.length, 8);
  assertValidStream(h.sink.lines);

  assert.equal(payloadWire('"ab"', true, false, undefined, undefined), '{"value":"ab","truncated":true}');
  assert.throws(() => payloadWire("12", true, false, undefined, undefined), isInvariant, "a truncated value that is not a string");
});

test("the host declaration is written before any record", async () => {
  const seen: string[][] = [];
  const first = (): Sink => {
    const lines: string[] = [];
    seen.push(lines);
    return { write: (batch) => void lines.push(...batch) };
  };
  const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [first(), first()] });
  const ex = m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t", input: 1, notice: true }).output(1);
  ex.complete();
  m.declare();
  for (const lines of seen) {
    assert.equal(JSON.parse(lines[0] as string)["kind"], "host", "each sink's first line is the declaration");
    assert.equal(lines.at(-1), lines[0], "a re-declaration is the same line");
  }

  // A sink whose first write fails has not taken the declaration, so the next batch it is offered carries it again.
  const offered: string[][] = [];
  let writes = 0;
  const flaky: Sink = {
    write(batch) {
      offered.push([...batch]);
      if (++writes === 1) throw new Error("collector unreachable");
    },
  };
  const runtime = createRuntime("h", '{"kind":"host","host":"h"}', [flaky], new Capturer(undefined), undefined);
  runtime.declare();
  runtime.inst.emit(['{"kind":"execution","id":"e1"}']);
  runtime.inst.emit(['{"kind":"execution","id":"e2"}']);
  assert.deepEqual(
    offered.map((batch) => batch.map((l) => JSON.parse(l)["kind"] as string)),
    [["host"], ["host", "execution"], ["execution"]],
    "every batch carries the declaration until one write of it goes through",
  );
  await runtime.close();
});
