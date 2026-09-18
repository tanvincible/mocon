/**
 * The cause rule shared by `ExecutionHandle.fail`, `CrossingHandle.error` and
 * `ErrorInput.cause` (types.ts). `cause` is what the host caught, often what
 * the program threw, so nothing here trusts it: every read is guarded, errors
 * are recognised by internal brand rather than `instanceof` or a tag the
 * program can set (an error from node:vm, an isolate or a worker is not an
 * instance of this realm's `Error`), and a cause chain is cut at a fixed
 * depth. Members are read lazily, as the bounded walker in `payload.ts`
 * writes them, so a getter past the slot's cap never runs.
 */

import { types } from "node:util";
import { checkString } from "./check.js";
import type { ErrorInput } from "./types.js";

/** Nested causes deeper than this are dropped from `value`. */
const MAX_CAUSE_DEPTH = 32;

function fromCause(cause: unknown, cls: string): ErrorInput {
  if (cause === null || cause === undefined) return { class: cls };
  try {
    if (typeof cause === "object" || typeof cause === "function") {
      if (types.isNativeError(cause)) {
        const message = text(read(cause, "message"));
        const value = plainError(cause, message, new Set([cause]), 0);
        return message === undefined ? { class: cls, value } : { class: cls, message, value };
      }
      const message = (cause as { message?: unknown }).message;
      return typeof message === "string" ? { class: cls, message, value: cause } : { class: cls, value: cause };
    }
    return { class: cls, message: String(cause) };
  } catch {
    // A getter or trap threw. The error slot's encoder guards whatever this is.
    return { class: cls, value: cause };
  }
}

/**
 * `class`, then `message` and `value` from `cause` under the rule above, a
 * `message` or `value` given beside the cause winning. Throws a TypeError for
 * a non-string `class` or `message`, before it reads the cause.
 */
export function errorInput(error: ErrorInput): ErrorInput {
  const cls = checkString(error.class, "error.class");
  const message = error.message === undefined ? undefined : checkString(error.message, "error.message");
  const { value, cause } = error;
  const out: ErrorInput = cause === undefined ? { class: cls } : fromCause(cause, cls);
  if (message !== undefined) out.message = message;
  if (value !== undefined) out.value = value;
  return out;
}

const OWN = new Set(["name", "message", "stack", "cause"]);

/**
 * A native error as `{ name, message, stack, ...own enumerable properties,
 * cause }`, absent and non-string fields omitted, a nested error converted
 * the same way, and a cycle or a chain past `MAX_CAUSE_DEPTH` cut. `name`,
 * `stack`, the key list and the cause chain are read when the object is made;
 * every other member is an accessor that reads the error once and holds it.
 */
function plainError(error: Error, message: string | undefined, seen: Set<object>, level: number): Record<string, unknown> {
  const nested = (e: Error): Record<string, unknown> | undefined => {
    if (seen.has(e) || level >= MAX_CAUSE_DEPTH) return undefined;
    seen.add(e);
    return plainError(e, text(read(e, "message")), seen, level + 1);
  };
  const out: Record<string, unknown> = {};
  const hold = (key: string, value: unknown): void => void Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  let own: string[];
  try {
    own = Object.keys(error).filter((key) => !OWN.has(key));
  } catch {
    own = [];
  }
  const name = text(read(error, "name"));
  if (name !== undefined) hold("name", name);
  if (message !== undefined) hold("message", message);
  const stack = text(read(error, "stack"));
  if (stack !== undefined) hold("stack", stack);
  for (const key of own) {
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        const v = read(error, key);
        const value = types.isNativeError(v) ? (nested(v) ?? v) : v;
        hold(key, value);
        return value;
      },
    });
  }
  const cause = read(error, "cause");
  if (types.isNativeError(cause)) {
    const value = nested(cause);
    if (value !== undefined) hold("cause", value);
  } else if (cause !== undefined) {
    hold("cause", cause);
  }
  return out;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function read(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
