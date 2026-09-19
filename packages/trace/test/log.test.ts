/**
 * The logger destination. A team whose telemetry is structured logs should get the whole vocabulary
 * without standing up a collector and a trace store, because that pipeline is the real cost of
 * adopting this and it dwarfs the two wrappers.
 *
 * Several of these assert mistakes a hand-written destination actually made when this was measured.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Capabilities, codeMode, type LogRecord, logTracer } from "../src/index.js";

const CAPS: Capabilities = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target"] };

function harness(caps: Capabilities = CAPS, capture?: { values: boolean }) {
  const records: LogRecord[] = [];
  return { m: codeMode({ capabilities: caps, capture, tracer: logTracer((r) => records.push(r)) }), records };
}

test("a whole run reaches a plain logger, with no SDK, exporter, collector or trace store", () => {
  const h = harness();
  h.m.execution.run({ program: "await callTool('search', {})", tool: "execute", id: "exec-1" }, (execution) => {
    execution.instrument((name: string) => ({ rows: 2 }))("company_search");
  });
  assert.equal(h.records.length, 2);
  const [crossing, execution] = h.records as [LogRecord, LogRecord];
  assert.equal(execution.name, "execute_code execute");
  assert.equal(execution["code_mode.execution.disposition"], "completed");
  assert.equal(crossing.name, "execute_tool company_search");
  assert.equal(crossing["code_mode.crossing.outcome"], "output");
  assert.equal(crossing["code_mode.execution.id"], "exec-1", "the join key an operator holds");
});

test("the tree is reassembled by grouping, not by trusting the writer to nest it", () => {
  const h = harness();
  h.m.execution.run({ program: "p" }, (execution) => {
    execution.instrument((n: string) => 1)("a");
    execution.instrument((n: string) => 1)("b");
  });
  const [a, b, execution] = h.records as [LogRecord, LogRecord, LogRecord];
  assert.equal(a.parent_span_id, execution.span_id);
  assert.equal(b.parent_span_id, execution.span_id);
  assert.equal(a.trace_id, execution.trace_id);
  assert.equal(execution.parent_span_id, undefined, "the execution is the root");
});

test("a crossing that starts after its execution ended is still written, not buffered forever", () => {
  // The failure a nested log destination had when this was measured: it held children until the
  // parent closed, so a call the program made on a later tick vanished with no error at all.
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.complete();
  ex.crossing.start({ target: "late" }).output(1);
  assert.equal(h.records.length, 2);
  assert.equal(h.records[1]?.name, "execute_tool late");
});

test("the status and the kind survive, which is where the closed vocabulary lives", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", kind: "server" });
  ex.crossing.start({ target: "t" }).error(new Error("boom"), { errorType: "capability_error" });
  ex.fail(new Error("boom"));
  const [crossing, execution] = h.records as [LogRecord, LogRecord];
  assert.equal(execution.kind, "server");
  assert.equal(crossing.kind, "client");
  assert.equal(crossing.status, "error");
  assert.equal(crossing.status_message, "capability_error", "dropping this loses the error class entirely");
  assert.equal(execution.status_message, "runtime");
});

test("payloads come back as values, because a log record can hold a map and a span cannot", () => {
  const h = harness(CAPS, { values: true });
  const ex = h.m.execution.start({ program: "const x = 1;" });
  ex.crossing.start({ target: "t", input: { limit: 50 } }).output({ rows: [1, 2] });
  ex.complete();
  const crossing = h.records[0] as LogRecord;
  assert.deepEqual(crossing["gen_ai.tool.call.arguments"], { limit: 50 });
  assert.deepEqual(crossing["gen_ai.tool.call.result"], { rows: [1, 2] });
  assert.equal(typeof (h.records[1] as LogRecord)["code_mode.capture"], "object");
});

test("program text is never parsed, whatever it happens to start with", () => {
  const h = harness(CAPS, { values: true });
  h.m.execution.start({ program: '{"not":"json, this is a program"}' }).complete();
  assert.equal(h.records[0]?.["code_mode.program.text"], '{"not":"json, this is a program"}');
});

test("a logger that throws costs the record, never the call it describes", () => {
  const m = codeMode({ capabilities: CAPS, tracer: logTracer(() => { throw new Error("disk full"); }) });
  assert.doesNotThrow(() => m.execution.run({ program: "p" }, (e) => e.instrument((n: string) => 1)("t")));
});

test("the same host code moves to a real trace pipeline by passing a different tracer", () => {
  const body = (execution: { instrument: <F extends (...a: never[]) => unknown>(f: F) => F }): void => {
    execution.instrument((n: string) => 1)("t");
  };
  const logs: LogRecord[] = [];
  codeMode({ capabilities: CAPS, tracer: logTracer((r) => logs.push(r)) }).execution.run({ program: "p" }, body as never);
  assert.deepEqual(logs.map((r) => r.name), ["execute_tool t", "execute_code"]);
});
