/**
 * A tiny code-mode host for the tests: an `execute` tool that runs the
 * submitted JavaScript in `node:vm` with a `callTool` bridge, instrumented
 * through the execution handle. Wired to an `McpServer` or to the
 * low-level `Server`, each over an in-memory transport, with an SDK
 * `Client` on the other end.
 */

import { runInNewContext } from "node:vm";
import type { Mocon } from "@mocon/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { moconTool, type MoconToolHandler } from "../src/index.js";
import { deferred } from "./helpers.js";

export interface CodeMode {
  execute: MoconToolHandler<{ code: string }>;
  /** Resolves when a program calls the `slow` tool, which never answers. */
  slowStarted: Promise<void>;
}

export function codeMode(m: Mocon): CodeMode {
  const slow = deferred<void>();
  const bridge = async (name: string, args: unknown): Promise<unknown> => {
    switch (name) {
      case "add": {
        const { a, b } = args as { a: number; b: number };
        return a + b;
      }
      case "echo":
        return args;
      case "fail":
        throw new Error("upstream failed");
      case "slow":
        slow.resolve();
        return new Promise(() => {});
      default:
        throw new Error(`no tool ${name}`);
    }
  };
  const execute = moconTool<{ code: string }>(m, {
    program: (args) => args.code,
    language: "javascript",
    run: async ({ code }, { execution, extra }) => {
      const callTool = execution.instrument(bridge);
      const value = await Promise.race([runProgram(code, callTool), aborted(extra.signal)]);
      return { content: [{ type: "text", text: JSON.stringify(value) ?? "undefined" }] };
    },
  });
  return { execute, slowStarted: slow.promise };
}

function runProgram(code: string, callTool: (name: string, args: unknown) => Promise<unknown>): Promise<unknown> {
  return runInNewContext(`(async () => {${code}\n})()`, { callTool }) as Promise<unknown>;
}

/** Rejects with the signal's reason when it aborts. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export interface Connected {
  client: Client;
  close(): Promise<void>;
}

/** Connects `server` and a fresh client over a linked in-memory pair. */
async function connect(server: McpServer | Server, sessionId?: string): Promise<Connected> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (sessionId !== undefined) serverTransport.sessionId = sessionId;
  await server.connect(serverTransport);
  const client = new Client({ name: "agent", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The high-level path: `McpServer.registerTool` with the handler as the callback. */
export async function withMcpServer(m: Mocon, sessionId?: string): Promise<Connected & CodeMode> {
  const cm = codeMode(m);
  const server = new McpServer({ name: "codemode", version: "0.0.0" });
  server.registerTool("execute", { description: "Run a program", inputSchema: { code: z.string() } }, cm.execute);
  server.registerTool(
    "broken",
    { inputSchema: { code: z.string() } },
    moconTool(m, {
      program: (args) => args.code,
      run: () => {
        throw new Error("handler exploded");
      },
    }),
  );
  server.registerTool(
    "deny",
    { inputSchema: { code: z.string() } },
    moconTool(m, {
      program: (args) => args.code,
      run: async () => ({ content: [{ type: "text", text: "denied" }], isError: true }),
    }),
  );
  return { ...cm, ...(await connect(server, sessionId)) };
}

/** The low-level path: the handler behind `Server.setRequestHandler(CallToolRequestSchema, ...)`. */
export async function withLowLevelServer(m: Mocon, sessionId?: string): Promise<Connected & CodeMode> {
  const cm = codeMode(m);
  const server = new Server({ name: "codemode", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    if (request.params.name === "broken") throw new Error("handler exploded");
    return cm.execute(request.params.arguments as { code: string }, extra);
  });
  return { ...cm, ...(await connect(server, sessionId)) };
}
