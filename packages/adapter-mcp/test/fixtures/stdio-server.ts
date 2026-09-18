/**
 * The test code-mode server over stdio, as its own process. Lines go to
 * the file named by `MOCON_FILE`, or to stderr when it is unset; stdout is
 * the JSON-RPC channel and carries nothing else.
 *
 * It closes the server when stdin ends, which is the shape a code-mode
 * host over stdio needs and the SDK does not provide: see the note in the
 * README. Without it a client that closes the pipe with a call in flight
 * takes the process down with no complete record for that call.
 */

import { fileSink, mocon, stderrSink } from "@mocon/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { codeMode } from "../codemode.js";

const file = process.env["MOCON_FILE"];
const m = mocon({
  host: "test/stdio",
  capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] },
  sinks: [file === undefined ? stderrSink() : fileSink(file)],
});
const server = new McpServer({ name: "codemode", version: "0.0.0" });
server.registerTool("execute", { description: "Run a program", inputSchema: { code: z.string() } }, codeMode(m).execute);
await server.connect(new StdioServerTransport());

// `StdioServerTransport.start` subscribes to stdin's "data" and "error" and not to its end, so a client
// that closes the pipe never reaches the transport's `onclose`, and the SDK never aborts the signal of a
// request in flight. Closing the server here does reach it: each in-flight handler's signal aborts, the
// wrapper writes `terminated` with class `cancelled` for every call still running, and the lines are on
// the sink before the process exits.
process.stdin.once("end", () => {
  void server.close();
});
