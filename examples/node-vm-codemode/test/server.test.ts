/**
 * The built server as a child process over stdio, the way `drive.js` and
 * any MCP client start it: where the stream goes and who may read it, that
 * stdout carries JSON-RPC and nothing else, and that neither a program nor
 * a failing stream file takes the server down.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertHostRules, completeExecution, crossingsOf, DRIVER_PROGRAM, serverEntry, text, waitFor } from "./helpers.js";

interface Child {
  client: Client;
  execute(code: string): Promise<CallToolResult>;
  /** What the server wrote to stderr so far. */
  stderr(): string;
  close(): Promise<void>;
}

async function start(options: { cwd: string; env?: Record<string, string> }): Promise<Child> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: options.cwd, env: options.env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    execute: async (code) => (await client.callTool({ name: "execute", arguments: { code } })) as CallToolResult,
    stderr: () => stderr,
    close: () => client.close(),
  };
}

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "mocon-example-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
}

test("the server writes its stream to MOCON_FILE, readable by its owner only, before it answers", async (t) => {
  const dir = scratch(t);
  const file = join(dir, "stream.jsonl");
  const child = await start({ cwd: dir, env: { MOCON_FILE: file } });
  try {
    const result = await child.execute(DRIVER_PROGRAM);
    assert.equal(JSON.parse(text(result)).company, "Acme Example Co");
    const records = assertHostRules(lines(file));
    assert.equal(completeExecution(records)["end"]["disposition"], "completed");
    assert.equal(crossingsOf(records).length, 3);
  } finally {
    await child.close();
  }
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600, "the stream holds program text and payloads");
});

test("without MOCON_FILE the stream is mocon.jsonl in the working directory", async (t) => {
  const dir = scratch(t);
  const child = await start({ cwd: dir });
  try {
    await child.execute("return 1;");
  } finally {
    await child.close();
  }
  assert.equal(completeExecution(assertHostRules(lines(join(dir, "mocon.jsonl"))))["end"]["disposition"], "completed");
});

test("stdout carries JSON-RPC and nothing else, whatever a program logs", async (t) => {
  const dir = scratch(t);
  const child = spawn(process.execPath, [serverEntry], { cwd: dir, env: { MOCON_FILE: join(dir, "s.jsonl") }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "";
  const answered = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.endsWith("\n") && stdout.includes('"id":2')) resolve();
    });
  });
  const send = (message: object): void => void child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
  send({ method: "notifications/initialized" });
  const code = "console.log('to stdout?');\nconsole.info('{\"jsonrpc\":\"2.0\"}');\nconsole.error('to stderr?');\nreturn 'done';";
  send({ id: 2, method: "tools/call", params: { name: "execute", arguments: { code } } });
  await answered;
  child.stdin.end();
  const received = stdout.split("\n").filter((l) => l !== "");
  assert.equal(received.length, 2, stdout);
  for (const line of received) assert.equal((JSON.parse(line) as { jsonrpc?: string }).jsonrpc, "2.0");
  assert.match(received[1]!, /\\"done\\"/);
});

test("a promise a program leaves rejected is reported on stderr, without control characters, and the server keeps serving", async (t) => {
  const dir = scratch(t);
  const file = join(dir, "s.jsonl");
  const child = await start({ cwd: dir, env: { MOCON_FILE: file } });
  try {
    const first = await child.execute("Promise.reject(new Error('left behind \\u001b[2J\\u009b31m'));\nreturn 1;");
    assert.equal(text(first), "1");
    const second = await child.execute("return (await callTool('company_lookup', { domain: 'acme.example' })).name;");
    assert.equal(text(second), '"Acme Example Co"');
    await waitFor(() => child.stderr().includes("\n"));
    assert.match(child.stderr(), /node-vm-codemode: a promise rejection went unhandled: left behind \\u001b\[2J\\u009b31m\n/);
    assert.doesNotMatch(child.stderr(), /[\u001b\u009b]/);
  } finally {
    await child.close();
  }
  const records = assertHostRules(lines(file));
  assert.deepEqual(
    records.filter((r) => r["kind"] === "execution" && r["end"] !== undefined).map((r) => r["end"]["disposition"]),
    ["completed", "completed"],
  );
});

test("a stream file that stops taking lines is reported on stderr, and the call still answers", { skip: process.platform === "win32" && "needs a named pipe" }, async (t) => {
  const dir = scratch(t);
  const fifo = join(dir, "stream.fifo");
  execFileSync("mkfifo", [fifo]);
  // A reader lets the server open the pipe; closing it turns the server's next write into EPIPE.
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const child = await start({ cwd: dir, env: { MOCON_FILE: fifo } });
  try {
    closeSync(reader);
    assert.equal(text(await child.execute("return 2;")), "2");
    await waitFor(() => child.stderr().includes("\n"));
    assert.match(child.stderr(), /^node-vm-codemode: the stream file failed to write: EPIPE/);
  } finally {
    await child.close();
  }
});
