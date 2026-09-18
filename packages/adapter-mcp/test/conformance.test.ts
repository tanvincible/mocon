/**
 * Streams the adapter produces for three golden shapes, compared with the
 * canonical view in spec/conformance/expected field by field. Ids, times,
 * hashes, byte counts, messages and payload contents are the host's own,
 * so each is compared by type; every other leaf, and which fields exist at
 * all, is compared by value. Where the reference library writes a field
 * differently from the golden stream, the difference is listed and
 * explained, so a new one fails the test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { View } from "@mocon/core/fold";
import { fold } from "@mocon/core/fold";
import { moconTool } from "../src/index.js";
import { assertValidStream, extraOf, harness, SYNC_BRIDGE, type Rec } from "./helpers.js";

const expectedDir = new URL("../../../spec/conformance/expected/", import.meta.url);

type Leaf = string | number | boolean | null;

function golden(name: string): Rec {
  return JSON.parse(readFileSync(new URL(name + ".json", expectedDir), "utf8")) as Rec;
}

/** Keys whose value the host chooses freely: compared by type. */
const OPAQUE = new Set(["host", "id", "execution_id", "crossing_id", "message", "start", "time", "bytes", "hash"]);
/** Keys that hold a Payload, whose `value` is the host's data. */
const PAYLOADS = new Set(["program", "input", "output", "result"]);

function typeOf(v: unknown): string {
  return v === null ? "<null>" : Array.isArray(v) ? "<array>" : "<" + typeof v + ">";
}

/** Every leaf of a view as `path → leaf`, with records ordered by what the stream says about them rather than by id. */
function shape(view: Pick<View, "hosts" | "executions" | "crossings" | "unresolved" | "conflicts" | "skipped">): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  /** `isPayload`: `value` is a Payload, so its own `value` is the host's data. */
  const walk = (value: unknown, path: string, key: string, isPayload: boolean): void => {
    if (OPAQUE.has(key)) out.set(path, typeOf(value));
    else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (key === "ext" || key === "context" || (isPayload && k === "value")) out.set(path + "/" + k, typeOf(v));
        else walk(v, path + "/" + k, k, PAYLOADS.has(k) || key === "outputs" || (key === "error" && k === "value"));
      }
    } else out.set(path, value as Leaf);
  };
  const rank = (r: Rec): string => String(r["seq"] ?? "").padStart(6, "0") + (r["start"] ?? "") + (r["target"] ?? "");
  const ordered = (records: Record<string, unknown>): Rec[] => (Object.values(records) as Rec[]).sort((a, b) => rank(a).localeCompare(rank(b)));
  ordered(view.hosts).forEach((r, i) => walk(r, `hosts/${i}`, "", false));
  ordered(view.executions).forEach((r, i) => walk(r, `executions/${i}`, "", false));
  ordered(view.crossings).forEach((r, i) => walk(r, `crossings/${i}`, "", false));
  view.unresolved.forEach((r, i) => out.set(`unresolved/${i}`, r.kind));
  view.conflicts.forEach((r, i) => out.set(`conflicts/${i}`, r.kind));
  out.set("skipped", view.skipped);
  return out;
}

/** `- path` for a field only the golden view has, `+ path` for one only the adapter's has, `~ path` for a leaf that differs. */
function differences(expected: Map<string, Leaf>, actual: Map<string, Leaf>): string[] {
  const out: string[] = [];
  for (const [path, leaf] of expected) {
    if (!actual.has(path)) out.push("- " + path);
    else if (actual.get(path) !== leaf) out.push(`~ ${path}: ${String(leaf)} became ${String(actual.get(path))}`);
  }
  for (const path of actual.keys()) if (!expected.has(path)) out.push("+ " + path);
  return out.sort();
}

function compare(name: string, lines: readonly string[]): string[] {
  assertValidStream(lines);
  return differences(shape(golden(name) as unknown as View), shape(fold(lines)));
}

test("pre-run-rejection: a body that rejects the program before it runs gives the golden shape exactly", async () => {
  const h = harness("example/mcp");
  const execute = moconTool<{ code: string }>(h.m, {
    program: (a) => a.code,
    language: "javascript",
    notice: false,
    run: (_a, { execution }) => {
      execution.fail("unknown tool name: unknown_tool_name", { class: "validation" });
      return { content: [{ type: "text", text: "unknown tool name: unknown_tool_name" }], isError: true };
    },
  });
  await execute({ code: "const x = await callTool('unknown_tool_name', {});\nreturn x;" }, extraOf());
  assert.deepEqual(compare("pre-run-rejection", h.sink.lines), []);
});

test("sync-bridge: overlapping instrumented calls, a truncated output and credits on the complete record", async () => {
  const h = harness("example/mcp", { capabilities: SYNC_BRIDGE, capture: { caps: { "crossing.output": 80 } } });
  const people = Array.from({ length: 120 }, (_, i) => ({ name: "Person " + i, title: "Engineer" }));
  const tools = async (name: string, args: unknown): Promise<unknown> => {
    await new Promise((resolve) => setTimeout(resolve, name === "company_identify" ? 5 : 15));
    return name === "company_identify" ? { name: "Acme Robotics", id: 8842 } : people.slice(0, (args as { limit: number }).limit);
  };
  const execute = moconTool<{ code: string }>(h.m, {
    program: (a) => a.code,
    language: "javascript",
    run: async (_a, { execution }) => {
      const callTool = execution.instrument(tools);
      // The golden program, run as the host's sandbox would.
      const [co, found] = (await Promise.all([callTool("company_identify", { query: "acme.example" }), callTool("person_search", { domain: "acme.example", limit: 200 })])) as [{ name: string }, unknown[]];
      const value = { company: co.name, count: found.length };
      execution.complete({ result: value, ext: { "example.credits_remaining": 9982, "example.credits_used": 18 } });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  });
  const code =
    "const [co, people] = await Promise.all([callTool('company_identify',{query:'acme.example'}), callTool('person_search',{domain:'acme.example',limit:200})]); return {company: co.name, count: people.length};";
  await execute({ code }, extraOf({ sessionId: "mcp-9a1f0c" }));
  assert.deepEqual(compare("sync-bridge", h.sink.lines), [
    // The encoder stops reading a value at the cap and will not claim a length or hash for bytes it never read (core README, Capture and redaction).
    "- crossings/1/end/output/bytes",
    "- crossings/1/end/output/hash",
  ]);
});

test("terminated-timeout: the host's own step limit, surfacing as a throw and named by classify, abandons the open call and terminates", async () => {
  class StepTimeout extends Error {}
  const h = harness("huggingface/smolagents", { capabilities: { observes_crossings: "some", unmediated_egress: true, attested: [] } });
  const execute = moconTool<{ code: string }>(h.m, {
    program: (a) => a.code,
    language: "python",
    classify: (cause) => (cause instanceof StepTimeout ? { disposition: "terminated", class: "timeout" } : undefined),
    run: async (_a, { execution }) => {
      const webSearch = execution.instrument((_name: string, _args: unknown) => new Promise<never>(() => {}));
      const running = webSearch("web_search", { query: "quarterly filings for every S&P 500 company since 1990" });
      const limit = new Promise<never>((_, reject) => setTimeout(() => reject(new StepTimeout("ExecutionTimeoutError: step exceeded 20ms")), 20));
      await Promise.race([running, limit]);
      return { content: [] };
    },
  });
  await assert.rejects(execute({ code: "result = web_search('quarterly filings for every S&P 500 company since 1990')\nprint(result)" }, extraOf()), StepTimeout);
  assert.deepEqual(compare("terminated-timeout", h.sink.lines), [
    // A started handle numbers its crossings (core README, Handles).
    "+ crossings/0/seq",
    // The cause rule keeps the thrown error as a Payload beside its message.
    "+ executions/0/end/error/value/bytes",
    "+ executions/0/end/error/value/hash",
    "+ executions/0/end/error/value/value",
  ]);
});
