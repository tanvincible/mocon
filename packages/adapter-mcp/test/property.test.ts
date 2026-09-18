/**
 * Properties over generated calls. For anything `run` can do (return a
 * result, return `isError`, throw any value, settle the handle itself,
 * leave crossings open) under any abort and any `classify`, a handled call
 * ends its execution exactly once, with the disposition and class the
 * README's table gives, after writing every crossing it left open; and it
 * hands back exactly what `run` returned or threw. For any `extra`, the
 * context reader never returns a field that is not a string or is over
 * its cap, and relays one that is within it verbatim.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { fold } from "@mocon/core/fold";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contextFromMcp, moconTool, type McpExtra, type MoconToolOptions } from "../src/index.js";
import { assertValidStream, extraOf, harness, type Rec } from "./helpers.js";

const RUNS = { numRuns: 300 };

type Body = { kind: "result"; isError: boolean | undefined } | { kind: "throw"; cause: unknown } | { kind: "throwReason" };
type Classifier = { kind: "none" } | { kind: "throws" } | { kind: "returns"; value: unknown };

const cause = fc.oneof(
  fc.string().map((message) => new Error(message)),
  fc.string().map((message) => new Error("outer " + message, { cause: new RangeError(message) })),
  fc.constantFrom(null, undefined, 0, true),
  fc.integer(),
  fc.string(),
  fc.record({ ok: fc.boolean(), status: fc.integer(), message: fc.option(fc.string(), { nil: undefined }) }),
);

const body: fc.Arbitrary<Body> = fc.oneof(
  fc.record({ kind: fc.constant("result" as const), isError: fc.constantFrom(undefined, false, true) }),
  fc.record({ kind: fc.constant("throw" as const), cause }),
  // The body stops waiting by surfacing the signal's own reason, as `throwIfAborted` and a raced signal do.
  fc.constant({ kind: "throwReason" as const }),
);

const classifier: fc.Arbitrary<Classifier> = fc.oneof(
  fc.constant({ kind: "none" as const }),
  fc.constant({ kind: "throws" as const }),
  fc.record({
    kind: fc.constant("returns" as const),
    value: fc.oneof(
      fc.constantFrom(undefined, null, "terminated", 3),
      fc.record(
        {
          disposition: fc.constantFrom("failed", "terminated", "completed", "abandoned", 7, undefined),
          class: fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom(5, null, undefined)),
        },
        { requiredKeys: [] },
      ),
    ),
  }),
);

const abort = fc.option(
  fc.record({
    reason: fc.oneof(
      fc.string({ maxLength: 20 }),
      // Either side of the 256-character relay cap, since the client chooses the length.
      fc.integer({ min: 250, max: 300 }).map((n) => "r".repeat(n)),
      fc.constant(undefined),
      fc.record({ code: fc.string({ maxLength: 5 }) }),
    ),
  }),
  { nil: undefined },
);

const scenario = fc.record({
  body,
  classifier,
  abort,
  /** One entry per crossing the body opens: settle it, or leave it open. */
  crossings: fc.array(fc.boolean(), { maxLength: 4 }),
  selfSettles: fc.boolean(),
  async: fc.boolean(),
});

/** What `fail(cause)` writes for `cause`, message and value, from an instance of its own. */
function referenceError(of: unknown): Rec {
  const ref = harness();
  ref.m.execution.start({ program: "x", notice: false }).fail(of);
  return ref.done()["end"]["error"];
}

test("a handled call ends its execution exactly once, with the table's disposition and class, after every crossing it left open", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (s) => {
      const h = harness();
      const result: CallToolResult = s.body.kind === "result" && s.body.isError !== undefined ? { content: [], isError: s.body.isError } : { content: [] };
      const classify: MoconToolOptions<unknown>["classify"] =
        s.classifier.kind === "none"
          ? undefined
          : s.classifier.kind === "throws"
            ? () => {
                throw new Error("classify");
              }
            : ((value) => () => value)(s.classifier.value) as MoconToolOptions<unknown>["classify"];
      const execute = moconTool<unknown>(h.m, {
        program: () => "p",
        classify,
        run: async (_args, { execution, extra }) => {
          if (s.async) await Promise.resolve();
          s.crossings.forEach((settle, i) => {
            const c = execution.crossing.start({ target: "t" + i, input: i });
            if (settle) c.output(i);
          });
          if (s.selfSettles) execution.end({ disposition: "failed", error: { class: "self" } });
          if (s.body.kind === "throw") throw s.body.cause;
          if (s.body.kind === "throwReason") throw extra.signal.reason as unknown;
          return result;
        },
      });
      const extra: McpExtra = extraOf(s.abort === undefined ? undefined : { abort: s.abort });
      const thrown: unknown = s.body.kind === "throwReason" ? extra.signal.reason : s.body.kind === "throw" ? s.body.cause : undefined;

      let outcome: { returned: unknown } | { thrown: unknown };
      try {
        outcome = { returned: await execute(undefined, extra) };
      } catch (e) {
        outcome = { thrown: e };
      }
      if (s.body.kind === "result") assert.ok("returned" in outcome && outcome.returned === result, "returns exactly what run returned");
      else assert.ok("thrown" in outcome && Object.is(outcome.thrown, thrown), "rethrows exactly what run threw");

      assertValidStream(h.sink.lines);
      const records = h.records();
      const completeAt = records.findIndex((r) => r["kind"] === "execution" && r["end"] !== undefined);
      const done = h.done();
      const crossings = h.ofKind("crossing");
      assert.equal(crossings.length, s.crossings.length, "every crossing is written once");
      assert.deepEqual(
        crossings.map((c) => c["end"]["outcome"]).sort(),
        s.crossings.map((settled) => (settled ? "output" : "abandoned")).sort(),
      );
      assert.ok(records.every((r, i) => r["kind"] !== "crossing" || i < completeAt), "every crossing precedes the complete record");
      const view = fold(h.sink.lines);
      assert.deepEqual(view.unresolved, []);
      assert.deepEqual(view.conflicts, []);

      const end = done["end"];
      if (s.selfSettles) {
        assert.deepEqual([end["disposition"], end["error"]], ["failed", { class: "self" }]);
        return;
      }
      const normal = s.body.kind === "result" && s.body.isError !== true;
      if (normal) {
        assert.equal(end["disposition"], "completed");
        assert.equal(end["error"], undefined);
        return;
      }
      const given = s.classifier.kind === "returns" && typeof s.classifier.value === "object" && s.classifier.value !== null ? (s.classifier.value as Rec) : {};
      const cls = typeof given["class"] === "string" ? given["class"] : undefined;
      const disposition = given["disposition"] === "failed" || given["disposition"] === "terminated" ? given["disposition"] : undefined;
      const aborted = s.abort !== undefined;
      assert.equal(end["disposition"], disposition ?? (aborted ? "terminated" : "failed"));
      assert.equal(end["error"]["class"], cls ?? (aborted ? "cancelled" : "runtime"));
      const reason = s.abort?.reason;
      // A cause that *is* the client's string reason never reaches the cause rule, so the record is as if the
      // body had thrown nothing: the reason's own 256-character rule is the one door it has.
      const surfaced = aborted && s.body.kind === "throwReason" && typeof reason === "string";
      const reference = referenceError(surfaced ? undefined : s.body.kind === "result" ? result : thrown);
      const relayed = aborted && typeof reason === "string" && reason.length <= 256 && (surfaced || cls === undefined);
      assert.equal(end["error"]["message"], relayed ? reason : reference["message"]);
      assert.deepEqual(end["error"]["value"], reference["value"]);
    }),
    RUNS,
  );
});

const text = fc.oneof(
  fc.string({ maxLength: 64 }),
  fc.string({ minLength: 250, maxLength: 262 }),
  fc.integer({ min: 257, max: 1 << 16 }).map((n) => "x".repeat(n)),
);
const field = fc.oneof(text, fc.anything());
const extraShape = fc.record(
  {
    sessionId: field,
    _meta: fc.oneof(fc.constantFrom(undefined, null), fc.anything(), fc.record({ traceparent: field }, { requiredKeys: [] })),
  },
  { requiredKeys: [] },
);

test("the context reader relays a string of up to 256 characters verbatim and nothing else, for any extra", () => {
  fc.assert(
    fc.property(extraShape, (extra) => {
      const context = contextFromMcp(extra as Parameters<typeof contextFromMcp>[0]);
      assert.ok(Object.keys(context).every((k) => k === "session" || k === "traceparent"));
      const relayed = (given: unknown): string | undefined => (typeof given === "string" && given.length <= 256 ? given : undefined);
      assert.equal(context.session, relayed((extra as Rec)["sessionId"]));
      const meta = (extra as Rec)["_meta"];
      assert.equal(context.traceparent, relayed(meta === null || meta === undefined ? undefined : (meta as Rec)["traceparent"]));

      const h = harness();
      const execution = h.m.execution.start({ program: "p", context });
      execution.crossing.start({ target: "t", input: null }).output(null);
      execution.complete();
      assertValidStream(h.sink.lines);
      for (const line of h.sink.lines) assert.ok(line.length < 4096, `a line of ${line.length} bytes`);
    }),
    RUNS,
  );
});
