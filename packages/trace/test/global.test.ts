/**
 * The claim the whole move rests on: a host that emits through the OpenTelemetry API reaches the
 * exporters the application owner already configured, with no destination of ours to wire. Here the
 * owner registers a provider the way any application does, the host passes no tracer, and the spans
 * arrive at the owner's exporter.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { codeMode } from "../src/index.js";

test("a host that passes no tracer reaches the exporter the application owner already registered", () => {
  // What an application owner writes once, for every library in the process. Nothing here is ours.
  const owner = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(owner));
  trace.setGlobalTracerProvider(provider);

  try {
    // What a code-mode host writes. No exporter, no sink, no destination.
    const m = codeMode({ capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation" } });
    m.execution.run({ program: "await callTool('search', {});", tool: "execute" }, (execution) => {
      const callTool = execution.instrument((name: string) => ({ rows: 2 }));
      callTool("search");
    });

    const spans = owner.getFinishedSpans();
    assert.deepEqual(spans.map((s) => s.name), ["execute_tool search", "execute_code execute"]);
    assert.equal(spans[1]?.instrumentationLibrary.name, "@mocon/trace", "the scope names the instrumentation");
    assert.equal(spans[0]?.parentSpanId, spans[1]?.spanContext().spanId);
    assert.equal(spans[1]?.attributes["code_mode.execution.disposition"], "completed");
  } finally {
    trace.disable();
  }
});
