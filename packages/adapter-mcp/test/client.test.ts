/**
 * `instrumentMcpClient`: against a recording stand-in for the client, for
 * what the wrapper reads and hands on, and against a real upstream
 * `McpServer` over the SDK's in-memory transport.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fold } from "@mocon/core/fold";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { instrumentMcpClient, type McpClientCalls } from "../src/index.js";
import { assertValidStream, harness, type Rec } from "./helpers.js";

function text(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content[0]?.text ?? "";
}

/** An upstream server with one tool that answers, one that reports an error, a resource and a prompt. */
async function upstream(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: "upstream", version: "0.0.0" });
  server.registerTool("add", { inputSchema: { a: z.number(), b: z.number() } }, ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }));
  server.registerTool("bad", {}, () => ({ content: [{ type: "text", text: "no such record" }], isError: true }));
  server.registerResource("greeting", "mem://greeting", {}, async (uri) => ({ contents: [{ uri: uri.href, text: "hello" }] }));
  server.registerPrompt("hello", { argsSchema: { name: z.string() } }, ({ name }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Hello ${name}` } }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "proxy", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("instrumentMcpClient records callTool, readResource and getPrompt as crossings", async () => {
  const h = harness();
  const up = await upstream();
  try {
    const execution = h.m.execution.start({ program: "proxy", language: "javascript" });
    const wrapped = instrumentMcpClient(up.client, { execution, target: (name) => "up/" + name });

    const sum = await wrapped.callTool({ name: "add", arguments: { a: 1, b: 2 } });
    assert.equal(text(sum), "3");
    const bad = await wrapped.callTool({ name: "bad" });
    assert.equal(bad.isError, true);
    const resource = await wrapped.readResource({ uri: "mem://greeting" });
    const first = resource.contents[0];
    assert.equal(first !== undefined && "text" in first ? first.text : "", "hello");
    const prompt = await wrapped.getPrompt({ name: "hello", arguments: { name: "Ada" } });
    assert.equal(prompt.messages[0]?.content.type, "text");
    await assert.rejects(wrapped.readResource({ uri: "mem://missing" }));
    execution.complete();

    assertValidStream(h.sink.lines);
    const crossings = h.ofKind("crossing");
    assert.equal(crossings.length, 5);
    const [add, isError, read, get, missing] = crossings as [Rec, Rec, Rec, Rec, Rec];
    for (const c of crossings) assert.equal(c["execution_id"], execution.id);
    assert.deepEqual(
      crossings.map((c) => c["seq"]),
      [1, 2, 3, 4, 5],
    );

    assert.equal(add["target"], "up/add");
    assert.deepEqual(add["input"]["value"], { a: 1, b: 2 });
    assert.equal(add["end"]["outcome"], "output");
    assert.deepEqual(add["end"]["output"]["value"], sum);

    assert.equal(isError["target"], "up/bad");
    assert.equal(isError["input"]["value"], null);
    assert.equal(isError["end"]["outcome"], "error");
    assert.equal(isError["end"]["error"]["class"], "capability_error");
    assert.equal(isError["end"]["error"]["message"], undefined);
    assert.deepEqual(isError["end"]["error"]["value"]["value"], bad);

    assert.equal(read["target"], "up/mem://greeting");
    assert.equal(read["input"]["value"], null);
    assert.equal(read["end"]["outcome"], "output");
    assert.deepEqual(read["end"]["output"]["value"], resource);

    assert.equal(get["target"], "up/hello");
    assert.deepEqual(get["input"]["value"], { name: "Ada" });
    assert.deepEqual(get["end"]["output"]["value"], prompt);

    assert.equal(missing["target"], "up/mem://missing");
    assert.equal(missing["end"]["outcome"], "error");
    assert.equal(missing["end"]["error"]["class"], "capability_error");
    assert.equal(missing["end"]["error"]["value"]["value"]["name"], "McpError");

    const view = fold(h.sink.lines);
    assert.deepEqual(Object.keys(view.executions), [`test/mcp\0${execution.id}`], "fold keys by (host, id)");
    assert.equal(Object.keys(view.crossings).length, 5);
    assert.deepEqual(view.unresolved, []);
  } finally {
    await up.close();
  }
});

test("the default target is the name itself, and _meta is not recorded", async () => {
  const h = harness();
  const up = await upstream();
  try {
    const execution = h.m.execution.start({ program: "proxy" });
    const wrapped = instrumentMcpClient(up.client, { execution });
    await wrapped.callTool({ name: "add", arguments: { a: 5, b: 5 }, _meta: { progressToken: "p" } });
    execution.complete();
    const [add] = h.ofKind("crossing");
    assert.equal(add!["target"], "add");
    assert.deepEqual(add!["input"]["value"], { a: 5, b: 5 });
  } finally {
    await up.close();
  }
});

test("a crossing still open when the execution ends is abandoned", async () => {
  const h = harness();
  const up = await upstream();
  try {
    const execution = h.m.execution.start({ program: "proxy" });
    const wrapped = instrumentMcpClient(up.client, { execution });
    const controller = new AbortController();
    const pending = wrapped.callTool({ name: "add", arguments: { a: 1, b: 1 } }, undefined, { signal: controller.signal });
    execution.end({ disposition: "terminated", error: { class: "timeout" } });
    controller.abort();
    await assert.rejects(pending);
    const [add] = h.ofKind("crossing");
    assert.deepEqual(add!["end"], { outcome: "abandoned" });
    assert.equal(h.ofKind("crossing").length, 1, "the late settlement does not write a second crossing record");
    const [late] = h.ofKind("event");
    assert.equal(late!["name"], "late_settlement");
    assert.equal(late!["crossing_id"], add!["id"]);
    assert.equal(late!["data"]["outcome"], "error");
    assertValidStream(h.sink.lines.filter((line) => JSON.parse(line).kind !== "event"));
  } finally {
    await up.close();
  }
});

/** A client whose three methods record the arguments they receive and answer with `answer`. */
function standIn(answer: (method: string) => unknown): { client: McpClientCalls; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const method =
    (name: string) =>
    (...args: unknown[]): never => {
      calls.push([name, args]);
      return answer(name) as never;
    };
  return { client: { callTool: method("callTool"), readResource: method("readResource"), getPrompt: method("getPrompt") } as McpClientCalls, calls };
}

test("the wrapper hands the caller's own params, schema and options to the client, and returns and rejects with the client's own values", async () => {
  const h = harness();
  const execution = h.m.execution.start({ program: "p", notice: false });
  const answer = { content: [] };
  const failure = new Error("upstream down");
  const { client, calls } = standIn((name) => (name === "getPrompt" ? Promise.reject(failure) : Promise.resolve(answer)));
  const wrapped = instrumentMcpClient(client, { execution });
  const params = { name: "add", arguments: { a: 1 } };
  const options = { timeout: 5 };
  assert.equal(await wrapped.callTool(params, undefined, options), answer);
  const resource = { uri: "mem://x" };
  assert.equal(await wrapped.readResource(resource, options), answer);
  const prompt = { name: "hello", arguments: { who: "Ada" } };
  await assert.rejects(wrapped.getPrompt(prompt, options), (e) => e === failure);
  assert.equal(calls[0]![1][0], params);
  assert.equal(calls[0]![1][2], options);
  assert.equal(calls[1]![1][0], resource);
  assert.equal(calls[1]![1][1], options);
  assert.equal(calls[2]![1][0], prompt);
  execution.complete();
  assertValidStream(h.sink.lines);
  assert.deepEqual(
    h.ofKind("crossing").map((c) => [c["target"], c["end"]["outcome"]]),
    [
      ["add", "output"],
      ["mem://x", "output"],
      ["hello", "error"],
    ],
  );
});

test("the wrapper reads name and arguments once each, and runs nothing else on params", async () => {
  const h = harness();
  const execution = h.m.execution.start({ program: "p", notice: false });
  const reads: string[] = [];
  const params = {
    get name(): string {
      reads.push("name");
      return "add";
    },
    get arguments(): Record<string, unknown> {
      reads.push("arguments");
      return { a: 1 };
    },
    get _meta(): undefined {
      reads.push("_meta");
      return undefined;
    },
  };
  const { client } = standIn(() => Promise.resolve({ content: [] }));
  await instrumentMcpClient(client, { execution }).callTool(params);
  assert.deepEqual(reads.sort(), ["arguments", "name"]);
});

test("a name that is not a string is recorded through String(), or as its type when that throws, and the call still reaches the client", async () => {
  const h = harness();
  const execution = h.m.execution.start({ program: "p", notice: false });
  const { client, calls } = standIn(() => Promise.resolve({ content: [] }));
  const wrapped = instrumentMcpClient(client, { execution });
  const unprintable = {
    toString(): string {
      throw new Error("no");
    },
  };
  await wrapped.callTool({ name: 42 as unknown as string });
  await wrapped.callTool({ name: unprintable as unknown as string });
  await wrapped.readResource({ uri: Object.create(null) as string });
  assert.equal(calls.length, 3);
  execution.complete();
  assertValidStream(h.sink.lines);
  assert.deepEqual(
    h.ofKind("crossing").map((c) => c["target"]),
    ["42", "[object]", "[object]"],
  );
});

test("a throw while reading params or from target rejects the call instead of throwing synchronously, and nothing reaches the client", async () => {
  const h = harness();
  const execution = h.m.execution.start({ program: "p", notice: false });
  const { client, calls } = standIn(() => Promise.resolve({ content: [] }));
  const wrapped = instrumentMcpClient(client, { execution });
  let pending: Promise<unknown> | undefined;
  assert.doesNotThrow(() => {
    pending = wrapped.callTool(undefined as never);
  });
  await assert.rejects(pending!, TypeError);
  const broken = instrumentMcpClient(client, {
    execution,
    target: () => {
      throw new Error("target broke");
    },
  });
  assert.doesNotThrow(() => {
    pending = broken.getPrompt({ name: "p" });
  });
  await assert.rejects(pending!, /target broke/);
  assert.equal(calls.length, 0);
});

test("a client method that throws synchronously settles the crossing as an error and rejects with the same error", async () => {
  const h = harness();
  const execution = h.m.execution.start({ program: "p", notice: false });
  const thrown = new Error("sync");
  const { client } = standIn(() => {
    throw thrown;
  });
  await assert.rejects(instrumentMcpClient(client, { execution }).callTool({ name: "t" }), (e) => e === thrown);
  execution.complete();
  const [c] = h.ofKind("crossing");
  assert.equal(c!["end"]["outcome"], "error");
  assert.equal(c!["end"]["error"]["message"], "sync");
});
