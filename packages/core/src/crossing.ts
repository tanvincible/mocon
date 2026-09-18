/**
 * One crossing (core.md 5.3). A crossing written as abandoned records the first output or error that arrives
 * after it as a `late_settlement` event (extensions/events.md 5), never attributed to the closed key; later
 * ones are ignored.
 *
 * A settle call reads each option once and validates it, then captures the payload and the `ext`, which may
 * run program code, and only then reads and changes the state. A rejected call leaves the crossing open, and
 * a getter that settled or abandoned the crossing from inside the capture wins, because it finished first.
 */

import { errorInput } from "./cause.js";
import { checkEndTime, checkExt } from "./check.js";
import { CLOSED } from "./closed.js";
import type { Execution } from "./execution.js";
import { invariant } from "./invariants.js";
import { extJson, extText, mergeExt, note, raw, type Notes } from "./serialize.js";
import { notBefore } from "./time.js";
import type { CrossingEndOptions, CrossingHandle, ErrorInput, SettleOptions } from "./types.js";

/** A `...Text` field is the JSON text the line writes for the field before it. */
interface CrossingFields {
  id: string;
  idText: string;
  /** The target as the line carries it, cut at the `crossing.target` cap. */
  target: string;
  targetText: string;
  inputText: string;
  seq: number | undefined;
  start: string;
  startText: string;
  /** `start` when the host gave it, so a clock-read `end.time` cannot fall below it. */
  floor: string | undefined;
  /** The host's `ext` as given at initiation, with the library's own notes. */
  ext: string | undefined;
}

const OPEN = 0;
const SETTLED = 1;
const ABANDONED = 2;
/** Abandoned, and the one late settlement was recorded; later calls are ignored like any later settlement. */
const LATE = 3;
type State = typeof OPEN | typeof SETTLED | typeof ABANDONED | typeof LATE;

export class Crossing implements CrossingHandle {
  private state: State = OPEN;
  /** The line up to, not including, `end` and `ext`, once a line has needed it. */
  private headText: string | undefined;

  constructor(
    private readonly owner: Execution,
    private readonly fields: CrossingFields,
  ) {}

  /** Built on first use, then fixed: whatever line needed it settled what the crossing carries. */
  private get head(): string {
    if (this.headText !== undefined) return this.headText;
    const f = this.fields;
    const owner = this.owner;
    let head = '{"kind":"crossing","host":' + owner.inst.hostText + ',"id":' + f.idText + ',"execution_id":' + owner.idText + ',"target":' + f.targetText + ',"input":' + f.inputText;
    if (f.seq !== undefined) head += ',"seq":' + f.seq;
    return (this.headText = head + owner.crossingContextText + ',"start":' + f.startText);
  }

  /**
   * Fills in what the input capture produced, once it has returned. The execution tracks a crossing before
   * the capture runs, because a rule, an `instrument` derive or a `toJSON` inside it can end the execution;
   * when one did, this crossing's abandoned record was already written from the redacted input, and nothing
   * here changes what that line said.
   */
  opened(inputText: string, ext: string | undefined): void {
    if (this.headText !== undefined) return;
    this.fields.inputText = inputText;
    this.fields.ext = ext;
  }

  get id(): string {
    return this.fields.id;
  }

  output(value: unknown, options?: SettleOptions): void {
    this.settle("output", value, undefined, options?.time, options?.ext);
  }

  error(cause: unknown, options?: SettleOptions & { class?: string }): void {
    const cls = options?.class;
    this.settle("error", undefined, { class: cls === undefined ? "capability_error" : cls, cause }, options?.time, options?.ext);
  }

  end(options: CrossingEndOptions): void {
    const { outcome, time, ext, output, error } = options as { outcome: unknown; time?: unknown; ext?: unknown; output?: unknown; error?: unknown };
    if (!CLOSED.outcome.has(outcome)) throw new RangeError(`mocon: unknown crossing outcome ${JSON.stringify(outcome)}`);
    this.settle(outcome as CrossingEndOptions["outcome"], outcome === "output" ? output : undefined, outcome === "error" ? (error as ErrorInput | undefined) : undefined, time, ext);
  }

  /** The start notice line. */
  notice(): string {
    return this.head + extText(this.fields.ext) + "}";
  }

  /** Closes the crossing as its execution ends; returns its line. Runs no host or program code. */
  abandon(): string {
    this.move(OPEN, ABANDONED);
    return this.head + ',"end":{"outcome":"abandoned"}' + extText(this.fields.ext) + "}";
  }

  /** The one place the state changes. Leaving `OPEN` also stops the execution tracking the crossing. */
  private move(from: State, to: State): void {
    invariant(this.state === from, "a crossing ends at most once");
    this.state = to;
    if (from === OPEN) this.owner.forget(this);
  }

  private settle(outcome: CrossingEndOptions["outcome"], output: unknown, errorIn: ErrorInput | undefined, time: unknown, ext: unknown): void {
    const given = time === undefined ? undefined : checkEndTime(time, this.fields.start);
    const settleExt = checkExt(ext, "ext");
    const error = errorIn === undefined ? undefined : errorInput(errorIn);
    if (this.state === SETTLED || this.state === LATE || (this.state === ABANDONED && outcome === "abandoned")) return;
    const inst = this.owner.inst;
    // A host-determined outcome carries its instant; an abandon carries one only when the host gave it.
    const timed = outcome !== "abandoned" || given !== undefined;
    const reading = !timed ? undefined : (given ?? (this.fields.floor === undefined ? inst.now() : notBefore(inst.now(), this.fields.floor)));
    if (inst.inert) {
      this.move(this.state, this.state === OPEN ? (outcome === "abandoned" ? ABANDONED : SETTLED) : LATE);
      return;
    }
    const payload = this.capture(outcome, output, error);
    const settleExtJson = extJson(settleExt);
    // The capture and the ext ran program code, which may have settled this crossing or ended its execution.
    if (this.state === OPEN) {
      let end = ',"end":{' + (reading === undefined ? "" : '"time":' + raw(reading) + ",") + '"outcome":"' + outcome + '"';
      if (payload !== undefined) end += ',"' + payload.key + '":' + payload.text;
      const line = this.head + end + "}" + extText(mergeExt(this.fields.ext, settleExtJson, payload?.notes)) + "}";
      this.move(OPEN, outcome === "abandoned" ? ABANDONED : SETTLED);
      this.owner.write(line);
    } else if (this.state === ABANDONED && outcome !== "abandoned") {
      this.move(ABANDONED, LATE);
      this.owner.write(this.lateSettlement(outcome, raw(reading as string), payload));
    }
  }

  /** The captured `output` Payload or `error` object, as wire text, with the notes it needs. */
  private capture(outcome: CrossingEndOptions["outcome"], output: unknown, error: ErrorInput | undefined): { key: "output" | "error"; text: string; notes: Notes | undefined } | undefined {
    const capture = this.owner.inst.capture;
    const target = this.fields.target;
    if (outcome === "output" && output !== undefined) {
      const c = capture.value("crossing.output", output, undefined, target);
      return { key: "output", text: c.text, notes: c.base64 ? note(undefined, "mocon.encoding", "output", "base64") : undefined };
    }
    if (outcome === "error" && error !== undefined) {
      const e = capture.error("crossing.error", error, undefined, target);
      let notes = e.base64 ? note(undefined, "mocon.encoding", "error.value", "base64") : undefined;
      if (e.messageTruncated) notes = note(notes, "mocon.message", "truncated", true);
      return { key: "error", text: e.text, notes };
    }
    return undefined;
  }

  /** The `late_settlement` event. `data.payload` has the shape `end.output` or `end.error` would have had. */
  private lateSettlement(outcome: "output" | "error", timeText: string, payload: { text: string; notes: Notes | undefined } | undefined): string {
    const inst = this.owner.inst;
    // Through `extJson`, not `JSON.stringify`: a `toJSON` on `Object.prototype` answers for any object.
    const notes = extText(extJson(payload?.notes));
    return (
      '{"kind":"event","host":' +
      inst.hostText +
      ',"id":' +
      raw(inst.ids.crossing()) +
      ',"execution_id":' +
      this.owner.idText +
      ',"crossing_id":' +
      this.fields.idText +
      ',"time":' +
      timeText +
      ',"name":"late_settlement","data":{"outcome":"' +
      outcome +
      '"' +
      (payload === undefined ? "" : ',"payload":' + payload.text) +
      "}" +
      notes +
      "}"
    );
  }
}
