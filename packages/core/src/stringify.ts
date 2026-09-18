/**
 * `JSON.stringify` for a value a consumer read out of a line, at any depth.
 * The value has already been parsed, so nothing runs a `toJSON` or a getter,
 * and the only question is how deep it goes.
 *
 * `JSON.stringify` recurses on the native stack and throws a RangeError a few
 * thousand levels down, while `JSON.parse` accepts far more, so a deeply
 * nested line parses and then cannot be written back. The loop below keeps
 * its stack on the heap. It is the fallback, not the rule.
 *
 * Two departures: a bigint, which is how an integer past 2^53 but within
 * int64 survives a second parse, is written as its digits; and object keys
 * come from the caller when it knows the order the line carried, which the
 * engine does not preserve for an array-index key. Both are the loop's, so
 * the native call is taken only when it returns text and a value cannot be
 * written one way with a key order and another way without.
 */

/** The keys of one object, in the order the caller wants them written. */
export type KeysOf = (object: object) => readonly string[];

/** `keysOf` orders every object's keys; without it, `Object.keys` order. */
export function stringifyDeep(value: unknown, keysOf?: KeysOf): string {
  if (keysOf === undefined) {
    try {
      const text = JSON.stringify(value);
      if (text !== undefined) return text;
    } catch (e) {
      // A RangeError is the native stack; a TypeError is a bigint, which the
      // loop writes, or a cycle, which it rejects the same way.
      if (!(e instanceof RangeError) && !(e instanceof TypeError)) throw e;
    }
  }
  return write(value, keysOf);
}

interface Frame {
  node: Record<string, unknown> | unknown[];
  /** `undefined` for an array. */
  keys: readonly string[] | undefined;
  next: number;
  /** A member has been written, so the next one needs a comma. */
  wrote: boolean;
}

function write(root: unknown, keysOf: KeysOf | undefined): string {
  let out = "";
  const frames: Frame[] = [];
  /**
   * The containers this value is inside, as `JSON.stringify` holds them: a
   * value that appears twice is written twice, one inside itself is an error.
   */
  const open = new Set<object>();
  let value = root;
  for (;;) {
    if (value !== null && typeof value === "object") {
      const node = value as Record<string, unknown> | unknown[];
      if (open.has(node)) throw new TypeError("Converting circular structure to JSON");
      open.add(node);
      const keys = Array.isArray(value) ? undefined : keysOf === undefined ? Object.keys(value) : keysOf(value);
      out += keys === undefined ? "[" : "{";
      frames.push({ node, keys, next: 0, wrote: false });
    } else if (typeof value === "string") {
      out += JSON.stringify(value);
    } else if (typeof value === "bigint") {
      out += String(value);
    } else {
      // As `JSON.stringify`: infinities, NaN and nothing-in-array are `null`.
      out += typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : "null";
    }
    for (;;) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) return out;
      const { node, keys } = frame;
      if (keys === undefined) {
        const items = node as unknown[];
        if (frame.next < items.length) {
          if (frame.next > 0) out += ",";
          value = items[frame.next++];
          break;
        }
        out += "]";
      } else {
        let next: unknown;
        let found = false;
        while (frame.next < keys.length) {
          const key = keys[frame.next++] as string;
          const v = (node as Record<string, unknown>)[key];
          // As `JSON.stringify`: skipped, and its comma with it.
          if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
          out += (frame.wrote ? "," : "") + JSON.stringify(key) + ":";
          frame.wrote = true;
          next = v;
          found = true;
          break;
        }
        if (found) {
          value = next;
          break;
        }
        out += "}";
      }
      open.delete(node);
      frames.pop();
    }
  }
}
