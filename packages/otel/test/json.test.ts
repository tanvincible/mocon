/**
 * json.ts: the serialization otel-mapping.md 8.2 asks for. Compact, non-ASCII
 * unescaped, object keys in the order the text carried them, at any depth,
 * and otherwise identical to `JSON.stringify`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { keysOf, parse, stringify, type Parsed } from "../src/json.js";
import { objectTree, parseExact, render, tree, type Rec } from "./helpers.js";

const roundTrip = (text: string): string => {
  const parsed = parse(text) as Parsed;
  return stringify(parsed.value, parsed.order);
};

test("parse: undefined for text that is not JSON, the value for text that is", () => {
  for (const bad of ["", "{", "{oops", "[1,]", '{"a":1}}', "NaN", "'x'", '{"a":01}', '"\\x"', "\u2028"]) {
    assert.equal(parse(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parse('{"a":[1,"two",null,true]}'), { value: { a: [1, "two", null, true] }, order: undefined });
  assert.deepEqual(parse(" 7 "), { value: 7, order: undefined });
});

test("key order: a text without an array-index key needs no second parse; one with such a key keeps its order at every depth", () => {
  assert.equal(parse('{"b":1,"a":{"z":2,"y":3}}')?.order, undefined);
  assert.equal(roundTrip('{"b":1,"a":{"z":2,"y":3}}'), '{"b":1,"a":{"z":2,"y":3}}');
  const text = '{"b":1,"10":2,"a":{"z":[{"x":1,"2":2,"1":3}],"0":null},"9":"nine"}';
  const parsed = parse(text) as Parsed;
  assert.notEqual(parsed.order, undefined);
  assert.deepEqual(parsed.value, JSON.parse(text), "the same value JSON.parse builds");
  assert.equal(stringify(parsed.value, parsed.order), text);
  assert.deepEqual(keysOf(parsed.value as object, parsed.order), ["b", "10", "a", "9"]);
  assert.deepEqual(keysOf({ b: 1, 10: 2 }, undefined), ["10", "b"], "without an order, the engine's");
});

test("key order: an escaped digit key counts, and a digit key inside a string value is only text", () => {
  assert.equal(roundTrip('{"b":1,"\\u0031":2}'), '{"b":1,"1":2}');
  assert.equal(roundTrip('{"b":"{\\"12\\":1}","a":"\\"3\\":"}'), '{"b":"{\\"12\\":1}","a":"\\"3\\":"}');
  assert.equal(roundTrip('{"b":1,"a":"x","12":"y"}'), '{"b":1,"a":"x","12":"y"}');
  assert.equal(roundTrip('{"":1,"5":2,"":3}'), '{"":3,"5":2}', "an empty key is a key");
});

test("the second parse builds what JSON.parse builds: duplicates, __proto__, escapes, numbers, an int64 integer kept exact, and whitespace", () => {
  const cases = [
    '{"a":1,"3":2,"a":3}',
    '{"3":1,"__proto__":{"polluted":true},"constructor":{"prototype":1}}',
    ' { "3" : [ 1 , 2 ] ,\n\t"s" : "\\u00e9\\ud83d\\ude00\\ud800\\n\\"\\\\\\/" , "n" : [ -0 , 1E2 , 1.50 , 1e400 , -1e-400 , 9007199254740993 ] } ',
    '{"7":{"8":{"9":[[[{"10":{}}]]]}}}',
    '[{"1":true},{"2":false},{"3":null}]',
  ];
  for (const text of cases) {
    const parsed = parse(text) as Parsed;
    assert.notEqual(parsed.order, undefined, text);
    assert.deepEqual(parsed.value, parseExact(text), text);
  }
  const proto = (parse(cases[1] as string) as Parsed).value as Rec;
  assert.equal(Object.getPrototypeOf(proto), Object.prototype, "__proto__ is an own key, not the prototype");
  assert.deepEqual(Object.getOwnPropertyDescriptor(proto, "__proto__")?.value, { polluted: true });
  assert.equal(({} as Rec)["polluted"], undefined);
  assert.equal(roundTrip(cases[1] as string), '{"3":1,"__proto__":{"polluted":true},"constructor":{"prototype":1}}');
  assert.equal(roundTrip(cases[2] as string), '{"3":[1,2],"s":"é😀\\ud800\\n\\"\\\\/","n":[0,100,1.5,null,0,9007199254740993]}', "compact, non-ASCII unescaped, as JSON.stringify writes, an integer past 2^53 with its own digits");
});

test("nesting past the native stack: parsed and written in full, the same text JSON.stringify gives a shallower value", () => {
  const depth = 200_000;
  const arrays = "[".repeat(depth) + "]".repeat(depth);
  assert.throws(() => JSON.stringify(JSON.parse(arrays)), RangeError, "the native serializer cannot");
  assert.equal(roundTrip(arrays), arrays);
  const objects = '{"1":'.repeat(depth) + '"x"' + "}".repeat(depth);
  assert.equal(roundTrip(objects), objects);
  const mixed = '{"b":['.repeat(depth / 2) + "1" + "]}".repeat(depth / 2);
  assert.equal(roundTrip(mixed), mixed);
});

test("stringify through its loop writes what JSON.stringify writes, for any JSON value", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      assert.equal(stringify(value, new Map()), JSON.stringify(value), "an order map, even an empty one, takes the loop");
      assert.equal(stringify(value, undefined), JSON.stringify(value));
    }),
    { numRuns: 500 },
  );
});

test("the text a line carried, in its key order, comes back byte for byte for any value, numbers as JSON.stringify writes them", () => {
  fc.assert(
    fc.property(objectTree, (t) => {
      const parsed = parse(render(t)) as Parsed;
      assert.equal(stringify(parsed.value, parsed.order), render(t, true));
      assert.deepEqual([...keysOf(parsed.value as object, parsed.order)], t.entries.map((e) => e[0]));
    }),
    { numRuns: 500 },
  );
});

test("a text of any nesting and key order parses to the value JSON.parse builds, an int64 integer past 2^53 kept exact", () => {
  fc.assert(
    fc.property(tree, (t) => {
      const text = render(t);
      assert.deepEqual((parse(text) as Parsed).value, parseExact(text));
    }),
    { numRuns: 500 },
  );
});
