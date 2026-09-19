/**
 * The emitter against a real OpenTelemetry SDK and a real in-memory exporter, so what is asserted is
 * what an exporter receives rather than what a mock was told. Each test is named for the rule in
 * spec/otel-code-mode.md that it protects.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { type Capabilities, type CapturePolicy, codeMode } from "../src/index.js";
type Rec2 = { attributes: Record<string, unknown> };

const ATTESTED = ["crossing.target", "crossing.input", "crossing.output"] as const;
const CAPS: Capabilities = { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ATTESTED };
const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");

function harness(capabilities: Capabilities = CAPS, capture?: CapturePolicy) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const m = codeMode({ capabilities, capture, tracer: provider.getTracer("test") });
  const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
  const one = (name: string): ReadableSpan => {
    const found = spans().filter((s) => s.name.startsWith(name));
    assert.equal(found.length, 1, `exactly one ${name} span`);
    return found[0] as ReadableSpan;
  };
  return { m, spans, one, executions: () => spans().filter((s) => "code_mode.execution.disposition" in s.attributes) };
}

test("the declaration is on every span, because a crossing can reach a consumer without its execution", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).output(1);
  ex.complete();
  assert.equal(h.spans().length, 2);
  for (const span of h.spans()) {
    assert.equal(span.attributes["code_mode.observes_crossings"], "all");
    assert.equal(span.attributes["code_mode.unmediated_egress"], false);
    assert.equal(span.attributes["code_mode.crossing_edge"], "invocation");
    assert.deepEqual(span.attributes["code_mode.attested"], [...ATTESTED]);
  }
});

test("a host that attests nothing still emits the list, so silence is told apart from a declaration", () => {
  const h = harness({ observes_crossings: "none", unmediated_egress: true });
  h.m.execution.start({ program: "p" }).complete();
  const span = h.one("execute_code");
  assert.deepEqual(span.attributes["code_mode.attested"], []);
  assert.equal("code_mode.crossing_edge" in span.attributes, false, "no edge to declare when nothing is mediated");
});

test("the execution span is named, kinded and operation-named as section 4 defines", () => {
  const h = harness();
  h.m.execution.start({ program: "p", tool: "execute", toolCallId: "toolu_1", sessionId: "s1", id: "ex_1", language: "javascript" }).complete();
  const span = h.one("execute_code");
  assert.equal(span.name, "execute_code execute");
  assert.equal(span.kind, SpanKind.SERVER);
  assert.equal(span.attributes["gen_ai.operation.name"], "execute_code");
  assert.equal(span.attributes["gen_ai.tool.name"], "execute");
  assert.equal(span.attributes["gen_ai.tool.call.id"], "toolu_1");
  assert.equal(span.attributes["mcp.session.id"], "s1");
  assert.equal(span.attributes["code_mode.execution.id"], "ex_1");
  assert.equal(span.attributes["code_mode.program.language"], "javascript");
});

test("a dispatch the runtime made in-process is INTERNAL, and an unnamed one drops the tool from the name", () => {
  const h = harness();
  h.m.execution.start({ program: "p", kind: "local" }).complete();
  const span = h.one("execute_code");
  assert.equal(span.name, "execute_code");
  assert.equal(span.kind, SpanKind.INTERNAL);
});

test("four dispositions collapse to two statuses, and the attribute keeps what status loses", () => {
  for (const [disposition, code] of [
    ["completed", SpanStatusCode.UNSET],
    ["abandoned", SpanStatusCode.UNSET],
    ["failed", SpanStatusCode.ERROR],
    ["terminated", SpanStatusCode.ERROR],
  ] as const) {
    const h = harness();
    h.m.execution.start({ program: "p" }).end({ disposition, errorType: "timeout" });
    const span = h.one("execute_code");
    assert.equal(span.attributes["code_mode.execution.disposition"], disposition, "the vocabulary is normative");
    assert.equal(span.status.code, code, "status is a display hint");
  }
});

test("instrumentation never sets Ok, so a completed execution is Unset and carries no error.type", () => {
  const h = harness();
  h.m.execution.start({ program: "p" }).complete();
  const span = h.one("execute_code");
  assert.equal(span.status.code, SpanStatusCode.UNSET);
  assert.equal("error.type" in span.attributes, false);
});

test("a failure with no reason the host can name carries the well-known fallback", () => {
  const h = harness();
  h.m.execution.start({ program: "p" }).end({ disposition: "failed" });
  assert.equal(h.one("execute_code").attributes["error.type"], "_OTHER");
});

test("the status description carries a closed vocabulary, never the program's own words", () => {
  const h = harness();
  h.m.execution.start({ program: "p" }).fail(new Error("boom"));
  const span = h.one("execute_code");
  assert.equal(span.attributes["error.type"], "runtime");
  assert.equal(span.attributes["code_mode.execution.disposition"], "failed");
  // The description is the one field nothing can label, so it never carries a program claim.
  assert.equal(span.status.message, "runtime");
  assert.equal("code_mode.error.message" in span.attributes, false, "the reason is Opt-In, and capture is off here");
});

test("with capture on the reason is written where it can be labelled as a program claim", () => {
  const h = harness(CAPS, { values: true });
  h.m.execution.start({ program: "p" }).fail(new Error("boom"));
  const span = h.one("execute_code");
  assert.equal(span.attributes["code_mode.error.message"], '"boom"');
  assert.equal(span.attributes["code_mode.provenance.code_mode.error.message"], "P");
  assert.equal(span.status.message, "runtime", "and the description still says nothing the program chose");
});

test("a crossing span is a child of its execution, named and kinded as section 5 defines", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "crm.deleteRecord", id: "c1", toolType: "function" }).output({ deleted: true });
  ex.complete();
  const crossing = h.one("execute_tool");
  const execution = h.one("execute_code");
  assert.equal(crossing.name, "execute_tool crm.deleteRecord");
  assert.equal(crossing.kind, SpanKind.CLIENT);
  assert.equal(crossing.parentSpanId, execution.spanContext().spanId);
  assert.equal(crossing.spanContext().traceId, execution.spanContext().traceId);
  assert.equal(crossing.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(crossing.attributes["gen_ai.tool.name"], "crm.deleteRecord");
  assert.equal(crossing.attributes["gen_ai.tool.call.id"], "c1");
  assert.equal(crossing.attributes["gen_ai.tool.type"], "function");
  assert.equal(crossing.attributes["code_mode.crossing.outcome"], "output");
  assert.equal(crossing.status.code, SpanStatusCode.UNSET);
});

test("three outcomes collapse to two statuses, and abandoned is Unset because it is not a failure", () => {
  for (const [outcome, code] of [
    ["output", SpanStatusCode.UNSET],
    ["abandoned", SpanStatusCode.UNSET],
    ["error", SpanStatusCode.ERROR],
  ] as const) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p" });
    ex.crossing.start({ target: "t" }).end({ outcome });
    ex.complete();
    const span = h.one("execute_tool");
    assert.equal(span.attributes["code_mode.crossing.outcome"], outcome);
    assert.equal(span.status.code, code);
  }
});

test("an abandoned crossing carries no error.type: nothing failed, the host stopped watching", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).end({ outcome: "abandoned" });
  ex.complete();
  assert.equal("error.type" in h.one("execute_tool").attributes, false);
});

test("a crossing open at the execution's end is closed first, at its own start, and says the time was made up", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "finance.wireTransfer" });
  ex.end({ disposition: "terminated", errorType: "timeout" });
  const [first, second] = h.spans() as [ReadableSpan, ReadableSpan];
  assert.equal(first.name, "execute_tool finance.wireTransfer", "the crossing ends before the execution that owns it");
  assert.equal(second.name, "execute_code");
  assert.equal(first.attributes["code_mode.crossing.outcome"], "abandoned");
  assert.equal(first.attributes["code_mode.crossing.timing"], "start_only");
  assert.deepEqual(first.duration, [0, 0], "closed where it began, which renders as a tick");
  assert.deepEqual(first.startTime, first.endTime);
});

test("a crossing that settled normally has real timing and no timing attribute", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).output(1);
  ex.complete();
  assert.equal("code_mode.crossing.timing" in h.one("execute_tool").attributes, false);
});

test("seq is assigned from 1 under `all`, the declaration that says the host has an initiation order", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "a" }).output(1);
  ex.crossing.start({ target: "b" }).output(2);
  ex.complete();
  assert.deepEqual(h.spans().filter((s) => s.name.startsWith("execute_tool")).map((s) => s.attributes["code_mode.crossing.seq"]), [1, 2]);
});

test("seq is not assigned under `some`, because such a host is not claiming it saw every initiation", () => {
  const h = harness({ observes_crossings: "some", unmediated_egress: true, crossing_edge: "invocation" });
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "a" }).output(1);
  ex.complete();
  assert.equal("code_mode.crossing.seq" in h.one("execute_tool").attributes, false);
});

test("values are Opt-In: the program hash is always written and the text never is by default", () => {
  const h = harness();
  h.m.execution.start({ program: "const x = 1;" }).complete({ result: { rows: 3 } });
  const span = h.one("execute_code");
  assert.equal(span.attributes["code_mode.program.hash"], sha("const x = 1;"));
  assert.equal("code_mode.program.text" in span.attributes, false);
  assert.equal("gen_ai.tool.call.result" in span.attributes, false);
  assert.equal("code_mode.capture" in span.attributes, false, "an absent Opt-In attribute claims nothing");
});

test("with values on, payloads are written as JSON and the note carries the size and hash of the whole", () => {
  const h = harness(CAPS, { values: true });
  const ex = h.m.execution.start({ program: "const x = 1;" });
  ex.crossing.start({ target: "t", input: { limit: 50 } }).output({ ok: true });
  ex.complete({ result: { rows: 3 }, outputs: { stdout: "hello" } });
  const execution = h.one("execute_code");
  const crossing = h.one("execute_tool");
  assert.equal(execution.attributes["code_mode.program.text"], "const x = 1;");
  assert.equal(execution.attributes["gen_ai.tool.call.result"], '{"rows":3}');
  assert.equal(execution.attributes["code_mode.output.stdout"], '"hello"');
  assert.equal(crossing.attributes["gen_ai.tool.call.arguments"], '{"limit":50}');
  assert.equal(crossing.attributes["gen_ai.tool.call.result"], '{"ok":true}');
  const note = JSON.parse(crossing.attributes["code_mode.capture"] as string) as Record<string, Record<string, unknown>>;
  assert.equal(note["gen_ai.tool.call.arguments"]?.["bytes"], 12);
  assert.equal(note["gen_ai.tool.call.arguments"]?.["hash"], sha('{"limit":50}'));
  assert.equal("truncated" in (note["gen_ai.tool.call.arguments"] as object), false);
});

test("a value past the cap is a prefix, and the note says so while keeping the whole value's size", () => {
  const h = harness(CAPS, { values: true, cap: 64 });
  const rows = Array.from({ length: 40 }, (_, i) => ({ name: "Person " + i }));
  const whole = JSON.stringify(rows);
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t", input: rows }).output(1);
  ex.complete();
  const crossing = h.one("execute_tool");
  const written = crossing.attributes["gen_ai.tool.call.arguments"] as string;
  assert.ok(whole.startsWith(JSON.parse(written) as string), "the written value is a prefix of the whole serialization");
  assert.ok(Buffer.byteLength(written) <= 64);
  const note = JSON.parse(crossing.attributes["code_mode.capture"] as string) as Record<string, Record<string, unknown>>;
  assert.equal(note["gen_ai.tool.call.arguments"]?.["truncated"], true);
  assert.equal(note["gen_ai.tool.call.arguments"]?.["bytes"], Buffer.byteLength(whole), "the size describes the whole, not the prefix");
});

test("instrument makes one crossing per call, rethrows the exact error and keeps the function's shape", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  const bridge = ex.instrument(function callTool(name: string, args: unknown) {
    if (name === "bad") throw new Error("refused");
    return { ok: name, args };
  });
  assert.equal(bridge.name, "callTool");
  assert.equal(bridge.length, 2);
  assert.deepEqual(bridge("good", { a: 1 }), { ok: "good", args: { a: 1 } });
  const thrown = new Error("refused");
  assert.throws(() => bridge("bad", {}), (e: Error) => e.message === thrown.message);
  ex.complete();
  const crossings = h.spans().filter((s) => s.name.startsWith("execute_tool"));
  assert.deepEqual(crossings.map((s) => s.attributes["gen_ai.tool.name"]), ["good", "bad"]);
  assert.deepEqual(crossings.map((s) => s.attributes["code_mode.crossing.outcome"]), ["output", "error"]);
  assert.equal(crossings[1]?.attributes["error.type"], "capability_error");
  assert.equal(crossings[1]?.status.message, "capability_error", "the description is the closed error type");
});

test("instrument follows a promise: the crossing settles when the bridge does, not when it was called", async () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  const bridge = ex.instrument(async (name: string) => ({ got: name }));
  const pending = bridge("search");
  assert.equal(h.spans().length, 0, "nothing has settled yet");
  assert.deepEqual(await pending, { got: "search" });
  assert.equal(h.one("execute_tool").attributes["code_mode.crossing.outcome"], "output");
  ex.complete();
});

test("a bridge answering with an error envelope reads it in the end hook", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  const bridge = ex.instrument((name: string) => ({ ok: false, error: "quota" }), {
    end: (answer) => (!answer.threw && (answer.value as { ok: boolean }).ok === false ? { outcome: "error", errorType: "refused" } : undefined),
  });
  bridge("t");
  ex.complete();
  const crossing = h.one("execute_tool");
  assert.equal(crossing.attributes["code_mode.crossing.outcome"], "error");
  assert.equal(crossing.attributes["error.type"], "refused");
});

test("a hook that throws or answers with a shape the span refuses costs the reading, never the call", () => {
  for (const end of [() => { throw new Error("hook"); }, () => "error" as never, () => ({ outcome: "exploded" }) as never]) {
    const h = harness();
    const ex = h.m.execution.start({ program: "p" });
    const bridge = ex.instrument((name: string) => ({ got: name }), { end });
    assert.deepEqual(bridge("t"), { got: "t" }, "the call still returns what the bridge returned");
    ex.complete();
    assert.equal(h.one("execute_tool").attributes["code_mode.crossing.outcome"], "output", "the default outcome still records it");
  }
});

test("run settles completed, reads a failure envelope through its hook, and records a throw as failed", () => {
  const h = harness();
  assert.deepEqual(h.m.execution.run({ program: "p" }, () => ({ ok: true })), { ok: true });
  assert.equal(h.one("execute_code").attributes["code_mode.execution.disposition"], "completed");

  const g = harness();
  g.m.execution.run({ program: "p", end: (v) => ((v as { ok: boolean }).ok === false ? { disposition: "failed", errorType: "runtime" } : undefined) }, () => ({ ok: false }));
  assert.equal(g.one("execute_code").attributes["code_mode.execution.disposition"], "failed");

  const f = harness();
  assert.throws(() => f.m.execution.run({ program: "p" }, () => { throw new Error("boom"); }));
  assert.equal(f.one("execute_code").attributes["code_mode.execution.disposition"], "failed");
});

test("an execution ends once: a second end is a no-op, not a second span", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.complete();
  ex.fail(new Error("late"));
  assert.equal(h.executions().length, 1);
  assert.equal(h.one("execute_code").attributes["code_mode.execution.disposition"], "completed");
});

test("a capability the conventions close is refused at construction, before any span exists", () => {
  assert.throws(() => codeMode({ capabilities: { observes_crossings: "most" } as never }), RangeError);
  assert.throws(() => codeMode({ capabilities: { observes_crossings: "all" } as never }), TypeError, "unmediated_egress is required");
  assert.throws(() => codeMode({ capabilities: { observes_crossings: "all", unmediated_egress: false } }), RangeError, "an edge is required when the host mediates");
  assert.throws(() => codeMode({ capabilities: { ...CAPS, attested: ["crossing.everything"] as never } }), RangeError);
  assert.throws(() => codeMode({ capabilities: { ...CAPS, attested: ["host_attributes"] } }), RangeError, "the attribute list is the other half of the gate");
  assert.throws(() => codeMode({ capabilities: { ...CAPS, attested_attributes: ["com.acme.credits"] } }), RangeError, "the list without the entry is an invisible upgrade");
});

test("the declaration is frozen, so a later mutation cannot make one dispatch's spans disagree", () => {
  const capabilities: Capabilities = { ...CAPS, attested: [...ATTESTED] };
  const h = harness(capabilities);
  (capabilities as { observes_crossings: string }).observes_crossings = "none";
  h.m.execution.start({ program: "p" }).complete();
  assert.equal(h.one("execute_code").attributes["code_mode.observes_crossings"], "all");
});

test("an MCP crossing is one span carrying both vocabularies, not two spans", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "search", mcp: { method: "tools/call", session: "s1" } }).output(1);
  ex.complete();
  const crossing = h.one("execute_tool");
  assert.equal(crossing.attributes["mcp.method.name"], "tools/call");
  assert.equal(crossing.attributes["mcp.session.id"], "s1");
  assert.equal(crossing.attributes["gen_ai.tool.name"], "search");
});

test("an unbounded target keeps the span name bounded and the full target in the attribute", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "https://api.example.com/v1/people/12345", name: "execute_tool fetch" }).output(1);
  ex.complete();
  const crossing = h.one("execute_tool");
  assert.equal(crossing.name, "execute_tool fetch");
  assert.equal(crossing.attributes["gen_ai.tool.name"], "https://api.example.com/v1/people/12345");
});

test("the worked example in section 15 comes out of the emitter as the document prints it", () => {
  const h = harness({ ...CAPS, attested: [...ATTESTED] }, { values: true });
  const program = "await connectors.crm.deleteRecord({id: 'rec_50'});\n";
  const ex = h.m.execution.start({ program, tool: "execute", language: "javascript", id: "3c95e2578dd5e0169e81c566e43fac92" });
  ex.crossing.start({ target: "connectors.crm.deleteRecord", input: { id: "rec_50" } }).output({ deleted: true });
  ex.crossing.start({ target: "connectors.finance.wireTransfer", input: { amountCents: 500000, to: "acct_9" } });
  ex.end({ disposition: "terminated", errorType: "timeout", message: "execution TTL (300s) elapsed while wireTransfer awaited approval" });

  const [settled, abandoned, execution] = h.spans() as [ReadableSpan, ReadableSpan, ReadableSpan];
  assert.equal(execution.name, "execute_code execute");
  assert.equal(execution.kind, SpanKind.SERVER);
  assert.equal(execution.status.code, SpanStatusCode.ERROR);
  assert.equal(execution.attributes["code_mode.execution.disposition"], "terminated");
  assert.equal(execution.attributes["error.type"], "timeout");
  assert.equal(execution.attributes["code_mode.execution.id"], "3c95e2578dd5e0169e81c566e43fac92");
  assert.equal(execution.attributes["code_mode.program.hash"], sha(program));

  assert.equal(settled.attributes["code_mode.crossing.outcome"], "output");
  assert.equal(settled.attributes["code_mode.crossing.seq"], 1);

  assert.equal(abandoned.name, "execute_tool connectors.finance.wireTransfer");
  assert.equal(abandoned.kind, SpanKind.CLIENT);
  assert.equal(abandoned.parentSpanId, execution.spanContext().spanId);
  assert.equal(abandoned.status.code, SpanStatusCode.UNSET, "abandoned is not a failure");
  assert.equal(abandoned.attributes["code_mode.crossing.outcome"], "abandoned");
  assert.equal(abandoned.attributes["code_mode.crossing.timing"], "start_only");
  assert.equal(abandoned.attributes["code_mode.crossing.seq"], 2);
  assert.deepEqual(abandoned.duration, [0, 0]);
  const note = JSON.parse(abandoned.attributes["code_mode.capture"] as string) as Record<string, Record<string, unknown>>;
  assert.equal(note["gen_ai.tool.call.arguments"]?.["bytes"], 36, "the input size the fixture records");
  assert.equal("gen_ai.tool.call.result" in abandoned.attributes, false, "no result: the host never determined one");
});

test("a host attribute cannot overwrite the declaration, the disposition or the target", () => {
  const h = harness();
  const ex = h.m.execution.start({
    program: "p",
    attributes: { "code_mode.observes_crossings": "none", "gen_ai.operation.name": "invoke_agent", "com.acme.sandbox": "sb_1" },
  });
  ex.crossing.start({ target: "real", attributes: { "gen_ai.tool.name": "forged" } }).output(1);
  ex.end({ disposition: "failed", attributes: { "code_mode.execution.disposition": "completed" } });
  const execution = h.one("execute_code");
  assert.equal(execution.attributes["code_mode.observes_crossings"], "all");
  assert.equal(execution.attributes["gen_ai.operation.name"], "execute_code");
  assert.equal(execution.attributes["code_mode.execution.disposition"], "failed");
  assert.equal(execution.attributes["com.acme.sandbox"], "sb_1", "the host's own namespace is untouched");
  assert.equal(h.one("execute_tool").attributes["gen_ai.tool.name"], "real");
});

test("a crossing span carries the execution id, so a span-scoped query finds it without its parent", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", id: "exec_42" });
  ex.crossing.start({ target: "company_search" }).output({ rows: 4 });
  ex.crossing.start({ target: "company_identify" }).error(new Error("429"), { errorType: "rate_limited" });
  ex.complete();

  // The query a backend actually runs: one span at a time, both terms on the same span. Parentage
  // cannot answer it, which is why the id is repeated rather than left to the parent.
  const failed = h.spans().filter((s) => s.attributes["code_mode.execution.id"] === "exec_42" && s.attributes["code_mode.crossing.outcome"] === "error");
  assert.equal(failed.length, 1, "the failing crossing is reachable by the execution's own id");
  assert.equal(failed[0]?.attributes["gen_ai.tool.name"], "company_identify");
  assert.equal(failed[0]?.attributes["error.type"], "rate_limited");
  assert.equal(h.spans().filter((s) => s.attributes["code_mode.execution.id"] === "exec_42").length, 3, "the whole run answers to one key");
});

test("crossings of an execution that never ended still carry the id, so a crash leaves no orphans", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", id: "exec_43" });
  ex.crossing.start({ target: "t" }).output(1);
  // The execution span is deliberately never ended: the process died. Its span was never exported,
  // so a consumer holding the crossing has no parent to resolve and only this key to work with.
  assert.equal(h.spans().length, 1);
  assert.equal(h.spans()[0]?.attributes["code_mode.execution.id"], "exec_43");
});

test("a host with no id of its own gets one minted, so the query cannot silently return nothing", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).output(1);
  ex.complete();
  const [crossing, execution] = h.spans().map((s) => s.attributes["code_mode.execution.id"]);
  assert.equal(typeof execution, "string");
  assert.equal(crossing, execution, "both spans of one dispatch answer to the same key");
  const other = harness();
  other.m.execution.start({ program: "p" }).complete();
  assert.notEqual(other.spans()[0]?.attributes["code_mode.execution.id"], execution, "and two dispatches do not collide");
});

test("an unattested host labels every program claim beside the value, for a reader who never saw the spec", () => {
  const h = harness({ observes_crossings: "none", unmediated_egress: true }, { values: true });
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "company_identify", input: { q: 1 } }).output({ ok: true });
  ex.complete();
  const crossing = h.one("execute_tool");
  // The target names the span and is what every span-metrics connector keys on. Unattested, it is
  // something the program said, and this is the only thing on the span that says so.
  assert.equal(crossing.attributes["gen_ai.tool.name"], "company_identify");
  assert.equal(crossing.attributes["code_mode.provenance.gen_ai.tool.name"], "P");
  assert.equal(crossing.attributes["code_mode.provenance.code_mode.crossing.outcome"], "P");
  assert.equal(crossing.attributes["code_mode.provenance.gen_ai.tool.call.arguments"], "P");
  assert.equal(crossing.attributes["code_mode.provenance.gen_ai.tool.call.result"], "P");
});

test("attestation removes the label, and an attested output reads as target-relayed, not host-observed", () => {
  const h = harness({ ...CAPS, attested: ["crossing.target", "crossing.input", "crossing.output"] }, { values: true });
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t", input: { q: 1 } }).output({ ok: true });
  ex.complete();
  const crossing = h.one("execute_tool");
  assert.equal("code_mode.provenance.gen_ai.tool.name" in crossing.attributes, false, "observed, so no label at all");
  assert.equal("code_mode.provenance.gen_ai.tool.call.arguments" in crossing.attributes, false);
  assert.equal(crossing.attributes["code_mode.provenance.gen_ai.tool.call.result"], "T", "the target said it, not the host");
});

test("a host's own attribute is a program claim until both gates are passed", () => {
  const claimed = harness(CAPS);
  claimed.m.execution.start({ program: "p", attributes: { "com.acme.credits": 5 } }).complete();
  assert.equal(claimed.one("execute_code").attributes["code_mode.provenance.com.acme.credits"], "P");

  const observed = harness({ ...CAPS, attested: [...ATTESTED, "host_attributes"], attested_attributes: ["com.acme.credits"] });
  observed.m.execution.start({ program: "p", attributes: { "com.acme.credits": 5, "com.acme.plan": "pro" } }).complete();
  const span = observed.one("execute_code");
  assert.equal("code_mode.provenance.com.acme.credits" in span.attributes, false, "named and attested, so observed");
  assert.equal(span.attributes["code_mode.provenance.com.acme.plan"], "P", "attested but unnamed is still a claim");
});

test("a number the target reported is target-relayed, which is neither the host's word nor the program's", () => {
  // The case that has no honest expression without this: a host bills from a credit count its API
  // returned. Attesting it claims the host measured it, which is false. Leaving it a program claim
  // is also false, and forbids the cost metric an operator actually needs.
  const h = harness({
    ...CAPS,
    attested: [...ATTESTED, "host_attributes"],
    attested_attributes: ["com.acme.engine"],
    relayed_attributes: ["com.acme.credits_used"],
  });
  const ex = h.m.execution.start({ program: "p", attributes: { "com.acme.engine": "quickjs" } });
  ex.crossing.start({ target: "search", attributes: { "com.acme.credits_used": 5, "com.acme.cache_hit": true } }).output(1);
  ex.complete();
  const crossing = h.one("execute_tool");
  assert.equal(crossing.attributes["code_mode.provenance.com.acme.credits_used"], "T", "the target's number, passed through");
  assert.equal(crossing.attributes["code_mode.provenance.com.acme.cache_hit"], "P", "named in neither list, so still a claim");
  assert.equal("code_mode.provenance.com.acme.engine" in h.one("execute_code").attributes, false, "the host measured this one");
});

test("an attribute cannot be both measured and relayed, and naming any needs the gate", () => {
  assert.throws(() => codeMode({ capabilities: { ...CAPS, attested: [...ATTESTED, "host_attributes"], attested_attributes: ["com.acme.x"], relayed_attributes: ["com.acme.x"] } }), RangeError);
  assert.throws(() => codeMode({ capabilities: { ...CAPS, relayed_attributes: ["com.acme.x"] } }), RangeError, "the gate a consumer reads is still required");
  assert.throws(() => codeMode({ capabilities: { ...CAPS, attested: [...ATTESTED, "host_attributes"] } }), RangeError, "the gate without any name claims nothing");
});

test("a crossing says whether it left the host, so an error points at the right system", () => {
  const h = harness({ ...CAPS, attested: [...ATTESTED, "crossing.error"] });
  const ex = h.m.execution.start({ program: "p" });
  // A refusal the host answered itself. Its error is not the program's, so it reads target-relayed,
  // which alone would send an operator to an API the call never reached.
  ex.crossing.start({ target: "t", dispatched: false }).error(new Error("over cap"), { errorType: "refused" });
  ex.crossing.start({ target: "t", dispatched: true }).error(new Error("upstream"), { errorType: "capability_error" });
  ex.complete();
  const [refused, upstream] = h.spans() as [Rec2, Rec2];
  assert.equal(refused.attributes["code_mode.crossing.dispatched"], false);
  assert.equal(upstream.attributes["code_mode.crossing.dispatched"], true);
  assert.equal(refused.attributes["code_mode.provenance.error.type"], "T", "both read T, which is why the bit is needed");
  assert.equal(upstream.attributes["code_mode.provenance.error.type"], "T");
  assert.equal("code_mode.provenance.code_mode.crossing.dispatched" in refused.attributes, false, "the host's own knowledge carries no label");
});

test("a host that cannot tell whether a call left writes nothing rather than guessing", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).output(1);
  ex.complete();
  assert.equal("code_mode.crossing.dispatched" in h.one("execute_tool").attributes, false);
});

test("a host says what its own attributes mean, so a stranger can add them up correctly", () => {
  const h = harness({
    ...CAPS,
    attested: [...ATTESTED, "host_attributes"],
    relayed_attributes: ["com.acme.credits_used"],
    declared: {
      "com.acme.credits_used": { agg: "sum", unit: "{credit}", card: "low", name: "Credits" },
      "com.acme.tenant_id": { agg: "none", card: "high" },
    },
  });
  const ex = h.m.execution.start({ program: "p", attributes: { "com.acme.tenant_id": "t_9" } });
  ex.crossing.start({ target: "search", attributes: { "com.acme.credits_used": 5 } }).output(1);
  ex.complete();
  const declared = JSON.parse(h.one("execute_code").attributes["code_mode.declared"] as string) as Record<string, Record<string, unknown>>;
  assert.deepEqual(declared["com.acme.credits_used"], { agg: "sum", unit: "{credit}", card: "low", name: "Credits" });
  assert.deepEqual(declared["com.acme.tenant_id"], { agg: "none", card: "high" });
  // Summable by declaration, believable by provenance. A consumer needs both and they are separate
  // claims: this one says the number adds up, the label says whose number it is.
  assert.equal(h.one("execute_tool").attributes["code_mode.provenance.com.acme.credits_used"], "T");
});

test("the meaning declaration rides the execution span only, since it is about combining across spans", () => {
  const h = harness({ ...CAPS, declared: { "com.acme.x": { agg: "sum" } } });
  const ex = h.m.execution.start({ program: "p" });
  ex.crossing.start({ target: "t" }).output(1);
  ex.complete();
  assert.equal("code_mode.declared" in h.one("execute_tool").attributes, false, "a crossing does not pay for it");
  assert.ok("code_mode.declared" in h.one("execute_code").attributes);
});

test("a meaning nobody could act on is refused at construction", () => {
  assert.throws(() => codeMode({ capabilities: { ...CAPS, declared: { "com.acme.x": { agg: "average" } } as never } }), RangeError);
  assert.throws(() => codeMode({ capabilities: { ...CAPS, declared: { "com.acme.x": { agg: "sum", card: "medium" } } as never } }), RangeError);
  assert.throws(() => codeMode({ capabilities: { ...CAPS, declared: { "com.acme.x": "sum" } as never } }), TypeError);
});
