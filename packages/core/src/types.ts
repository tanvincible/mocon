/**
 * Public types of @mocon/core.
 *
 * The wire types mirror spec/schema field for field. The handle types are
 * the emitter's surface. This file declares no runtime value; `index.ts`
 * exports the functions.
 */

/** Any JSON value. `null` is a value. Absence is `undefined`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Open map of namespaced keys, `vendor.key` (core.md 3). */
export type Ext = Record<string, JsonValue>;

/**
 * A captured value (core.md 5.4). Atomic: always whole within one line.
 * `bytes` and `hash` describe the host's serialization of the original,
 * never the prefix held in `value`. When `truncated` is `true`, `value` is
 * a string prefix of that serialization. A Payload without `value` sets
 * `truncated` or `redacted`. The union encodes those rules.
 */
export type Payload =
  | { value: JsonValue; truncated?: false; redacted?: boolean; bytes?: number; hash?: string }
  | { value: string; truncated: true; redacted?: boolean; bytes?: number; hash?: string }
  | { value?: undefined; truncated: true; redacted?: boolean; bytes?: number; hash?: string }
  | { value?: undefined; truncated?: boolean; redacted: true; bytes?: number; hash?: string };

/** An error on the wire (core.md 5.5). `class` is required. */
export interface ErrorObject {
  /** Open string. Recommended values are in spec/vocabulary.md. */
  class: string;
  message?: string;
  /** The raw error object as the host or target produced it. */
  value?: Payload;
}

/** Closed set (core.md 5.2). */
export type Disposition = "completed" | "failed" | "terminated" | "abandoned";

/** Closed set (core.md 5.1). */
export type ObservesCrossings = "all" | "some" | "none";

/** Closed set (core.md 5.1). */
export type CrossingEdge = "invocation" | "dispatch";

/** The `attested` entries spec 1.0 defines (provenance.md 4). */
export type Attestation =
  | "crossing.target"
  | "crossing.input"
  | "crossing.output"
  | "crossing.error"
  | "execution.error.class";

/** The capabilities declaration. Key `(host, "host")`. No `id`. */
export interface HostLine {
  kind: "host";
  host: string;
  /** `"MAJOR.MINOR"`. Absent reads as the consumer's own major. */
  spec_version?: string;
  /** Absent reads as `"none"`. */
  observes_crossings?: ObservesCrossings;
  /** Absent reads as unknown, which consumers treat like `true`. */
  unmediated_egress?: boolean;
  /** Absent reads as unknown. */
  crossing_edge?: CrossingEdge;
  /** Absent reads as `[]`. A consumer ignores an entry it does not know, so the wire type is open. */
  attested?: string[];
  ext?: Ext;
}

export interface ExecutionContext {
  /** Host-defined grouping under which executions are related. */
  session?: string;
  /** W3C `traceparent`, relayed from the caller unmodified and unverified. */
  traceparent?: string;
}

export interface ExecutionEnd {
  /** RFC 3339 UTC with `Z`, host clock. */
  time: string;
  disposition: Disposition;
  error?: ErrorObject;
  /** The value the host returned on its return channel. */
  result?: Payload;
  /** Channel name to Payload. Recommended names: stdout, stderr, logs, files. */
  outputs?: Record<string, Payload>;
}

interface ExecutionBase {
  kind: "execution";
  host: string;
  /** Unique within `(host, "execution")`. */
  id: string;
  /** `value` is the submitted text. A notice may omit it while the submission is still arriving. */
  program?: Payload;
  /** RFC 3339 UTC with `Z`, host clock. */
  start: string;
  /** Open string. A role hint, not a guarantee. */
  language?: string;
  context?: ExecutionContext;
  ext?: Ext;
}

/** A line without `end`. Optional. Carries the fields known when the record began. */
export interface ExecutionNotice extends ExecutionBase {
  end?: undefined;
}

/** A line with `end`. Carries every field the record has. Written exactly once. */
export interface ExecutionComplete extends ExecutionBase {
  program: Payload;
  end: ExecutionEnd;
}

export type ExecutionLine = ExecutionNotice | ExecutionComplete;

export interface CrossingContext {
  /** The execution's `traceparent`, copied onto the crossing. */
  traceparent?: string;
}

interface CrossingEndBase {
  /** The instant the host determined the outcome. RFC 3339 UTC with `Z`, host clock. */
  time?: string;
}

/** `output` only under `"output"`, `error` only under `"error"`, neither under `"abandoned"`. */
export type CrossingEnd =
  | (CrossingEndBase & { outcome: "output"; output?: Payload; error?: undefined })
  | (CrossingEndBase & { outcome: "error"; error?: ErrorObject; output?: undefined })
  | (CrossingEndBase & { outcome: "abandoned"; output?: undefined; error?: undefined });

interface CrossingBase {
  kind: "crossing";
  host: string;
  /** Unique within `(host, "crossing")`. */
  id: string;
  /** Id of an execution under the same host. */
  execution_id: string;
  /** Host-defined identifier on the declared edge. */
  target: string;
  /** Fixed at initiation. */
  input: Payload;
  /** Initiation order within the execution. */
  seq?: number;
  context?: CrossingContext;
  /** RFC 3339 UTC with `Z`, host clock. */
  start?: string;
  ext?: Ext;
}

/** A line without `end`. Optional. */
export interface CrossingNotice extends CrossingBase {
  end?: undefined;
}

/** A line with `end`. Written exactly once. */
export interface CrossingComplete extends CrossingBase {
  end: CrossingEnd;
}

export type CrossingLine = CrossingNotice | CrossingComplete;

/**
 * What the host declares about itself: the host line minus what the
 * instance fills in. `spec_version` is always the version this package
 * implements, because the package is what knows it. `attested` is
 * narrowed to the entries that version knows. `ext` is written on the
 * declaration; a differing re-declaration is a conflict (core.md 5.1).
 */
export type Capabilities = Omit<HostLine, "kind" | "host" | "spec_version" | "attested"> & {
  observes_crossings: ObservesCrossings;
  /** Only entries true of every record written under this host string. */
  attested?: Attestation[];
};

/** Which sink call failed. `lines` is the size of the batch for `"write"` and `0` otherwise. */
export type SinkPhase = "write" | "flush" | "close";

export interface MoconOptions {
  /** Opaque, recommended form `vendor/product[/profile]`. Scopes every id. */
  host: string;
  capabilities: Capabilities;
  /** Where lines go. With no sinks nothing is written, nothing is captured and every handle is inert. */
  sinks: Sink[];
  capture?: CapturePolicy;
  /**
   * Called when a sink throws from `write`, `flush` or `close`, when the
   * promise one of them returned rejects, and once per sink for a write
   * issued after `close`, which is dropped. Default: no-op. Never throws
   * into the host; the emitter attaches the handler to every write
   * promise synchronously, and a handler that returns a promise has its
   * rejection caught, so no rejection goes unhandled.
   */
  onError?: (error: unknown, context: { sink: Sink; lines: number; phase: SinkPhase }) => void;
}

export interface Mocon {
  readonly execution: {
    /** Writes the start notice, unless `notice: false` defers it, and returns the handle. */
    start(options: ExecutionStartOptions): ExecutionHandle;
    /**
     * The wrapper around an execute handler. Starts an execution, calls
     * `body` with its handle, and settles it: `complete({ result })` with
     * the return value, `fail(error)` with the thrown or rejected error.
     * Rethrows the exact error `body` threw. A native promise `body`
     * returns is followed through the intrinsic `then`, and `run` returns
     * the promise that call derives, which settles with the same value or
     * error; any other value, a thenable of another kind included, is
     * returned unchanged and recorded as the result. A body that ends the
     * handle itself wins, because a handle ignores every settlement after
     * the first.
     */
    run<T>(options: ExecutionStartOptions, body: (execution: ExecutionHandle) => T): T;
  };
  /**
   * Writes the host line again, byte for byte. A consumer treats the
   * re-send as a no-op (core.md 5.1). Call it after a sink's file was
   * rotated, so the new file starts with the declaration.
   */
  declare(): void;
  /** Resolves when every sink has accepted what was handed to it so far. */
  flush(): Promise<void>;
  /**
   * Marks the instance closed, then flushes and closes each sink, one sink's
   * close waiting only on its own flush. Writes from then on are dropped
   * and reported. A later call returns the first call's promise.
   */
  close(): Promise<void>;
}

/**
 * Receives lines: each one JSON object, no trailing newline, in the
 * order the emitter produced them, as a frozen array. `end` hands over
 * the abandoned crossings and the complete record in one call. The emitter
 * calls `write` on the request path but never awaits it there; a throw or
 * a rejection goes to `onError`. Until a write that carried the host
 * declaration has returned, or its promise has fulfilled, every batch the
 * sink receives starts with the declaration.
 */
export interface Sink {
  /** Returns nothing, or a promise; any other value is taken as a write that went through. */
  write(lines: readonly string[]): void | Promise<void>;
  /** Resolves when writes handed over so far have been accepted downstream. */
  flush?(): void | Promise<void>;
  /** Releases resources. Writes after close are dropped. */
  close?(): void | Promise<void>;
}

/** The places a Payload is written. `outputs` covers every channel. */
export type CaptureSlot =
  | "program"
  | "result"
  | "outputs"
  | "error"
  | "crossing.input"
  | "crossing.output"
  | "crossing.error";

/**
 * `"drop"` writes `{redacted: true}`. `"hash-only"` writes
 * `{redacted: true, bytes, hash}`, hashing the original read in full, up
 * to 8 MiB of serialization; past that the slot is `{redacted: true}`.
 */
export type CaptureDirective = "drop" | "hash-only";

export interface CaptureContext {
  slot: CaptureSlot;
  /** The channel name, for the `outputs` slot. */
  channel?: string;
  /** The crossing target, for crossing slots. */
  target?: string;
  /** The slot's cap in bytes, less when the line's budget has less left. */
  cap: number;
  /**
   * The default encoder under this slot's cap. The Payload comes back
   * frozen, and returning it unchanged writes exactly what the default
   * encoder writes, its `mocon.encoding` note included. With
   * `redacted: true` the result carries the flag and no `bytes` or `hash`,
   * because those would describe the replacement rather than the original.
   */
  capture(value: unknown, options?: { redacted?: boolean }): Payload;
}

/**
 * Returns what to write. A Payload is read once and written from the
 * fields read, `value` through the default encoder under the cap;
 * anything that is not a Payload counts as `"drop"`.
 */
export type CaptureFn = (value: unknown, context: CaptureContext) => Payload | CaptureDirective;

export type CaptureRule = CaptureDirective | CaptureFn;

/**
 * Caps, redaction and hashing in one place. A slot without a rule uses
 * the default encoder under its cap.
 */
export interface CapturePolicy {
  /**
   * Byte cap per slot: what the slot's `value` may add to a line, in UTF-8
   * bytes as written, escapes included. Every cap keeps a prefix.
   * `crossing.target` caps the target string itself, which is not a
   * Payload: a longer target is cut on a code point boundary and the
   * record's `ext` carries `"mocon.target": { "truncated": true }`.
   */
  caps?: Partial<Record<CaptureSlot | "crossing.target", number>>;
  /**
   * One rule per slot. `outputs` covers every channel and an error slot
   * covers the whole error but its class; a function rule tells targets
   * and channels apart through its context.
   */
  rules?: Partial<Record<CaptureSlot, CaptureRule>>;
}

export interface ExecutionStartOptions {
  /** The submitted text, in full. */
  program: string;
  language?: string;
  context?: ExecutionContext;
  ext?: Ext;
  /** Your own unique id. Default: 32 lowercase hex digits from 128 random bits. */
  id?: string;
  /** Your own host-clock reading of when you first observed the execution. Default: now. */
  start?: string;
  /**
   * Write the start notice now. Default: true. With `false` the notice is
   * written only when this handle writes a crossing line before `end`,
   * ahead of that line, so a crossing never reaches the stream without an
   * execution record for its dispatch (core.md 10).
   */
  notice?: boolean;
}

/**
 * Error fields as the host supplies them. `value` is raw and captured under
 * the error slot. `cause` is what the host caught: it becomes `message` and
 * `value` under the cause rule below, and a `message` or `value` given
 * beside it wins. `fail(cause)` is `end` with `error: { class, cause }`.
 */
export interface ErrorInput {
  class: string;
  message?: string;
  value?: unknown;
  cause?: unknown;
}

export interface SettleOptions {
  /**
   * Your own host-clock reading of the instant you determined the outcome.
   * A time before the record's `start` is refused with a RangeError.
   * Default: now, or the record's `start` when the clock reads earlier.
   */
  time?: string;
  /** Merged over the start `ext` key by key. A key given here wins. */
  ext?: Ext;
}

export interface CompleteOptions extends SettleOptions {
  result?: unknown;
  /** Channel name to raw value. */
  outputs?: Record<string, unknown>;
}

export interface ExecutionEndOptions extends CompleteOptions {
  disposition: Disposition;
  error?: ErrorInput;
}

export interface CrossingStartOptions {
  target: string;
  /** Raw. Captured under `crossing.input`. */
  input: unknown;
  /** Your own unique id. Default: 16 lowercase hex digits from 64 random bits. */
  id?: string;
  /**
   * Initiation order, an integer below 2^53 - 1. A handle counts from 1
   * and continues past any value given here.
   */
  seq?: number;
  /** Your own host-clock reading of initiation. Default: now. */
  start?: string;
  ext?: Ext;
  /** Write a start notice. Default: false. */
  notice?: boolean;
}

export type CrossingEndOptions = SettleOptions &
  (
    | { outcome: "output"; output?: unknown }
    | { outcome: "error"; error?: ErrorInput }
    | { outcome: "abandoned" }
  );

/*
 * The cause rule, shared by `ExecutionHandle.fail`, `CrossingHandle.error`
 * and `ErrorInput.cause` on either handle's `end`. `cause` is what the host
 * caught. It never throws: a getter or trap that throws costs the field it
 * guarded.
 *
 * - A native error from any realm: `message` is `cause.message` when
 *   that is a string; `value` is the plain object `{ name, message,
 *   stack, ...own enumerable properties, cause }` with absent fields
 *   omitted, a nested error converted the same way, and a cause chain
 *   cut after 32 levels, captured under the error slot and read no
 *   further than the slot's cap.
 * - A string, number, boolean, bigint or symbol: `message` is
 *   `String(cause)`; no `value`.
 * - `null` or `undefined`: no `message`, no `value`.
 * - Any other object, such as an MCP `isError` result or `{ok: false,
 *   status}`: `value` is `cause`, captured under the error slot;
 *   `message` is `cause.message` when that is a string.
 */

/** One crossing. The first settlement writes the record; later calls are ignored. */
export interface CrossingHandle {
  readonly id: string;
  output(value: unknown, options?: SettleOptions): void;
  /** `class` defaults to `"capability_error"`. `cause` follows the cause rule above. */
  error(cause: unknown, options?: SettleOptions & { class?: string }): void;
  end(options: CrossingEndOptions): void;
}

/**
 * How `instrument` derives a crossing from a call's arguments. The
 * functions run on every call, on arguments the program chose, and a
 * mistake in one costs the field it derives, never the call: the bridge
 * still runs and the crossing is still written.
 */
export interface InstrumentOptions<A extends unknown[]> {
  /**
   * The crossing target. A string names every call. A function derives it
   * from the arguments; what it returns goes through `String()` when it is
   * not a string, and when it throws the first argument does. Default: the
   * first argument, as is when it is a string and through `String()`
   * otherwise. A bridge shaped like `callTool({ name, arguments })` passes
   * `target` and `input` functions.
   */
  target?: string | ((...args: A) => string);
  /**
   * What to record as the input. Default: the arguments not used as the
   * target, unwrapped when there is exactly one. When the function throws,
   * the input is written as `{ redacted: true }`.
   */
  input?: (...args: A) => unknown;
  /**
   * An object, read once when `instrument` is called, or a function of the
   * arguments. A function that throws, or returns something that does not
   * serialize to an object, gives the `mocon.ext` redaction note.
   */
  ext?: Ext | ((...args: A) => Ext | undefined);
}

/**
 * One execution. `end` and its two shorthands write `abandoned` for every
 * crossing this handle opened and has not settled, then the complete
 * record. The first call writes; later calls are ignored.
 *
 * `ext` on `end`, `complete` and `fail` is merged over the start `ext` key
 * by key; the settle key wins. A crossing opened after `end` is not
 * tracked: it is written when it settles and may stay unresolved.
 */
export interface ExecutionHandle {
  readonly id: string;
  readonly crossing: {
    /** Opens a crossing. Writes a notice only with `notice: true`. */
    start(options: CrossingStartOptions): CrossingHandle;
  };
  /**
   * Wraps a bridge function. The wrapper forwards `this`, rethrows the
   * exact error the bridge threw, and carries the bridge's `name`,
   * `length` and own properties. Each call is one crossing: `output` on
   * return, `error` on throw. A native promise the bridge returns is
   * followed as `run` follows one, and the wrapper returns the promise the
   * intrinsic `then` derives from it; any other value, a thenable of
   * another kind, an iterator, a stream or a callback included, is
   * returned unchanged and recorded as the output at the moment the bridge
   * returned. `instrument` throws only for an option of the wrong type;
   * nothing a call's arguments do keeps the call from the bridge.
   */
  instrument<F extends (...args: any[]) => unknown>(fn: F, options?: InstrumentOptions<Parameters<F>>): F;
  complete(options?: CompleteOptions): void;
  /**
   * `class` defaults to `"runtime"`; use `"validation"` for a rejection
   * before the program ran. `cause` follows the cause rule above.
   */
  fail(cause: unknown, options?: CompleteOptions & { class?: string }): void;
  end(options: ExecutionEndOptions): void;
}
