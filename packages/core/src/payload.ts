/**
 * Payloads (core.md 5.4): one encoder that produces `value`, `truncated`,
 * `redacted`, `bytes` and `hash` as wire text, and the capture policy that
 * decides which rule a slot uses.
 *
 * The encoder reads a value once. A bounded walker serializes it under
 * `serialize.ts`'s rule and stops once its output passes the slot's cap,
 * so every property, getter and `toJSON` of a program-controlled value
 * runs at most once, and a 5 MB result costs O(cap). The bytes the walker
 * wrote are the bytes that are hashed, measured and cut, so `bytes`,
 * `hash` and a truncated `value` agree by construction. `bytes` and `hash`
 * are written only when the walker read the whole value; they describe the
 * full serialization, never the prefix. `program` is the one exception:
 * its text is hashed in full even when `value` is cut, because core.md 5.2
 * wants `program.hash` and `program.bytes` always present.
 *
 * A cap bounds what `value` adds to a line, in UTF-8 bytes as written: a
 * cut value is a JSON string, and its prefix is chosen so that the string,
 * escapes and quotes included, fits the cap.
 *
 * The walker departs from `JSON.stringify` in three ways: binary anywhere
 * is a base64 string; a value nested deeper than `MAX_DEPTH` is cut there,
 * so a ref can always be serialized again; and a string far longer than
 * the cap is not read at all, because its first character read would
 * flatten a rope the program built for free. `hash-only` reads a value in
 * full, but no further than `WHOLE_LIMIT` bytes of serialization.
 *
 * Every capture returns wire text, so a line splices it in instead of
 * serializing a Payload object.
 */

import { types } from "node:util";
import { sha256 } from "./hash.js";
import { invariant, InvariantError } from "./invariants.js";
import { parseFrozen, quote } from "./serialize.js";
import type { CaptureContext, CapturePolicy, CaptureRule, CaptureSlot, ErrorInput, Payload } from "./types.js";

type CapKey = CaptureSlot | "crossing.target";

export const DEFAULT_CAPS: Readonly<Record<CapKey, number>> = {
  program: 768 << 10,
  result: 1 << 16,
  outputs: 1 << 16,
  error: 1 << 14,
  "crossing.target": 1 << 12,
  "crossing.input": 1 << 14,
  "crossing.output": 1 << 16,
  "crossing.error": 1 << 14,
};

/**
 * The bytes the payloads of one complete execution line share with its
 * head: 1 MiB, the size core.md 3 asks lines to stay under, less room for
 * the envelope the library writes around them.
 */
export const LINE_BUDGET = (1 << 20) - (1 << 12);

/** Containers open at once. `JSON.stringify` and most JSON parsers recurse, and a ref's value has to survive both. */
const MAX_DEPTH = 256;

/** A string longer than this many times the cap is not read: reading one character of a rope flattens all of it. */
const READ_FACTOR = 64;

/** `hash-only` reads a value in full up to this many bytes of serialization, and redacts the slot past it. */
const WHOLE_LIMIT = 8 << 20;

/** The largest scratch buffer an encoder keeps; a larger cap encodes into a fresh buffer. */
const SCRATCH_MAX = 4 << 20;

const HASH = /^sha256:[0-9a-f]{64}$/;

/* The intrinsics a capture reads through, taken at load so nothing a program later defines on a value or a prototype stands in for them. */

const objectProto = Object.prototype;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const { getPrototypeOf } = Object;
const { isArray } = Array;
const { isView } = ArrayBuffer;
const { isAnyArrayBuffer, isSharedArrayBuffer, isTypedArray, isBoxedPrimitive, isNumberObject, isStringObject, isBooleanObject, isBigIntObject } = types;
const isRawJSON = (JSON as { isRawJSON?: (v: unknown) => boolean }).isRawJSON;
const booleanValue = Boolean.prototype.valueOf;

type Getter = (this: unknown) => unknown;
const getter = (proto: object, key: string): Getter => (Object.getOwnPropertyDescriptor(proto, key) as PropertyDescriptor).get as Getter;
const typedArrayProto = getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = getter(typedArrayProto, "buffer");
const typedArrayOffset = getter(typedArrayProto, "byteOffset");
const typedArrayLength = getter(typedArrayProto, "byteLength");
const dataViewBuffer = getter(DataView.prototype, "buffer");
const dataViewOffset = getter(DataView.prototype, "byteOffset");
const dataViewLength = getter(DataView.prototype, "byteLength");
const arrayBufferLength = getter(ArrayBuffer.prototype, "byteLength");
const sharedArrayBufferLength = getter(SharedArrayBuffer.prototype, "byteLength");

/** What `resolve` hands the walker for a value it writes its own way. One base class, so a plain object costs one check. */
abstract class Marker {}

/** Binary as its internal slots: the buffer, offset and length a program cannot redefine. */
class Binary extends Marker {
  constructor(
    readonly buffer: ArrayBufferLike,
    readonly offset: number,
    readonly length: number,
  ) {
    super();
  }

  view(length: number): Uint8Array {
    return new Uint8Array(this.buffer, this.offset, length);
  }

  base64(length: number): string {
    return Buffer.from(this.view(length)).toString("base64");
  }
}

/** A `JSON.rawJSON` value: its text is spliced in as `JSON.stringify` splices it. */
class Raw extends Marker {
  constructor(readonly text: string) {
    super();
  }
}

/** An object whose prototype is neither `Object.prototype` nor `null`: its members come from its own key list, never from a loop that would enumerate its prototypes too. */
class Keyed extends Marker {
  constructor(readonly object: object) {
    super();
  }
}

/** `v` itself, or `v` marked as `Keyed` when it is an object. */
function keyed(v: unknown): unknown {
  return v !== null && typeof v === "object" ? new Keyed(v) : v;
}

/** An `ArrayBuffer`, `SharedArrayBuffer` or view from any realm, by brand; `undefined` for anything else, whatever its tag says. */
function binaryOf(v: object): Binary | undefined {
  if (isView(v)) {
    return isTypedArray(v)
      ? new Binary(typedArrayBuffer.call(v) as ArrayBufferLike, typedArrayOffset.call(v) as number, typedArrayLength.call(v) as number)
      : new Binary(dataViewBuffer.call(v) as ArrayBufferLike, dataViewOffset.call(v) as number, dataViewLength.call(v) as number);
  }
  if (isSharedArrayBuffer(v)) return new Binary(v, 0, sharedArrayBufferLength.call(v) as number);
  if (isAnyArrayBuffer(v)) return new Binary(v, 0, arrayBufferLength.call(v) as number);
  return undefined;
}

/** A plain object or array: nothing to unbox, nothing binary, nothing raw. */
function isPlain(v: object): boolean {
  if (isArray(v)) return true;
  const proto: unknown = getPrototypeOf(v);
  return proto === objectProto || (proto === null && !(isRawJSON !== undefined && isRawJSON(v)));
}

/** What the walker writes without walking it: binary, or raw JSON text. `undefined` for an ordinary object. */
function marker(v: object): Binary | Raw | undefined {
  if (isRawJSON !== undefined && isRawJSON(v)) return new Raw((v as { rawJSON: string }).rawJSON);
  return binaryOf(v);
}

/**
 * Steps 2 and 4 of SerializeJSONProperty for an object, a function or a
 * BigInt: `toJSON`, then unboxing by internal slot, as `JSON.stringify`
 * does, so an own `valueOf` runs and a `Symbol.toStringTag` is never read.
 * Binary is caught before `toJSON`, so a Buffer's own `toJSON` never builds
 * its full number array.
 */
function resolve(v: object | bigint, key: string | number): unknown {
  const plain = typeof v !== "object" || isPlain(v);
  if (!plain) {
    const m = marker(v as object);
    if (m !== undefined) return m;
  }
  const toJSON = (v as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    const out: unknown = toJSON.call(v, typeof key === "number" ? String(key) : key);
    if (out === null || typeof out !== "object" || isPlain(out)) return out;
    return marker(out) ?? keyed(unbox(out));
  }
  return plain ? v : keyed(unbox(v as object));
}

function unbox(v: object): unknown {
  if (!isBoxedPrimitive(v)) return v;
  if (isNumberObject(v)) return +(v as unknown as number);
  if (isStringObject(v)) return String(v);
  if (isBooleanObject(v)) return booleanValue.call(v);
  if (isBigIntObject(v)) throw bigintError();
  return v;
}

/** A value as read from its holder, resolved when it is an object, a function or a BigInt. */
function settle(v: unknown, key: string | number): unknown {
  return typeof v === "object" ? (v === null ? v : resolve(v, key)) : typeof v === "function" || typeof v === "bigint" ? resolve(v as object | bigint, key) : v;
}

function bigintError(): TypeError {
  return new TypeError("Do not know how to serialize a BigInt");
}

function circularError(): TypeError {
  return new TypeError("Converting circular structure to JSON");
}

/** `n`, or `n + 1` when the unit before `n` is a high surrogate, so a cut never splits a pair. */
function cutAt(s: string, n: number): number {
  return n > 0 && (s.charCodeAt(n - 1) & 0xfc00) === 0xd800 ? n + 1 : n;
}

interface Walk {
  /** Holds the serialization's UTF-8 bytes up to `size`: whole, or cut once they passed the limit, possibly a few bytes past a prefix. */
  buffer: Buffer;
  size: number;
  complete: boolean;
  /** Binary was written as a base64 string somewhere in the value. */
  binary: boolean;
}

/** Containers this shallow are checked for a cycle by scanning the open ones; deeper ones go in a set. */
const SCAN_DEPTH = 32;

/** Room a walk keeps past its last check: closing brackets as a deep value unwinds, and separators. More than `MAX_DEPTH`. */
const SLACK = 512;

/**
 * Serializes a resolved value the way `JSON.stringify` does, with the
 * departures listed at the top of this file, as UTF-8 written straight
 * into `buffer`, which grows when a value needs it, and stops once more
 * than `limit` bytes are written. Each string is sliced to the remaining
 * budget before it is escaped, and one longer than `readBound` past the
 * budget is not read at all; escaped text is written no further than a
 * few bytes past the limit. Every node visited adds at least one byte,
 * except an object member that serializes to nothing, and those are
 * counted against the limit too, so the work past a container's own key
 * list is bounded by the limit.
 * The key list is the one residual O(own keys) step, paid once per object
 * the walk opens: V8 materializes every key of a dictionary-mode object,
 * and a Proxy's whole `ownKeys` result, before the first one can be read.
 * An object's members are read in a `for...in` loop, which V8 turns into
 * direct field loads for an object of known shape, so a Proxy's
 * descriptor and `has` traps may run more than once per key; its `get`
 * trap runs once per key the walk reads. The walk recurses, one frame per
 * open container, which `MAX_DEPTH` bounds.
 */
function walk(root: unknown, limit: number, readBound: number, buffer: Buffer): Walk {
  const walker = new Walker(limit, readBound, buffer);
  const size = walker.value(0, root, 0);
  return { buffer: walker.buffer, size, complete: !walker.stopped, binary: walker.binary };
}

class Walker {
  stopped = false;
  binary = false;
  private readonly open: object[] = [];
  private deep: Set<object> | undefined;
  /** Object members read that serialized to nothing, and so wrote no byte. */
  private empty = 0;

  constructor(
    private readonly limit: number,
    private readonly readBound: number,
    public buffer: Buffer,
  ) {}

  /** Writes a resolved value at `at` and returns where it ends. */
  value(at: number, v: unknown, depth: number): number {
    switch (typeof v) {
      case "string":
        return this.string(at, v);
      case "number":
        return this.number(at, v);
      case "boolean":
        return this.ascii(at, v ? "true" : "false");
      case "bigint":
        throw bigintError();
      case "object":
        return v === null ? this.ascii(at, "null") : this.object(at, v, depth);
      default:
        return this.ascii(at, "null");
    }
  }

  private string(at: number, s: string): number {
    const room = this.limit - at + 1;
    if (s.length <= room) return this.quoted(at, s);
    this.stopped = true;
    return s.length > this.readBound ? at : this.quoted(at, s.slice(0, cutAt(s, room)));
  }

  private object(at: number, v: object, depth: number): number {
    if (!(v instanceof Marker)) return this.container(at, v, true, depth);
    if (v instanceof Keyed) return this.container(at, v.object, false, depth);
    if (v instanceof Binary) {
      this.binary = true;
      const keep = Math.ceil((this.limit - at + 1) / 4) * 3;
      if (v.length > keep) this.stopped = true;
      return this.text(at, '"' + v.base64(v.length > keep ? keep : v.length) + (v.length > keep ? "" : '"'));
    }
    const raw = (v as Raw).text;
    const room = this.limit - at + 1;
    if (raw.length <= room) return this.text(at, raw);
    this.stopped = true;
    return this.text(at, raw.slice(0, cutAt(raw, room)));
  }

  /** An array, or an object read by `for...in` when `plain` and by its own key list otherwise. */
  private container(at: number, v: object, plain: boolean, depth: number): number {
    if (depth === MAX_DEPTH) {
      this.stopped = true;
      return at;
    }
    const open = this.open;
    for (let d = 0; d < depth && d < SCAN_DEPTH; d++) if (open[d] === v) throw circularError();
    if (depth >= SCAN_DEPTH) {
      this.deep ??= new Set();
      if (this.deep.has(v)) throw circularError();
      this.deep.add(v);
    }
    open[depth] = v;
    at = isArray(v) ? this.items(at, v, depth) : this.members(at, v as Record<string, unknown>, plain, depth);
    if (depth >= SCAN_DEPTH) this.deep?.delete(v);
    return at;
  }

  private items(at: number, a: readonly unknown[], depth: number): number {
    const limit = this.limit;
    const length = a.length;
    this.buffer[at++] = 0x5b;
    for (let i = 0; i < length; i++) {
      if (at > limit) {
        this.stopped = true;
        return at;
      }
      this.reserve(at, 1);
      if (i > 0) this.buffer[at++] = 0x2c;
      let v = a[i];
      if (typeof v === "object" ? v !== null : typeof v === "function" || typeof v === "bigint") v = resolve(v as object | bigint, i);
      at = this.value(at, v, depth + 1);
      if (this.stopped) return at;
    }
    this.buffer[at++] = 0x5d;
    return at;
  }

  /**
   * A plain object, whose prototype is `Object.prototype` or `null`,
   * inherits nothing a `for...in` loop would visit past its own keys, and
   * V8 reads its members in that loop as direct field loads; any other
   * object's members come from its own key list, so a prototype with many
   * enumerable keys costs nothing.
   */
  private members(at: number, o: Record<string, unknown>, plain: boolean, depth: number): number {
    this.buffer[at++] = 0x7b;
    const start = at;
    if (plain) {
      for (const key in o) {
        if (!hasOwnProperty.call(o, key)) continue;
        at = this.member(at, o, key, at === start, depth);
        if (this.stopped) return at;
      }
    } else {
      for (const key of Object.keys(o)) {
        at = this.member(at, o, key, at === start, depth);
        if (this.stopped) return at;
      }
    }
    this.buffer[at++] = 0x7d;
    return at;
  }

  /** One member, read only while the limit is not passed; `at` unchanged when its value serializes to nothing, which counts against the limit instead. */
  private member(at: number, o: Record<string, unknown>, key: string, first: boolean, depth: number): number {
    const limit = this.limit;
    if (at > limit) {
      this.stopped = true;
      return at;
    }
    let v = o[key];
    if (typeof v === "object" ? v !== null : typeof v === "function" || typeof v === "bigint") v = resolve(v as object | bigint, key);
    if (v === undefined || typeof v === "function" || typeof v === "symbol") {
      if (++this.empty > limit) this.stopped = true;
      return at;
    }
    // The last write left `SLACK` bytes past it, and the key's own write makes room again.
    if (!first) this.buffer[at++] = 0x2c;
    const room = limit - at + 1;
    if (key.length > room) {
      this.stopped = true;
      return this.quoted(at, key.slice(0, cutAt(key, room)));
    }
    at = this.quoted(at, key);
    if (this.stopped) return at;
    this.buffer[at++] = 0x3a;
    if (at > limit) {
      this.stopped = true;
      return at;
    }
    if (typeof v === "string") return v.length > limit - at + 1 ? this.string(at, v) : this.quoted(at, v);
    if (typeof v === "number") return this.number(at, v);
    return this.value(at, v, depth + 1);
  }

  /** A JSON string literal, copied byte by byte when it is short printable ASCII, written natively otherwise. */
  private quoted(at: number, s: string): number {
    const n = s.length;
    if (n > 64) return this.text(at, JSON.stringify(s));
    this.reserve(at, n + 2);
    const b = this.buffer;
    b[at] = 0x22;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      // Outside space to tilde, a quote or a backslash: anything JSON escapes, or that UTF-8 writes in more than one byte.
      if (c - 0x20 > 0x5e || c - 0x20 < 0 || c === 0x22 || c === 0x5c) return this.text(at, JSON.stringify(s));
      b[at + 1 + i] = c;
    }
    b[at + 1 + n] = 0x22;
    return at + n + 2;
  }

  /** A number as `JSON.stringify` writes it; a small non-negative integer digit by digit, with no string made for it. */
  private number(at: number, v: number): number {
    if (!(v >= 0 && v < 1e9 && v === Math.floor(v))) return this.ascii(at, Number.isFinite(v) ? "" + v : "null");
    this.reserve(at, 9);
    const b = this.buffer;
    let end = at + 1;
    for (let rest = v; rest >= 10; rest = Math.floor(rest / 10)) end++;
    for (let i = end - 1, rest = v; i >= at; i--, rest = Math.floor(rest / 10)) b[i] = 0x30 + (rest % 10);
    return end;
  }

  /** Short ASCII text: a number, a literal. */
  private ascii(at: number, s: string): number {
    this.reserve(at, s.length);
    const b = this.buffer;
    for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i);
    return at + s.length;
  }

  /**
   * Text already escaped as JSON, written as UTF-8. It holds no lone
   * surrogate, so its bytes are exact. Text that could pass the limit is
   * written no further than four bytes past it, cut on a code point
   * boundary, and once it passes the limit the walk stops, so escaping
   * cannot make a walk hold several times the limit.
   */
  private text(at: number, s: string): number {
    const most = s.length * 3;
    const room = this.limit - at + 1;
    if (most <= room) {
      this.reserve(at, most);
      return at + this.buffer.write(s, at);
    }
    const bound = (room > 0 ? room : 0) + 4;
    this.reserve(at, bound);
    const written = this.buffer.write(s, at, bound);
    if (written > room) this.stopped = true;
    return at + written;
  }

  /** Makes room for `bytes` more past `at`, and `SLACK` beyond them. */
  private reserve(at: number, bytes: number): void {
    const need = at + bytes + SLACK;
    if (need <= this.buffer.length) return;
    const grown = Buffer.allocUnsafe(Math.max(need, this.buffer.length * 2));
    this.buffer.copy(grown, 0, 0, at);
    this.buffer = grown;
  }
}

/* ------------------------------------------------------------------ */

export interface Encoded {
  /** The JSON text `value` carries on the wire, or `undefined` when there is no room for any. */
  valueText: string | undefined;
  truncated: boolean;
  /** Byte length of the whole serialization. Present when the encoder read the whole value and was asked to describe it. */
  bytes: number | undefined;
  /** Lowercase hex SHA-256 of the whole serialization, present with `bytes`. */
  hash: string | undefined;
  /** Binary was written as base64: the whole value, or somewhere inside it. */
  binary: boolean;
  /** The value serializes to nothing: `undefined`, a function or a symbol, directly or through `toJSON`. */
  omitted: boolean;
}

export interface Literal {
  /** A JSON string literal, or `undefined` when not even `""` fits. */
  text: string | undefined;
  cut: boolean;
}

const OMITTED: Encoded = Object.freeze({ valueText: undefined, truncated: false, bytes: undefined, hash: undefined, binary: false, omitted: true });

/**
 * Serializes values under the rule in `serialize.ts`, reading each once
 * and at most O(cap) of it. A walk writes its UTF-8 into a scratch buffer,
 * which gives the byte length, and the hash is taken over those bytes; a
 * primitive's text is written into it once the same way. A cut value is
 * found on a code point boundary and outside any escape. Nothing here runs
 * program code once the bytes are written and before they are read back,
 * and a capture that a getter starts from inside a walk works in buffers
 * of its own, so it cannot disturb the walk it interrupted.
 */
export class Encoder {
  private readonly scratch: Buffer;
  /** A walk holds the scratch buffer: a capture a getter starts inside it works in buffers of its own. */
  private walking = false;

  constructor(maxCap: number) {
    this.scratch = Buffer.allocUnsafe(Math.min(maxCap, SCRATCH_MAX) + SLACK);
  }

  /** A value under `cap`. `describe` asks for `bytes` and `hash` when the whole value is read. */
  encode(value: unknown, cap: number, describe: boolean): Encoded {
    const v = settle(value, "");
    switch (typeof v) {
      case "string":
        return this.string(v, cap, describe);
      case "number":
        return this.known(Number.isFinite(v) ? "" + v : "null", cap, describe);
      case "boolean":
        return this.known(v ? "true" : "false", cap, describe);
      case "bigint":
        throw bigintError();
      case "object": {
        if (v === null) return this.known("null", cap, describe);
        if (v instanceof Binary) return this.binary(v, cap, describe);
        const w = this.walk(v, cap, READ_FACTOR * cap);
        const { buffer, size, binary } = w;
        const hash = describe && w.complete ? sha256(buffer.subarray(0, size)) : undefined;
        const text = buffer.toString("utf8", 0, size);
        if (w.complete && size <= cap) return { valueText: text, truncated: false, bytes: size, hash, binary, omitted: false };
        return { valueText: this.literal(text, cap).text, truncated: true, bytes: hash === undefined ? undefined : size, hash, binary, omitted: false };
      }
      default:
        return OMITTED;
    }
  }

  /** The whole serialization of a resolved value, as `hash-only` reads it; `undefined` past `WHOLE_LIMIT`. */
  whole(v: unknown): Uint8Array | undefined {
    const w = this.walk(v, WHOLE_LIMIT, 0);
    return w.complete && w.size <= WHOLE_LIMIT ? w.buffer.subarray(0, w.size) : undefined;
  }

  private walk(v: unknown, limit: number, readBound: number): Walk {
    if (this.walking) return walk(v, limit, readBound, Buffer.allocUnsafe(Math.min(limit, 1 << 16) + SLACK));
    this.walking = true;
    try {
      return walk(v, limit, readBound, this.scratch);
    } finally {
      this.walking = false;
    }
  }

  /** JSON text the encoder holds in full, so `bytes` and `hash` are available even when the cap cuts `value`. */
  known(text: string, cap: number, describe: boolean): Encoded {
    const buffer = this.buffer(cap);
    const written = buffer.write(text, 0, cap, "utf8");
    if (written <= cap - 4 || buffer.toString("utf8", 0, written).length === text.length) {
      // Every UTF-16 unit takes one to three bytes, so a count outside that range means the write stopped short unseen.
      invariant(written >= text.length && written <= text.length * 3, "bytes equals the byte length of the serialization the hash is taken over");
      return { valueText: text, truncated: false, bytes: written, hash: describe ? sha256(buffer.subarray(0, written)) : undefined, binary: false, omitted: false };
    }
    const valueText = this.literal(text, cap).text;
    return describe
      ? { valueText, truncated: true, bytes: Buffer.byteLength(text), hash: sha256(text), binary: false, omitted: false }
      : { valueText, truncated: true, bytes: undefined, hash: undefined, binary: false, omitted: false };
  }

  /**
   * The JSON string literal of the longest prefix of `s` whose literal,
   * quotes and escapes included, fits in `cap` bytes: cut on a code point
   * boundary and never inside an escape. Reads O(cap) of `s`.
   */
  literal(s: string, cap: number): Literal {
    if (s.length * 6 + 2 <= cap) return { text: quote(s), cut: false };
    if (cap < 2) return { text: undefined, cut: true };
    const head = s.length > cap - 2 ? s.slice(0, cutAt(s, cap - 2)) : s;
    const full = JSON.stringify(head);
    if (head.length === s.length && this.fit(full, cap) === full.length) return { text: full, cut: false };
    const body = full.slice(0, -1);
    return { text: body.slice(0, escapeBoundary(body, this.fit(body, cap - 1))) + '"', cut: true };
  }

  /** The byte length and hash of a text's UTF-8, from one write into the scratch buffer when it fits. */
  digest(text: string): { bytes: number; hash: string } {
    if (this.walking || text.length * 3 > this.scratch.length) return { bytes: Buffer.byteLength(text), hash: sha256(text) };
    const bytes = this.scratch.write(text, 0);
    return { bytes, hash: sha256(this.scratch.subarray(0, bytes)) };
  }

  /** A string far longer than the cap is not read: its literal is `""`, cut. */
  bounded(s: string, cap: number): Literal {
    if (s.length > READ_FACTOR * cap) return { text: cap < 2 ? undefined : '""', cut: true };
    return this.literal(s, cap);
  }

  private string(s: string, cap: number, describe: boolean): Encoded {
    if (s.length <= cap) return this.known(quote(s), cap, describe);
    const valueText = s.length > READ_FACTOR * cap ? undefined : this.literal(quote(s.slice(0, cutAt(s, cap))), cap).text;
    return { valueText, truncated: true, bytes: undefined, hash: undefined, binary: false, omitted: false };
  }

  /** A whole value that is binary: base64 with `bytes` and `hash` over the raw bytes (core.md 5.4). */
  private binary(b: Binary, cap: number, describe: boolean): Encoded {
    const size = b.length;
    if (Math.ceil(size / 3) * 4 + 2 <= cap) {
      return { valueText: '"' + b.base64(size) + '"', truncated: false, bytes: describe ? size : undefined, hash: describe ? sha256(b.view(size)) : undefined, binary: true, omitted: false };
    }
    // A prefix `"<base64>` of the serialization travels as `"\"<base64>"`: four bytes around whole base64 groups.
    const groups = Math.floor((cap - 4) / 4);
    const valueText = groups < 0 ? undefined : '"\\"' + b.base64(groups * 3) + '"';
    // The raw length is known without reading the bytes, so a cut binary value keeps it.
    return { valueText, truncated: true, bytes: describe ? size : undefined, hash: undefined, binary: true, omitted: false };
  }

  /** How many UTF-16 units of `s`, whole code points, fit in `bytes` bytes of UTF-8. */
  private fit(s: string, bytes: number): number {
    if (s.length * 3 <= bytes) return s.length;
    const buffer = this.buffer(bytes);
    const written = buffer.write(s, 0, bytes, "utf8");
    return written <= bytes - 4 ? s.length : buffer.toString("utf8", 0, written).length;
  }

  /** A buffer of at least `size` bytes: the scratch buffer, or a fresh one while a walk holds it or when it is too small. Every read and write of it is bounded by an offset and a length. */
  private buffer(size: number): Buffer {
    return this.walking || size > this.scratch.length ? Buffer.allocUnsafe(size) : this.scratch;
  }
}

/**
 * `end`, moved back to the backslash that starts the escape sequence it
 * would split. `body` is `JSON.stringify` output, where a backslash starts
 * an escape unless it closes a `\\` pair, so the parity of a run of
 * backslashes tells the two apart.
 */
function escapeBoundary(body: string, end: number): number {
  for (let j = end - 1; j > 0 && j >= end - 6; j--) {
    if (body.charCodeAt(j) !== 0x5c) continue;
    let run = 1;
    while (j - run > 0 && body.charCodeAt(j - run) === 0x5c) run++;
    if (run % 2 === 0) return end;
    return j + (body.charCodeAt(j + 1) === 0x75 ? 6 : 2) > end ? j : end;
  }
  return end;
}

/**
 * The wire text of a Payload, in the key order `value`, `truncated`,
 * `redacted`, `bytes`, `hash`. `valueText` is the JSON text of `value`;
 * `hash` is bare hex. A redacted Payload carries neither `bytes` nor
 * `hash`.
 */
export function payloadWire(valueText: string | undefined, truncated: boolean, redacted: boolean, bytes: number | undefined, hash: string | undefined): string {
  invariant(!truncated || valueText === undefined || valueText.charCodeAt(0) === 34, "truncated implies value is a string prefix");
  invariant(hash === undefined || bytes !== undefined, "bytes equals the byte length of the serialization the hash is taken over");
  let t = valueText === undefined ? "" : '"value":' + valueText;
  if (truncated) t += (t === "" ? "" : ",") + '"truncated":true';
  if (redacted) t += (t === "" ? "" : ",") + '"redacted":true';
  else if (bytes !== undefined) t += ',"bytes":' + bytes + (hash === undefined ? "" : ',"hash":"sha256:' + hash + '"');
  return "{" + t + "}";
}

/* ------------------------------------------------------------------ */

/** The wire text of a Payload, and whether its value holds binary written as base64. */
export interface Captured {
  text: string;
  base64: boolean;
}

export const REDACTED_TEXT = '{"redacted":true}';
const REDACTED: Captured = Object.freeze({ text: REDACTED_TEXT, base64: false });

/**
 * What is left of a line's byte budget. A text spent is counted at three
 * bytes a UTF-16 unit, its most, and measured exactly only once a cap would
 * be cut by that estimate, so a line with ample room pays for no measuring.
 */
export class Budget {
  private readonly pending: string[] = [];
  private worst = 0;

  constructor(private room: number) {}

  /** `cap`, or less when less is left. */
  cap(cap: number): number {
    if (this.room - this.worst < cap && this.pending.length > 0) {
      for (const text of this.pending) this.room -= Buffer.byteLength(text);
      this.pending.length = 0;
      this.worst = 0;
    }
    const left = this.room - this.worst;
    return left >= cap ? cap : left > 0 ? left : 0;
  }

  spend(text: string): void {
    this.pending.push(text);
    this.worst += text.length * 3;
  }
}

export interface CapturedError extends Captured {
  /** `message` was cut at the slot's cap. */
  messageTruncated: boolean;
}

type ErrorSlot = "error" | "crossing.error";

const RULE_SLOTS: ReadonlySet<string> = new Set<CaptureSlot>(["program", "result", "outputs", "error", "crossing.input", "crossing.output", "crossing.error"]);

/** Caps, rules and the encoder for one instance. Compiled once. */
export class Capturer {
  readonly caps: Readonly<Record<CapKey, number>>;
  private readonly rules: Partial<Record<CaptureSlot, CaptureRule>>;
  private readonly encoder: Encoder;

  constructor(policy: CapturePolicy | undefined) {
    // A key this version does not read would otherwise be a redaction rule that silently never applies.
    for (const key of Object.keys(policy ?? {})) if (key !== "caps" && key !== "rules") throw new RangeError(`mocon: unknown capture policy key "${key}"`);
    const caps = { ...DEFAULT_CAPS };
    if (policy?.caps !== undefined) {
      for (const slot of Object.keys(policy.caps)) {
        if (!Object.hasOwn(DEFAULT_CAPS, slot)) throw new RangeError(`mocon: unknown capture slot "${slot}"`);
        const cap: unknown = policy.caps[slot as CapKey];
        if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) throw new RangeError(`mocon: cap for "${slot}" must be a positive integer`);
        caps[slot as CapKey] = cap;
      }
    }
    const rules: Partial<Record<CaptureSlot, CaptureRule>> = {};
    if (policy?.rules !== undefined) {
      for (const slot of Object.keys(policy.rules)) {
        if (!RULE_SLOTS.has(slot)) throw new RangeError(`mocon: unknown capture slot "${slot}"`);
        const rule: unknown = policy.rules[slot as CaptureSlot];
        if (rule === undefined) continue;
        if (rule !== "drop" && rule !== "hash-only" && typeof rule !== "function") throw new TypeError(`mocon: rule for "${slot}" must be "drop", "hash-only" or a function`);
        rules[slot as CaptureSlot] = rule as CaptureRule;
      }
    }
    this.caps = caps;
    this.rules = rules;
    this.encoder = new Encoder(Math.max(...Object.values(caps)));
  }

  program(text: string): Captured {
    return this.apply("program", text, this.caps.program, undefined, undefined);
  }

  /** A Payload slot. With a budget the slot's cap shrinks to what the line has left, and what it writes is spent. */
  value(slot: Exclude<CaptureSlot, "program">, value: unknown, budget?: Budget, target?: string, channel?: string): Captured {
    const cap = budget === undefined ? this.caps[slot] : budget.cap(this.caps[slot]);
    const c = this.apply(slot, value, cap, target, channel);
    budget?.spend(c.text);
    return c;
  }

  /**
   * An Error object (core.md 5.5) as wire text. Under the default encoder
   * `message` is cut at the slot's cap and `value` is captured under it.
   * Under a rule the rule decides `value` and no `message` is written, so a
   * policy that withholds an error's content withholds all of it.
   */
  error(slot: ErrorSlot, input: ErrorInput, budget?: Budget, target?: string): CapturedError {
    let text = '{"class":' + quote(input.class);
    let messageTruncated = false;
    if (input.message !== undefined && this.rules[slot] === undefined) {
      const m = this.encoder.bounded(input.message, budget === undefined ? this.caps[slot] : budget.cap(this.caps[slot]));
      if (m.text !== undefined) {
        text += ',"message":' + m.text;
        budget?.spend(m.text);
      }
      messageTruncated = m.cut;
    }
    if (input.value === undefined) return { text: text + "}", base64: false, messageTruncated };
    const c = this.value(slot, input.value, budget, target);
    return { text: text + ',"value":' + c.text + "}", base64: c.base64, messageTruncated };
  }

  /** The target as the line carries it: a JSON string literal cut at the `crossing.target` cap, and the text it holds. */
  target(target: string): { text: string; value: string; truncated: boolean } {
    const t = this.encoder.bounded(target, this.caps["crossing.target"]);
    if (!t.cut) return { text: t.text as string, value: target, truncated: false };
    const text = t.text ?? '""';
    return { text, value: JSON.parse(text) as string, truncated: true };
  }

  /**
   * A Payload a rule built instead of taking it from `ctx.capture`. Each
   * field is read once, checked as core.md 5.4 and payload.json define it,
   * and written from what was read; `value` goes through the encoder under
   * `cap`, so binary in it is base64 with the note that says so.
   * `undefined` for anything else, a `value` that serializes to nothing or
   * that the serialization rejects included.
   */
  private payload(p: unknown, cap: number): Captured | undefined {
    if (p === null || typeof p !== "object" || isArray(p)) return undefined;
    let value: unknown, truncated: unknown, redacted: unknown, bytes: unknown, hash: unknown;
    try {
      ({ value, truncated, redacted, bytes, hash } = p as Record<string, unknown>);
      if (truncated !== undefined && typeof truncated !== "boolean") return undefined;
      if (redacted !== undefined && typeof redacted !== "boolean") return undefined;
      if (bytes !== undefined && !(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0)) return undefined;
      if (hash !== undefined && !(typeof hash === "string" && HASH.test(hash))) return undefined;
      let valueText: string | undefined;
      let cut = truncated === true;
      let base64 = false;
      if (value !== undefined) {
        if (cut) {
          if (typeof value !== "string") return undefined;
          valueText = this.encoder.bounded(value, cap).text;
        } else {
          const e = this.encoder.encode(value, cap, false);
          if (e.omitted) return undefined;
          valueText = e.valueText;
          cut = e.truncated;
          base64 = e.binary;
        }
      } else if (!cut && redacted !== true) {
        return undefined;
      }
      const fields: string[] = [];
      if (valueText !== undefined) fields.push('"value":' + valueText);
      if (cut || truncated === false) fields.push('"truncated":' + cut);
      if (redacted !== undefined) fields.push('"redacted":' + redacted);
      if (bytes !== undefined) fields.push('"bytes":' + bytes);
      if (hash !== undefined) fields.push('"hash":"' + hash + '"');
      return { text: "{" + fields.join(",") + "}", base64 };
    } catch (e) {
      if (e instanceof InvariantError) throw e;
      return undefined;
    }
  }

  private apply(slot: CaptureSlot, value: unknown, cap: number, target: string | undefined, channel: string | undefined): Captured {
    const rule = this.rules[slot];
    if (rule === undefined) return this.encode(slot, value, cap, false);
    if (rule === "drop") return REDACTED;
    if (rule === "hash-only") return this.hashOnly(slot, value);
    const issued: Array<[Payload, Captured]> = [];
    const context: CaptureContext = {
      slot,
      cap,
      capture: (v, options) => {
        const c = this.encode(slot, v, cap, options?.redacted === true);
        const payload = parseFrozen<Payload>(c.text);
        issued.push([payload, c]);
        return payload;
      },
    };
    if (channel !== undefined) context.channel = channel;
    if (target !== undefined) context.target = target;
    try {
      const out = rule(value, context);
      if (out === "drop") return REDACTED;
      if (out === "hash-only") return this.hashOnly(slot, value);
      for (const [payload, c] of issued) if (payload === out) return c;
      return this.payload(out, cap) ?? REDACTED;
    } catch (e) {
      if (e instanceof InvariantError) throw e;
      return REDACTED;
    }
  }

  /** `{redacted: true, bytes, hash}` over the whole original, read in full by request up to a ceiling. */
  private hashOnly(slot: CaptureSlot, value: unknown): Captured {
    try {
      let bytes: number;
      let hash: string;
      if (slot === "program" && typeof value === "string") {
        ({ bytes, hash } = this.encoder.digest(value));
      } else {
        const v = settle(value, "");
        const whole = v instanceof Binary ? v.view(v.length) : this.encoder.whole(v);
        if (whole === undefined) return REDACTED;
        bytes = whole.byteLength;
        hash = sha256(whole);
      }
      return { text: '{"redacted":true,"bytes":' + bytes + ',"hash":"sha256:' + hash + '"}', base64: false };
    } catch (e) {
      if (e instanceof InvariantError) throw e;
      return REDACTED;
    }
  }

  /**
   * The default encoder under a cap. A value the serialization rejects,
   * such as a BigInt or a cycle, is written as `{redacted: true}`, and one
   * that serializes to nothing as `null`. A failed invariant is a bug in
   * this package and is not hidden that way.
   */
  private encode(slot: CaptureSlot, value: unknown, cap: number, redacted: boolean): Captured {
    try {
      if (slot === "program" && typeof value === "string") {
        const t = this.encoder.literal(value, cap);
        if (redacted) return { text: payloadWire(t.text, t.cut, true, undefined, undefined), base64: false };
        const { bytes, hash } = this.encoder.digest(value);
        return { text: payloadWire(t.text, t.cut, false, bytes, hash), base64: false };
      }
      let e = this.encoder.encode(value, cap, !redacted);
      if (e.omitted) e = this.encoder.known("null", cap, !redacted);
      return { text: payloadWire(e.valueText, e.truncated, redacted, e.bytes, e.hash), base64: e.binary };
    } catch (e) {
      if (e instanceof InvariantError) throw e;
      return REDACTED;
    }
  }
}
