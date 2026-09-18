/**
 * @mocon/adapter-mcp: mocon wrappers for hosts built on
 * `@modelcontextprotocol/sdk`. One handler wrapper, one client wrapper,
 * one context reader. Nothing here runs in the background or holds
 * anything across executions.
 */

export { contextFromMcp, type McpExtra } from "./context.js";
export { moconTool, type MoconToolHandler, type MoconToolOptions } from "./tool.js";
export { instrumentMcpClient, type InstrumentMcpClientOptions, type McpClientCalls } from "./client.js";
