/**
 * JSON text in and out, for the value encoding of otel-mapping.md 8.2:
 * compact, non-ASCII unescaped, and object keys in the order the line
 * carried them, at any depth.
 *
 * `JSON.parse` and `JSON.stringify` do the work whenever they can. There
 * are three cases they cannot handle. The engine enumerates an array-index
 * key such as `"10"` before every other key, wherever it stood in the
 * text, and `JSON.parse` rounds an integer past 2^53 to a double, so a
 * line that holds such a key or such an integer is parsed a second time
 * here, recording each object's source key order and keeping every
 * integer within int64 exact as a bigint. And `JSON.stringify` recurses on
 * the native stack, so a value nested a few thousand levels deep is
 * written by `stringifyDeep` from `@mocon/core/fold`, which keeps its
 * stack on the heap and takes the key order from here.
 */

import { stringifyDeep } from "@mocon/core/fold";

type Rec = Record<string, unknown>;

/** The source key order of objects parsed from a line that holds an array-index key. */
export type KeyOrder = ReadonlyMap<object, readonly string[]>;

export interface Parsed {
  /** The value, with an integer past 2^53 but within int64 as a bigint. */
  value: unknown;
  /** Present when the text was parsed a second time, so `Object.keys` might not give the source order or a value may be a bigint. */
  order: KeyOrder | undefined;
}

// A key whose characters are all digits, literal or \u-escaped: the only keys the engine reorders. Anything else it matches costs a second parse, never a wrong order.
const INDEX_KEY = /"(?:[0-9]|\\u003[0-9])+"[ \t\n\r]*:/;
// An integer token of sixteen digits or more, which `JSON.parse` may round. Digits inside a string can match too, which costs a second parse, never a wrong value.
const LONG_INTEGER = /[0-9]{16}(?![.eE0-9])/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
// A string token and a number token of text already known to be JSON. The string pattern is the unrolled loop, which the regexp engine runs without a backtrack entry per character.
const STRING = /"[^"\\]*(?:\\.[^"\\]*)*"/y;
const NUMBER = /-?[0-9][-+.0-9eE]*/y;

/** The value of a JSON text, or `undefined` when the text is not JSON. */
export function parse(text: string): Parsed | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!INDEX_KEY.test(text) && !LONG_INTEGER.test(text)) return { value, order: undefined };
  const order = new Map<object, readonly string[]>();
  return { value: parseInOrder(text, order), order };
}

/** The keys of an object parsed by `parse`, in source order. */
export function keysOf(object: object, order: KeyOrder | undefined): readonly string[] {
  return order?.get(object) ?? Object.keys(object);
}

/**
 * The compact JSON text of a value `parse` returned, with the keys of
 * every object in source order. Identical to `JSON.stringify` for a value
 * whose key order that function reproduces, at any depth.
 */
export function stringify(value: unknown, order: KeyOrder | undefined): string {
  return order === undefined ? stringifyDeep(value) : stringifyDeep(value, (object) => keysOf(object, order));
}

interface Open {
  container: Rec | unknown[];
  /** The object's keys in source order; `undefined` for an array. */
  keys: string[] | undefined;
  /** The key the object's next value goes under; `undefined` while a key is expected. */
  key: string | undefined;
}

/** A second parse of text `JSON.parse` accepted, building the same value and recording each object's keys in source order. */
function parseInOrder(text: string, order: Map<object, readonly string[]>): unknown {
  let root: unknown;
  const open: Open[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    const top = open[open.length - 1];
    let value: unknown;
    switch (c) {
      case 0x20: // space
      case 0x09: // tab
      case 0x0a: // line feed
      case 0x0d: // carriage return
      case 0x2c: // ,
      case 0x3a: // :
        i++;
        continue;
      case 0x5d: // ]
      case 0x7d: // }
        // Only an object holding a digit key needs its order recorded: for any other, Object.keys already gives it.
        if (top?.keys !== undefined && top.keys.some(isDigits)) order.set(top.container, top.keys);
        open.pop();
        i++;
        continue;
      case 0x22: {
        STRING.lastIndex = i;
        STRING.test(text);
        const body = text.slice(i + 1, STRING.lastIndex - 1);
        value = body.includes("\\") ? JSON.parse(text.slice(i, STRING.lastIndex)) : body;
        i = STRING.lastIndex;
        if (top?.keys !== undefined && top.key === undefined) {
          top.key = value as string;
          continue;
        }
        break;
      }
      case 0x7b: // {
        value = {};
        i++;
        break;
      case 0x5b: // [
        value = [];
        i++;
        break;
      case 0x74: // true
        value = true;
        i += 4;
        break;
      case 0x66: // false
        value = false;
        i += 5;
        break;
      case 0x6e: // null
        value = null;
        i += 4;
        break;
      default: {
        NUMBER.lastIndex = i;
        NUMBER.test(text);
        const token = text.slice(i, NUMBER.lastIndex);
        value = Number(token);
        i = NUMBER.lastIndex;
        if (!Number.isSafeInteger(value) && /^-?[0-9]+$/.test(token)) {
          const exact = BigInt(token);
          if (exact >= INT64_MIN && exact <= INT64_MAX) value = exact;
        }
      }
    }
    if (top === undefined) root = value;
    else if (top.keys === undefined) (top.container as unknown[]).push(value);
    else {
      const object = top.container as Rec;
      const key = top.key as string;
      // As JSON.parse: the first position kept and the last value winning, and `__proto__` an own property rather than the prototype.
      if (!Object.hasOwn(object, key)) top.keys.push(key);
      if (key === "__proto__") Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
      else object[key] = value;
      top.key = undefined;
    }
    if (c === 0x7b) {
      open.push({ container: value as Rec, keys: [], key: undefined });
    } else if (c === 0x5b) {
      open.push({ container: value as unknown[], keys: undefined, key: undefined });
    }
  }
  return root;
}

const isDigits = (key: string): boolean => /^[0-9]+$/.test(key);
