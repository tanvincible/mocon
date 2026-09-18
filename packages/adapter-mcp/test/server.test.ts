/**
 * The handler behind a real SDK server: `McpServer.registerTool` and the
 * low-level `Server`, each over the SDK's in-memory transport, driven by an
 * SDK `Client`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fold } from "@mocon/core/fold";
import { withLowLevelServer, withMcpServer } from "./codemode.js";
import { assertValidStream, complete, harness, waitFor, type Rec } from "./helpers.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function text(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content[0]?.text ?? "";
}

test("a program's crossings and result are recorded, and the stream validates and folds to one execution", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m, "session-1");
  try {
    const code = "const s = await callTool('add', { a: 2, b: 3 }); return await callTool('echo', { s });";
    const result = await cm.client.callTool({ name: "execute", arguments: { code }, _meta: { traceparent: TP } });
    assert.equal(text(result), '{"s":5}');

    assertValidStream(h.sink.lines);
    const hostLine = h.records()[0]!;
    assert.equal(hostLine["kind"], "host");
    assert.equal(hostLine["host"], "test/mcp");

    const executions = h.ofKind("execution");
    assert.equal(executions.length, 2, "a start notice and a complete record");
    const notice = executions[0]!;
    assert.equal(notice["end"], undefined);
    const done = complete(executions);
    assert.equal(done["id"], notice["id"]);
    assert.equal(done["program"]["value"], code);
    assert.equal(done["language"], "javascript");
    assert.deepEqual(done["context"], { session: "session-1", traceparent: TP });
    assert.equal(done["end"]["disposition"], "completed");
    assert.deepEqual(done["end"]["result"]["value"], result);
    assert.equal(done["end"]["error"], undefined);

    const crossings = h.ofKind("crossing");
    assert.equal(crossings.length, 2);
    const [add, echo] = crossings as [Rec, Rec];
    assert.equal(add["execution_id"], done["id"]);
    assert.equal(add["target"], "add");
    assert.deepEqual(add["input"]["value"], { a: 2, b: 3 });
    assert.equal(add["seq"], 1);
    assert.equal(add["end"]["outcome"], "output");
    assert.equal(add["end"]["output"]["value"], 5);
    assert.deepEqual(add["context"], { traceparent: TP });
    assert.equal(echo["target"], "echo");
    assert.equal(echo["seq"], 2);
    assert.deepEqual(echo["end"]["output"]["value"], { s: 5 });

    const view = fold(h.sink.lines);
    assert.deepEqual(Object.keys(view.executions), [`test/mcp\0${done["id"]}`], "fold keys by (host, id)");
    assert.equal(Object.keys(view.crossings).length, 2);
    assert.deepEqual(view.unresolved, []);
    assert.deepEqual(view.conflicts, []);
    assert.equal(view.skipped, 0);
    assert.ok(view.hosts["test/mcp"]);
  } finally {
    await cm.close();
  }
});

test("a bridge that throws settles its crossing as error; the execution still completes when the program catches it", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m);
  try {
    const code = "try { await callTool('fail', {}) } catch (e) { return 'caught ' + e.message }";
    const result = await cm.client.callTool({ name: "execute", arguments: { code } });
    assert.equal(text(result), '"caught upstream failed"');

    assertValidStream(h.sink.lines);
    const done = complete(h.ofKind("execution"));
    assert.equal(done["end"]["disposition"], "completed");
    assert.equal(done["context"], undefined);
    const [fail] = h.ofKind("crossing");
    assert.equal(fail!["target"], "fail");
    assert.equal(fail!["end"]["outcome"], "error");
    assert.equal(fail!["end"]["error"]["class"], "capability_error");
    assert.equal(fail!["end"]["error"]["message"], "upstream failed");
    assert.equal(fail!["end"]["error"]["value"]["value"]["name"], "Error");
  } finally {
    await cm.close();
  }
});

test("a program that throws yields failed with class runtime", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m);
  try {
    const result = await cm.client.callTool({ name: "execute", arguments: { code: "throw new Error('bad program')" } });
    // McpServer turns a thrown handler into an isError result on the wire; the record saw the throw.
    assert.equal((result as { isError?: boolean }).isError, true);

    assertValidStream(h.sink.lines);
    const done = complete(h.ofKind("execution"));
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
    assert.equal(done["end"]["error"]["message"], "bad program");
    assert.equal(done["end"]["result"], undefined);
    assert.deepEqual(fold(h.sink.lines).unresolved, []);
  } finally {
    await cm.close();
  }
});

test("a thrown handler yields failed with the error as message and value", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m);
  try {
    const result = await cm.client.callTool({ name: "broken", arguments: { code: "x" } });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(text(result), "handler exploded");

    assertValidStream(h.sink.lines);
    const done = complete(h.ofKind("execution"));
    assert.equal(done["program"]["value"], "x");
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
    assert.equal(done["end"]["error"]["message"], "handler exploded");
    assert.equal(done["end"]["error"]["value"]["value"]["name"], "Error");
    assert.equal(typeof done["end"]["error"]["value"]["value"]["stack"], "string");
    assert.equal(h.ofKind("crossing").length, 0);
  } finally {
    await cm.close();
  }
});

test("a result with isError is failed, with the whole result as the error value and no end.result", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m);
  try {
    const result = await cm.client.callTool({ name: "deny", arguments: { code: "x" } });
    assert.equal(text(result), "denied");

    assertValidStream(h.sink.lines);
    const done = complete(h.ofKind("execution"));
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
    assert.equal(done["end"]["error"]["message"], undefined);
    assert.deepEqual(done["end"]["error"]["value"]["value"], result);
    assert.equal(done["end"]["result"], undefined);
  } finally {
    await cm.close();
  }
});

test("an aborted request yields terminated with class cancelled, after abandoning the open crossing", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m);
  try {
    const controller = new AbortController();
    const pending = cm.client.callTool(
      { name: "execute", arguments: { code: "await callTool('slow', {}); return 1" } },
      undefined,
      { signal: controller.signal },
    );
    await cm.slowStarted;
    controller.abort("user cancelled");
    await assert.rejects(pending);
    await waitFor(() => h.ofKind("execution").some((r) => r["end"] !== undefined));

    assertValidStream(h.sink.lines);
    const done = complete(h.ofKind("execution"));
    assert.equal(done["end"]["disposition"], "terminated");
    assert.deepEqual(done["end"]["error"], { class: "cancelled", message: "user cancelled" });
    assert.equal(done["end"]["result"], undefined);

    const [slow] = h.ofKind("crossing");
    assert.equal(slow!["target"], "slow");
    assert.deepEqual(slow!["end"], { outcome: "abandoned" });
    const lines = h.records();
    const abandonedAt = lines.findIndex((r) => r["kind"] === "crossing");
    const completeAt = lines.findIndex((r) => r["kind"] === "execution" && r["end"] !== undefined);
    assert.ok(abandonedAt < completeAt, "the abandoned crossing is written before the complete record");
    const view = fold(h.sink.lines);
    assert.deepEqual(view.unresolved, []);
    assert.equal(Object.keys(view.crossings).length, 1);
  } finally {
    await cm.close();
  }
});

test("the same handler serves the low-level Server, where a throw reaches the client as a JSON-RPC error", async () => {
  const h = harness();
  const cm = await withLowLevelServer(h.m, "session-2");
  try {
    const result = await cm.client.callTool({ name: "execute", arguments: { code: "return await callTool('add', { a: 1, b: 1 })" } });
    assert.equal(text(result), "2");
    let done = complete(h.ofKind("execution"));
    assert.equal(done["end"]["disposition"], "completed");
    assert.deepEqual(done["context"], { session: "session-2" });

    await assert.rejects(cm.client.callTool({ name: "execute", arguments: { code: "throw new Error('bad program')" } }), /bad program/);
    const executions = h.ofKind("execution").filter((r) => r["end"] !== undefined);
    assert.equal(executions.length, 2);
    done = executions[1]!;
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
    assert.equal(done["end"]["error"]["message"], "bad program");

    assertValidStream(h.sink.lines);
    const view = fold(h.sink.lines);
    assert.equal(Object.keys(view.executions).length, 2);
    assert.deepEqual(view.unresolved, []);
    assert.deepEqual(view.conflicts, []);
  } finally {
    await cm.close();
  }
});
