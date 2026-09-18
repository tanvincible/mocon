/**
 * The JSON serialization this package uses for the lines it writes.
 *
 * It is `JSON.stringify` with no indentation:
 *
 * - compact separators, no whitespace;
 * - object keys in the order JavaScript enumerates them: integer-like
 *   keys first in numeric order, then the rest in insertion order;
 * - strings escaped the way `JSON.stringify` escapes them: `"`, `\`,
 *   control characters and lone surrogates, nothing else, so non-ASCII
 *   text travels as UTF-8 and not as `\u` escapes;
 * - numbers formatted as JavaScript formats them, with `NaN` and the
 *   infinities written as `null`;
 * - `toJSON` honoured; `undefined`, functions and symbols written as
 *   `null` at the top level and inside arrays, and omitted inside
 *   objects.
 *
 * Payload values follow the same rule through the bounded walker in
 * `payload.ts`, with the departures listed there: binary anywhere is a
 * base64 string, and a value nested deeper than the walker's depth limit,
 * or a string far past the cap, is cut. `program` is the one slot whose
 * serialization is the UTF-8 text itself (core.md 5.4).
 *
 * The conformance fixtures under spec/conformance were produced this way:
 * hashing `{"name":"Acme Robotics","id":8842}` in that key order gives
 * the `hash` the sync-bridge stream carries for that output. The hashes
 * test in this package pins the rule to those fixtures.
 *
 * A line is written by concatenation: a fixed envelope around Payload
 * text the encoder already produced, so a payload is serialized once.
 */

import type { Ext, JsonValue } from "./types.js";

/** A JSON string literal: `JSON.stringify(s)`, with a fast path for the short strings that need no escaping. */
export function quote(s: string): string {
  const n = s.length;
  if (n > 32) return JSON.stringify(s);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x22 || c === 0x5c || (c & 0xf800) === 0xd800) return JSON.stringify(s);
  }
  return '"' + s + '"';
}

/** A JSON string literal for text known to need no escaping: a minted id, a validated timestamp. */
export function raw(s: string): string {
  return '"' + s + '"';
}

/** What replaces an `ext` the serialization rejects: a cycle, a BigInt, a throwing `toJSON`, or anything that yields no object. */
export const EXT_REDACTED = '{"mocon.ext":{"redacted":true}}';

/**
 * The JSON text of `value` when it serializes to an object; `undefined`
 * when it serializes to nothing; `null` when it serializes to anything
 * else or the serialization throws.
 */
export function objectJson(value: unknown): string | undefined | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined) return undefined;
  return text.charCodeAt(0) === 123 ? text : null;
}

/**
 * The JSON text of an `ext`, read once when the host hands it over, so a
 * later change to the host's object, or a getter or `toJSON` inside it,
 * cannot reach a record. Total: an `ext` that cannot be serialized, or
 * serializes to something other than an object, is replaced by a
 * `mocon.ext` note; one that serializes to nothing is absent.
 */
export function extJson(ext: unknown): string | undefined {
  if (ext === undefined) return undefined;
  const text = objectJson(ext);
  return text === null ? EXT_REDACTED : text;
}

/** `,"ext":{...}` or nothing, for JSON text from `extJson` or `mergeExt`. */
export function extText(json: string | undefined): string {
  return json === undefined ? "" : ',"ext":' + json;
}

/** The library's own notes, keyed by their `mocon.*` key: `{ "mocon.encoding": { input: "base64" } }`. */
export type Notes = Record<string, Record<string, JsonValue>>;

/** `notes` with `note` merged into its key, creating either as needed. */
export function note(notes: Notes | undefined, key: string, field: string, value: JsonValue): Notes {
  const out: Notes = notes ?? {};
  (out[key] ??= {})[field] = value;
  return out;
}

/**
 * `base` with `over` merged in key by key, the key in `over` winning, and
 * each note merged into its own key the same way. `base` and `over` are
 * JSON text from `extJson`, so nothing here runs host or program code.
 */
export function mergeExt(base: string | undefined, over: string | undefined, notes?: Notes): string | undefined {
  if (notes === undefined) {
    if (over === undefined) return base;
    if (base === undefined) return over;
  }
  const ext: Record<string, JsonValue> = { ...parseExt(base), ...parseExt(over) };
  if (notes !== undefined) {
    for (const key of Object.keys(notes)) {
      const held = ext[key];
      const added = notes[key] as Record<string, JsonValue>;
      ext[key] = held !== null && typeof held === "object" && !Array.isArray(held) ? { ...held, ...added } : added;
    }
  }
  return JSON.stringify(ext);
}

function parseExt(json: string | undefined): Ext | undefined {
  return json === undefined ? undefined : (JSON.parse(json) as Ext);
}

/** `JSON.parse(text)` with every object and array in the result frozen: the Payload `ctx.capture` hands a rule. */
export function parseFrozen<T>(text: string): T {
  const root: unknown = JSON.parse(text);
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v !== null && typeof v === "object") {
      Object.freeze(v);
      for (const key of Object.keys(v)) stack.push((v as Record<string, unknown>)[key]);
    }
  }
  return root as T;
}
