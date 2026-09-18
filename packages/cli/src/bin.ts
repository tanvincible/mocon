#!/usr/bin/env node
/**
 * The `mocon` binary: validate, view, ui, otlp. Each command reads the
 * whole file once. `view` and `ui` apply the supersede rule once per key
 * through @mocon/core, so they show the same result for any permutation of
 * the lines; `validate` reports by line number, and `otlp` maps lines in
 * order, as a sink receives them.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildModel } from "./model.js";
import { exportStream, requestText } from "./otlp.js";
import { safe } from "./text.js";
import { serveUi, writeUi } from "./ui.js";
import { exitCode, renderReport, validateStream } from "./validate.js";
import { renderView } from "./view.js";

const DEFAULT_PORT = 7311;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const USAGE = `usage: mocon <command> <file> [options]

  validate <file>                  check every line against core.md and spec/schema;
                                   exit 1 when a line fails, 0 otherwise
  view <file>                      print the stream as a tree with P and T provenance markers
  ui <file> [--port N] [--out path]
                                   serve the viewer on 127.0.0.1, port ${DEFAULT_PORT} unless --port
                                   says otherwise (0 picks a free one), at the URL it prints;
                                   --out writes one self-contained HTML file instead
  otlp <file> [--url endpoint] [--header name=value]...
                                   print the ExportTraceServiceRequest JSON, or POST it to --url
                                   with each --header; exit 1 when the POST fails
`;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    return usage(errorMessage(e));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, file, extra] = positionals;
  if (command === undefined || file === undefined) return usage();
  if (extra !== undefined) return usage(`unexpected argument ${extra}`);
  const read = (): string => readFileSync(file, "utf8");

  switch (command) {
    case "validate": {
      const report = validateStream(read());
      process.stdout.write(renderReport(file, report));
      return exitCode(report);
    }
    case "view":
      process.stdout.write(renderView(buildModel(read())));
      return 0;
    case "ui": {
      if (values.out !== undefined) {
        writeUi(file, values.out);
        process.stderr.write(`mocon ui: wrote ${safe(values.out)}\n`);
        return 0;
      }
      const port = values.port === undefined ? DEFAULT_PORT : /^\d{1,5}$/.test(values.port) ? Number(values.port) : -1;
      if (port < 0 || port > 65535) return usage("--port must be an integer between 0 and 65535");
      const { url } = await serveUi(file, port);
      process.stderr.write(`mocon ui: serving ${safe(file)} at ${url} (ctrl-c to stop)\n`);
      return 0;
    }
    case "otlp": {
      const headers = new Map<string, string>();
      for (const pair of values.header ?? []) {
        const eq = pair.indexOf("=");
        const name = pair.slice(0, Math.max(eq, 0)).trim().toLowerCase();
        // The value may be a credential, so a malformed pair is never echoed.
        if (eq === -1 || !HEADER_NAME.test(name)) return usage("--header takes name=value, with a valid header name");
        headers.set(name, pair.slice(eq + 1));
      }
      if (headers.size > 0 && values.url === undefined) return usage("--header needs --url");
      const url = values.url;
      const result = await exportStream(read(), url === undefined ? undefined : { url, headers: Object.fromEntries(headers) });
      const s = result.skipped;
      process.stderr.write(
        `mocon otlp: ${result.spans} span${result.spans === 1 ? "" : "s"}; skipped: notice ${s.notice}, malformed ${s.malformed}, ` +
          `unknown kind ${s.unknown_kind}, bad enum ${s.bad_enum}, bad timestamp ${s.bad_timestamp}; ` +
          `host conflicts ${result.conflicts}, other major versions ${result.versionMismatches}\n`,
      );
      if (url === undefined) {
        process.stdout.write(requestText(result.request) + "\n");
        return 0;
      }
      // Origin and path only, as the sink's own errors print it: some collectors take a key in the query string.
      const endpoint = new URL(url);
      process.stderr.write(`mocon otlp: POST ${safe(endpoint.origin + endpoint.pathname)} -> ${result.status ?? "no response"}\n`);
      if (!("error" in result)) return 0;
      process.stderr.write(`mocon otlp: ${safe(errorMessage(result.error))}\n`);
      return 1;
    }
    default:
      return usage(`unknown command ${command}`);
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      out: { type: "string" },
      url: { type: "string" },
      header: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** A usage problem is about the command line the user typed, so it is printed as is. */
function usage(problem?: string): 2 {
  process.stderr.write((problem === undefined ? "" : `mocon: ${problem}\n`) + USAGE);
  return 2;
}

/** The message, and the cause's when the message does not already say it: `fetch failed` alone does not say what failed. */
function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error && !e.message.includes(e.cause.message) ? `${e.message}: ${e.cause.message}` : e.message;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`mocon: ${safe(errorMessage(e))}\n`);
    process.exitCode = 2;
  },
);
