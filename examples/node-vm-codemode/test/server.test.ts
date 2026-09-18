/**
 * The built server as a child process over stdio, the way `drive.js` and
 * any MCP client start it: where the stream goes and who may read it, that
 * stdout carries JSON-RPC and nothing else, and that neither a program nor
 * a failing stream file takes the server down.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

test("an agent that closes the pipe with a call in flight leaves a complete record saying the agent went away, not that the clock ran out", async (t) => {
  // `StdioServerTransport` subscribes to stdin's "data" and "error" and not to its end, so without the
  // server's own close on end nothing aborts the request: the record for a call in flight would be whatever
  // the time limit eventually wrote, or nothing at all on a host whose calls can outlive the pipe. The time
  // limit is raised here so that the clock cannot be what ends this call, which is the whole distinction.
  const dir = scratch(t);
  const file = join(dir, "stream.jsonl");
  const child = spawn(process.execPath, [serverEntry], { cwd: dir, env: { ...process.env, MOCON_FILE: file, MOCON_TIME_LIMIT_MS: "30000" }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const answered = new Set<number>();
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        const id = (JSON.parse(line) as { id?: number }).id;
        if (typeof id === "number") answered.add(id);
      }
    });
    const send = (message: object): void => void child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } } });
    await waitFor(() => answered.has(1));
    send({ method: "notifications/initialized" });
    // A program that never settles and starts no timer: only the host can end this call.
    send({ id: 2, method: "tools/call", params: { name: "execute", arguments: { code: "await new Promise(() => {}); return 1" } } });
    await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes('"kind":"execution"'));

    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.end();
    await exited;

    const records = assertHostRules(lines(file));
    const done = completeExecution(records);
    assert.equal(done["end"]["disposition"], "terminated");
    assert.equal(done["end"]["error"]["class"], "cancelled", "the record says the host's own clock ended a call the agent abandoned");
  } finally {
    child.kill();
  }
});
