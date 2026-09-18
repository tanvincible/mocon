/**
 * Boundary checks on what the host hands a handle. Each throws before any state changes, so a rejected call leaves
 * the handle as it was. `targetOf` is the exception: a target names the call, so it is coerced, not refused.
 */

import { CLOSED } from "./closed.js";
import { quote } from "./serialize.js";
import { earlier, unixNanos } from "./time.js";
import type { Dimension, Ext, Link } from "./types.js";

export function checkString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`mocon: ${field} must be a string`);
  return value;
}

export function checkTimestamp(value: unknown, field: string): string {
  const text = checkString(value, field);
  if (unixNanos(text) === undefined) throw new RangeError(`mocon: ${field} must be an RFC 3339 UTC time that exists, with a Z suffix, got ${JSON.stringify(text)}`);
  return text;
}

/** A host-given `end.time`, refused when it names an instant before the record's `start` (core.md 7). */
export function checkEndTime(value: unknown, start: string): string {
  const time = checkTimestamp(value, "end.time");
  if (earlier(time, start)) throw new RangeError(`mocon: end.time ${time} is earlier than the record's start ${start}`);
  return time;
}

/** A seq below 2^53 - 1, so the automatic seq after it is still exact. */
export function checkSeq(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`mocon: seq must be a non-negative integer below 2^53 - 1, got ${String(value)}`);
  }
  return value;
}

/**
 * A crossing target from whatever named the call: the string itself, the text of any other primitive, and the
 * value's type in brackets for an object or a function. Never throws and never runs the value's own code: a program
 * reaches this call, and coercing an object it supplied would run its `toString`, which the host cannot bound — a
 * Proxy claiming a length of 1e8 parks `String()` in `Array.prototype.join` for a target the cap then discards.
 */
export function targetOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && (typeof value === "object" || typeof value === "function")) return "[" + typeof value + "]";
  return String(value);
}

export function checkExt(value: unknown, field: string): Ext | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`mocon: ${field} must be an object`);
  return value as Ext;
}

/**
 * The `dimensions` map of core.md 5.1.1: each entry read once and rebuilt from what was read, so a getter cannot
 * answer the closed-set check with a member and the line with anything. Two declarations contradict themselves
 * and are refused rather than written: a `unit` on a key declared `none`, which is not a quantity and has no
 * unit, and a `card` on a key declared `sum` or `last`, whose value is a measure and whose cardinality no
 * consumer reads. The reserved `mocon.` namespace (core.md 3) is not declarable.
 */
export function checkDimensions(value: unknown): Record<string, Dimension> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("mocon: dimensions must be an object");
  // No prototype: a declaration of the key `__proto__` is an own entry the line carries, not an assignment
  // to this object's prototype, which would drop the key from the wire without a word.
  const out = Object.create(null) as Record<string, Dimension>;
  for (const key of Object.keys(value)) {
    const at = `dimensions[${JSON.stringify(key)}]`;
    if (key.startsWith("mocon.")) throw new RangeError(`mocon: ${at} declares a reserved key; the "mocon." namespace belongs to the specification`);
    const entry: unknown = (value as Record<string, unknown>)[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`mocon: ${at} must be an object`);
    const { agg, unit, card, name, observed } = entry as Dimension;
    if (!CLOSED.agg.has(agg)) throw new RangeError(`mocon: ${at}.agg must be "sum", "last" or "none", got ${JSON.stringify(agg)}`);
    const d: Dimension = { agg };
    if (unit !== undefined) {
      if (agg === "none") throw new RangeError(`mocon: ${at} declares a unit under agg "none", which is not a quantity; declare it "sum" or "last", or drop the unit`);
      d.unit = checkString(unit, `${at}.unit`);
    }
    if (card !== undefined) {
      if (agg !== "none") throw new RangeError(`mocon: ${at} declares card under agg "${agg}", where the value is a measure and card is not read`);
      if (!CLOSED.card.has(card)) throw new RangeError(`mocon: ${at}.card must be "low" or "high", got ${JSON.stringify(card)}`);
      d.card = card;
    }
    if (name !== undefined) d.name = checkString(name, `${at}.name`);
    if (observed !== undefined) {
      if (typeof observed !== "boolean") throw new TypeError(`mocon: ${at}.observed must be a boolean`);
      d.observed = observed;
    }
    out[key] = d;
  }
  return out;
}

/**
 * `,"links":[...]` as wire text (extensions/links.md 2), or nothing for an empty or absent array. Each entry is
 * read once and written from the validated strings, in the order the extension's table gives. A link that names
 * the record carrying it is refused when the host minted that id itself; a minted id cannot be named.
 */
export function linksText(value: unknown, kind: Link["kind"], selfId: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("mocon: links must be an array");
  let body = "";
  for (const entry of [...(value as unknown[])]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("mocon: a link must be an object");
    const { rel, kind: named, id, counts, host, execution_id: executionId } = entry as Link;
    if (!CLOSED.rel.has(rel)) throw new RangeError(`mocon: unknown link rel ${JSON.stringify(rel)}`);
    if (!CLOSED.linked.has(named)) throw new RangeError(`mocon: a link names an "execution" or a "crossing", got ${JSON.stringify(named)}`);
    if (!CLOSED.counts.has(counts)) throw new RangeError(`mocon: link counts must be "additive" or "duplicate", got ${JSON.stringify(counts)}`);
    const namedId = checkString(id, "link id");
    const namedHost = host === undefined ? undefined : checkString(host, "link host");
    if (namedHost === undefined && named === kind && namedId === selfId) throw new RangeError(`mocon: a link must not name the record carrying it (${kind} ${namedId})`);
    let text = '{"rel":"' + rel + '","kind":"' + named + '","id":' + quote(namedId) + ',"counts":"' + counts + '"';
    if (namedHost !== undefined) text += ',"host":' + quote(namedHost);
    if (executionId !== undefined) text += ',"execution_id":' + quote(checkString(executionId, "link execution_id"));
    body += (body === "" ? "" : ",") + text + "}";
  }
  return body === "" ? undefined : ',"links":[' + body + "]";
}
