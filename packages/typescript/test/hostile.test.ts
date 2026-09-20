/**
 * The values a code-mode emitter captures come from the program, which is agent-written. Serializing
 * one runs its code: a getter, a `toJSON`, a Proxy trap, a `toString`. Every test here asserts the
 * same rule from otel-code-mode.md 10, the one that decides whether this library is safe to put on a
 * request path: no emitter fault may raise into the caller, and the span is still recorded.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Capabilities, codeMode } from "../src/index.js";

const CAPS: Capabilities = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation" };

function harness(values = true) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  return { m: codeMode({ capabilities: CAPS, capture: { values }, tracer: provider.getTracer("t") }), spans: (): ReadableSpan[] => exporter.getFinishedSpans() };
}

const note = (span: ReadableSpan): Record<string, Record<string, unknown>> =>
  JSON.parse((span.attributes["code_mode.capture"] as string | undefined) ?? "{}") as Record<string, Record<string, unknown>>;

/** Each returns a value whose serialization runs code that fails. */
const HOSTILE: Array<[string, () => unknown]> = [
  ["a throwing toJSON", () => ({ toJSON() { throw new Error("hostile"); } })],
  ["a throwing getter", () => Object.defineProperty({}, "x", { get() { throw new Error("hostile"); }, enumerable: true })],
  ["a cycle", () => { const c: Record<string, unknown> = {}; c["self"] = c; return c; }],
  ["a bigint, which JSON refuses", () => ({ n: 1n })],
  ["a Proxy whose ownKeys trap throws", () => new Proxy({}, { ownKeys() { throw new Error("hostile"); } })],
];

for (const [what, make] of HOSTILE) {
  test(`${what} in a result costs the value, not the execution`, () => {
    const h = harness();
    h.m.execution.start({ program: "p" }).complete({ result: make() });
    const span = h.spans()[0] as ReadableSpan;
    assert.equal(span.attributes["code_mode.execution.disposition"], "completed", "the execution still records");
    assert.equal("gen_ai.tool.call.result" in span.attributes, false, "the value it could not serialize is not written");
    assert.equal(note(span)["gen_ai.tool.call.result"]?.["redacted"], true, "and the note says the host dropped it");
  });

  test(`${what} in a crossing's input costs the value, not the call`, () => {
    const h = harness();
    const ex = h.m.execution.start({ program: "p" });
    const bridge = ex.instrument((name: string, args: unknown) => ({ ok: true }));
    assert.deepEqual(bridge("search", make()), { ok: true }, "the bridge still ran and answered");
    ex.complete();
    const crossing = h.spans()[0] as ReadableSpan;
    assert.equal(crossing.attributes["code_mode.crossing.outcome"], "output");
    assert.equal(note(crossing)["gen_ai.tool.call.arguments"]?.["redacted"], true);
  });
}

test("a hostile toString on a bridge argument names the target without running it", () => {
  const h = harness(false);
  const ex = h.m.execution.start({ program: "p" });
  const bridge = ex.instrument((first: unknown) => 1);
  const hostile = { toString() { throw new Error("hostile"); } };
  assert.equal(bridge(hostile), 1, "the call still ran");
  ex.complete();
  assert.equal(h.spans()[0]?.attributes["gen_ai.tool.name"], "[object]", "labelled by type, never by its own toString");
});

test("a throwing getter on an output channel costs that channel, not the execution", () => {
  const h = harness();
  const outputs = Object.defineProperty({ stdout: "fine" }, "stderr", { get() { throw new Error("hostile"); }, enumerable: true });
  h.m.execution.start({ program: "p" }).complete({ outputs: outputs as Record<string, unknown> });
  const span = h.spans()[0] as ReadableSpan;
  assert.equal(span.attributes["code_mode.execution.disposition"], "completed");
  assert.equal(span.attributes["code_mode.output.stdout"], '"fine"', "the channels read before the throw survive");
});

test("a throwing getter on a host attribute costs that attribute, not the execution", () => {
  const h = harness(false);
  const attrs = Object.defineProperty({ "com.acme.ok": 1 }, "com.acme.bad", { get() { throw new Error("hostile"); }, enumerable: true });
  h.m.execution.start({ program: "p", attributes: attrs as never }).complete();
  const span = h.spans()[0] as ReadableSpan;
  assert.equal(span.attributes["code_mode.execution.disposition"], "completed");
  assert.equal(span.attributes["com.acme.ok"], 1);
});

test("an outputs container that is not an object is the host's own bug, refused before the span changes", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  assert.throws(() => ex.complete({ outputs: "stdout" as never }), TypeError);
  assert.equal(h.spans().length, 0, "the span is untouched, so the host can still end it correctly");
  ex.complete();
  assert.equal(h.spans()[0]?.attributes["code_mode.execution.disposition"], "completed");
});

/**
 * Ported from the retired format's negative corpus. Those fixtures were the reason it could not ship
 * a defect this emitter did ship, so the cases that still apply are asserted here instead.
 */

test("a sequence number that is not a positive integer is refused, because a wrong order beats no order", () => {
  const h = harness(false);
  const ex = h.m.execution.start({ program: "p" });
  for (const seq of [-1, 0, 1.5, "two", NaN, null]) ex.crossing.start({ target: "t", seq: seq as never }).output(1);
  ex.complete();
  const written = h.spans().filter((s) => s.name.startsWith("execute_tool")).map((s) => s.attributes["code_mode.crossing.seq"]);
  assert.deepEqual(written, [1, 2, 3, 4, 5, 6], "each falls back to the host's own counter, which is trustworthy");
});

test("a supplied sequence number is kept when it is a positive integer", () => {
  const h = harness(false);
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t", seq: 7 }).output(1);
  ex.complete();
  assert.equal(h.spans()[0]?.attributes["code_mode.crossing.seq"], 7);
});

test("an end with no disposition is refused before the span is touched", () => {
  const h = harness(false);
  const ex = h.m.execution.start({ program: "p" });
  assert.throws(() => ex.end({} as never), RangeError);
  assert.equal(h.spans().length, 0, "the span is untouched, so the host can still end it correctly");
  ex.complete();
  assert.equal(h.spans()[0]?.attributes["code_mode.execution.disposition"], "completed");
});

test("an execution id that is not a string gets a minted one rather than a bad attribute", () => {
  const h = harness(false);
  h.m.execution.start({ program: "p", id: 42 as never }).complete();
  const id = h.spans()[0]?.attributes["code_mode.execution.id"];
  assert.equal(typeof id, "string");
  assert.notEqual(id, "42", "a number is not silently stringified into the host's own id space");
});

test("an error field passed with a successful outcome is ignored, not written", () => {
  const h = harness(false);
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).end({ outcome: "output", errorType: "timeout", message: "nope" } as never);
  ex.complete();
  const crossing = h.spans()[0];
  assert.equal(crossing?.attributes["code_mode.crossing.outcome"], "output");
  assert.equal("error.type" in (crossing?.attributes ?? {}), false, "the closed outcome decides, not the stray field");
  assert.equal(crossing?.status.code, 0, "and the status stays Unset");
});

/**
 * Both of these were found by a second implementation in another language disagreeing with this one,
 * which is the only way either would have been noticed.
 */

test("a value JSON cannot hold is dropped whole, with no size and no hash", () => {
  const h = harness();
  h.m.execution.start({ program: "p" }).complete({ result: { temp: NaN, max: Infinity, ok: 1 } });
  const span = h.spans()[0] as ReadableSpan;
  // Writing null in place of NaN turns a reading into a reading of nothing, and a reader who misses
  // the flag takes that at face value. And bytes and hash describe the original, which is precisely
  // what could not be serialized.
  assert.equal("gen_ai.tool.call.result" in span.attributes, false);
  const n = note(span)["gen_ai.tool.call.result"] as Record<string, unknown>;
  assert.equal(n["redacted"], true);
  assert.equal("bytes" in n, false);
  assert.equal("hash" in n, false);
});

test("a finite payload carries no redaction flag, so the flag means something", () => {
  const h = harness();
  h.m.execution.start({ program: "p" }).complete({ result: { temp: 21.5, ok: 1 } });
  assert.equal("redacted" in (note(h.spans()[0] as ReadableSpan)["gen_ai.tool.call.result"] ?? {}), false);
});

test("a truncated program is a prefix of the program, not of its JSON literal", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const m = codeMode({ capabilities: CAPS, capture: { values: true, programCap: 200 }, tracer: provider.getTracer("t") });
  const program = "const x = 1;\n".repeat(40);
  m.execution.start({ program }).complete();
  const written = exporter.getFinishedSpans()[0]?.attributes["code_mode.program.text"] as string;
  assert.ok(program.startsWith(written), "a reader can match it against the source they hold");
  assert.equal(written.includes("\\n"), false, "and it is source, not an escaped JSON literal");
});

test("an error thrown inside a sandbox is read by shape, because it belongs to another realm", async () => {
  const h = harness();
  // The single most common failure a code-mode host handles. `instanceof Error` is false for this
  // value in the host's realm, so a check written that way returns nothing exactly when it matters.
  const thrown = ((): unknown => {
    try {
      vm.runInNewContext('throw new Error("boom from program")');
    } catch (e) {
      return e;
    }
  })();
  assert.equal(thrown instanceof Error, false);

  const ex = h.m.execution.start({ program: "p" });
  ex.fail(thrown);
  const span = h.spans()[0] as ReadableSpan;
  assert.equal(span.attributes["code_mode.error.message"], '"boom from program"');
  // `name` is on the prototype and `message` is own-but-not-enumerable, so a walk over enumerable
  // keys writes `{}` and the note then attests it faithfully captured nothing.
  assert.equal(span.attributes["code_mode.error.body"], '{"name":"Error","message":"boom from program"}');
});

test("a message is read from anything carrying one, and a hostile getter costs only the message", () => {
  const cases: Array<[unknown, string | undefined]> = [
    [{ code: 7, message: "disk full" }, '"disk full"'],
    ["disk full", '"disk full"'],
    [{ get message(): string { throw new Error("TRAP"); } }, undefined],
    [{ message: 42 }, undefined],
    [null, undefined],
  ];
  for (const [thrown, expected] of cases) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p" });
    ex.fail(thrown);
    assert.equal((h.spans()[0] as ReadableSpan).attributes["code_mode.error.message"], expected);
  }
});

test("an end hook names what it changes, so answering with one field never drops the payload", async () => {
  const h = harness();
  // The `Envelopes` recipe in the docs. Before the hook's answer was merged it was taken as the
  // whole end, so this span said a call failed and carried nothing about why.
  const bridge = async (): Promise<unknown> => ({ ok: false, error: { code: "rate_limited" } });
  await h.m.execution.run({ program: "p" }, async (execution) => {
    const callTool = execution.instrument(bridge, {
      end: (answer) =>
        !answer.threw && !(answer.value as { ok: boolean }).ok
          ? { outcome: "error" as const, errorType: "capability_error", dispatched: true }
          : undefined,
    });
    await callTool();
  });
  const crossing = h.spans().find((s) => s.name.startsWith("execute_tool")) as ReadableSpan;
  assert.equal(crossing.attributes["code_mode.crossing.outcome"], "error");
  assert.equal(crossing.attributes["error.type"], "capability_error");
  assert.equal(crossing.attributes["code_mode.error.body"], '{"ok":false,"error":{"code":"rate_limited"}}');
});

test("a hook that only adds an attribute keeps the output it did not mention", async () => {
  const h = harness();
  await h.m.execution.run({ program: "p" }, async (execution) => {
    const callTool = execution.instrument(async () => ({ rows: 3 }), { end: () => ({ dispatched: true }) });
    await callTool();
  });
  const crossing = h.spans().find((s) => s.name.startsWith("execute_tool")) as ReadableSpan;
  assert.equal(crossing.attributes["code_mode.crossing.outcome"], "output");
  assert.equal(crossing.attributes["gen_ai.tool.call.result"], '{"rows":3}');
  assert.equal(crossing.attributes["code_mode.crossing.dispatched"], true);
});

test("an error that holds itself is a cycle, not a heap bomb", () => {
  // The shape is memoized per error so the walker's identity scan sees the cycle. Without that it
  // recursed to the depth limit rebuilding the shape at every level, and a wide enough error
  // exhausted the heap and took the process with it rather than costing the value.
  const h = harness();
  const e = new Error("boom") as Error & Record<string, unknown>;
  e["self"] = e;
  for (let i = 0; i < 20000; i++) e["k" + i] = i;

  const started = process.hrtime.bigint();
  h.m.execution.start({ program: "p" }).fail(e);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const span = h.spans()[0] as ReadableSpan;
  assert.deepEqual(note(span)["code_mode.error.body"], { redacted: true });
  assert.equal(span.attributes["code_mode.error.body"], undefined);
  // Generous, because it is a cliff and not a slope: the defect took seconds, the fix takes tens of
  // milliseconds, and nothing lands in between.
  assert.ok(ms < 2000, `cyclic error took ${ms.toFixed(0)}ms`);
});

test("a cycle reached through an error, and two errors holding each other, both terminate", () => {
  const cases: Array<[string, () => unknown]> = [
    ["an error inside an envelope", () => { const e = new Error("c") as Error & Record<string, unknown>; e["self"] = e; return { wrapped: e }; }],
    ["two errors holding each other", () => { const a = new Error("a") as Error & Record<string, unknown>; const b = new Error("b") as Error & Record<string, unknown>; a["other"] = b; b["other"] = a; return a; }],
  ];
  for (const [what, make] of cases) {
    const h = harness();
    h.m.execution.start({ program: "p" }).fail(make());
    assert.deepEqual(note(h.spans()[0] as ReadableSpan)["code_mode.error.body"], { redacted: true }, what);
  }
});

test("a hook that names one field keeps the error class the default would have set", async () => {
  const h = harness();
  await h.m.execution.run({ program: "p" }, async (execution) => {
    const call = execution.instrument(() => { throw new Error("upstream"); }, { end: () => ({ dispatched: true }) });
    try { call(); } catch { /* the caller's own error, rethrown */ }
  });
  const crossing = h.spans().find((s) => s.name.startsWith("execute_tool")) as ReadableSpan;
  // Without the default merged in this read `_OTHER`, which is a facet most backends group by.
  assert.equal(crossing.attributes["error.type"], "capability_error");
});

test("a time from another realm is read as a time, not as NaN", () => {
  const h = harness();
  const elsewhere = vm.runInNewContext("new Date(Date.now() - 5000)") as Date;
  assert.equal(elsewhere instanceof Date, false);
  const ex = h.m.execution.start({ program: "p", startTime: elsewhere });
  ex.complete();
  const span = h.spans()[0] as ReadableSpan;
  const seconds = span.duration[0] + span.duration[1] / 1e9;
  assert.ok(seconds > 4 && seconds < 7, `duration was ${seconds}s`);
});

test("a re-captured error reports what it is now, not what it was the first time", () => {
  // The shape memo exists only to make a cycle terminate within one capture. Kept beyond that, it
  // republished the first capture's content under a hash asserting the value was read whole, which
  // is the spec's second-worst outcome: telemetry that is false rather than absent.
  const e = new Error("attempt 1 failed") as Error & Record<string, unknown>;
  e["attempt"] = 1;

  const first = harness();
  first.m.execution.start({ program: "p" }).fail(e);
  assert.equal((first.spans()[0] as ReadableSpan).attributes["code_mode.error.body"], '{"name":"Error","message":"attempt 1 failed","attempt":1}');

  e.message = "attempt 2 failed";
  e["attempt"] = 2;
  const second = harness();
  second.m.execution.start({ program: "p" }).fail(e);
  assert.equal((second.spans()[0] as ReadableSpan).attributes["code_mode.error.body"], '{"name":"Error","message":"attempt 2 failed","attempt":2}');
});

test("an error that stops being cyclic stops being redacted", () => {
  const e = new Error("boom") as Error & Record<string, unknown>;
  e["self"] = e;
  const cyclic = harness();
  cyclic.m.execution.start({ program: "p" }).fail(e);
  assert.deepEqual(note(cyclic.spans()[0] as ReadableSpan)["code_mode.error.body"], { redacted: true });

  delete e["self"];
  const plain = harness();
  plain.m.execution.start({ program: "p" }).fail(e);
  assert.equal((plain.spans()[0] as ReadableSpan).attributes["code_mode.error.body"], '{"name":"Error","message":"boom"}');
});

test("no time a caller can supply reaches the caller as a throw", () => {
  const times: Array<[string, unknown]> = [
    ["a throwing valueOf", { valueOf() { throw new Error("TRAP"); }, toString() { throw new Error("TRAP"); } }],
    ["NaN", NaN],
    ["an invalid Date", new Date(NaN)],
    ["past the Date range", 1e300],
    ["a pair with a throwing element", [{ valueOf() { throw new Error("TRAP"); } }, 0]],
    ["a pair of the wrong length", [5]],
    ["a symbol", Symbol("t")],
  ];
  for (const [what, time] of times) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p", startTime: time as never });
    ex.complete({ endTime: time as never });
    const span = h.spans()[0] as ReadableSpan;
    // Not merely contained: the span still has a usable time rather than a NaN one.
    assert.ok(Number.isFinite(span.duration[0] + span.duration[1] / 1e9), `${what} left a span with no readable duration`);
  }
});

test("a host cannot set the dimension the duration histograms are split by", () => {
  const h = harness();
  h.m.execution.start({ program: "p", attributes: { "error.type": "anything-at-all", team: "billing" } }).complete();
  const span = h.spans()[0] as ReadableSpan;
  assert.equal(span.attributes["error.type"], undefined);
  assert.equal(span.attributes["team"], "billing");
});
