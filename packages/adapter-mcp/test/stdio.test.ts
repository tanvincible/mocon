/**
 * The handler in a real server process over stdio, the transport a local
 * code-mode server uses: the lines reach the file or stderr, stdout
 * carries JSON-RPC and nothing else, and a cancel sent across the pipe
 * ends the execution `terminated` after abandoning its open crossing.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fold } from "@mocon/core/fold";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { assertValidStream, completeExecution, waitFor, type Rec } from "./helpers.js";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const server = fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url));
const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

test("over stdio, stdout carries only JSON-RPC and every mocon line lands in the file", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-adapter-"));
  const file = join(dir, "mocon.jsonl");
  const child = spawn(process.execPath, ["--import", "tsx", server], { cwd: packageDir, env: { ...process.env, MOCON_FILE: file }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const stdout: string[] = [];
    const responses = new Map<number, Rec>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      stdout.push(line);
      const message = JSON.parse(line) as Rec;
      if (typeof message["id"] === "number") responses.set(message["id"], message);
    });
    const send = (message: object): void => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    };
    send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } });
    await waitFor(() => responses.has(1), 20_000);
    send({ method: "notifications/initialized" });
    const code = "const s = await callTool('add', { a: 2, b: 3 }); return await callTool('echo', { s });";
    send({ id: 2, method: "tools/call", params: { name: "execute", arguments: { code }, _meta: { traceparent: TP } } });
    send({ id: 3, method: "tools/call", params: { name: "execute", arguments: { code: "throw new Error('bad program')" } } });
    await waitFor(() => responses.has(2) && responses.has(3), 20_000);

    assert.equal(responses.get(2)!["result"]["content"][0]["text"], '{"s":5}');
    assert.equal(responses.get(3)!["result"]["isError"], true);
    for (const line of stdout) {
      const message = JSON.parse(line) as Rec;
      assert.equal(message["jsonrpc"], "2.0", `stdout carried a line that is not JSON-RPC: ${line}`);
      assert.equal(message["kind"], undefined);
    }

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    assertValidStream(lines);
    const view = fold(lines);
    const executions = Object.values(view.executions) as Rec[];
    assert.deepEqual(executions.map((e) => e["end"]["disposition"]).sort(), ["completed", "failed"]);
    const completed = executions.find((e) => e["end"]["disposition"] === "completed")!;
    assert.deepEqual(completed["context"], { traceparent: TP });
    const crossings = Object.values(view.crossings) as Rec[];
    assert.deepEqual(crossings.map((c) => [c["target"], c["seq"], c["context"]]).sort(), [
      ["add", 1, { traceparent: TP }],
      ["echo", 2, { traceparent: TP }],
    ]);
    assert.deepEqual(view.unresolved, []);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over stdio, a client that closes the pipe with a call in flight still leaves one complete record, because the server closes on stdin end", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mocon-adapter-"));
  const file = join(dir, "mocon.jsonl");
  const child = spawn(process.execPath, ["--import", "tsx", server], { cwd: packageDir, env: { ...process.env, MOCON_FILE: file }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const responses = new Set<number>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Rec;
      if (typeof message["id"] === "number") responses.add(message["id"]);
    });
    const send = (message: object): void => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    };
    send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } });
    await waitFor(() => responses.has(1), 20_000);
    send({ method: "notifications/initialized" });
    // `slow` never answers, so this call is still in flight when the client goes away.
    send({ id: 2, method: "tools/call", params: { name: "execute", arguments: { code: "await callTool('slow', {}); return 1" } } });
    const lines = (): string[] => {
      try {
        return readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "");
      } catch {
        return [];
      }
    };
    // The start notice is on the sink before `run`; the crossing line comes only when it settles, which
    // for this program is the disconnect itself.
    await waitFor(() => lines().some((l) => l.includes('"kind":"execution"')), 20_000);

    const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    child.stdin.end();
    await exit;

    const written = lines();
    assertValidStream(written);
    const view = fold(written);
    const executions = Object.values(view.executions) as Rec[];
    assert.equal(executions.length, 1, "the call in flight when the pipe closed leaves an execution record");
    assert.equal(executions[0]!["end"]?.["disposition"], "terminated", "the disconnect is the host acting on an external cancel");
    assert.equal(executions[0]!["end"]["error"]["class"], "cancelled");
    const crossings = Object.values(view.crossings) as Rec[];
    assert.deepEqual(
      crossings.map((c) => c["end"]),
      [{ outcome: "abandoned" }],
      "the open crossing is abandoned before the complete record",
    );
    assert.deepEqual(view.unresolved, [], "nothing is left open by a disconnect");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over stdio with the stderr sink, a cancel sent across the pipe terminates the execution after abandoning its open crossing", { timeout: 30_000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", server], cwd: packageDir, stderr: "pipe" });
  const stderr: string[] = [];
  // With `stderr: "pipe"` the transport hands back a PassThrough before the process starts.
  createInterface({ input: transport.stderr as Readable }).on("line", (line) => stderr.push(line));
  const client = new Client({ name: "agent", version: "0.0.0" });
  const transportErrors: unknown[] = [];
  client.onerror = (error) => transportErrors.push(error);
  await client.connect(transport);
  try {
    const records = (): Rec[] => stderr.filter((l) => l.startsWith('{"kind":')).map((l) => JSON.parse(l) as Rec);
    const executions = (): Rec[] => records().filter((r) => r["kind"] === "execution");

    const controller = new AbortController();
    const pending = client.callTool({ name: "execute", arguments: { code: "await callTool('slow', {}); return 1" } }, undefined, { signal: controller.signal });
    // The notice is written before run; the program calls `slow` in the same turn, before the server reads the cancel.
    await waitFor(() => executions().length === 1, 20_000);
    controller.abort("user cancelled");
    await assert.rejects(pending);
    await waitFor(() => executions().some((r) => r["end"] !== undefined), 20_000);

    const after = await client.callTool({ name: "execute", arguments: { code: "return 1 + 1" } });
    assert.equal((after as { content: { text: string }[] }).content[0]!.text, "2", "the server keeps serving after a cancel");
    await waitFor(() => executions().filter((r) => r["end"] !== undefined).length === 2, 20_000);

    const lines = stderr.filter((l) => l.startsWith('{"kind":'));
    assertValidStream(lines);
    const cancelled = completeExecution(executions().filter((r) => r["end"]?.["disposition"] !== "completed"));
    assert.equal(cancelled["end"]["disposition"], "terminated");
    assert.deepEqual(cancelled["end"]["error"], { class: "cancelled", message: "user cancelled" });
    const all = records();
    const slowAt = all.findIndex((r) => r["kind"] === "crossing" && r["target"] === "slow");
    assert.deepEqual(all[slowAt]!["end"], { outcome: "abandoned" });
    const cancelledAt = all.findIndex((r) => r["kind"] === "execution" && r["end"]?.["disposition"] === "terminated");
    assert.ok(slowAt < cancelledAt, "the abandoned crossing is written before the complete record");
    assert.deepEqual(fold(lines).unresolved, []);
    assert.deepEqual(transportErrors, [], "stdout carried nothing the client could not parse");
  } finally {
    await client.close();
  }
});
