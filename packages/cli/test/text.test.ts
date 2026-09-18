import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { head, safe, text } from "../src/text.js";
import { UNSAFE } from "./helpers.js";

const ch = (code: number): string => String.fromCharCode(code);

test("text gives a string as it is and any other JSON value as JSON, and never throws", () => {
  assert.equal(text("e1"), "e1");
  assert.equal(text(42), "42");
  assert.equal(text(true), "true");
  assert.equal(text(null), "null");
  assert.equal(text(undefined), "undefined");
  assert.equal(text({ name: "t" }), '{"name":"t"}');
  assert.equal(text([1, "a"]), '[1,"a"]');
  const hostile = JSON.parse('{"toString":null,"valueOf":1}') as unknown;
  assert.throws(() => String(hostile), TypeError, "the premise: String throws on this parsed object");
  assert.equal(text(hostile), '{"toString":null,"valueOf":1}');
  assert.equal(text(JSON.parse('[{"toString":null}]')), '[{"toString":null}]');
});

test("printable text, non-Latin scripts and a literal backslash pass through unchanged", () => {
  for (const s of ["", "company_identify", "crm.update_contact #2", "héllo wörld", "日本語", "emoji 🙂", "a\\x1b literal backslash"]) {
    assert.equal(safe(s), s);
  }
});

test("C0 controls, DEL and C1 controls become \\xNN", () => {
  assert.equal(safe(ch(0x1b) + "[2K"), "\\x1b[2K");
  assert.equal(safe("a" + ch(0x00) + "b"), "a\\x00b");
  assert.equal(safe("line" + ch(0x0a) + "next" + ch(0x0d)), "line\\x0anext\\x0d");
  assert.equal(safe(ch(0x09)), "\\x09");
  assert.equal(safe(ch(0x07)), "\\x07");
  assert.equal(safe(ch(0x7f)), "\\x7f");
  assert.equal(safe(ch(0x9b) + "31m"), "\\x9b31m", "CSI as a single C1 byte");
  assert.equal(safe(ch(0x9d) + "0;title" + ch(0x9c)), "\\x9d0;title\\x9c", "OSC and ST as C1");
  assert.equal(safe(ch(0x80) + ch(0x9f)), "\\x80\\x9f");
});

test("line separators and bidirectional formatting marks become \\uNNNN", () => {
  assert.equal(safe("a" + ch(0x2028) + "b" + ch(0x2029)), "a\\u2028b\\u2029");
  assert.equal(safe(ch(0x202e) + "txt.exe"), "\\u202etxt.exe", "right-to-left override");
  for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.equal(safe(ch(code)), "\\u" + code.toString(16).padStart(4, "0"));
  }
});

test("the output of safe never holds an unsafe character, so applying it twice changes nothing more", () => {
  let all = "";
  for (let c = 0; c < 0x2100; c++) all += ch(c);
  const once = safe(all);
  assert.doesNotMatch(once, UNSAFE);
  assert.equal(safe(once), once);
});

/* ------------------------------------------------------------------ */
/* head: what a display reads of a value                               */
/* ------------------------------------------------------------------ */

const SCAN = 101;

test("head writes the first `limit` code units of what text writes, for any JSON value", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.integer({ min: 4, max: 40 }), (value, limit) => {
      const whole = text(value);
      const bounded = head(value, limit);
      assert.equal(bounded.slice(0, limit), whole.slice(0, limit), whole);
      if (whole.length <= limit) assert.equal(bounded, whole, "a value the limit does not reach is written whole");
      assert.ok(bounded.length <= 16 * limit + 32, `${bounded.length} units written for a limit of ${limit}`);
    }),
    { numRuns: 2000 },
  );
});

test("head writes what JSON.stringify writes: holes, the infinities, members that serialize to nothing, and the escapes", () => {
  const WIDE = 10_000;
  const sparse: unknown[] = [1];
  sparse[3] = 2;
  const escapes = { [ch(0) + '"\\']: "é😀" + ch(0xd800) };
  for (const v of [sparse, [NaN, Infinity, -0, 1e21], [undefined, () => 1, Symbol("s")], { a: undefined, b: () => 1, c: Symbol("s"), d: 1 }, { only: undefined }, escapes]) {
    assert.equal(head(v, WIDE), JSON.stringify(v), JSON.stringify(v));
  }
  assert.equal(head(1n, WIDE), "[bigint]", "as text: a value the native writer cannot write at all is its type");
  assert.equal(head([1n], WIDE), text([1n]));
  assert.equal(head(undefined, WIDE), text(undefined));
  assert.equal(head("a string is itself", WIDE), text("a string is itself"));
});

test("head reads no more of a value than the width shows, whatever its shape", () => {
  const long = "x".repeat(5_000_000);
  const rows = new Array(200_000).fill("a") as string[];
  const record = { "v.rows": rows, "v.note": long };
  for (const v of [long, rows, record, [record], { deep: record }]) {
    assert.equal(head(v, SCAN).slice(0, SCAN), text(v).slice(0, SCAN), "the width shows what the whole serialization would show");
    assert.ok(head(v, SCAN).length < 16 * SCAN, "a 5 MB value writes a prefix, never the whole of itself");
  }
  assert.equal(head({ ["k".repeat(5_000_000)]: 1 }, SCAN).length, SCAN + 3, "a key longer than the width is cut in it");
});

test("a value nested deeper than the width reads as its type, and one that is not all structure shows what the width holds", () => {
  const deep: unknown = JSON.parse("[".repeat(20_000) + "]".repeat(20_000));
  const shallow: unknown = JSON.parse("[".repeat(99) + "]".repeat(99));
  assert.equal(head(deep, SCAN), "[array]");
  assert.equal(head({ "v.deep": deep }, SCAN).slice(0, SCAN), '{"v.deep":' + "[".repeat(SCAN - 10), "the width holds the key, so the key is shown");
  assert.equal(head(shallow, SCAN), text(shallow), "a value the width can hold is written whole");
});

test("a value that refers to itself, which a parsed one cannot, stops at the width like any other", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const shown = head(cyclic, SCAN);
  assert.ok(shown.startsWith('{"self":{"self":'), shown);
  assert.ok(shown.length < 16 * SCAN, shown);
});
