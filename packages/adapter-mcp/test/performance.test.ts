/**
 * What the wrappers add, as shapes the machine cannot change. Each test
 * compares the wrapper against the core calls it makes, measured in the
 * same process and interleaved round by round so load from other test
 * files lands on both sides, and each side is the shortest of several
 * rounds after a warmup (`interleaved` in `helpers.ts` holds that rule).
 * The bounds are several times the steady-state ratio and far below what a
 * wrapper doing per-call work beyond one execution or one crossing would
 * cost. No test here asserts a figure in microseconds: absolute figures
 * belong in `bench/hot-path.mjs`, which gates them against the 10
 * microsecond target on a known machine.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { instrumentMcpClient, moconTool, type McpClientCalls } from "../src/index.js";
import { extraOf, harness, interleaved } from "./helpers.js";

const RESULT: CallToolResult = { content: [{ type: "text", text: "x".repeat(1000) }] };
const PROGRAM = "return await callTool('lookup', { id: 42 })";

test("moconTool costs a small multiple of the one execution it opens and ends", async () => {
  const h = harness();
  const body = async (): Promise<CallToolResult> => RESULT;
  const handler = moconTool<{ code: string }>(h.m, { program: (a) => a.code, language: "javascript", run: body });
  const extra = extraOf({ sessionId: "s-1", _meta: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } });
  // The same execution the wrapper opens, written by hand: everything it costs beyond this is the wrapper's own.
  const byHand = async (): Promise<void> => {
    const execution = h.m.execution.start({ program: PROGRAM, language: "javascript", context: { session: "s-1", traceparent: extra._meta?.["traceparent"] as string } });
    execution.end({ disposition: "completed", result: await body() });
  };
  const [wrapped, bare] = await interleaved(
    async () => {
      await handler({ code: PROGRAM }, extra);
      h.sink.lines.length = 0;
    },
    async () => {
      await byHand();
      h.sink.lines.length = 0;
    },
  );
  // Steady state is within a few percent: the wrapper reads two fields of `extra` and one argument.
  assert.ok(wrapped <= bare * 6, `the handler took ${wrapped.toFixed(1)} us, the same execution by hand ${bare.toFixed(1)} us`);
});

test("instrumentMcpClient costs a small multiple of the one crossing it opens and settles", async () => {
  const h = harness();
  const execution = h.m.execution.start({ program: "p", notice: false });
  const answer = async (): Promise<CallToolResult> => RESULT;
  const client = { callTool: answer, readResource: answer, getPrompt: answer } as unknown as McpClientCalls;
  const wrapped = instrumentMcpClient(client, { execution });
  const params = { name: "lookup", arguments: { id: 42, query: "acme.example" } };
  const [instrumented, bare] = await interleaved(
    async () => {
      await wrapped.callTool(params);
      h.sink.lines.length = 0;
    },
    async () => {
      // The same crossing by hand, around the same call.
      const c = execution.crossing.start({ target: params.name, input: params.arguments });
      c.output(await client.callTool(params));
      h.sink.lines.length = 0;
    },
  );
  assert.ok(instrumented <= bare * 6, `the wrapped client took ${instrumented.toFixed(1)} us, the same crossing by hand ${bare.toFixed(1)} us`);
});

test("a far side that opens a handle per call pays for the program once per call, and a program rule of hash-only leaves it one hash", async () => {
  const small = "x".repeat(100);
  const large = "x".repeat(256 * 1024);
  /** One continued handle plus one crossing, as a proxy that dispatches per call does it. */
  const per = (program: string, hashOnly: boolean): (() => Promise<void>) => {
    const h = harness("test/mcp", hashOnly ? { capture: { rules: { program: "hash-only" } } } : undefined);
    const options = { id: "e1", program, language: "javascript", start: "2026-09-17T09:00:00.000Z", notice: false };
    return async () => {
      h.m.execution.start(options).crossing.start({ target: "t", input: null, seq: 1 }).output(1);
      h.sink.lines.length = 0;
    };
  };
  const hash = async (): Promise<void> => void createHash("sha256").update(large).digest("hex");

  const [largeUs, smallUs] = await interleaved(per(large, false), per(small, false), 9, 20);
  // The program is captured once per handle, so a proxy that opens one per call pays O(program) per call: this is the cost the README's RPC shape warns about.
  assert.ok(largeUs > smallUs, `a 256 KiB program cost ${largeUs.toFixed(1)} us, a 100 B one ${smallUs.toFixed(1)} us`);

  const [hashedUs, hashUs] = await interleaved(per(large, true), hash, 9, 20);
  // core.md 5.2 wants program.bytes and program.hash on every record, so hash-only still reads the whole text, natively, and nothing more.
  assert.ok(hashedUs <= (smallUs + hashUs) * 5, `hash-only cost ${hashedUs.toFixed(1)} us for a 256 KiB program: ${smallUs.toFixed(1)} us of handle plus ${hashUs.toFixed(1)} us of SHA-256`);
  assert.ok(hashedUs < largeUs, `hash-only cost ${hashedUs.toFixed(1)} us against ${largeUs.toFixed(1)} us for the default encoder`);
});
