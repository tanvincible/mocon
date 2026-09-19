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

/** What the host did to each value, keyed by the attribute it did it to. */
export type Notes = Record<string, Record<string, unknown>>;

export class Capture {
  readonly values: boolean;
  private readonly cap: number;
  private readonly programCap: number;
  private readonly measure: number;
  private readonly encoder: Encoder;

  constructor(policy: CapturePolicy | undefined) {
    if (policy !== undefined && (policy === null || typeof policy !== "object")) throw new TypeError("@mocon/trace: capture must be an object");
    // A key this version does not read would be a withholding rule that silently never applies.
    for (const key of Object.keys(policy ?? {})) {
      if (key !== "values" && key !== "cap" && key !== "programCap" && key !== "measure") throw new RangeError(`@mocon/trace: unknown capture policy key "${key}"`);
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
    const encoded = this.encoder.encode(text, this.programCap, false);
    if (encoded.valueText === undefined) {
      notes["code_mode.program.text"] = { redacted: true, bytes };
      return;
    }
    attrs["code_mode.program.text"] = encoded.truncated ? (JSON.parse(encoded.valueText) as string) : text;
    const note: Record<string, unknown> = { bytes, hash: "sha256:" + hash };
    if (encoded.truncated) note["truncated"] = true;
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

function positive(given: unknown, fallback: number, name: string): number {
  if (given === undefined) return fallback;
  if (typeof given !== "number" || !Number.isInteger(given) || given < 1) throw new RangeError(`@mocon/trace: capture ${name} must be a positive integer`);
  return given;
}
