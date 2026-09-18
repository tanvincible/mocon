/**
 * Starts `server.js` as a child over stdio, connects an SDK Client, calls
 * `execute` with a program that makes two overlapping tool calls and one
 * that fails, then prints the result and the stream the server wrote. The
 * stream goes to `MOCON_FILE`, default `mocon.jsonl` in this package, and
 * each run starts it afresh.
 */

import { readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InvariantError } from "@mocon/core";
import { fold } from "@mocon/core/fold";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const streamPath = resolve(process.env["MOCON_FILE"] ?? root + "mocon.jsonl");
const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));

const PROGRAM = `
const [company, people] = await Promise.all([
  callTool("company_lookup", { domain: "acme.example" }),
  callTool("person_search", { domain: "acme.example", limit: 3 }),
]);
let failure;
try {
  await callTool("company_lookup", { domain: "nowhere.invalid" });
} catch (e) {
  failure = e.message;
}
return { company: company.name, people: people.map((p) => p.name), failure };
`.trim();

rmSync(streamPath, { force: true });

const client = new Client({ name: "drive", version: "0.1.0" });
// The SDK passes a child only a short list of variables, so the stream path is handed over explicitly.
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: root, env: { MOCON_FILE: streamPath }, stderr: "inherit" }));
let result: Awaited<ReturnType<Client["callTool"]>>;
try {
  result = await client.callTool({ name: "execute", arguments: { code: PROGRAM } });
} finally {
  await client.close();
}

const stream = readFileSync(streamPath, "utf8");
// The server writes the complete execution record through a synchronous sink before it answers, so the stream is whole by now.
const view = fold(stream);
const executions = Object.values(view.executions);
if (executions.length !== 1 || executions[0]?.end === undefined || view.unresolved.length > 0 || view.conflicts.length > 0) {
  throw new InvariantError(`the server answered before its stream was whole: ${executions.length} executions, ${view.unresolved.length} unresolved, ${view.conflicts.length} conflicts`);
}

console.log("result:", JSON.stringify(result.content));
console.log("");
console.log(`stream (${streamPath}):`);
console.log(stream.trimEnd());
console.log("");
const shown = relative(process.cwd(), streamPath);
console.log(`next: npx mocon view ${shown}, or npx mocon ui ${shown}`);
