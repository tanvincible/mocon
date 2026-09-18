/**
 * Generated programs against the host's rules. A program is a sequence of
 * tool calls, awaited, caught, raced together, left running or chained
 * after one left running, and then an ending: it returns, throws, never
 * settles, or opens with a busy loop. Whatever the timing, once every call
 * it left behind has settled, its stream keeps the rules in
 * `assertHostRules`: one complete execution, nothing unresolved, and no
 * call dispatched after the host stopped waiting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { assertHostRules, completeExecution, connect, settled } from "./helpers.js";

const LIMIT_MS = 120;

const call = fc
  .oneof(
    fc.constantFrom('"company_lookup", { domain: "acme.example" }', '"company_lookup", { domain: "nowhere.invalid" }', '"no_such_tool", {}'),
    fc.integer({ min: -1, max: 6 }).map((limit) => `"person_search", { domain: "acme.example", limit: ${limit} }`),
  )
  .map((args) => `callTool(${args})`);

const step = fc.oneof(
  call.map((c) => `await ${c};`),
  call.map((c) => `try { await ${c}; } catch {}`),
  fc.tuple(call, call).map(([a, b]) => `await Promise.allSettled([${a}, ${b}]);`),
  call.map((c) => `${c}.catch(() => {});`),
  fc.tuple(call, call).map(([a, b]) => `${a}.then(() => ${b}).catch(() => {});`),
);

const ending = fc.constantFrom("return 'done';", "throw new Error('the program gave up');", "await new Promise(() => {});", "");

const program = fc.record({ busy: fc.integer({ min: 0, max: 9 }).map((n) => n === 0), steps: fc.array(step, { maxLength: 4 }), ending });

test("every generated program leaves a stream that keeps the host's rules", async () => {
  await fc.assert(
    fc.asyncProperty(program, async ({ busy, steps, ending }) => {
      const code = [busy ? "while (true) {}" : "", ...steps, ending].filter((l) => l !== "").join("\n");
      const host = await connect(LIMIT_MS);
      try {
        const result = await host.execute(code);
        await settled(host.sink);
        const done = completeExecution(assertHostRules(host.sink.lines));
        const disposition = done["end"]["disposition"];
        const reachesTheHang = ending.startsWith("await new Promise") && !steps.some((s) => s.startsWith("await callTool"));
        if (busy || reachesTheHang) {
          assert.equal(disposition, "terminated");
          assert.equal(done["end"]["error"]["class"], "timeout");
        }
        assert.equal(result.isError === true, disposition !== "completed", "the client sees an error exactly when the execution did not complete");
      } finally {
        await host.close();
      }
    }),
    { numRuns: 25 },
  );
});
