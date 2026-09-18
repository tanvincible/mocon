/**
 * Test support: the server over an in-memory transport into a memory sink,
 * the rules every stream of this host keeps, and the paths of the built
 * entry points. The schema, the transport pairing and the small async
 * helpers are shared with the packages in `packages/testkit`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { memorySink, mocon, type MemorySink } from "@mocon/core";
import { fold } from "@mocon/core/fold";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pair, type Rec } from "../../../packages/testkit/mcp.js";
import { lineSchema } from "../../../packages/testkit/schema.js";
import { CAPABILITIES, createServer, HOST } from "../src/codemode.js";

export { completeExecution, text, waitFor, type Rec } from "../../../packages/testkit/mcp.js";

export const packageDir = fileURLToPath(new URL("../", import.meta.url));
export const serverEntry = join(packageDir, "dist", "server.js");
export const driveEntry = join(packageDir, "dist", "drive.js");

const require = createRequire(import.meta.url);
const cliManifest = require.resolve("@mocon/cli/package.json");
export const cliEntry = join(dirname(cliManifest), (JSON.parse(readFileSync(cliManifest, "utf8")) as { bin: { mocon: string } }).bin.mocon);

/** The program `drive.ts` sends: two overlapping calls and one that fails, caught by the program. */
export const DRIVER_PROGRAM = `
const [company, people] = await Promise.all([
  callTool("company_lookup", { domain: "acme.example" }),
  callTool("person_search", { domain: "acme.example", limit: 3 }),
]);
let failure;
try {
  await callTool("company_lookup", { domain: "nowhere.invalid" });
} catch (e) {
  failure = e.message;
}
return { company: company.name, people: people.map((p) => p.name), failure };
`.trim();

/**
 * Checks the rules every stream of this host keeps and returns the parsed
 * lines. Every core line validates against the schema and every event has
 * the fields events.md 2 requires. The declaration comes first and only
 * once. The stream folds with no conflict and nothing unresolved, so every
 * execution ended. Within an execution, crossings carry distinct `seq`
 * values from 1, and every crossing that was dispatched, including the
 * ones written as abandoned, precedes the complete record: after the host
 * stops waiting, a call is only ever refused. A late settlement names an
 * abandoned crossing.
 */
export function assertHostRules(lines: readonly string[]): Rec[] {
  const records = lines.map((text, i) => {
    assert.ok(!text.includes("\n"), `line ${i} holds a raw newline`);
    return JSON.parse(text) as Rec;
  });
  records.forEach((r, i) => {
    if (r["kind"] === "event") {
      for (const key of ["host", "id", "execution_id", "name"]) assert.equal(typeof r[key], "string", `line ${i}: event without ${key}`);
    } else {
      assert.ok(lineSchema(r), `line ${i}: ${JSON.stringify(lineSchema.errors)}`);
    }
  });
  assert.equal(records[0]?.["kind"], "host", "the declaration is the first line");
  assert.deepEqual(records[0], { kind: "host", host: HOST, spec_version: "1.0", ...CAPABILITIES });
  assert.equal(records.filter((r) => r["kind"] === "host").length, 1, "one declaration");

  const view = fold(lines);
  assert.deepEqual(view.conflicts, []);
  assert.deepEqual(view.unresolved, []);
  assert.equal(view.skipped, records.filter((r) => r["kind"] === "event").length, "only events are skipped by a core consumer");

  for (const [index, execution] of records.entries()) {
    if (execution["kind"] !== "execution" || execution["end"] === undefined) continue;
    const crossings = records.map((r, i) => [r, i] as const).filter(([r]) => r["kind"] === "crossing" && r["execution_id"] === execution["id"]);
    const seqs = crossings.map(([r]) => r["seq"] as number).sort((a, b) => a - b);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "crossings are numbered from 1 without a repeat");
    for (const [crossing, at] of crossings) {
      if (crossing["end"]["error"]?.["class"] === "refused") {
        assert.equal(crossing["end"]["outcome"], "error");
        continue;
      }
      assert.ok(at < index, `crossing ${crossing["id"]} (${crossing["end"]["outcome"]}) was dispatched but written after its execution's complete record`);
    }
  }
  for (const event of records.filter((r) => r["kind"] === "event")) {
    assert.equal(event["name"], "late_settlement");
    const abandoned = records.find((r) => r["kind"] === "crossing" && r["id"] === event["crossing_id"]);
    assert.equal(abandoned?.["end"]?.["outcome"], "abandoned", "a late settlement names an abandoned crossing");
  }
  return records;
}

export interface Connected {
  client: Client;
  sink: MemorySink;
  /** Parsed lines written so far. */
  records(): Rec[];
  execute(code: string, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** The server from `codemode.ts` over a linked in-memory pair, recording into a memory sink. */
export async function connect(timeLimitMs?: number): Promise<Connected> {
  const sink = memorySink();
  const server = createServer(mocon({ host: HOST, capabilities: CAPABILITIES, sinks: [sink] }), timeLimitMs);
  const { client, close } = await pair(server);
  return {
    client,
    sink,
    close,
    records: () => sink.lines.map((l) => JSON.parse(l) as Rec),
    execute: async (code, o) => (await client.callTool({ name: "execute", arguments: { code } }, undefined, o)) as CallToolResult,
  };
}

export function crossingsOf(records: Rec[]): Rec[] {
  return records.filter((r) => r["kind"] === "crossing");
}

/** Resolves once no line has been written for `quietMs`: every call a program left running has settled or been refused. */
export async function settled(sink: MemorySink, quietMs = 150): Promise<void> {
  let count = -1;
  while (count !== sink.lines.length) {
    count = sink.lines.length;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
  }
}
