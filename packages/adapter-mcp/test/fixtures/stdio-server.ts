/**
 * The test code-mode server over stdio, as its own process. Lines go to
 * the file named by `MOCON_FILE`, or to stderr when it is unset; stdout is
 * the JSON-RPC channel and carries nothing else.
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
