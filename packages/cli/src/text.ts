/**
 * Stream values as text for output. Every value here came from a line, so
 * nothing about its shape is trusted: `text` turns any JSON value into a
 * string without throwing, which neither `String` nor `JSON.stringify`
 * promises (a parsed object whose own `toString` is not a function makes
 * the first throw, and a value nested past the native stack the second).
 * `head` writes what a display can show of a value and reads no more of it
 * than that, whatever its shape; a whole view at any depth is written by
 * `stringifyDeep` from `@mocon/core/fold`. `safe` makes text fit for a
 * terminal. Every string in a stream is the choice of a program or a host,
 * and a crossing target is the program's under the default `instrument()`,
 * so each character that moves the cursor, starts an escape sequence,
 * breaks a line or reorders what the reader sees is written as a visible
 * escape instead: C0 controls and DEL, C1 controls, the line and paragraph
 * separators, and the bidirectional formatting marks.
 */

type Rec = Record<string, unknown>;

export const isRecord = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

/** A string as it is; any other JSON value as its JSON text, or as its type in brackets when it is nested too deep for that; `undefined` as `undefined`. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return bracket(value);
  }
}

/** A string as its JSON literal; anything else as `text` writes it. */
export function quoted(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : text(value);
}

/**
 * What `text` writes, cut to `limit` code units, by a walk that stops
 * there: each string is cut to the room left before it is escaped, and a
 * container is left as soon as the room runs out, so showing a value costs
 * what is shown of it and not what a program made it. The result runs a
 * little past `limit` — the escapes of the last string, the brackets an
 * unwound container closes — so that it is never mistaken for a whole one,
 * and its first `limit` units are the first `limit` of what `text` writes.
 *
 * A value nested deeper than `limit` has spent the whole width on brackets
 * and can show none of its content, so it reads as its type, as `text`
 * writes a value the native writer cannot write at all. A value that
 * refers to itself, which a parsed one cannot, stops at the width like any
 * other.
 *
 * The one step the limit does not bound is an object's own key list, which
 * the engine materializes before its first key can be read.
 */
export function head(value: unknown, limit: number): string {
  if (typeof value === "string") return clip(value, limit);
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return bracket(value);
    // As `text`: a value with no JSON text of its own is `String(value)`, never a throw.
    return scalar(value) ?? clip(String(value), limit);
  }
  let out = "";
  const frames: Frame[] = [];
  let v: unknown = value;
  for (;;) {
    if (v !== null && typeof v === "object") {
      if (frames.length >= limit) return bracket(value);
      const keys = Array.isArray(v) ? undefined : Object.keys(v);
      out += keys === undefined ? "[" : "{";
      frames.push({ node: v as Frame["node"], keys, next: 0, wrote: false });
    } else if (typeof v === "string") {
      const room = limit - out.length + 1;
      if (v.length > room) return out + JSON.stringify(clip(v, room));
      out += JSON.stringify(v);
    } else if (typeof v === "bigint") {
      return bracket(value);
    } else {
      // As `JSON.stringify`: an infinity, a NaN, and anything that serializes to nothing in an array, is `null`.
      out += scalar(v) ?? "null";
    }
    if (out.length > limit) return out;
    for (;;) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) return out;
      const { node, keys } = frame;
      if (keys === undefined) {
        const items = node as readonly unknown[];
        if (frame.next < items.length) {
          if (frame.next > 0) out += ",";
          v = items[frame.next++];
          break;
        }
        out += "]";
      } else {
        let found = false;
        while (frame.next < keys.length) {
          const key = keys[frame.next++] as string;
          const member = (node as Rec)[key];
          // As `JSON.stringify`: a member that serializes to nothing is left out, and so is its comma.
          if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
          if (frame.wrote) out += ",";
          const room = limit - out.length + 1;
          if (key.length > room) return out + JSON.stringify(clip(key, room));
          out += JSON.stringify(key) + ":";
          frame.wrote = true;
          v = member;
          found = true;
          break;
        }
        if (found) break;
        out += "}";
      }
      frames.pop();
    }
  }
}

interface Frame {
  node: Rec | readonly unknown[];
  /** `undefined` for an array. */
  keys: readonly string[] | undefined;
  next: number;
  /** A member of this object has been written, so the next one needs a comma. */
  wrote: boolean;
}

function bracket(value: unknown): string {
  return "[" + (Array.isArray(value) ? "array" : typeof value) + "]";
}

/** A value that is not a container, as `JSON.stringify` writes it; `undefined` for one that serializes to nothing. */
function scalar(v: unknown): string | undefined {
  switch (typeof v) {
    case "number":
      return Number.isFinite(v) ? String(v) : "null";
    case "boolean":
      return v ? "true" : "false";
    case "object":
      return "null";
    default:
      return undefined;
  }
}

/** The first `n` code units of `s`, never splitting a surrogate pair. */
function clip(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return s.slice(0, (s.charCodeAt(n - 1) & 0xfc00) === 0xd800 ? n + 1 : n);
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_IN_JSON = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `s` with every unsafe character written as `\xNN` or `\uNNNN`. */
export function safe(s: string): string {
  return s.replace(UNSAFE, escapeChar);
}

/**
 * JSON text with the unsafe characters `JSON.stringify` leaves raw written
 * as `\uNNNN`, the one escape JSON has for them, so the result is the same
 * JSON document and a terminal shows it as text. The C0 range is left
 * alone: `JSON.stringify` escapes it inside every string, so a C0
 * character in its output is the document's own whitespace.
 */
export function safeJson(s: string): string {
  return s.replace(UNSAFE_IN_JSON, unicodeEscape);
}

function escapeChar(c: string): string {
  const code = c.charCodeAt(0);
  return code < 0x100 ? "\\x" + code.toString(16).padStart(2, "0") : unicodeEscape(c);
}

function unicodeEscape(c: string): string {
  return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
}
