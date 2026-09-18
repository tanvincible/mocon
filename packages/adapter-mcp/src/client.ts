/**
 * The client wrapper. Each `callTool`, `readResource` and `getPrompt` on
 * the returned object is one crossing of the execution. The wrapper holds
 * nothing but the handle and the client. A name or uri the program passed
 * that is not a string goes through `targetOf`, the same coercion
 * `instrument` applies, and the call still reaches the client, which
 * decides what it means.
 */

import { targetOf, type ExecutionHandle } from "@mocon/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** The three request methods the wrapper covers, in the SDK client's own signatures. */
export type McpClientCalls = Pick<Client, "callTool" | "readResource" | "getPrompt">;

export interface InstrumentMcpClientOptions {
  execution: ExecutionHandle;
  /**
   * The crossing target for a tool name, a prompt name or a resource uri.
   * Default: the name itself. A proxy that fronts several servers prefixes
   * it, `(name) => "crm/" + name`.
   */
  target?: (name: string) => string;
}

/** Every method returns a promise, as the client's do: a throw while reading `params` or from `target` rejects it. */
export function instrumentMcpClient(client: McpClientCalls, options: InstrumentMcpClientOptions): McpClientCalls {
  const { execution, target = same } = options;
  return {
    callTool: async (params, resultSchema, requestOptions) =>
      crossing(execution, target(targetOf(params.name)), params.arguments, () => client.callTool(params, resultSchema, requestOptions)),
    readResource: async (params, requestOptions) =>
      crossing(execution, target(targetOf(params.uri)), undefined, () => client.readResource(params, requestOptions)),
    getPrompt: async (params, requestOptions) =>
      crossing(execution, target(targetOf(params.name)), params.arguments, () => client.getPrompt(params, requestOptions)),
  };
}

/** True for a tool result that reports a failure. */
export function isErrorResult(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { isError?: unknown }).isError === true;
}

const same = (name: string): string => name;

/**
 * Opens the crossing, makes the call, settles: `output` on a result,
 * `error` with the default class `capability_error` on a throw or on a
 * result that carries `isError`. The value returned or thrown is passed
 * through unchanged.
 */
async function crossing<T>(execution: ExecutionHandle, target: string, input: unknown, call: () => Promise<T>): Promise<T> {
  const c = execution.crossing.start({ target, input });
  let result: T;
  try {
    result = await call();
  } catch (error) {
    c.error(error);
    throw error;
  }
  if (isErrorResult(result)) c.error(result);
  else c.output(result);
  return result;
}
