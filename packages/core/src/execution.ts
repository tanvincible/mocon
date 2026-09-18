/**
 * One execution (core.md 5.2). The handle tracks only the crossings it
 * opened and has not settled; `end` writes those as abandoned, then the
 * complete record, in one write. The first `end` wins.
 *
 * The part of the line fixed at start (host, id, program, language,
 * start, context) is written once; `end` appends the rest. `end` reads
 * each option once and validates it, then captures the result, outputs,
 * error and `ext`, which may run program code, and only then reads and
 * changes the state. A rejected call leaves the handle and its open
 * crossings as they were, and a getter that ended the execution from
 * inside the capture wins, because it finished first.
 */

import { errorInput } from "./cause.js";
import { checkEndTime, checkExt, checkSeq, checkString, checkTimestamp, targetOf } from "./check.js";
import { CLOSED } from "./closed.js";
import { Crossing } from "./crossing.js";
import { follow, type Instance } from "./instance.js";
import { invariant } from "./invariants.js";
import { Budget, LINE_BUDGET, REDACTED_TEXT } from "./payload.js";
import { EXT_REDACTED, extJson, extText, mergeExt, note, quote, raw, type Notes } from "./serialize.js";
import { notBefore } from "./time.js";
import type { CompleteOptions, CrossingHandle, CrossingStartOptions, Disposition, ErrorInput, ExecutionContext, ExecutionEndOptions, ExecutionHandle, Ext, InstrumentOptions } from "./types.js";

/** A `...Text` field is the JSON text the line writes for the field before it. */
export interface ExecutionFields {
  id: string;
  idText: string;
  start: string;
  startText: string;
  /** `start` when the host gave it, so a default `end.time` read from this instance's clock does not fall below it. */
  floor: string | undefined;
  programText: string;
  language: string | undefined;
  context: ExecutionContext | undefined;
  ext: string | undefined;
}

/** An input `instrument` could not derive, written as `{ redacted: true }`. */
const WITHHELD = Symbol("withheld");

export class Execution implements ExecutionHandle {
  readonly crossing: ExecutionHandle["crossing"];
  readonly idText: string;
  /** `,"context":{"traceparent":...}` for every crossing line, or nothing. */
  readonly crossingContextText: string;
  private readonly tracked = new Set<Crossing>();
  /** The line up to, not including, `end` and `ext`. */
  private readonly head: string;
  private seq = 0;
  private ended = false;
  /** An execution line of this handle reached the stream, or none ever will because the instance is inert. */
  private noticed: boolean;

  constructor(
    readonly inst: Instance,
    private readonly fields: ExecutionFields,
  ) {
    this.idText = fields.idText;
    this.noticed = inst.inert;
    const traceparent = fields.context?.traceparent;
    this.crossingContextText = traceparent === undefined ? "" : ',"context":{"traceparent":' + quote(traceparent) + "}";
    let head = '{"kind":"execution","host":' + inst.hostText + ',"id":' + fields.idText + ',"program":' + fields.programText;
    if (fields.language !== undefined) head += ',"language":' + quote(fields.language);
    head += ',"start":' + fields.startText;
    if (fields.context !== undefined) head += ',"context":' + JSON.stringify(fields.context);
    this.head = head;
    this.crossing = { start: (options) => this.startCrossing(options) };
  }

  get id(): string {
    return this.fields.id;
  }

  /** Writes the start notice, unless an execution line of this handle already reached the stream. */
  announce(): void {
    if (this.noticed) return;
    this.noticed = true;
    this.inst.emit([this.head + extText(this.fields.ext) + "}"]);
  }

  /** Writes a line of one of this execution's crossings, after the start notice when this handle has written no execution line yet. */
  write(line: string): void {
    if (this.noticed) {
      this.inst.emit([line]);
      return;
    }
    this.noticed = true;
    this.inst.emit([this.head + extText(this.fields.ext) + "}", line]);
  }

  /** Called by a crossing when it leaves the open state. */
  forget(crossing: Crossing): void {
    this.tracked.delete(crossing);
  }

  instrument<F extends (...args: any[]) => unknown>(fn: F, options?: InstrumentOptions<Parameters<F>>): F {
    if (typeof fn !== "function") throw new TypeError("mocon: instrument() takes a function");
    const { target, input, ext } = instrumentOptions(options);
    const fixedExt = typeof ext === "function" ? undefined : extJson(ext);
    const execution = this;
    const wrapped = function (this: unknown, ...args: Parameters<F>): unknown {
      const crossing = execution.open(
        targetFrom(target, args),
        inputOf(input, target === undefined, args),
        typeof ext === "function" ? extOf(ext, args) : fixedExt,
        undefined,
        undefined,
        undefined,
        false,
      );
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (e) {
        crossing.error(e);
        throw e;
      }
      return follow(
        result,
        (value) => crossing.output(value),
        (e) => crossing.error(e),
      );
    };
    Object.defineProperties(wrapped, {
      name: { value: fn.name, configurable: true },
      length: { value: fn.length, configurable: true },
    });
    Object.assign(wrapped, fn);
    return wrapped as unknown as F;
  }

  complete(options?: CompleteOptions): void {
    this.end({ ...options, disposition: "completed" });
  }

  fail(cause: unknown, options?: CompleteOptions & { class?: string }): void {
    const { class: cls, ...rest } = options ?? {};
    this.end({ ...rest, disposition: "failed", error: { class: cls === undefined ? "runtime" : cls, cause } });
  }

  end(options: ExecutionEndOptions): void {
    const { disposition, time, ext, result, outputs, error } = options as { [K in keyof ExecutionEndOptions]: unknown };
    if (!CLOSED.disposition.has(disposition)) throw new RangeError(`mocon: unknown disposition ${JSON.stringify(disposition)}`);
    const given = time === undefined ? undefined : checkEndTime(time, this.fields.start);
    const settleExt = checkExt(ext, "ext");
    if (outputs !== undefined && (outputs === null || typeof outputs !== "object")) throw new TypeError("mocon: outputs must be an object");
    const errorIn = error === undefined ? undefined : errorInput(error as ErrorInput);
    if (this.ended) return;
    const inst = this.inst;
    if (inst.inert) {
      this.close();
      return;
    }
    const reading = given ?? (this.fields.floor === undefined ? inst.now() : notBefore(inst.now(), this.fields.floor));
    const [end, notes] = this.endText(disposition as Disposition, raw(reading), errorIn, result, outputs as Record<string, unknown> | undefined);
    const extMerged = mergeExt(this.fields.ext, extJson(settleExt), notes);
    // The capture and the ext ran program code, which may have ended this execution first.
    if (this.ended) return;
    const lines = this.close();
    lines.push(this.head + end + extText(extMerged) + "}");
    inst.emit(lines);
  }

  /** Abandons every tracked crossing, then marks the execution ended. Returns the abandoned records' lines. Runs no host or program code. */
  private close(): string[] {
    invariant(!this.ended, "an execution ends at most once");
    const lines: string[] = [];
    for (const crossing of this.tracked) lines.push(crossing.abandon());
    invariant(this.tracked.size === 0, "abandon precedes execution end: every tracked crossing is written before the complete record");
    this.ended = true;
    this.noticed = true;
    return lines;
  }

  private startCrossing(options: CrossingStartOptions): CrossingHandle {
    const { target, input, id, seq, start, ext, notice } = options as { [K in keyof CrossingStartOptions]: unknown };
    return this.open(
      checkString(target, "crossing target"),
      input,
      extJson(checkExt(ext, "ext")),
      id === undefined ? undefined : checkString(id, "crossing id"),
      seq === undefined ? undefined : checkSeq(seq),
      start === undefined ? undefined : checkTimestamp(start, "crossing start"),
      notice === true,
    );
  }

  /** Opens a crossing from values already checked, and tracks it unless the execution ended while its input was captured. */
  private open(given: string, input: unknown, ext: string | undefined, ownId: string | undefined, ownSeq: number | undefined, ownStart: string | undefined, notice: boolean): Crossing {
    const inst = this.inst;
    const id = ownId ?? inst.ids.crossing();
    let seq = ownSeq;
    if (ownSeq === undefined) seq = this.seq < Number.MAX_SAFE_INTEGER ? ++this.seq : undefined;
    else if (ownSeq > this.seq) this.seq = ownSeq;
    const start = ownStart ?? inst.now();
    const target = inst.capture.target(given);
    let notes: Notes | undefined = target.truncated ? note(undefined, "mocon.target", "truncated", true) : undefined;
    let inputText = REDACTED_TEXT;
    if (!inst.inert && input !== WITHHELD) {
      const c = inst.capture.value("crossing.input", input, undefined, target.value);
      inputText = c.text;
      if (c.base64) notes = note(notes, "mocon.encoding", "input", "base64");
    }
    const crossing = new Crossing(this, {
      id,
      idText: ownId === undefined ? raw(id) : quote(id),
      target: target.value,
      targetText: target.text,
      inputText,
      seq,
      start,
      startText: raw(start),
      floor: ownStart,
      ext: mergeExt(ext, undefined, notes),
    });
    if (!this.ended) this.tracked.add(crossing);
    if (notice && !inst.inert) this.write(crossing.notice());
    return crossing;
  }

  /** `,"end":{...}`, and a note for every slot whose value holds base64 or whose message was cut. The payloads share the line's budget. */
  private endText(
    disposition: Disposition,
    timeText: string,
    error: ErrorInput | undefined,
    result: unknown,
    outputs: Record<string, unknown> | undefined,
  ): [text: string, notes: Notes | undefined] {
    const capture = this.inst.capture;
    const budget = new Budget(LINE_BUDGET);
    budget.spend(this.head);
    let notes: Notes | undefined;
    let text = ',"end":{"time":' + timeText + ',"disposition":"' + disposition + '"';
    if (error !== undefined) {
      const e = capture.error("error", error, budget);
      text += ',"error":' + e.text;
      if (e.base64) notes = note(notes, "mocon.encoding", "error.value", "base64");
      if (e.messageTruncated) notes = note(notes, "mocon.message", "truncated", true);
    }
    if (result !== undefined) {
      const c = capture.value("result", result, budget);
      text += ',"result":' + c.text;
      if (c.base64) notes = note(notes, "mocon.encoding", "result", "base64");
    }
    if (outputs !== undefined) {
      let outputsText = "";
      for (const channel of Object.keys(outputs)) {
        const value = outputs[channel];
        if (value === undefined) continue;
        const c = capture.value("outputs", value, budget, undefined, channel);
        outputsText += (outputsText === "" ? "" : ",") + quote(channel) + ":" + c.text;
        if (c.base64) notes = note(notes, "mocon.encoding", "outputs." + channel, "base64");
      }
      if (outputsText !== "") text += ',"outputs":{' + outputsText + "}";
    }
    return [text + "}", notes];
  }
}

type Derive<T> = (...args: any[]) => T;

/** The options of one `instrument` call, read once and checked for type. */
function instrumentOptions(options: unknown): { target: string | Derive<unknown> | undefined; input: Derive<unknown> | undefined; ext: Ext | Derive<unknown> | undefined } {
  if (options === undefined) return { target: undefined, input: undefined, ext: undefined };
  if (options === null || typeof options !== "object") throw new TypeError("mocon: instrument() options must be an object");
  const { target, input, ext } = options as Record<string, unknown>;
  if (target !== undefined && typeof target !== "string" && typeof target !== "function") throw new TypeError("mocon: instrument() target must be a string or a function");
  if (input !== undefined && typeof input !== "function") throw new TypeError("mocon: instrument() input must be a function");
  if (typeof ext !== "function") checkExt(ext, "instrument() ext");
  return { target: target as string | Derive<unknown> | undefined, input: input as Derive<unknown> | undefined, ext: ext as Ext | Derive<unknown> | undefined };
}

/** The target of one call: the option's string, what its function returned, or the first argument, through `targetOf`. */
function targetFrom(option: string | Derive<unknown> | undefined, args: unknown[]): string {
  if (typeof option === "string") return option;
  let value: unknown = args[0];
  if (option !== undefined) {
    try {
      value = option(...args);
    } catch {
      // The target function could not read these arguments; the first argument names the call instead.
    }
  }
  return targetOf(value);
}

/** The input of one call: what the option's function returned, or the arguments not used as the target, unwrapped when there is one. */
function inputOf(option: Derive<unknown> | undefined, targetFromFirst: boolean, args: unknown[]): unknown {
  if (option !== undefined) {
    try {
      return option(...args);
    } catch {
      return WITHHELD;
    }
  }
  if (targetFromFirst) return args.length === 2 ? args[1] : args.slice(1);
  return args.length === 1 ? args[0] : args;
}

/** The `ext` of one call, from the option's function: its JSON text, or the redaction note for a throw or a value that is not an object. */
function extOf(option: Derive<unknown>, args: unknown[]): string | undefined {
  try {
    return extJson(option(...args));
  } catch {
    return EXT_REDACTED;
  }
}
