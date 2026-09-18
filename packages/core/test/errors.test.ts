/**
 * The error a record carries is bounded like any other captured field.
 * `message` comes from what the program threw, or from a client's cancel
 * reason, so it is cut at the error slot's cap with a `mocon.message` note,
 * and a rule on the slot withholds it with the value. The cause rule reads
 * a thrown error's own properties lazily, as the walk writes them, so a
 * getter past the cap never runs, as for a plain object.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAPS } from "../src/payload.js";
import { assertValidStream, harness, type Rec } from "./helpers.js";

const MIB = 1 << 20;
const HUGE = 5_000_000;

test("a thrown Error with a long message has it cut at the error cap, noted, and a 5 MB one keeps the line under 1 MiB (execution.fail)", () => {
  const h = harness();
  for (const size of [HUGE, 1 << 19]) {
    const ex = h.m.execution.start({ program: "p", notice: false });
    ex.fail(new Error("x".repeat(size)));
    const line = h.sink.lines.at(-1) as string;
    assertValidStream([line]);
    assert.ok(line.length < MIB, `the complete execution line is ${line.length} bytes`);
    const rec = JSON.parse(line) as Rec;
    const message = ((rec["end"] as Rec)["error"] as Rec)["message"] as string;
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= DEFAULT_CAPS.error);
    assert.equal("x".repeat(message.length), message, "the message is a prefix of the thrown one");
    assert.deepEqual(rec["ext"], { "mocon.message": { truncated: true } });
  }
  const cut = ((h.last("execution")["end"] as Rec)["error"] as Rec)["message"] as string;
  assert.equal(cut.length, DEFAULT_CAPS.error - 2, "a message that is not far past the cap fills it");
});

test("a thrown 5 MB string does not produce a line over 1 MiB (execution.end with error.cause)", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.end({ disposition: "failed", error: { class: "runtime", cause: "y".repeat(HUGE) } });
  const line = h.sink.lines.at(-1) as string;
  assert.ok(line.length < MIB, `the complete execution line is ${line.length} bytes`);
});

test("a bridge error with a 5 MB message does not produce a crossing line over 1 MiB", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((_name: string) => {
    throw new Error("z".repeat(HUGE));
  });
  assert.throws(() => call("t"));
  const line = h.sink.lines.at(-1) as string;
  assert.ok(line.length < MIB, `the complete crossing line is ${line.length} bytes`);
  assert.deepEqual((JSON.parse(line) as Rec)["ext"], { "mocon.message": { truncated: true } });
});

test("a late error with a 5 MB message does not produce a late_settlement event over 1 MiB, and the event carries the note", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const c = ex.crossing.start({ target: "t", input: null });
  ex.complete();
  c.error(new Error("w".repeat(HUGE)));
  const event = h.sink.lines.at(-1) as string;
  assert.equal((JSON.parse(event) as Rec)["kind"], "event");
  assert.ok(event.length < MIB, `the late_settlement line is ${event.length} bytes`);
  assert.deepEqual((JSON.parse(event) as Rec)["ext"], { "mocon.message": { truncated: true } });
  assertValidStream(h.sink.lines);
});

test('an error slot set to "drop" keeps the thrown text out of the record', () => {
  const h = harness({ capture: { rules: { error: "drop", "crossing.error": "drop" } } });
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "auth.login", input: null }).error(new Error("bad token sk-live-crossing"));
  ex.fail(new Error("password=hunter2"));
  const text = h.sink.lines.join("\n");
  assert.ok(!text.includes("sk-live-crossing"), "a dropped crossing error still writes its message");
  assert.ok(!text.includes("hunter2"), "a dropped execution error still writes its message");
  assert.deepEqual((h.last("execution")["end"] as Rec)["error"], { class: "runtime", value: { redacted: true } });
});

test("the cause rule does not run every getter of a thrown error: reads stop near the error cap, as they do for a plain object", () => {
  const COUNT = 50_000;
  const withGetters = <T extends object>(target: T): { value: T; reads: () => number } => {
    let reads = 0;
    for (let i = 0; i < COUNT; i++) {
      Object.defineProperty(target, "k" + i, {
        enumerable: true,
        get() {
          reads++;
          return "v".repeat(10);
        },
      });
    }
    return { value: target, reads: () => reads };
  };
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });

  const plain = withGetters({});
  ex.crossing.start({ target: "t", input: null }).error(plain.value);
  const plainReads = plain.reads();
  assert.ok(plainReads < COUNT / 4, `a plain object's getters ran ${plainReads} times`);

  const error = withGetters(new Error("boom"));
  ex.crossing.start({ target: "t", input: null }).error(error.value);
  assert.ok(error.reads() <= plainReads * 2, `a thrown Error's getters ran ${error.reads()} times, against ${plainReads} for a plain object under the same 16 KiB cap`);
});
