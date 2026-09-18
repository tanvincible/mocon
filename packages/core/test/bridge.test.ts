/**
 * `instrument`'s `end` hook: the host's own reading of what its bridge answered, in place of the library's
 * guess that a return is an output and a throw is an error. Each test is named for the rule it protects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeAnswer } from "../src/index.js";
import { assertValidStream, harness, type Rec } from "./helpers.js";

/** The shape the one real integration had: the bridge never throws and answers with an envelope. */
type Envelope = { ok: true; data: unknown; credits_used: number } | { ok: false; status: number; errorType: string; message: string };

test("instrument: a bridge that never throws is one line, not a special case", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const bridge = (name: string, _params: unknown): Envelope => (name === "person_search" ? { ok: true, data: [1, 2], credits_used: 12 } : { ok: false, status: 503, errorType: "capability_error", message: "upstream unavailable" });
  // `threw` narrows `value` to the bridge's own return type, so the hook needs no cast.
  const callTool = ex.instrument(bridge, {
    end: (a) =>
      a.threw
        ? undefined
        : a.value.ok
          ? { outcome: "output", output: a.value.data, ext: { "example.credits_used": a.value.credits_used } }
          : { outcome: "error", error: { class: a.value.errorType, message: a.value.message } },
  });
  callTool("person_search", { limit: 2 });
  callTool("company_identify", { domain: "acme.example" });
  ex.complete();

  const [good, bad] = h.ofKind("crossing") as [Rec, Rec];
  assert.deepEqual((good["end"] as Rec)["outcome"], "output");
  assert.deepEqual(((good["end"] as Rec)["output"] as Rec)["value"], [1, 2]);
  assert.deepEqual(good["ext"], { "example.credits_used": 12 });
  assert.deepEqual(bad["end"], { time: (bad["end"] as Rec)["time"], outcome: "error", error: { class: "capability_error", message: "upstream unavailable" } });
  assertValidStream(h.sink.lines);
});

test("instrument: without the hook a return is an output and a throw is an error, as before", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument((name: string) => {
    if (name === "bad") throw new Error("boom");
    return { ok: 1 };
  });
  call("good");
  assert.throws(() => call("bad"), /boom/);
  ex.complete();
  const [good, bad] = h.ofKind("crossing") as [Rec, Rec];
  assert.equal((good["end"] as Rec)["outcome"], "output");
  assert.equal((bad["end"] as Rec)["outcome"], "error");
  assert.equal(((bad["end"] as Rec)["error"] as Rec)["class"], "capability_error");
  assertValidStream(h.sink.lines);
});

test("instrument: the hook reads a throw too, and the wrapper still rethrows the exact error", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const thrown = new Error("cancelled by the caller");
  const seen: Array<BridgeAnswer<[string]>> = [];
  const call = ex.instrument(
    (_name: string): unknown => {
      throw thrown;
    },
    {
      end: (answer) => {
        seen.push(answer as BridgeAnswer<[string]>);
        return answer.threw && (answer.error as Error).message.startsWith("cancelled") ? { outcome: "abandoned" } : undefined;
      },
    },
  );
  assert.throws(() => call("t"), (e: unknown) => e === thrown);
  ex.complete();
  assert.deepEqual(seen.map((a) => [a.threw, a.args]), [[true, ["t"]]]);
  assert.deepEqual(h.last("crossing")["end"], { outcome: "abandoned" });
  assertValidStream(h.sink.lines);
});

test("instrument: a hook that throws, returns nothing, or returns an outcome the wire refuses costs the reading and never the call", () => {
  for (const end of [
    () => {
      throw new Error("the hook could not read this answer");
    },
    () => undefined,
    () => ({ outcome: "sideways" }) as never,
    () => "output" as never,
    () => null as never,
  ]) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", notice: false });
    const call = ex.instrument((n: string) => ({ echoed: n }), { end });
    assert.deepEqual(call("t"), { echoed: "t" }, "the bridge still ran and answered the program");
    ex.complete();
    const crossing = h.last("crossing");
    assert.equal((crossing["end"] as Rec)["outcome"], "output", "the default outcome still records the call");
    assert.deepEqual(((crossing["end"] as Rec)["output"] as Rec)["value"], { echoed: "t" });
    assertValidStream(h.sink.lines);
  }
});

test("instrument: the hook follows a promise, settling the crossing when the bridge's promise settles", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const call = ex.instrument(async (name: string) => ({ ok: name === "good" }), {
    end: (a) => (a.threw || a.value.ok ? undefined : { outcome: "error", error: { class: "capability_error", message: "the target said no" } }),
  });
  await call("good");
  await call("bad");
  ex.complete();
  const [good, bad] = h.ofKind("crossing") as [Rec, Rec];
  assert.equal((good["end"] as Rec)["outcome"], "output");
  assert.deepEqual((bad["end"] as Rec)["error"], { class: "capability_error", message: "the target said no" });
  assertValidStream(h.sink.lines);
});

test("instrument: end must be a function, and only instrument() itself throws for an option of the wrong type", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  assert.throws(() => ex.instrument((n: string) => n, { end: "output" as never }), TypeError);
  ex.complete();
});
