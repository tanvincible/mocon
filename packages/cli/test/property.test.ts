/**
 * Properties over generated lines: `mocon validate` accepts a line exactly
 * when spec/schema accepts it; nothing a stream carries reaches the
 * terminal as a control character; the model and the tree never throw and
 * keep their invariants on any JSON line; and the tree is the same for any
 * order of the lines.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { buildModel } from "../src/model.js";
import { renderReport, structuralErrors, validateStream } from "../src/validate.js";
import { renderView } from "../src/view.js";
import { schemaAccepts, UNSAFE } from "./helpers.js";

const RUNS = { numRuns: 400 };

/* ------------------------------------------------------------------ */
/* Arbitraries                                                         */
/* ------------------------------------------------------------------ */

const ch = (code: number): string => String.fromCharCode(code);
/** Text that includes the characters a terminal acts on, alongside ordinary ones. */
const hostileChar = fc.constantFrom(ch(0x1b), ch(0x07), ch(0x0a), ch(0x0d), ch(0x00), ch(0x7f), ch(0x85), ch(0x9b), ch(0x2028), ch(0x2029), ch(0x202e), ch(0x2066), ch(0x061c), "[", "]", ";", "a", "0");
const text = fc.oneof(fc.string({ maxLength: 8 }), fc.stringOf(hostileChar, { maxLength: 8 }), fc.string({ unit: "binary", maxLength: 8 }));
const json = fc.jsonValue({ maxDepth: 2 });

/** A value from the set a field's rule allows, or one just outside it. */
const either = <T, U>(good: fc.Arbitrary<T>, bad: fc.Arbitrary<U>): fc.Arbitrary<T | U> => fc.oneof({ weight: 3, arbitrary: good }, { weight: 1, arbitrary: bad });
/** A parsed object `String()` throws on, because its own `toString` is not a function. */
const unprintable = fc.constantFrom({ toString: null }, { toString: 1, valueOf: {} }, [{ toString: null }]);
const wrongType = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant([]), fc.constant({}), fc.string({ maxLength: 3 }), unprintable);
/** The same without `unprintable`, for `host` and `id`, which `@mocon/core/fold` converts with `String()`. */
const wrongKey = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant([]), fc.constant({}), fc.string({ maxLength: 3 }));
/** `v`, or a plain string when `String(v)` would throw. */
function foldable(v: unknown): unknown {
  try {
    String(v);
    return v;
  } catch {
    return "x";
  }
}

const timestamp = either(
  fc.date({ min: new Date("1970-01-01T00:00:00Z"), max: new Date("9999-12-31T23:59:59Z"), noInvalidDate: true }).map((d) => d.toISOString()),
  fc.constantFrom("2026-09-16T10:00:00", "2026-09-16 10:00:00Z", "2026-09-16T10:00:00.1234567890Z", "", 5, null),
);
const hash = either(fc.constant("sha256:" + "ab".repeat(32)), fc.constantFrom("sha256:" + "AB".repeat(32), "sha256:abc", "md5:" + "0".repeat(32), 7));
const count = either(fc.nat(), fc.constantFrom(-1, 1.5, "12", null));
const bool = either(fc.boolean(), fc.constantFrom("true", 0, null));

const payload = either(
  fc.record({ value: json, truncated: bool, redacted: bool, bytes: count, hash }, { requiredKeys: [] }),
  wrongType,
);
const error = either(fc.record({ class: either(text, wrongType), message: either(text, wrongType), value: payload }, { requiredKeys: [] }), wrongType);

const host = fc.constantFrom("h", "example/mcp");
const hostLine = fc.record(
  {
    kind: fc.constant("host"),
    host: either(host, wrongKey),
    spec_version: either(fc.constantFrom("1.0", "1.1", "2.0", "10.25"), fc.constantFrom("1", "v1.0", "1.0.0", 1)),
    observes_crossings: either(fc.constantFrom("all", "some", "none"), fc.constantFrom("most", "ALL", 1)),
    unmediated_egress: bool,
    crossing_edge: either(fc.constantFrom("invocation", "dispatch"), fc.constantFrom("sideways", null)),
    attested: either(fc.array(fc.constantFrom("crossing.target", "crossing.input", "crossing.output", "crossing.error", "execution.error.class", "made.up")), fc.constantFrom("crossing.target", [1], [null])),
    ext: either(fc.dictionary(fc.string({ maxLength: 4 }), json, { maxKeys: 2 }), wrongType),
  },
  { requiredKeys: ["kind"] },
);

const executionEnd = either(
  fc.record(
    {
      time: timestamp,
      disposition: either(fc.constantFrom("completed", "failed", "terminated", "abandoned"), fc.constantFrom("success", "")),
      error,
      result: payload,
      outputs: either(fc.dictionary(fc.constantFrom("stdout", "stderr", "logs"), payload, { maxKeys: 2 }), wrongType),
    },
    { requiredKeys: [] },
  ),
  wrongType,
);
const executionLine = fc.record(
  {
    kind: fc.constant("execution"),
    host: either(host, wrongKey),
    id: either(fc.constantFrom("e1", "e2", "e3"), wrongKey),
    program: payload,
    start: timestamp,
    language: either(text, wrongType),
    context: either(fc.record({ session: either(fc.constantFrom("s1", "s2"), wrongType), traceparent: either(text, wrongType) }, { requiredKeys: [] }), wrongType),
    end: executionEnd,
    ext: either(fc.dictionary(fc.string({ maxLength: 4 }), json, { maxKeys: 2 }), wrongType),
  },
  { requiredKeys: ["kind"] },
);

const crossingEnd = either(
  fc.record(
    {
      time: timestamp,
      outcome: either(fc.constantFrom("output", "error", "abandoned"), fc.constantFrom("ok", 1)),
      output: payload,
      error,
    },
    { requiredKeys: [] },
  ),
  wrongType,
);
const crossingLine = fc.record(
  {
    kind: fc.constant("crossing"),
    host: either(host, wrongKey),
    id: either(fc.constantFrom("c1", "c2", "c3", "c4"), wrongKey),
    execution_id: either(fc.constantFrom("e1", "e2", "ghost"), wrongType),
    target: either(text, wrongType),
    input: payload,
    seq: count,
    start: timestamp,
    context: either(fc.record({ traceparent: either(text, wrongType) }, { requiredKeys: [] }), wrongType),
    end: crossingEnd,
    ext: either(fc.dictionary(fc.string({ maxLength: 4 }), json, { maxKeys: 2 }), wrongType),
  },
  { requiredKeys: ["kind"] },
);

/** A known-kind line as it arrives on the wire: through JSON text, so `undefined` is absent. */
const line = fc.oneof(hostLine, executionLine, crossingLine).map((l) => JSON.parse(JSON.stringify(l)) as Record<string, unknown>);

/** Lines of a stream, including ones that do not parse and kinds a 1.0 consumer does not know. */
const streamLine = fc.oneof(
  { weight: 8, arbitrary: line.map((l) => JSON.stringify(l)) },
  { weight: 1, arbitrary: fc.constantFrom("not json", "[1,2]", "null", '{"kind":"metric","host":"h"}', "") },
  {
    weight: 1,
    arbitrary: fc
      .record({ kind: fc.constantFrom("host", "execution", "crossing", "event"), host: json, id: json, execution_id: json, end: json, target: json, input: json, program: json }, { requiredKeys: ["kind"] })
      .map((l) => JSON.stringify({ ...l, host: foldable(l.host), id: foldable(l.id) })),
  },
);
const stream = fc.array(streamLine, { maxLength: 12 });

/* ------------------------------------------------------------------ */
/* Properties                                                          */
/* ------------------------------------------------------------------ */

test("structuralErrors is empty exactly when spec/schema accepts the line", () => {
  let accepted = 0;
  fc.assert(
    fc.property(line, (l) => {
      const errors = structuralErrors(l);
      const schema = schemaAccepts(l);
      if (schema) accepted++;
      assert.equal(errors.length === 0, schema, `structural ${JSON.stringify(errors)}, schema ${schema}, line ${JSON.stringify(l)}`);
    }),
    { numRuns: 3000 },
  );
  assert.ok(accepted > 150, `only ${accepted} generated lines were valid, too few to exercise acceptance`);
});

test("validate and view never write an unsafe character, whatever the stream carries", () => {
  fc.assert(
    fc.property(stream, (lines) => {
      const text = lines.join("\n");
      for (const out of [renderReport("s.jsonl", validateStream(text)), renderView(buildModel(text))]) {
        const hit = UNSAFE.exec(out.replace(/\n/g, ""));
        assert.equal(hit, null, hit === null ? "" : `U+${hit[0].charCodeAt(0).toString(16)} in ${JSON.stringify(out)}`);
      }
    }),
    RUNS,
  );
});

test("the model and the tree never throw on any JSON line, and the model keeps its invariants", () => {
  const anyLine = fc.oneof(
    streamLine,
    fc
      .dictionary(fc.constantFrom("kind", "host", "id", "execution_id", "target", "input", "program", "start", "end", "seq", "context", "ext", "language"), fc.oneof(json, unprintable))
      .map((o) => JSON.stringify({ kind: "crossing", ...o, host: foldable(o["host"]), id: foldable(o["id"]) })),
  );
  fc.assert(
    fc.property(fc.array(anyLine, { maxLength: 12 }), (lines) => {
      const model = buildModel(lines.join("\n"));
      renderView(model);
      JSON.stringify(model);
    }),
    RUNS,
  );
});

test("the tree is the same for any order of the lines", () => {
  const shuffled = stream.chain((lines) => fc.tuple(fc.constant(lines), fc.shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length })));
  fc.assert(
    fc.property(shuffled, ([a, b]) => {
      assert.equal(renderView(buildModel(b.join("\n"))), renderView(buildModel(a.join("\n"))));
    }),
    RUNS,
  );
});

test("the report's verdict, counts and warnings do not depend on line order", () => {
  const shuffled = stream.chain((lines) => fc.tuple(fc.constant(lines), fc.shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length })));
  fc.assert(
    fc.property(shuffled, ([a, b]) => {
      const ra = validateStream(a.join("\n"));
      const rb = validateStream(b.join("\n"));
      assert.equal(rb.lines, ra.lines);
      assert.equal(rb.skipped, ra.skipped);
      assert.equal(rb.failures.length, ra.failures.length);
      assert.deepEqual([...rb.warnings].sort(), [...ra.warnings].sort());
    }),
    RUNS,
  );
});
