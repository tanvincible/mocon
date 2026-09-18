/**
 * The execution context an MCP request carries, read from the `extra`
 * argument the SDK hands every request handler.
 */

import type { ExecutionContext } from "@mocon/core";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

/** The second argument of an SDK request handler. */
export type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The longest value relayed. A W3C traceparent is 55 characters. */
const MAX_LENGTH = 256;

/**
 * Pure. `extra.sessionId` becomes `context.session` and
 * `extra._meta.traceparent` becomes `context.traceparent`, both verbatim.
 * A field that is absent, not a string, or longer than 256 characters is
 * omitted rather than cut: the value is relayed unmodified or not at all,
 * and the core handle copies `traceparent` onto every crossing line.
 *
 * Every read is guarded, `extra` itself included. The argument comes from
 * the SDK, and a host can hand over something else: registering a tool
 * with no `inputSchema` makes the SDK call the handler with one argument,
 * so `extra` arrives as `undefined`. A missing field then costs that
 * field, never the record — a throw here would happen before the
 * execution starts, and the call would leave no line at all.
 */
export function contextFromMcp(extra: Pick<McpExtra, "sessionId" | "_meta">): ExecutionContext {
  const given = extra as Partial<Pick<McpExtra, "sessionId" | "_meta">> | undefined;
  const context: ExecutionContext = {};
  const session = given?.sessionId;
  if (relayable(session)) context.session = session;
  const traceparent = given?._meta?.["traceparent"];
  if (relayable(traceparent)) context.traceparent = traceparent;
  return context;
}

/** A string a client supplied that is short enough to relay: 256 characters or fewer. */
export function relayable(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_LENGTH;
}
