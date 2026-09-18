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

const server = createServer(m, limitFromEnv());
await server.connect(new StdioServerTransport());

// `StdioServerTransport.start` subscribes to stdin's "data" and "error" and not to its end, so an agent that
// closes the pipe reaches neither the transport's `onclose` nor the server's: the SDK aborts no signal, and
// every call in flight would end with a start notice and no complete record — the one event this server
// exists to record. Closing the server here does reach `onclose`, so each in-flight request's signal aborts
// and the wrapper writes `terminated` for it before the process goes.
process.stdin.once("end", () => void server.close());

/** `MOCON_TIME_LIMIT_MS` as the server's time limit, or the default when it is unset; a value the server would refuse is refused here, by name, before anything starts. */
function limitFromEnv(): { timeLimitMs?: number } {
  const given = process.env["MOCON_TIME_LIMIT_MS"];
  if (given === undefined) return {};
  const timeLimitMs = Number(given);
  if (!Number.isInteger(timeLimitMs) || timeLimitMs < 1) throw new RangeError("MOCON_TIME_LIMIT_MS must be an integer of 1 or more");
  return { timeLimitMs };
}

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
