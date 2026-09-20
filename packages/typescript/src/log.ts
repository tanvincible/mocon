/**
 * A tracer that writes to a logger instead of to a trace backend.
 *
 * The specification's contribution is the vocabulary: what a host observed, what the program
 * claimed, what it was allowed to see. None of that needs a trace store. But an emitter built on
 * the OpenTelemetry API needs *a* tracer, and the only ones that ship require an SDK, an exporter,
 * a collector and somewhere for spans to land. For a team whose telemetry is structured logs, that
 * pipeline is the entire cost of adoption and it dwarfs the two wrappers.
 *
 * So this implements the small slice of the API the emitter actually uses, and turns each finished
 * span into one flat record handed to a function you supply. No SDK, no exporter, no new backend.
 *
 * Deliberately flat, one record per span, rather than nesting crossings inside their execution. A
 * nested shape has to buffer children until the parent closes, and a crossing that starts after its
 * execution ended is then never flushed. That is not hypothetical: it was measured, and it lost
 * calls silently, which is the worst way to lose them. Flat records carry `parent_span_id`, so a
 * reader reassembles the tree by grouping rather than by trusting the writer's buffering.
 *
 * The same host code moves to a real trace pipeline later by passing a different tracer. Nothing
 * about the integration changes, which is the point: the decision to run tracing stays yours and
 * stays reversible.
 */

import { randomBytes } from "node:crypto";
import { types } from "node:util";
import type { Attributes, Context, HrTime, Span, SpanContext, SpanOptions, SpanStatus, TimeInput, Tracer } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { isEncoded } from "./capture.js";

/** One finished span, flattened. Values are whatever the attribute held, payloads decoded. */
export interface LogRecord {
  name: string;
  kind: "server" | "client" | "internal" | "producer" | "consumer";
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  /** RFC 3339, UTC, milliseconds. */
  start: string;
  duration_ms: number;
  /** Only when the emitter set one; `unset` is the default and is left out. */
  status?: "error" | "ok";
  /** The status description, which for this specification is a closed-vocabulary value. */
  status_message?: string;
  [attribute: string]: unknown;
}

export interface LogTracerOptions {
  /**
   * Called once per finished span, on the thread that ended it. Hand it to your logger. It must not
   * throw: a destination that fails must not fail the call it describes.
   */
  write: (record: LogRecord) => void;
  /**
   * Leave payload attributes as the JSON text a span attribute requires, instead of decoding them
   * back into values. Off by default, because a log record can hold a map and a reader wants one.
   */
  raw?: boolean;
}

const KINDS: Record<SpanKind, LogRecord["kind"]> = {
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "producer",
  [SpanKind.CONSUMER]: "consumer",
};

export function logTracer(options: LogTracerOptions | LogTracerOptions["write"]): Tracer {
  const o = typeof options === "function" ? { write: options } : options;
  if (o === null || typeof o !== "object" || typeof o.write !== "function") {
    throw new TypeError("mocon: logTracer needs a write function");
  }
  return new LogTracer(o.write, o.raw === true);
}

class LogTracer implements Tracer {
  constructor(
    private readonly write: (record: LogRecord) => void,
    private readonly raw: boolean,
  ) {}

  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    const parent = context === undefined ? undefined : trace.getSpan(context)?.spanContext();
    return new LogSpan(this.write, this.raw, name, options ?? {}, parent);
  }

  /** Present because `Tracer` declares it. The emitter never calls it. */
  startActiveSpan<T>(name: string, ...rest: unknown[]): T {
    const fn = rest[rest.length - 1] as (span: Span) => T;
    return fn(this.startSpan(name, rest.length > 1 ? (rest[0] as SpanOptions) : undefined));
  }
}

class LogSpan implements Span {
  private readonly ctx: SpanContext;
  private readonly attributes: Attributes = {};
  private readonly startMs: number;
  private status: SpanStatus = { code: SpanStatusCode.UNSET };
  private ended = false;

  constructor(
    private readonly write: (record: LogRecord) => void,
    private readonly raw: boolean,
    private readonly name: string,
    options: SpanOptions,
    parent: SpanContext | undefined,
  ) {
    this.kind = options.kind ?? SpanKind.INTERNAL;
    this.parent = parent;
    this.ctx = {
      traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      traceFlags: 1,
    };
    this.startMs = millis(options.startTime) ?? Date.now();
    if (options.attributes !== undefined) this.setAttributes(options.attributes);
  }

  private readonly kind: SpanKind;
  private readonly parent: SpanContext | undefined;

  spanContext(): SpanContext {
    return this.ctx;
  }

  setAttribute(key: string, value: unknown): this {
    if (!this.ended) this.attributes[key] = value as Attributes[string];
    return this;
  }

  setAttributes(attributes: Attributes): this {
    if (!this.ended) for (const key of Object.keys(attributes)) this.attributes[key] = attributes[key];
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (!this.ended) this.status = status;
    return this;
  }

  updateName(name: string): this {
    return this;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  /** The emitter records an error as attributes, never as an exception, so these are no-ops. */
  recordException(): void {}
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }

  end(endTime?: TimeInput): void {
    if (this.ended) return;
    this.ended = true;
    const endMs = millis(endTime) ?? Date.now();
    const record: LogRecord = {
      name: this.name,
      kind: KINDS[this.kind] ?? "internal",
      trace_id: this.ctx.traceId,
      span_id: this.ctx.spanId,
      start: iso(this.startMs),
      duration_ms: Math.max(0, endMs - this.startMs),
    };
    if (this.parent !== undefined) record.parent_span_id = this.parent.spanId;
    // The status carries load-bearing information this specification puts nowhere else: the
    // description is a closed-vocabulary value, and dropping it was the first mistake a
    // hand-written destination made when this was measured.
    if (this.status.code === SpanStatusCode.ERROR) record.status = "error";
    else if (this.status.code === SpanStatusCode.OK) record.status = "ok";
    if (this.status.message !== undefined) record.status_message = this.status.message;
    for (const key of Object.keys(this.attributes)) {
      const value = this.attributes[key];
      record[key] = !this.raw && typeof value === "string" && isEncoded(key) ? decode(value) : value;
    }
    try {
      this.write(record);
    } catch {
      // A destination that fails must not fail the call it describes.
    }
  }
}

/** A payload back to a value, or the text unchanged when it is not the JSON the emitter wrote. */
function decode(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const { isDate } = types;

/** A time outside the Date range has no ISO form, and losing the record over it is the worse loss. */
function iso(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function millis(time: TimeInput | undefined): number | undefined {
  if (time === undefined) return undefined;
  if (typeof time === "number") return time;
  // `isDate` rather than `instanceof Date`: a Date built inside a sandbox belongs to that realm and
  // fails the identity check here. Anything that is neither reads as no time rather than destructuring
  // a value that is not a pair, which threw `time is not iterable` straight into the caller.
  if (isDate(time)) return time.getTime();
  if (!Array.isArray(time)) return undefined;
  const [seconds, nanos] = time as HrTime;
  return seconds * 1000 + nanos / 1e6;
}
