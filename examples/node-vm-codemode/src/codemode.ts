/**
 * The code-mode server. Its one tool, `execute({ code })`, runs the
 * submitted JavaScript in `node:vm` as the body of an async function whose
 * only global is `callTool(name, args)`, a bridge over the fake tools in
 * `tools.ts`. `moconTool` brackets each call with one execution and
 * `execution.instrument` makes each tool call one crossing.
 *
 * The host settles two outcomes itself, and the wrapper's settlement after
 * them is ignored: a program that does not compile is `failed` with class
 * `validation`, and a program still running at the time limit is
 * `terminated` with class `timeout`, whether the limit stopped a busy loop
 * or the host stopped waiting on an await. A request the client cancels is
 * `terminated` with class `cancelled`, which the wrapper records. Once the
 * host stops waiting, `callTool` refuses every call: node:vm cannot stop
 * the program, but the host can stop serving it.
 *
 * node:vm is not a security boundary. This server demonstrates the record
 * format; it is not a sandbox.
 */

import { Script } from "node:vm";
import { moconTool } from "@mocon/adapter-mcp";
import type { Capabilities, ExecutionHandle, Mocon } from "@mocon/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTool } from "./tools.js";

export const HOST = "mocon/example-node-vm";

/**
 * Attesting a field says it is host-observed: determined at a point the
 * program cannot write through, for every record under this host string,
 * and provenance.md 2 makes that conditional on the host's isolation
 * holding. This host has no isolation. node:vm is not a boundary: the
 * program has paths out that this host does not see, and it can reach the
 * host realm and change what the host records, a crossing's target, input
 * and output included — `test/codemode.test.ts` forges a recorded tool
 * answer to keep that honest. So no field holds as host-observed here, and
 * the declaration attests nothing and names no `crossing_edge`: every
 * crossing field stays program-determined, which is what a reader of this
 * stream must assume. A host with real isolation, a worker or a separate
 * process with the bridge as its only channel, is the one that can attest
 * `crossing.target` and `crossing.input` and declare the edge it mediates.
 */
export const CAPABILITIES: Capabilities = {
  observes_crossings: "all",
  unmediated_egress: true,
};

/** How long a program may run, its synchronous part and its awaits together. */
const TIME_LIMIT_MS = 1000;

/** `timeLimitMs` is an integer from 1 to 2^31 - 1, the range both node:vm and timers accept. Default: one second. */
export function createServer(m: Mocon, timeLimitMs: number = TIME_LIMIT_MS): McpServer {
  if (!Number.isInteger(timeLimitMs) || timeLimitMs < 1 || timeLimitMs > 2 ** 31 - 1) throw new RangeError("createServer: timeLimitMs must be an integer from 1 to 2147483647");
  const server = new McpServer({ name: "node-vm-codemode", version: "0.1.0" });
  server.registerTool(
    "execute",
    {
      description: "Run JavaScript with a callTool(name, args) bridge over company_lookup and person_search.",
      inputSchema: { code: z.string() },
    },
    moconTool<{ code: string }>(m, {
      program: (args) => args.code,
      language: "javascript",
      run: ({ code }, { execution, extra }) => execute(code, execution, extra.signal, timeLimitMs),
    }),
  );
  return server;
}

const TIMED_OUT = Symbol("timed out");

async function execute(code: string, execution: ExecutionHandle, signal: AbortSignal, timeLimitMs: number): Promise<CallToolResult> {
  signal.throwIfAborted();
  let script: Script;
  try {
    // The offset keeps the program's own line numbers in its stack traces.
    script = new Script(`(async () => {\n${code}\n})()`, { filename: "program.js", lineOffset: -1 });
  } catch (e) {
    execution.fail(e, { class: "validation" });
    return failure(`the program does not compile: ${(e as Error).message}`);
  }
  const bridge = programBridge(execution);
  const timeout = (): CallToolResult => {
    const message = `the program did not finish within ${timeLimitMs} ms`;
    bridge.close();
    execution.end({ disposition: "terminated", error: { class: "timeout", message } });
    return failure(message);
  };
  const stop = stopWaiting(signal, timeLimitMs);
  try {
    let running: Promise<unknown>;
    const began = performance.now();
    try {
      running = script.runInNewContext({ callTool: bridge.callTool }, { timeout: timeLimitMs }) as Promise<unknown>;
    } catch (e) {
      // The limit stopped the synchronous part. The host's clock decides, not the error, which a program can imitate; the limit's
      // own clock counts whole milliseconds and can fire up to one early.
      if (performance.now() - began > timeLimitMs - 1) return timeout();
      throw e;
    }
    const value = await Promise.race([running, stop.reached]);
    if (value === TIMED_OUT) return timeout();
    return { content: [{ type: "text", text: JSON.stringify(value) ?? "undefined" }] };
  } finally {
    bridge.close();
    stop.release();
  }
}

/**
 * The `callTool` a program sees. The arguments cross as JSON, read once, as
 * they would into a host outside the sandbox, so the input a crossing
 * records is the input the tool receives and no program object reaches the
 * tools. A name that is not a string, or arguments that do not serialize,
 * fail on the program's side of that boundary and are not a crossing.
 * After `close` a call is refused: recorded as a crossing that ends in an
 * error with class `refused`, and never dispatched.
 */
function programBridge(execution: ExecutionHandle): { callTool: (name: unknown, args?: unknown) => Promise<unknown>; close: () => void } {
  const dispatch = execution.instrument(callTool);
  let open = true;
  return {
    callTool: (name, args) => {
      if (typeof name !== "string") return Promise.reject(new TypeError("callTool: the tool name must be a string"));
      let input: unknown;
      try {
        const text = JSON.stringify(args ?? null);
        input = text === undefined ? null : JSON.parse(text);
      } catch (e) {
        return Promise.reject(e);
      }
      if (open) return dispatch(name, input);
      const refusal = new Error(`callTool: ${name} was not called because the execution has ended`);
      execution.crossing.start({ target: name, input }).error(refusal, { class: "refused" });
      return Promise.reject(refusal);
    },
    close: () => {
      open = false;
    },
  };
}

/** Resolves to `TIMED_OUT` after `ms`, or rejects with the client's reason when it cancels, until released. */
function stopWaiting(signal: AbortSignal, ms: number): { reached: Promise<typeof TIMED_OUT>; release: () => void } {
  let release = (): void => {};
  const reached = new Promise<typeof TIMED_OUT>((resolve, reject) => {
    const timer = setTimeout(resolve, ms, TIMED_OUT);
    const cancel = (): void => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    release = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
  });
  return { reached, release };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
