/**
 * Boundary checks on what the host hands a handle. Each throws before any
 * state changes, so a rejected call leaves the handle as it was.
 * `targetOf` is the one exception: a target names the call, so it is
 * coerced rather than refused.
 */

import { earlier, unixNanos } from "./time.js";
import type { Ext } from "./types.js";

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
 * A crossing target from whatever named the call: the string itself, or
 * `String(value)`, or the value's type when `String` throws, since a
 * program can reach that call. Never throws: the wrapper that derives a
 * target still has a bridge to reach.
 */
export function targetOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[" + typeof value + "]";
  }
}

export function checkExt(value: unknown, field: string): Ext | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`mocon: ${field} must be an object`);
  return value as Ext;
}
