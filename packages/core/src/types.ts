/** The wire types mirror spec/schema field for field. */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Open map of namespaced keys, `vendor.key` (core.md 3). */
export type Ext = Record<string, JsonValue>;

/** A captured value (core.md 5.4); the union encodes the rules there. */
export type Payload =
  | { value: JsonValue; truncated?: false; redacted?: boolean; bytes?: number; hash?: string }
  | { value: string; truncated: true; redacted?: boolean; bytes?: number; hash?: string }
  | { value?: undefined; truncated: true; redacted?: boolean; bytes?: number; hash?: string }
  | { value?: undefined; truncated?: boolean; redacted: true; bytes?: number; hash?: string };

/** An error on the wire (core.md 5.5). */
export interface ErrorObject {
  /** Recommended values in spec/vocabulary.md. */
  class: string;
  message?: string;
  value?: Payload;
}

/** Closed set (core.md 5.2). */
export type Disposition = "completed" | "failed" | "terminated" | "abandoned";

/** Closed set (core.md 5.1). */
export type ObservesCrossings = "all" | "some" | "none";

/** Closed set (core.md 5.1). */
export type CrossingEdge = "invocation" | "dispatch";

/** Closed set (core.md 5.1.1). Grows by minor version. */
export type Aggregation = "sum" | "last" | "none";

/** Closed set (core.md 5.1.1). Grows by minor version. */
export type Cardinality = "low" | "high";

/**
 * What one of this host's own `ext` keys means (core.md 5.1.1). Meaning,
 * never identity: an entry names an `ext` key and changes nothing about how
 * a core field is read.
 */
export interface Dimension {
  /** `sum` is additive, `last` is a level, `none` is not a quantity. */
  agg: Aggregation;
  /** Absent reads as `"1"`. Only under `sum` or `last`. */
  unit?: string;
  /** Absent reads as `"high"`. Only under `none`. */
  card?: Cardinality;
  /** Display name. Absent, a consumer displays the key. */
  name?: string;
  /**
   * The host determines the value where the program cannot write through.
   * It upgrades the key to host-observed only together with `ext.declared`
   * in `attested` (provenance.md 4).
   */
  observed?: boolean;
}

/** Closed set (extensions/links.md 5). Grows by minor version. */
export type LinkRel = "retry_of" | "replay_of" | "forked_from" | "continues";

/** Closed set (extensions/links.md 4). */
export type LinkCounts = "additive" | "duplicate";

/**
 * One causal relation this record has to an older one (extensions/links.md).
 * The newer record carries the link and points back.
 */
export interface Link {
  rel: LinkRel;
  /** Ids are unique only within `(host, kind)`. */
  kind: "execution" | "crossing";
  id: string;
  /** Whether this record's values are additional to the named record's. */
  counts: LinkCounts;
  /** Absent means this line's own host. */
  host?: string;
  /** Under `kind: "crossing"`; absent means this line's own execution. */
  execution_id?: string;
}

/** The `attested` entries spec 1.1 defines (provenance.md 4). */
export type Attestation =
  | "crossing.target"
  | "crossing.input"
  | "crossing.output"
  | "crossing.error"
  | "execution.error.class"
  /**
   * 1.1. Upgrades to host-observed exactly those `ext` keys whose `host.dimensions`
   * entry carries `observed: true`. Both gates are required, so attesting it while
   * declaring no observed dimension upgrades nothing (provenance.md 4).
   */
  | "ext.declared";

/** The capabilities declaration. Key `(host, "host")`, so no `id`. */
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
  /** Absent reads as `[]`. Open: unknown entries are ignored, not errors. */
  attested?: string[];
  /** Absent reads as `{}`. One entry per `ext` key (core.md 5.1.1). */
  dimensions?: Record<string, Dimension>;
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
  result?: Payload;
  /** Recommended channel names: stdout, stderr, logs, files. */
  outputs?: Record<string, Payload>;
}

interface ExecutionBase {
  kind: "execution";
  host: string;
  /** Unique within `(host, "execution")`. */
  id: string;
  /** The submitted text. A notice may omit it while the submission arrives. */
  program?: Payload;
  /** RFC 3339 UTC with `Z`, host clock. */
  start: string;
  /** A role hint, not a guarantee. */
  language?: string;
  context?: ExecutionContext;
  /** Causal relations to older records (extensions/links.md). */
  links?: Link[];
  ext?: Ext;
}

/** Optional (core.md 10). Carries the fields known when the record began. */
export interface ExecutionNotice extends ExecutionBase {
  end?: undefined;
}

/** Every field the record has, written exactly once (core.md 10). */
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
  /** When the host determined the outcome. RFC 3339 UTC `Z`, host clock. */
  time?: string;
}

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
  /** Causal relations to older records (extensions/links.md). */
  links?: Link[];
  ext?: Ext;
}

export interface CrossingNotice extends CrossingBase {
  end?: undefined;
}

/** Written exactly once (core.md 10). */
export interface CrossingComplete extends CrossingBase {
  end: CrossingEnd;
}

export type CrossingLine = CrossingNotice | CrossingComplete;

/**
 * `spec_version` is omitted: the package is what knows it. A re-declaration
 * with a differing `ext` is a conflict (core.md 5.1).
 */
export type Capabilities = Omit<HostLine, "kind" | "host" | "spec_version" | "attested"> & {
  observes_crossings: ObservesCrossings;
  /** Only entries true of every record written under this host string. */
  attested?: Attestation[];
};

/** `lines` is the batch size for `"write"` and `0` otherwise. */
export type SinkPhase = "write" | "flush" | "close";

export interface MoconOptions {
  /** Opaque, recommended form `vendor/product[/profile]`. Scopes every id. */
  host: string;
  capabilities: Capabilities;
  /** With no sinks nothing is written or captured; every handle is inert. */
  sinks: Sink[];
  capture?: CapturePolicy;
  /**
   * A sink throw or rejection from `write`, `flush` or `close`, and once per
   * sink for a write after `close`, which is dropped. Default: no-op. Attached
   * synchronously, and the handler's own rejection is caught, so no rejection
   * goes unhandled.
   */
  onError?: (error: unknown, context: { sink: Sink; lines: number; phase: SinkPhase }) => void;
}

export interface Mocon {
  readonly execution: {
    /** Writes the start notice unless `notice: false` defers it. */
    start(options: ExecutionStartOptions): ExecutionHandle;
    /**
     * Starts an execution, calls `body` with its handle, and settles it:
     * `complete({ result })` or `fail(error)`. Rethrows the exact error
     * `body` threw. A native promise is followed through the intrinsic
     * `then`; any other value, a thenable of another kind included, is
     * returned unchanged and recorded as the result. A body that ends the
     * handle itself wins: a handle ignores every settlement after the first.
     */
    run<T>(options: RunOptions, body: (execution: ExecutionHandle) => T): T;
  };
  /** Re-writes the host line byte for byte; a re-send is a no-op (5.1). */
  declare(): void;
  /** Resolves when every sink has accepted what was handed to it so far. */
  flush(): Promise<void>;
  /**
   * Flushes and closes each sink, one sink's close waiting only on its own
   * flush. Later writes are dropped and reported; a later call returns the
   * first call's promise.
   */
  close(): Promise<void>;
}

/**
 * One JSON object per line, no trailing newline, in emit order, as a frozen
 * array. `write` is called on the request path and never awaited there; a
 * throw or rejection goes to `onError`. Until a write carrying the host
 * declaration has returned or fulfilled, every batch starts with the
 * declaration (core.md 10).
 */
export interface Sink {
  /** Any return that is not a promise counts as a write that went through. */
  write(lines: readonly string[]): void | Promise<void>;
  /** Resolves when writes handed over so far have been accepted downstream. */
  flush?(): void | Promise<void>;
  /** Writes after close are dropped. */
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
   * The default encoder under this slot's cap; the Payload comes back
   * frozen. With `redacted: true` the result carries the flag and no
   * `bytes` or `hash`: those would describe the replacement, not the
   * original. With `full: true` the `value` runs to the slot's cap instead
   * of stopping at `capture.preview`: this is how full capture is opted
   * into, per target or per channel.
   */
  capture(value: unknown, options?: { redacted?: boolean; full?: boolean }): Payload;
}

/**
 * A Payload is read once and written from the fields read, `value` through
 * the default encoder under the cap. Anything else counts as `"drop"`.
 */
export type CaptureFn = (value: unknown, context: CaptureContext) => Payload | CaptureDirective;

export type CaptureRule = CaptureDirective | CaptureFn;

/** A slot without a rule uses the default encoder under its cap. */
export interface CapturePolicy {
  /**
   * How many bytes of a Payload's `value` reach the line. Default: 256. The
   * slot's cap still says how much is read, so a value over the preview and
   * under the cap is written as a prefix with the `bytes` and `hash` of the
   * whole. `ctx.capture(v, { full: true })` in a rule opts one value out,
   * and a preview at or above every cap restores full capture everywhere.
   */
  preview?: number;
  /**
   * What the slot's `value` may add to a line, in UTF-8 bytes as written,
   * escapes included; every cap keeps a prefix. `crossing.target` caps the
   * target string itself, not a Payload: it is cut on a code point boundary
   * and the record's `ext` carries `"mocon.target": { "truncated": true }`.
   */
  caps?: Partial<Record<CaptureSlot | "crossing.target", number>>;
  /**
   * `outputs` covers every channel; an error slot covers the whole error but
   * its `class`. A function rule tells them apart through its context.
   */
  rules?: Partial<Record<CaptureSlot, CaptureRule>>;
}

/**
 * `run`'s options: a start, plus the body's own answer shape turned into the
 * execution's end fields. A body that answers with a failure envelope instead of
 * throwing reads it here, the way `instrument` reads a bridge's answer. Default:
 * a return is `completed` with the value, a throw is `failed` with the cause.
 */
export interface RunOptions extends ExecutionStartOptions {
  end?: (value: unknown) => ExecutionEndOptions | undefined | void;
}

export interface ExecutionStartOptions {
  /** The submitted text, in full. */
  program: string;
  language?: string;
  context?: ExecutionContext;
  /**
   * What this run is to an older record: a retry, a replay, a fork, a
   * resumption. Read once here, written on the notice and on the complete
   * record (extensions/links.md 3).
   */
  links?: Link[];
  ext?: Ext;
  /** Default: 32 lowercase hex digits from 128 random bits. */
  id?: string;
  /** Host-clock reading of when you observed it. Default: now. */
  start?: string;
  /**
   * Default: true. With `false` the notice is written only when this handle
   * writes a crossing line before `end`, ahead of that line: a crossing
   * never reaches the stream without an execution record (core.md 10).
   */
  notice?: boolean;
}

/**
 * `value` is raw, captured under the error slot. `cause` is what the host
 * caught: it becomes `message` and `value` under the rule in `cause.ts`,
 * and a `message` or `value` given beside it wins.
 */
export interface ErrorInput {
  class: string;
  message?: string;
  value?: unknown;
  cause?: unknown;
}

export interface SettleOptions {
  /**
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
  /** Default: 16 lowercase hex digits from 64 random bits. */
  id?: string;
  /** An integer below 2^53 - 1. A handle counts from 1 and past any given. */
  seq?: number;
  /** Host-clock reading of initiation. Default: now. */
  start?: string;
  /** What this dispatch is to an older record (extensions/links.md). */
  links?: Link[];
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

/** The first settlement writes the record; later calls are ignored. */
export interface CrossingHandle {
  readonly id: string;
  output(value: unknown, options?: SettleOptions): void;
  /** `class` defaults to `"capability_error"`. `cause`: see `cause.ts`. */
  error(cause: unknown, options?: SettleOptions & { class?: string }): void;
  end(options: CrossingEndOptions): void;
}

/**
 * One call's answer, as the bridge gave it. `threw` is the discriminant, so
 * `answer.threw ? ... : answer.value` narrows `value` to what the bridge
 * returns, awaited when it returns a promise.
 */
export type BridgeAnswer<A extends unknown[], R = unknown> =
  | { args: A; threw: false; value: R; error?: undefined }
  | { args: A; threw: true; error: unknown; value?: undefined };

/**
 * These run on every call, on arguments the program chose: a mistake in one
 * costs the field it derives, never the call. The bridge still runs and the
 * crossing is still written.
 */
export interface InstrumentOptions<A extends unknown[], R = unknown> {
  /**
   * The bridge's own answer shape, turned into the crossing's end fields.
   * This is the mechanism; the default below is only the common case. A
   * bridge that never throws and answers with an error envelope reads it
   * here and returns `{ outcome: "error", error }`, and one that carries a
   * cost or a cache flag puts it in `ext` on the same object. Default: a
   * return is `output` with the value, a throw is `error` with the cause.
   */
  end?: (answer: BridgeAnswer<A, R>) => CrossingEndOptions | undefined | void;
  /**
   * A function derives the target from the arguments; a non-string return
   * goes through `String()`, and a throw falls back to the first argument.
   * Default: the first argument, through `String()` when not a string.
   */
  target?: string | ((...args: A) => string);
  /**
   * Default: the arguments not used as the target, unwrapped when there is
   * exactly one. A throw writes `{ redacted: true }`.
   */
  input?: (...args: A) => unknown;
  /**
   * An object, read once when `instrument` is called, or a function of the
   * arguments. A throw or a non-object return gives the `mocon.ext` note.
   */
  ext?: Ext | ((...args: A) => Ext | undefined);
}

/**
 * `end` and its two shorthands write `abandoned` for every crossing this
 * handle opened and has not settled, then the complete record (core.md 10).
 * The first call writes; later calls are ignored. A crossing opened after
 * `end` is not tracked: it is written when it settles and may stay
 * unresolved.
 */
export interface ExecutionHandle {
  readonly id: string;
  readonly crossing: {
    /** Writes a notice only with `notice: true`. */
    start(options: CrossingStartOptions): CrossingHandle;
  };
  /**
   * The wrapper forwards `this`, rethrows the exact error the bridge threw,
   * and carries its `name`, `length` and own properties. Each call is one
   * crossing. A native promise is followed as `run` follows one; any other
   * value, a thenable of another kind included, is returned unchanged and
   * recorded as the output at the moment the bridge returned. `instrument`
   * throws only for an option of the wrong type; nothing a call's arguments
   * do keeps the call from the bridge.
   */
  instrument<F extends (...args: any[]) => unknown>(fn: F, options?: InstrumentOptions<Parameters<F>, Awaited<ReturnType<F>>>): F;
  complete(options?: CompleteOptions): void;
  /** `class` defaults to `"runtime"`; `"validation"` before the program ran. */
  fail(cause: unknown, options?: CompleteOptions & { class?: string }): void;
  end(options: ExecutionEndOptions): void;
}
