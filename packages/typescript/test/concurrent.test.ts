/**
 * A code-mode host serves many dispatches at once, and one program's calls overlap. These assert the
 * two things that break first under that: a crossing must be parented to its own execution rather
 * than to whichever was most recent, and an execution must not end while its own work is in flight.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Capabilities, codeMode } from "../src/index.js";

const CAPS: Capabilities = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation" };

function harness() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  return { m: codeMode({ capabilities: CAPS, tracer: provider.getTracer("t") }), spans: (): ReadableSpan[] => exporter.getFinishedSpans() };
}

const byName = (spans: ReadableSpan[], name: string): ReadableSpan[] => spans.filter((s) => s.name === name);

test("concurrent executions keep their own crossings, traces and sequence counters", async () => {
  const h = harness();
  const dispatch = async (tag: string, calls: number): Promise<void> => {
    await h.m.execution.run({ program: tag, tool: tag }, async (execution) => {
      const bridge = execution.instrument(async (name: string) => {
        await new Promise((r) => setTimeout(r, 1));
        return name;
      });
      await Promise.all(Array.from({ length: calls }, (_, i) => bridge(`${tag}.call${i}`)));
    });
  };
  await Promise.all([dispatch("a", 3), dispatch("b", 2), dispatch("c", 4)]);

  for (const [tag, calls] of [["a", 3], ["b", 2], ["c", 4]] as const) {
    const execution = byName(h.spans(), `execute_code ${tag}`)[0] as ReadableSpan;
    const crossings = h.spans().filter((s) => (s.attributes["gen_ai.tool.name"] as string | undefined)?.startsWith(tag + "."));
    assert.equal(crossings.length, calls, `${tag} recorded every call it made`);
    for (const crossing of crossings) {
      assert.equal(crossing.parentSpanId, execution.spanContext().spanId, `${tag}'s crossing belongs to ${tag}`);
      assert.equal(crossing.spanContext().traceId, execution.spanContext().traceId);
    }
    const seqs = crossings.map((s) => s.attributes["code_mode.crossing.seq"]).sort();
    assert.deepEqual(seqs, Array.from({ length: calls }, (_, i) => i + 1), `${tag} counts its own crossings from 1`);
  }
});

test("an async body holds the execution open until it settles, and every crossing ends inside it", async () => {
  const h = harness();
  const promise = h.m.execution.run({ program: "p" }, async (execution) => {
    const bridge = execution.instrument(async (n: string) => n);
    await bridge("one");
    assert.equal(h.spans().length, 1, "the crossing ended, the execution has not");
    await bridge("two");
    return "done";
  });
  assert.equal(h.spans().length, 0, "nothing has ended while the body runs");
  assert.equal(await promise, "done");
  const spans = h.spans();
  assert.deepEqual(spans.map((s) => s.name), ["execute_tool one", "execute_tool two", "execute_code"]);
  assert.equal(spans[2]?.attributes["code_mode.execution.disposition"], "completed");
});

test("a rejected async body fails the execution and rethrows the original error", async () => {
  const h = harness();
  const boom = new Error("boom");
  await assert.rejects(
    h.m.execution.run({ program: "p" }, async (execution) => {
      execution.crossing.start({ target: "left-open" });
      throw boom;
    }),
    (e: Error) => e === boom,
  );
  const spans = h.spans();
  assert.deepEqual(spans.map((s) => s.attributes["code_mode.crossing.outcome"] ?? s.attributes["code_mode.execution.disposition"]), ["abandoned", "failed"]);
  assert.equal(spans[0]?.attributes["code_mode.crossing.timing"], "start_only", "the crossing in flight is closed where it began");
});

test("overlapping crossings within one execution are recorded independently and may finish out of order", async () => {
  const h = harness();
  await h.m.execution.run({ program: "p" }, async (execution) => {
    const slow = execution.crossing.start({ target: "slow" });
    const fast = execution.crossing.start({ target: "fast" });
    fast.output(1);
    await new Promise((r) => setTimeout(r, 2));
    slow.output(2);
  });
  const spans = h.spans();
  assert.deepEqual(spans.map((s) => s.name), ["execute_tool fast", "execute_tool slow", "execute_code"]);
  assert.equal(spans[0]?.attributes["code_mode.crossing.seq"], 2, "seq is initiation order, not settlement order");
  assert.equal(spans[1]?.attributes["code_mode.crossing.seq"], 1);
});
