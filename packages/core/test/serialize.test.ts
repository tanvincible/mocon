/**
 * The small serialization and boundary helpers on their own: `quote`, `raw`,
 * `extJson`, `extText`, `mergeExt`, `note`, `parseFrozen`, the checks in
 * check.ts, and `canonical`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fc from "fast-check";
import { canonical } from "../src/canonical.js";
import { checkExt, checkSeq, checkString, checkTimestamp } from "../src/check.js";
import { extJson, extText, mergeExt, note, parseFrozen, quote, raw } from "../src/serialize.js";

const EXT_REDACTED = '{"mocon.ext":{"redacted":true}}';

test("quote is JSON.stringify on either side of its fast path, and raw does not escape", () => {
  for (const s of ["", "plain", 'a"b\n', "back\\slash", "\u0001", "\ud800", "é😀", "x".repeat(32), "x".repeat(33) + '"']) assert.equal(quote(s), JSON.stringify(s));
  assert.equal(raw("2026-09-17T09:00:00.000Z"), '"2026-09-17T09:00:00.000Z"');
});

test("extJson reads an ext once and is total: nothing, an object, or the redaction marker for what cannot be serialized", () => {
  assert.equal(extJson(undefined), undefined);
  assert.equal(extJson({ "v.k": 1 }), '{"v.k":1}');
  assert.equal(extJson({ "v.n": 1n } as never), EXT_REDACTED);
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(extJson({ "v.c": cyclic } as never), '{"mocon.ext":{"redacted":true}}');
  assert.equal(extJson({ toJSON: () => undefined } as never), undefined, "an ext that serializes to nothing is absent");
  assert.equal(extJson({ toJSON: () => [1] } as never), '{"mocon.ext":{"redacted":true}}', "an ext that serializes to something other than an object is redacted");
  let reads = 0;
  const live = {
    get "v.g"() {
      return ++reads;
    },
  };
  const json = extJson(live as never);
  assert.equal(json, '{"v.g":1}');
  assert.equal(reads, 1, "the getter ran once, when the ext was handed over");
  assert.equal(extText(undefined), "");
  assert.equal(extText(json), ',"ext":{"v.g":1}');
});

test("mergeExt merges key by key, the later key winning, and merges each note into its own key", () => {
  const base = '{"v.a":1,"v.b":1}';
  assert.equal(mergeExt(undefined, undefined), undefined);
  assert.equal(mergeExt(base, undefined), base, "nothing to merge returns the same text");
  assert.equal(mergeExt(undefined, base), base);
  assert.deepEqual(JSON.parse(mergeExt(base, '{"v.b":2,"v.c":3}') as string), { "v.a": 1, "v.b": 2, "v.c": 3 });
  assert.deepEqual(JSON.parse(mergeExt(undefined, undefined, { "mocon.encoding": { input: "base64" } }) as string), { "mocon.encoding": { input: "base64" } });
  const held = '{"mocon.encoding":{"input":"base64"},"v.k":1}';
  assert.deepEqual(JSON.parse(mergeExt(held, undefined, { "mocon.encoding": { output: "base64" } }) as string), { "mocon.encoding": { input: "base64", output: "base64" }, "v.k": 1 });
  assert.deepEqual(JSON.parse(mergeExt('{"mocon.encoding":"odd"}', undefined, { "mocon.encoding": { output: "base64" } }) as string), { "mocon.encoding": { output: "base64" } });
  assert.deepEqual(Object.keys(JSON.parse(mergeExt('{"__proto__":{"x":1}}', '{"v.k":1}') as string) as object), ["__proto__", "v.k"], "a __proto__ key stays an own key");
  assert.deepEqual(note(note(undefined, "mocon.encoding", "input", "base64"), "mocon.encoding", "output", "base64"), { "mocon.encoding": { input: "base64", output: "base64" } });
});

test("parseFrozen freezes every object and array of the parsed value", () => {
  const v = parseFrozen<{ a: { b: number[] }; c: null }>('{"a":{"b":[1,{"d":2}]},"c":null}');
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.a) && Object.isFrozen(v.a.b) && Object.isFrozen(v.a.b[1]));
  assert.equal(parseFrozen("3"), 3);
});

test("the boundary checks reject the wrong type before anything else happens", () => {
  assert.equal(checkString("x", "f"), "x");
  assert.throws(() => checkString(1, "f"), TypeError);
  assert.equal(checkTimestamp("2026-09-17T09:00:00Z", "f"), "2026-09-17T09:00:00Z");
  assert.equal(checkTimestamp("2026-09-17T09:00:00.123456789Z", "f"), "2026-09-17T09:00:00.123456789Z");
  assert.equal(checkTimestamp("2024-02-29T23:59:60Z", "f"), "2024-02-29T23:59:60Z", "a leap day and a leap second exist");
  for (const bad of ["2026-09-17T09:00:00", "2026-09-17T09:00:00.1234567890Z", "2026-09-17 09:00:00Z", "", "2026-02-29T00:00:00Z", "2026-00-01T00:00:00Z"]) assert.throws(() => checkTimestamp(bad, "f"), RangeError, bad);
  assert.throws(() => checkTimestamp(12, "f"), TypeError);
  assert.equal(checkSeq(0), 0);
  assert.equal(checkSeq(42), 42);
  assert.equal(checkSeq(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER - 1);
  for (const bad of [-1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER, 2 ** 53]) assert.throws(() => checkSeq(bad), RangeError, String(bad));
  assert.equal(checkExt(undefined, "f"), undefined);
  assert.deepEqual(checkExt({ "v.k": 1 }, "f"), { "v.k": 1 });
  for (const bad of [null, [], "x", 1]) assert.throws(() => checkExt(bad, "f"), TypeError, String(bad));
});

test("canonical sorts keys at every depth by code point, keeps array order, keeps the last of a repeated key, and is never written to the wire", () => {
  assert.equal(canonical('{"b":[{"d":1,"c":2}],"a":null}'), '{"a":null,"b":[{"c":2,"d":1}]}');
  assert.equal(canonical(' [3, "x", true, false, null] '), '[3,"x",true,false,null]');
  assert.equal(canonical('"s"'), '"s"');
  assert.equal(canonical("{}"), "{}");
  assert.equal(canonical('{"a":1,"a":2}'), '{"a":2}');
  assert.equal(canonical('{"b":1,"a":2,"end":3}', new Set(["end", "b"])), '{"a":2}');
  assert.equal(canonical('{"x":{"end":1}}', new Set(["end"])), '{"x":{"end":1}}', "omit applies to the top level only");
  assert.equal(canonical('{"\\uffff":1,"\\ud83d\\ude00":2}'), '{"\\uffff":1,"\\ud83d\\ude00":2}', "a supplementary character sorts after U+FFFF");
  assert.equal(canonical('"é\\u0001\\u007f\\n\\"\\\\/"'), '"\\u00e9\\u0001\\u007f\\n\\"\\\\/"');
  assert.equal(canonical("[1, 1.0, -0, -0.0, 1e2, 12345678901234567890, 1e16, 1e-5, 0.0001, 1.5e300, 1e400]"), "[1,1.0,0,-0.0,100.0,12345678901234567890,1e+16,1e-05,0.0001,1.5e+300,Infinity]");
  const deep = '{"k":'.repeat(100_000) + "1" + "}".repeat(100_000);
  assert.equal(canonical(deep).length, deep.length);
});

const python = spawnSync("python3", ["--version"]).status === 0;

test("canonical agrees with check.py's json.dumps(sort_keys=True) on generated lines", { skip: !python }, () => {
  const texts = fc.sample(
    fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.stringify(v)),
    { numRuns: 400, seed: 7 },
  );
  texts.push("[1.0, 2.50, 1e21, 1E-7, -0.0, 123456789012345678901234567890, 0.1, 100.0, 1e15, 9999999999999998.0]", '{"\\ud800":1,"\\udfff":2,"\\ue000":3,"a\\u0000":4}');
  const script = "import sys, json\nfor line in sys.stdin.read().split('\\n'):\n    print(json.dumps(json.loads(line), sort_keys=True, separators=(',', ':')))";
  const run = spawnSync("python3", ["-c", script], { input: texts.join("\n"), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const expected = run.stdout.split("\n");
  texts.forEach((text, i) => assert.equal(canonical(text), expected[i], text));
});
