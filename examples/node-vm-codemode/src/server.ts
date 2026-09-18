/**
 * Serves the code-mode server in `codemode.ts` over stdio. Every line goes
 * through the core file sink to the file named by `MOCON_FILE`, default
 * `mocon.jsonl` in the working directory. Stdout is the JSON-RPC channel,
 * so anything else this process has to say goes to stderr.
 */

import { fileSink, mocon } from "@mocon/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CAPABILITIES, createServer, HOST } from "./codemode.js";

// Programs share this process's rejection tracking, so a promise one leaves rejected would otherwise stop the server and every execution in flight.
process.on("unhandledRejection", (reason) => report("a promise rejection went unhandled", reason));

const m = mocon({
  host: HOST,
  capabilities: CAPABILITIES,
  sinks: [fileSink(process.env["MOCON_FILE"] ?? "mocon.jsonl")],
  onError: (error, { phase }) => report(`the stream file failed to ${phase}`, error),
});

await createServer(m).connect(new StdioServerTransport());

/** One line on stderr. `detail` may come from a program, so reading it must not throw and printing it must not reach the terminal as control characters. */
function report(what: string, detail: unknown): void {
  let text: string;
  try {
    text = String((detail as { message?: unknown } | null | undefined)?.message ?? detail);
  } catch {
    text = "a value that cannot be printed";
  }
  const printable = text.slice(0, 512).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  process.stderr.write(`node-vm-codemode: ${what}: ${printable}\n`);
}
