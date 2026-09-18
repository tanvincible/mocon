/**
 * The integration shapes the README describes, written against the real
 * API: a callTool bridge in front of an upstream MCP server, an RPC proxy
 * with no async context whose refs cross by structured clone, a
 * batch-at-end host, an observer of a multi-turn programmatic tool call,
 * and an unmediated host. Every stream is validated against the schema and
 * folded.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { mocon, memorySink, type Capabilities } from "@mocon/core";
import { fold } from "@mocon/core/fold";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { instrumentMcpClient, moconTool } from "../src/index.js";
import { assertValidStream, complete, extraOf, harness, type Rec } from "./helpers.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const execFileP = promisify(execFile);

function parsed(lines: readonly string[]): Rec[] {
  return lines.map((l) => JSON.parse(l) as Rec);
}

async function pair(server: McpServer, name: string, sessionId?: string): Promise<{ client: Client; close(): Promise<void> }> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  if (sessionId !== undefined) st.sessionId = sessionId;
  await server.connect(st);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function program(code: string, bindings: Record<string, unknown>): Promise<unknown> {
  return runInNewContext(`(async () => {${code}\n})()`, bindings) as Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* A. Node callTool bridge: a code-mode proxy over an upstream server  */
/* ------------------------------------------------------------------ */

test("shape A: Node callTool bridge, the program's calls reach an upstream MCP server through instrumentMcpClient", async () => {
  const h = harness("example/proxy");
  const upstream = new McpServer({ name: "crm", version: "0.0.0" });
  upstream.registerTool("add", { inputSchema: { a: z.number(), b: z.number() } }, ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  const up = await pair(upstream, "proxy");
  const codemode = new McpServer({ name: "codemode", version: "0.0.0" });
  codemode.registerTool(
    "execute",
    { inputSchema: { code: z.string() } },
    moconTool<{ code: string }>(h.m, {
      program: (a) => a.code,
      language: "javascript",
      run: async ({ code }, { execution }) => {
        const crm = instrumentMcpClient(up.client, { execution, target: (n) => "crm/" + n });
        const callTool = (name: string, args: Record<string, unknown>) => crm.callTool({ name, arguments: args });
        const value = await program(code, { callTool });
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      },
    }),
  );
  const cm = await pair(codemode, "agent", "session-A");
  try {
    const code = "const x = await callTool('add', {a: 1, b: 2}); const y = await callTool('add', {a: 3, b: 4}); return [x.content[0].text, y.content[0].text]";
    const result = await cm.client.callTool({ name: "execute", arguments: { code }, _meta: { traceparent: TP } });
    assert.equal((result as { content: { text: string }[] }).content[0]?.text, '["3","7"]');

    assertValidStream(h.sink.lines);
    const done = complete(h.ofKind("execution"));
    assert.deepEqual(done["context"], { session: "session-A", traceparent: TP });
    const crossings = h.ofKind("crossing");
    assert.deepEqual(
      crossings.map((c) => [c["target"], c["seq"], c["end"]["outcome"], c["context"]]),
      [
        ["crm/add", 1, "output", { traceparent: TP }],
        ["crm/add", 2, "output", { traceparent: TP }],
      ],
    );
    const view = fold(h.sink.lines);
    assert.equal(Object.keys(view.executions).length, 1);
    assert.equal(Object.keys(view.crossings).length, 2);
    assert.deepEqual(view.unresolved, []);
    assert.deepEqual(view.conflicts, []);
  } finally {
    await cm.close();
    await up.close();
  }
});

/* ------------------------------------------------------------------ */
/* B. RPC proxy: no async context, refs by clone                       */
/* ------------------------------------------------------------------ */

const CF: Capabilities = {
  observes_crossings: "all",
  unmediated_egress: false,
  crossing_edge: "invocation",
  attested: ["crossing.target", "crossing.input", "crossing.output", "crossing.error"],
};

/** What the near side sends with every RPC call: the fields it gave `execution.start`, as plain data. */
interface Dispatch {
  id: string;
  program: string;
  language: string;
  start: string;
}

test("shape B: an RPC proxy with no async context settles crossings on the far side from structured-cloned dispatch fields", async () => {
  const sink = memorySink();
  // Two isolates of one host: the one that handles tools/call, and the one an RPC call may land in.
  const near = mocon({ host: "example/cf", capabilities: CF, sinks: [sink] });
  const far = mocon({ host: "example/cf", capabilities: CF, sinks: [sink] });
  const tools = async (name: string, args: unknown): Promise<unknown> => {
    if (name === "add") {
      const { a, b } = args as { a: number; b: number };
      return a + b;
    }
    throw new Error("no tool " + name);
  };
  // The RPC target. Plain data in, plain data out, nothing held between calls, no AsyncLocalStorage.
  async function callToolRpc(message: { dispatch: Dispatch; seq: number; name: string; args: unknown }): Promise<unknown> {
    const { dispatch, seq, name, args } = structuredClone(message);
    const crossing = far.execution.start({ ...dispatch, notice: false }).crossing.start({ target: name, input: args, seq });
    try {
      const out = await tools(name, args);
      crossing.output(out);
      return out;
    } catch (e) {
      crossing.error(e);
      throw e;
    }
  }
  // The near side gives `start` itself, so the dispatch it sends names the same instant its own record does.
  const execute = ({ code }: { code: string }): Promise<{ content: Array<{ type: string; text: string }> }> => {
    const start = new Date().toISOString();
    return near.execution.run({ program: code, language: "javascript", start }, async (execution) => {
      const dispatch: Dispatch = { id: execution.id, program: code, language: "javascript", start };
      let seq = 0;
      const binding = (name: string, args: unknown) => callToolRpc({ dispatch, seq: ++seq, name, args });
      const value = await program(code, { callTool: binding });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    });
  };
  const result = await execute({ code: "let f; try { await callTool('nope', {}) } catch (e) { f = e.message } return [await callTool('add', {a: 2, b: 3}), f]" });
  assert.equal(result.content[0]?.type, "text");

  assertValidStream(sink.lines);
  const records = parsed(sink.lines);
  assert.equal(records.filter((r) => r["kind"] === "host").length, 2, "each isolate declared the host");
  const notices = sink.lines.filter((l) => l.startsWith('{"kind":"execution"') && !l.includes('"end":'));
  assert.equal(notices[0], notices[1], "the far side's notice is the near side's, byte for byte");
  const crossings = records.filter((r) => r["kind"] === "crossing");
  assert.deepEqual(
    crossings.map((c) => [c["target"], c["seq"], c["end"]["outcome"]]),
    [
      ["nope", 1, "error"],
      ["add", 2, "output"],
    ],
  );
  const view = fold(sink.lines);
  assert.equal(Object.keys(view.executions).length, 1);
  assert.equal(Object.keys(view.crossings).length, 2);
  assert.deepEqual(view.unresolved, []);
  assert.deepEqual(view.conflicts, [], "identical host re-declarations are no-ops");
  assert.equal(view.executions[Object.keys(view.executions)[0]!]?.end?.disposition, "completed");
});

test("shape B: exactly one handle settles a crossing, so a far side that hands a call back for the near side to close sends its outcome back too", () => {
  const dispatch: Dispatch = { id: "e-rpc", program: "p", language: "javascript", start: "2026-09-17T09:00:00.000Z" };
  const call = { id: "c-slow", target: "slow", input: null, seq: 1, start: "2026-09-17T09:00:01.000Z" };
  const conflicting = memorySink();
  {
    const near = mocon({ host: "example/cf", capabilities: CF, sinks: [conflicting] });
    const far = mocon({ host: "example/cf", capabilities: CF, sinks: [conflicting] });
    const execution = near.execution.start({ ...dispatch, notice: false });
    const farCrossing = far.execution.start({ ...dispatch, notice: false }).crossing.start(call);
    execution.crossing.start(call);
    execution.end({ disposition: "terminated", error: { class: "timeout" } });
    farCrossing.output("late");
    assert.deepEqual(fold(conflicting.lines).conflicts, [{ kind: "crossing", host: "example/cf", id: call.id }], "both handles settled: two complete records for one key");
  }
  const clean = memorySink();
  {
    const near = mocon({ host: "example/cf", capabilities: CF, sinks: [clean] });
    const far = mocon({ host: "example/cf", capabilities: CF, sinks: [clean] });
    const execution = near.execution.start({ ...dispatch, notice: false });
    // The far side opens the call and leaves it to the near side, which tracks it.
    far.execution.start({ ...dispatch, notice: false }).crossing.start({ ...call, notice: true });
    const tracked = execution.crossing.start(call);
    execution.end({ disposition: "terminated", error: { class: "timeout" } });
    // The far side's outcome travels back as data and settles the handle that tracks the crossing.
    tracked.output(structuredClone("late"));
    const view = fold(clean.lines);
    assert.deepEqual(view.conflicts, []);
    assert.deepEqual(view.crossings[`example/cf\0${call.id}`]?.end, { outcome: "abandoned" });
    assert.equal(parsed(clean.lines).filter((r) => r["kind"] === "event" && r["name"] === "late_settlement").length, 1);
  }
});

/* ------------------------------------------------------------------ */
/* C. Batch-at-end host: a subprocess, outputs known only at exit      */
/* ------------------------------------------------------------------ */

test("shape C: a batch-at-end host records outputs and the exit code by settling the handle itself", async () => {
  const sink = memorySink();
  const m = mocon({ host: "example/batch", capabilities: { observes_crossings: "none", unmediated_egress: true }, sinks: [sink] });
  const execute = moconTool<{ code: string }>(m, {
    program: (a) => a.code,
    language: "javascript",
    run: async ({ code }, { execution }) => {
      try {
        const { stdout, stderr } = await execFileP(process.execPath, ["-e", code], { timeout: 10_000 });
        execution.complete({ result: stdout.trim(), outputs: { stdout, stderr }, ext: { "example.exit_code": 0 } });
        return { content: [{ type: "text", text: stdout }] };
      } catch (e) {
        const { code: exit, stdout, stderr } = e as { code?: number; stdout?: string; stderr?: string };
        execution.fail({ exit_code: exit }, { outputs: { stdout, stderr }, ext: { "example.exit_code": exit ?? null } });
        return { content: [{ type: "text", text: stderr ?? "" }], isError: true };
      }
    },
  });
  const ok = await execute({ code: "process.stdout.write('42'); process.stderr.write('warn')" }, extraOf());
  assert.equal(ok.isError, undefined);
  const bad = await execute({ code: "process.stdout.write('partial'); process.stderr.write('boom'); process.exit(3)" }, extraOf());
  assert.equal(bad.isError, true);

  assertValidStream(sink.lines);
  const done = parsed(sink.lines).filter((r) => r["kind"] === "execution" && r["end"] !== undefined);
  assert.equal(done.length, 2);
  assert.equal(done[0]!["end"]["disposition"], "completed");
  assert.equal(done[0]!["end"]["result"]["value"], "42");
  assert.deepEqual(done[0]!["end"]["outputs"]["stdout"]["value"], "42");
  assert.deepEqual(done[0]!["end"]["outputs"]["stderr"]["value"], "warn");
  assert.deepEqual(done[0]!["ext"], { "example.exit_code": 0 });
  assert.equal(done[1]!["end"]["disposition"], "failed");
  assert.equal(done[1]!["end"]["error"]["class"], "runtime");
  assert.deepEqual(done[1]!["end"]["error"]["value"]["value"], { exit_code: 3 });
  assert.equal(done[1]!["end"]["outputs"]["stdout"]["value"], "partial");
  assert.equal(done[1]!["end"]["outputs"]["stderr"]["value"], "boom");
  assert.deepEqual(done[1]!["ext"], { "example.exit_code": 3 });
  assert.equal(parsed(sink.lines).filter((r) => r["kind"] === "crossing").length, 0);
  const view = fold(sink.lines);
  assert.deepEqual(view.unresolved, []);
  assert.deepEqual(view.conflicts, []);
});

/* ------------------------------------------------------------------ */
/* D. Client-side observer of a multi-turn programmatic tool call      */
/* ------------------------------------------------------------------ */

test("shape D: an observer opens its handle from persisted dispatch fields on every turn and records each pause as a crossing", () => {
  const sink = memorySink();
  const m = mocon({
    host: "example/observer",
    capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] },
    sinks: [sink],
  });
  // The application's own durable state between HTTP turns holds JSON only.
  const store = new Map<string, string>();
  const text = "account = await lookup_account(customer_id='C-4821')\nticket = await create_ticket(account_id=account['id'])\nprint(ticket['id'])";

  // Turn 1: the response carries a code-execution block.
  {
    const dispatch = { id: "container-1", program: text, language: "python", start: new Date().toISOString(), context: { traceparent: TP } };
    m.execution.start(dispatch);
    store.set("container-1", JSON.stringify(dispatch));
  }
  // Turn 2: the run paused on a tool call; the application runs the tool and opens the handle again.
  {
    const execution = m.execution.start({ ...(JSON.parse(store.get("container-1")!) as Dispatch), notice: false });
    const c = execution.crossing.start({ id: "toolu_01A", target: "lookup_account", input: { customer_id: "C-4821" }, seq: 1, ext: { "example.tool_use_id": "toolu_01A" } });
    c.output({ id: "acc_881" });
  }
  // Turn 3: a second pause, then the final response.
  {
    const execution = m.execution.start({ ...(JSON.parse(store.get("container-1")!) as Dispatch), notice: false });
    const c = execution.crossing.start({ id: "toolu_01B", target: "create_ticket", input: { account_id: "acc_881" }, seq: 2, ext: { "example.tool_use_id": "toolu_01B" } });
    c.output({ id: "tkt_2290" });
    execution.complete({ outputs: { stdout: "tkt_2290\n" } });
  }

  assertValidStream(sink.lines);
  const records = parsed(sink.lines);
  const notices = sink.lines.filter((l) => l.startsWith('{"kind":"execution"') && !l.includes('"end":'));
  assert.equal(notices.length, 3, "turn 1 announced the dispatch, and each later turn's first crossing line brought the notice with it");
  assert.equal(new Set(notices).size, 1, "every turn's notice is the same line, byte for byte");
  const complete = records.filter((r) => r["kind"] === "execution" && r["end"] !== undefined);
  assert.equal(complete.length, 1, "one complete record, on turn 3");
  assert.equal(complete[0]!["program"]["value"], text);
  assert.equal(complete[0]!["end"]["disposition"], "completed");
  assert.deepEqual(complete[0]!["context"], { traceparent: TP });
  const crossings = records.filter((r) => r["kind"] === "crossing");
  assert.deepEqual(
    crossings.map((c) => [c["id"], c["seq"], c["target"], c["context"]]),
    [
      ["toolu_01A", 1, "lookup_account", { traceparent: TP }],
      ["toolu_01B", 2, "create_ticket", { traceparent: TP }],
    ],
  );
  const view = fold(sink.lines);
  assert.equal(Object.keys(view.executions).length, 1);
  assert.equal(Object.keys(view.crossings).length, 2);
  assert.deepEqual(view.unresolved, []);
  assert.deepEqual(view.conflicts, []);
});

/* ------------------------------------------------------------------ */
/* E. Unmediated host: only the return value is observed               */
/* ------------------------------------------------------------------ */

test("shape E: an unmediated host records the execution and no crossings", async () => {
  const sink = memorySink();
  const m = mocon({ host: "example/unmediated", capabilities: { observes_crossings: "none", unmediated_egress: true }, sinks: [sink] });
  const execute = moconTool<{ code: string }>(m, {
    program: (a) => a.code,
    run: async ({ code }) => ({ content: [{ type: "text", text: String(await program(code, {})) }] }),
  });
  const result = await execute({ code: "return 6 * 7" }, extraOf());
  assert.equal(result.content[0]?.type, "text");
  assertValidStream(sink.lines);
  const records = parsed(sink.lines);
  assert.deepEqual(
    records.map((r) => r["kind"]),
    ["host", "execution", "execution"],
  );
  const done = complete(records.filter((r) => r["kind"] === "execution"));
  assert.equal(done["end"]["disposition"], "completed");
  assert.equal(done["end"]["result"]["value"]["content"][0]["text"], "42");
  const view = fold(sink.lines);
  assert.deepEqual(view.unresolved, []);
  assert.equal(Object.keys(view.crossings).length, 0);
});
