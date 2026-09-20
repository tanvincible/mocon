/**
 * Payload capture and the `code_mode.capture` note (otel-code-mode.md 7). OpenTelemetry has no way
 * to say a value on a record was shortened or removed: the SDK's own length limit cuts silently and
 * `dropped_attributes_count` speaks only for attributes dropped whole. So the note is minted here.
 *
 * Values are Opt-In. With `values` off nothing is serialized at all, which is both the conventions'
 * default and the cheap path: an absent Opt-In attribute says nothing, and claims nothing.
 */

import { type Encoded, Encoder } from "./encode.js";
import type { Attributes } from "@opentelemetry/api";

/** Bytes of JSON kept per value. Under every SDK, collector and backend limit we know of. */
export const DEFAULT_CAP = 1 << 13;
/** The program is the host's own record of what it ran, and a reader wants more of it whole. */
export const DEFAULT_PROGRAM_CAP = 1 << 15;
/**
 * Bytes read to measure and hash the whole value, well above what is written. The encoder reports
 * `bytes` and `hash` only for a value it read whole, and those describe the original, so reading no
 * further than the write cap would drop them exactly where a truncated value needs them most.
 */
export const DEFAULT_MEASURE = 1 << 20;

export interface CapturePolicy {
  /**
   * Turns on the Opt-In attributes: program text, crossing arguments and results, execution result
   * and outputs, error bodies. Off by default, because they are agent-written code and target data.
   */
  values?: boolean;
  /** Bytes kept per value. Past it the attribute is a prefix and the note says `truncated`. */
  cap?: number;
  /** The same for the program text. */
  programCap?: number;
  /** Bytes read to measure and hash a whole value. Past it a truncated note carries no size. */
  measure?: number;
}

/**
 * Attributes this emitter writes as JSON text rather than as a value. A span attribute cannot hold a
 * map, so a payload is stringified; a log record can hold one, so a destination that is not a span
 * wants them back. Exported so no destination has to keep its own copy of this list and watch it go
 * stale. `code_mode.program.text` is deliberately absent: it is raw program source, and parsing it
 * would turn a program that happens to start with a brace into something else.
 */
export function isEncoded(key: string): boolean {
  return (
    key === "code_mode.capture" ||
    key === "code_mode.error.body" ||
    key === "code_mode.error.message" ||
    key === "gen_ai.tool.call.arguments" ||
    key === "gen_ai.tool.call.result" ||
    key.startsWith("code_mode.output.")
  );
}

/** What the host did to each value, keyed by the attribute it did it to. */
export type Notes = Record<string, Record<string, unknown>>;

export class Capture {
  readonly values: boolean;
  private readonly cap: number;
  private readonly programCap: number;
  private readonly measure: number;
  private readonly encoder: Encoder;

  constructor(policy: CapturePolicy | undefined) {
    if (policy !== undefined && (policy === null || typeof policy !== "object")) throw new TypeError("mocon: capture must be an object");
    // A key this version does not read would be a withholding rule that silently never applies.
    for (const key of Object.keys(policy ?? {})) {
      if (key !== "values" && key !== "cap" && key !== "programCap" && key !== "measure") throw new RangeError(`mocon: unknown capture policy key "${key}"`);
    }
    this.values = policy?.values === true;
    this.cap = positive(policy?.cap, DEFAULT_CAP, "cap");
    this.programCap = positive(policy?.programCap, DEFAULT_PROGRAM_CAP, "programCap");
    this.measure = Math.max(positive(policy?.measure, DEFAULT_MEASURE, "measure"), this.cap);
    this.encoder = new Encoder(Math.max(this.measure, this.programCap));
  }

  /**
   * The program. Its hash is written whatever the policy says: 4.2 makes it Recommended because it
   * is how two dispatches of one text are matched and the only thing left when the text is withheld.
   */
  program(text: string, attrs: Attributes, notes: Notes): void {
    const { bytes, hash } = this.encoder.digest(text);
    attrs["code_mode.program.hash"] = "sha256:" + hash;
    if (!this.values) return;
    // The cap bounds the RAW bytes of what lands on the span. This attribute is source rather than
    // a JSON payload, so its cost on the wire is its UTF-8 length; bounding the length of a literal
    // it never becomes would silently spend a third of the allowance on escaping.
    const prefix = cutToBytes(text, this.programCap);
    attrs["code_mode.program.text"] = prefix;
    const note: Record<string, unknown> = { bytes, hash: "sha256:" + hash };
    if (prefix.length !== text.length) note["truncated"] = true;
    notes["code_mode.program.text"] = note;
  }

  /**
   * One Opt-In payload attribute and its note, as a JSON string: the span attribute APIs of the
   * three major languages take primitives and homogeneous arrays, never the nested map `any` allows.
   */
  value(key: string, value: unknown, attrs: Attributes, notes: Notes): void {
    if (!this.values) return;
    let encoded: Encoded;
    try {
      encoded = this.encoder.encode(value, this.measure, true, this.cap);
    } catch {
      // Serializing runs program-authored code: a getter, a `toJSON`, a Proxy trap, and a cycle
      // throws by design. 7 calls a value the host could not serialize one it dropped by its own
      // policy, which is `redacted`. This is an ordinary path, not a fault, and nothing from it may
      // raise into the caller: an emitter that can fail a call has made observability an outage.
      this.redacted(key, notes);
      return;
    }
    // `undefined`, a function and a symbol serialize to nothing. There is no value to record and
    // none was withheld, so the attribute is absent and the note stays silent about it.
    if (encoded.omitted) return;
    if (encoded.valueText === undefined) {
      notes[key] = { redacted: true, ...(encoded.bytes === undefined ? {} : { bytes: encoded.bytes }) };
      return;
    }
    if (encoded.substituted) {
      // JSON holds no NaN and no infinity. Writing `null` in its place turns a reading into a
      // reading of nothing, which a reader who misses the flag takes at face value, so the payload
      // is dropped whole instead. No `bytes` and no `hash`: both are defined over an original that
      // could not be serialized. 7 calls this redacted, content the host removed by its own policy.
      this.redacted(key, notes);
      return;
    }
    attrs[key] = encoded.valueText;
    const note: Record<string, unknown> = {};
    if (encoded.truncated) note["truncated"] = true;
    if (encoded.bytes !== undefined) note["bytes"] = encoded.bytes;
    if (encoded.hash !== undefined) note["hash"] = "sha256:" + encoded.hash;
    if (Object.keys(note).length > 0) notes[key] = note;
  }

  /** The host held this value and removed it by policy, which is not the same as never recording it. */
  redacted(key: string, notes: Notes, bytes?: number): void {
    notes[key] = bytes === undefined ? { redacted: true } : { redacted: true, bytes };
  }
}

/** Writes the note onto the span, if the host has anything to say about what it captured. */
export function writeNotes(attrs: Attributes, notes: Notes): void {
  if (Object.keys(notes).length > 0) attrs["code_mode.capture"] = JSON.stringify(notes);
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never splitting a code point. */
function cutToBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const buf = Buffer.from(s, "utf8");
  let end = max;
  // Walk back off a continuation byte, so the cut lands on a character rather than inside one.
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function positive(given: unknown, fallback: number, name: string): number {
  if (given === undefined) return fallback;
  if (typeof given !== "number" || !Number.isInteger(given) || given < 1) throw new RangeError(`mocon: capture ${name} must be a positive integer`);
  return given;
}
