/**
 * @mocon/trace: the two wrappers of `spec/otel-code-mode.md`, on the OpenTelemetry API.
 *
 * Wrapper one goes around the handler that runs a program, wrapper two around the function the
 * sandbox calls to reach the host. Both write the capability declaration on every span they start.
 *
 * The package depends on the OpenTelemetry API and never the SDK, which is OpenTelemetry's own rule
 * for instrumentation and the reason this is worth doing: the host emits through the API and the
 * application owner's already-configured exporters receive it, with no new destination to wire.
 */

import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { Capture, type CapturePolicy, writeNotes, type Notes } from "./capture.js";
import { type Capabilities, declaration } from "./declare.js";
import { type Labels, label, labels } from "./provenance.js";
import type { Attestation } from "./declare.js";
import { type Attributes, type Context, context as activeContext, type HrTime, type Span, SpanKind, SpanStatusCode, type TimeInput, type Tracer, trace } from "@opentelemetry/api";

export type { Attestation, Capabilities, CrossingEdge, Observes } from "./declare.js";
export type { CapturePolicy } from "./capture.js";

const NAME = "@mocon/trace";
const VERSION = "0.1.0";
/** The version of `spec/otel-code-mode.md` these spans are written against. */
export const CONVENTIONS_VERSION = "0.1.0";

export type Disposition = "completed" | "failed" | "terminated" | "abandoned";
export type Outcome = "output" | "error" | "abandoned";

const DISPOSITIONS: ReadonlySet<unknown> = new Set<Disposition>(["completed", "failed", "terminated", "abandoned"]);
const OUTCOMES: ReadonlySet<unknown> = new Set<Outcome>(["output", "error", "abandoned"]);
/** 4.1: the two dispositions that set Status `Error`. Everything else, `abandoned` included, is `Unset`. */
const ERRORED: ReadonlySet<unknown> = new Set<Disposition>(["failed", "terminated"]);
/** The well-known fallback for `error.type`, for a host with a failure and no reason it can name. */
const OTHER = "_OTHER";
/** How a host classed its own attributes: observed by it, relayed from a target, or neither. */
interface HostClasses {
  observed: ReadonlySet<string>;
  relayed: ReadonlySet<string>;
}

/** The namespaces section 8 reserves. A host's own attributes go in the host's own namespace. */
const RESERVED = ["code_mode.", "gen_ai.", "mcp.", "otel."];

/**
 * A host's own attributes, with any key inside a reserved namespace dropped. Section 8 states the
 * rule; enforcing it here is what keeps a host attribute from overwriting the declaration or the
 * disposition, which on a host whose attributes are built from the program's own output would be a
 * channel the program rewrites its own trace through. Dropped rather than refused: no emitter fault
 * may raise into the caller.
 */
/**
 * Labels every field a consumer must not read as fact: the fixed table for this span kind, plus the
 * host's own keys, which are program-determined unless the host both attested `host_attributes` and
 * named them. Absence of a label means host-observed, so a field this misses under-claims.
 */
function mark(attrs: Attributes, map: Labels["execution"], host: HostClasses): void {
  label(attrs as Record<string, unknown>, map);
  for (const key of Object.keys(attrs)) {
    if (RESERVED.some((prefix) => key.startsWith(prefix)) || key === "error.type") continue;
    if (host.observed.has(key)) continue;
    attrs["code_mode.provenance." + key] = host.relayed.has(key) ? "T" : "P";
  }
}

function hostAttributes(given: Attributes | undefined): Attributes {
  const out: Attributes = {};
  if (given === undefined) return out;
  try {
    for (const key of Object.keys(given)) {
      if (!RESERVED.some((prefix) => key.startsWith(prefix))) out[key] = given[key];
    }
  } catch {
    // A throwing getter or `ownKeys` trap costs the attributes it hid and nothing else. Whatever was
    // read before the throw is kept.
  }
  return out;
}

/**
 * The channel map read once, under a guard, before anything is written: a map whose getter throws
 * must not throw out of the host's own `complete()`. The values are captured afterwards, each under
 * the capture guard. A container that is not an object at all is the host's own bug, refused here
 * while the span is still untouched.
 */
function readChannels(outputs: Record<string, unknown>): Array<[string, unknown]> {
  if (outputs === null || typeof outputs !== "object") throw new TypeError("@mocon/trace: outputs must be an object");
  const pairs: Array<[string, unknown]> = [];
  try {
    for (const channel of Object.keys(outputs)) pairs.push([channel, outputs[channel]]);
  } catch {
    // Whatever was read before the throw still counts.
  }
  return pairs;
}

const { isPromise } = types;
const promiseThen = Promise.prototype.then;

/** Epoch time as OpenTelemetry's `[seconds, nanoseconds]`, at `performance.now()`'s resolution. */
function hrNow(): HrTime {
  const ms = performance.timeOrigin + performance.now();
  let seconds = Math.trunc(ms / 1000);
  let nanos = Math.round((ms - seconds * 1000) * 1e6);
  if (nanos >= 1e9) {
    seconds += 1;
    nanos -= 1e9;
  }
  return [seconds, nanos];
}

export interface CodeModeOptions {
  capabilities: Capabilities;
  /** Default: this package's own tracer. Pass one to name your own instrumentation scope. */
  tracer?: Tracer;
  capture?: CapturePolicy;
}

export interface CodeMode {
  execution: {
    start(options: ExecutionStartOptions): ExecutionHandle;
    run<T>(options: RunOptions, body: (execution: ExecutionHandle) => T): T;
  };
}

export interface ExecutionStartOptions {
  /** The text the host dispatched. Always hashed; written only when capture values are on. */
  program: string;
  /** A role hint for display and routing. Omit rather than guess: a host may not know it. */
  language?: string;
  /** `server` when the dispatch arrived over a wire from an agent process, `local` when in-process. */
  kind?: "server" | "local";
  /** The name of the code-mode tool, when the dispatch arrived as a named tool call. */
  tool?: string;
  toolCallId?: string;
  /** Only when the host's grouping really is a conversation or agent session. Never a container id. */
  conversationId?: string;
  /** The MCP session id, when the dispatch arrived over MCP in a session. */
  sessionId?: string;
  /** The host's own id, which is the one in its logs. The span id is the SDK's and is not that. */
  id?: string;
  /**
   * The caller's context, as the host's own propagator extracted it from the incoming request.
   * It MUST NOT come from inside the sandbox: a program that supplies its own would choose where
   * its execution appears in the trace, and could attach its records to another tenant's.
   */
  parent?: Context;
  /** The host's own attributes, in the host's own namespace. Program-determined unless attested. */
  attributes?: Attributes;
  startTime?: TimeInput;
}

export interface RunOptions extends ExecutionStartOptions {
  /**
   * A host whose body answers with a failure envelope rather than a throw reads it here, the way
   * `instrument` reads a bridge's answer. Without it every such run settles `completed`, which is
   * wrong in the direction nothing complains about.
   */
  end?: (value: unknown) => ExecutionEndOptions | undefined | void;
}

export interface ExecutionEndOptions {
  disposition: Disposition;
  /** Written when the disposition sets Status `Error`; `_OTHER` when the host gives none. */
  errorType?: string;
  /** The human-readable reason. Opt-In, and labelled a program claim: usually the program's words. */
  message?: string;
  /** What the host returned on its return channel. Opt-In. */
  result?: unknown;
  /** One entry per captured channel: `stdout`, `stderr`, `logs`, `files`. Opt-In. */
  outputs?: Record<string, unknown>;
  /** The raw error object as the host produced it. Opt-In. */
  errorBody?: unknown;
  attributes?: Attributes;
  endTime?: TimeInput;
}

export interface ExecutionHandle {
  readonly span: Span;
  /** The execution span's context, for a bridge the host serves in another async task or process. */
  readonly context: Context;
  readonly crossing: { start(options: CrossingStartOptions): CrossingHandle };
  instrument<F extends (...args: any[]) => unknown>(fn: F, options?: InstrumentOptions<Parameters<F>>): F;
  complete(options?: Omit<ExecutionEndOptions, "disposition">): void;
  /** `errorType` defaults to `runtime`; pass `validation` for a rejection before the program ran. */
  fail(cause: unknown, options?: Omit<ExecutionEndOptions, "disposition" | "errorType"> & { errorType?: string }): void;
  end(options: ExecutionEndOptions): void;
}

export interface CrossingStartOptions {
  /** Whatever the host uses to name what was invoked. Uncut, and this document does not read it. */
  target: string;
  /** Fixed at initiation. Opt-In. */
  input?: unknown;
  /** The host's own id for this crossing. */
  id?: string;
  /** Initiation order from 1. Assigned automatically under `observes_crossings: all`. */
  seq?: number;
  toolType?: string;
  /** Set when the host forwards toward a remote target; `local` when it serves the call itself. */
  kind?: "client" | "local";
  /** A bounded span name for a host whose targets are unbounded. The full target stays an attribute. */
  name?: string;
  /**
   * Whether the host sent this call toward its target. Always the host's own knowledge. Set it
   * `false` on a refusal the host answered itself, a cache hit, or anything else that never left
   * the process: without it an operator reading an error has no way to tell a target that failed
   * from a call that never reached one.
   */
  dispatched?: boolean;
  /** The crossing went over MCP and this span is the only span for it. */
  mcp?: { method: string; session?: string; resourceUri?: string };
  attributes?: Attributes;
  startTime?: TimeInput;
}

export interface CrossingEndOptions {
  outcome: Outcome;
  /** Only under outcome `output`. Opt-In. */
  output?: unknown;
  errorType?: string;
  message?: string;
  errorBody?: unknown;
  attributes?: Attributes;
  /** Absent under `abandoned` closes the span at its start, which is what `start_only` means. */
  endTime?: TimeInput;
  /** As on the start options, for a host that only learns it at settlement. */
  dispatched?: boolean;
}

export interface CrossingHandle {
  readonly span: Span;
  output(value?: unknown, options?: Omit<CrossingEndOptions, "outcome" | "output">): void;
  /** `errorType` defaults to `capability_error`. */
  error(cause: unknown, options?: Omit<CrossingEndOptions, "outcome">): void;
  end(options: CrossingEndOptions): void;
}

/** One call's answer, as the bridge gave it. `threw` is the discriminant. */
export type BridgeAnswer<A extends unknown[]> =
  | { args: A; threw: false; value: unknown; error?: undefined }
  | { args: A; threw: true; error: unknown; value?: undefined };

export interface InstrumentOptions<A extends unknown[]> {
  /** A function derives the target from the arguments. Default: the first argument, stringified. */
  target?: string | ((...args: A) => string);
  /** Default: the arguments not used as the target, unwrapped when there is exactly one. */
  input?: (...args: A) => unknown;
  /** The bridge's own answer shape as the crossing's end. Default: a return is `output`, a throw `error`. */
  end?: (answer: BridgeAnswer<A>) => CrossingEndOptions | undefined | void;
  toolType?: string;
  attributes?: Attributes;
}

export function codeMode(options: CodeModeOptions): CodeMode {
  if (options === null || typeof options !== "object") throw new TypeError("@mocon/trace: options are required");
  const declared = declaration(options.capabilities);
  const capture = new Capture(options.capture);
  const tracer = options.tracer ?? trace.getTracer(NAME, VERSION);
  const ordered = declared["code_mode.observes_crossings"] === "all";
  // Read back from the frozen declaration, never from the caller's object a second time: a getter
  // that answered the closed-set check with one value could otherwise answer this with another.
  const marks = labels((declared["code_mode.attested"] ?? []) as Attestation[]);
  const host: HostClasses = {
    observed: new Set((declared["code_mode.attested_attributes"] ?? []) as string[]),
    relayed: new Set((declared["code_mode.relayed_attributes"] ?? []) as string[]),
  };

  const start = (o: ExecutionStartOptions): ExecutionHandle =>
    new ExecutionSpan(tracer, declared, capture, ordered, marks, host, o);

  const run = <T>(o: RunOptions, body: (execution: ExecutionHandle) => T): T => {
    const execution = start(o);
    const settle = (value: unknown): void => {
      if (o.end !== undefined) {
        try {
          const given = o.end(value);
          if (given !== null && typeof given === "object") {
            execution.end(given);
            return;
          }
        } catch {
          // `end` validates before it touches the span, so the execution is still open below.
        }
      }
      execution.complete({ result: value });
    };
    // Activates the span so that OTHER instrumentation running inside the body nests under it. This
    // only takes effect when the application has registered a context manager: `NodeSDK` does,
    // `BasicTracerProvider.register()` does not, and with the API's default `NoopContextManager`
    // the call is a no-op. Our own crossings are unaffected either way, because they are given
    // their parent explicitly rather than read from the active context.
    return activeContext.with(execution.context, () => {
      let out: T;
      try {
        out = body(execution);
      } catch (e) {
        execution.fail(e);
        throw e;
      }
      return follow(out, settle, (e) => execution.fail(e));
    });
  };

  return { execution: { start, run } };
}

class ExecutionSpan implements ExecutionHandle {
  readonly span: Span;
  readonly context: Context;
  readonly crossing: ExecutionHandle["crossing"];
  private readonly open = new Set<CrossingSpan>();
  /** Repeated onto every crossing: parentage carries a span id, never the id in the host's logs. */
  private readonly ownId: string;
  private readonly notes: Notes = {};
  private seq = 0;
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    private readonly declared: Readonly<Attributes>,
    private readonly capture: Capture,
    private readonly ordered: boolean,
    private readonly marks: Labels,
    private readonly host: HostClasses,
    o: ExecutionStartOptions,
  ) {
    const program = o.program;
    if (typeof program !== "string") throw new TypeError("@mocon/trace: program must be a string");
    // 4.2: Required, so one is minted when the host has none. A minted id still answers "the
    // crossings of this execution", which is the query that silently returned nothing without it.
    // It cannot match a host log line, which is why a host that has an id should pass it.
    this.ownId = typeof o.id === "string" && o.id !== "" ? o.id : randomBytes(8).toString("hex");
    const attributes: Attributes = { ...hostAttributes(o.attributes), "gen_ai.operation.name": "execute_code", ...this.declared };
    this.capture.program(program, attributes, this.notes);
    attributes["code_mode.execution.id"] = this.ownId;
    put(attributes, "code_mode.program.language", o.language);
    put(attributes, "gen_ai.tool.name", o.tool);
    put(attributes, "gen_ai.tool.call.id", o.toolCallId);
    put(attributes, "gen_ai.conversation.id", o.conversationId);
    put(attributes, "mcp.session.id", o.sessionId);
    mark(attributes, this.marks.execution, this.host);
    const parent = o.parent ?? activeContext.active();
    this.span = this.tracer.startSpan(
      o.tool === undefined ? "execute_code" : "execute_code " + o.tool,
      { kind: o.kind === "local" ? SpanKind.INTERNAL : SpanKind.SERVER, attributes, startTime: o.startTime },
      parent,
    );
    this.context = trace.setSpan(parent, this.span);
    this.crossing = { start: (options) => this.startCrossing(options) };
  }

  complete(options?: Omit<ExecutionEndOptions, "disposition">): void {
    this.end({ ...options, disposition: "completed" });
  }

  fail(cause: unknown, options?: Omit<ExecutionEndOptions, "disposition" | "errorType"> & { errorType?: string }): void {
    this.end({
      errorType: "runtime",
      message: messageOf(cause),
      errorBody: cause,
      ...options,
      disposition: "failed",
    });
  }

  end(options: ExecutionEndOptions): void {
    const { disposition, errorType, message, result, outputs, errorBody, attributes, endTime } = options;
    if (!DISPOSITIONS.has(disposition)) throw new RangeError(`@mocon/trace: unknown disposition ${JSON.stringify(disposition)}`);
    // Read before any state changes, so a refusal leaves the span exactly as it was.
    const channels = outputs === undefined ? undefined : readChannels(outputs);
    if (this.ended) return;
    this.ended = true;
    // 5: every crossing still open is closed before the execution span ends, so a reader never sees
    // a crossing outlive the execution that owns it.
    for (const crossing of [...this.open]) crossing.abandon();
    const attrs: Attributes = { ...hostAttributes(attributes), "code_mode.execution.disposition": disposition };
    if (result !== undefined) this.capture.value("gen_ai.tool.call.result", result, attrs, this.notes);
    if (channels !== undefined) {
      for (const [channel, value] of channels) this.capture.value("code_mode.output." + channel, value, attrs, this.notes);
    }
    if (errorBody !== undefined) this.capture.value("code_mode.error.body", errorBody, attrs, this.notes);
    if (ERRORED.has(disposition)) {
      const type = errorType ?? OTHER;
      attrs["error.type"] = type;
      if (message !== undefined) this.capture.value("code_mode.error.message", message, attrs, this.notes);
      // 4.1: the description is the one field that cannot carry a provenance label, so it carries a
      // closed-vocabulary host-observed value and never the program's words.
      this.span.setStatus({ code: SpanStatusCode.ERROR, message: type });
    }
    writeNotes(attrs, this.notes);
    mark(attrs, this.marks.execution, this.host);
    this.span.setAttributes(attrs);
    this.span.end(endTime);
  }

  instrument<F extends (...args: any[]) => unknown>(fn: F, options?: InstrumentOptions<Parameters<F>>): F {
    if (typeof fn !== "function") throw new TypeError("@mocon/trace: instrument() takes a function");
    const { target, input, end, toolType, attributes } = readInstrument(options);
    const execution = this;
    const wrapped = function (this: unknown, ...args: Parameters<F>): unknown {
      const crossing = execution.startCrossing({
        target: targetFrom(target, args),
        input: inputFrom(input, target === undefined, args),
        ...(toolType === undefined ? {} : { toolType }),
        ...(attributes === undefined ? {} : { attributes }),
      });
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (e) {
        settleCrossing(crossing, end, { args, threw: true, error: e });
        throw e;
      }
      return follow(
        result,
        (value) => settleCrossing(crossing, end, { args, threw: false, value }),
        (error) => settleCrossing(crossing, end, { args, threw: true, error }),
      );
    };
    Object.defineProperties(wrapped, {
      name: { value: fn.name, configurable: true },
      length: { value: fn.length, configurable: true },
    });
    return wrapped as F;
  }

  /** Called by a crossing when it ends, so the execution stops tracking it. */
  release(crossing: CrossingSpan): void {
    this.open.delete(crossing);
  }

  private startCrossing(o: CrossingStartOptions): CrossingHandle {
    const target = o.target;
    if (typeof target !== "string") throw new TypeError("@mocon/trace: crossing target must be a string");
    // `seq` is auto-assigned only under `all`, which is the declaration that says the host mediates
    // every call and therefore has an initiation order to report. A supplied value that is not a
    // positive integer is refused rather than written: it carries C10, so a consumer orders crossings
    // by it, and a wrong order is worse than no order. The refusal falls back to the counter, and
    // costs the value rather than the call.
    const given = o.seq;
    const usable = typeof given === "number" && Number.isInteger(given) && given > 0;
    const seq = usable ? given : this.ordered ? ++this.seq : undefined;
    const crossing = new CrossingSpan(this.tracer, this.declared, this.capture, this.context, this, target, seq, this.ownId, this.marks, this.host, o);
    if (!this.ended) this.open.add(crossing);
    return crossing;
  }
}

class CrossingSpan implements CrossingHandle {
  readonly span: Span;
  private readonly notes: Notes = {};
  private readonly start: HrTime;
  private ended = false;

  constructor(
    tracer: Tracer,
    declared: Readonly<Attributes>,
    private readonly capture: Capture,
    parent: Context,
    private readonly execution: ExecutionSpan,
    target: string,
    seq: number | undefined,
    executionId: string,
    private readonly marks: Labels,
    private readonly host: HostClasses,
    o: CrossingStartOptions,
  ) {
    const attributes: Attributes = {
      ...hostAttributes(o.attributes),
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": target,
      ...declared,
    };
    if (seq !== undefined) attributes["code_mode.crossing.seq"] = seq;
    put(attributes, "code_mode.execution.id", executionId);
    if (typeof o.dispatched === "boolean") attributes["code_mode.crossing.dispatched"] = o.dispatched;
    put(attributes, "gen_ai.tool.call.id", o.id);
    put(attributes, "gen_ai.tool.type", o.toolType);
    if (o.mcp !== undefined) {
      put(attributes, "mcp.method.name", o.mcp.method);
      put(attributes, "mcp.session.id", o.mcp.session);
      put(attributes, "mcp.resource.uri", o.mcp.resourceUri);
    }
    if (o.input !== undefined) this.capture.value("gen_ai.tool.call.arguments", o.input, attributes, this.notes);
    mark(attributes, this.marks.crossing, this.host);
    this.start = o.startTime === undefined ? hrNow() : toHrTime(o.startTime);
    this.span = tracer.startSpan(
      o.name ?? "execute_tool " + target,
      { kind: o.kind === "local" ? SpanKind.INTERNAL : SpanKind.CLIENT, attributes, startTime: this.start },
      parent,
    );
  }

  output(value?: unknown, options?: Omit<CrossingEndOptions, "outcome" | "output">): void {
    this.end({ ...options, outcome: "output", output: value });
  }

  error(cause: unknown, options?: Omit<CrossingEndOptions, "outcome">): void {
    this.end({ errorType: "capability_error", message: messageOf(cause), errorBody: cause, ...options, outcome: "error" });
  }

  /** The execution ended first: 5.4's `start_only`, closed where it began, with no outcome determined. */
  abandon(): void {
    this.end({ outcome: "abandoned" });
  }

  end(options: CrossingEndOptions): void {
    const { outcome, output, errorType, message, errorBody, attributes, endTime } = options;
    if (!OUTCOMES.has(outcome)) throw new RangeError(`@mocon/trace: unknown outcome ${JSON.stringify(outcome)}`);
    if (this.ended) return;
    this.ended = true;
    this.execution.release(this);
    const attrs: Attributes = { ...hostAttributes(attributes), "code_mode.crossing.outcome": outcome };
    if (typeof options.dispatched === "boolean") attrs["code_mode.crossing.dispatched"] = options.dispatched;
    // 5.4: a span always has two times, so a host with no end time closes the span at its start and
    // says so. A consumer MUST NOT read that zero duration as how long the crossing took.
    let close: TimeInput | undefined = endTime;
    if (close === undefined && outcome === "abandoned") {
      close = this.start;
      attrs["code_mode.crossing.timing"] = "start_only";
    }
    if (outcome === "output" && output !== undefined) this.capture.value("gen_ai.tool.call.result", output, attrs, this.notes);
    if (outcome === "error") {
      const type = errorType ?? OTHER;
      attrs["error.type"] = type;
      if (message !== undefined) this.capture.value("code_mode.error.message", message, attrs, this.notes);
      if (errorBody !== undefined) this.capture.value("code_mode.error.body", errorBody, attrs, this.notes);
      this.span.setStatus({ code: SpanStatusCode.ERROR, message: type });
    }
    writeNotes(attrs, this.notes);
    mark(attrs, this.marks.crossing, this.host);
    this.span.setAttributes(attrs);
    this.span.end(close);
  }
}

/**
 * The crossing's end, from the bridge's own answer when the hook supplied one and from the default
 * otherwise. A hook that throws, returns nothing, or returns a shape `end` refuses costs the reading
 * and never the call: the default outcome still records the crossing.
 */
function settleCrossing<A extends unknown[]>(crossing: CrossingHandle, end: InstrumentOptions<A>["end"], answer: BridgeAnswer<A>): void {
  if (end !== undefined) {
    try {
      const given = end(answer);
      if (given !== null && typeof given === "object") {
        crossing.end(given);
        return;
      }
    } catch {
      // `end` validates before it touches the span, so the crossing is still open for the default.
    }
  }
  if (answer.threw) crossing.error(answer.error);
  else crossing.output(answer.value);
}

/** Only a native promise is followed; any other thenable is returned unchanged and settled now. */
function follow<T>(result: T, onValue: (value: unknown) => void, onError: (error: unknown) => void): T {
  if (!isPromise(result)) {
    onValue(result);
    return result;
  }
  try {
    return promiseThen.call(
      result,
      (value: unknown) => {
        onValue(value);
        return value;
      },
      (error: unknown) => {
        onError(error);
        throw error;
      },
    ) as T;
  } catch (e) {
    // Reading the promise's `constructor` threw, as `await` on it would too.
    onError(e);
    return result;
  }
}

function readInstrument<A extends unknown[]>(options: InstrumentOptions<A> | undefined): InstrumentOptions<A> {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object") throw new TypeError("@mocon/trace: instrument() options must be an object");
  const { target, input, end, toolType, attributes } = options;
  if (target !== undefined && typeof target !== "string" && typeof target !== "function") throw new TypeError("@mocon/trace: instrument() target must be a string or a function");
  if (input !== undefined && typeof input !== "function") throw new TypeError("@mocon/trace: instrument() input must be a function");
  if (end !== undefined && typeof end !== "function") throw new TypeError("@mocon/trace: instrument() end must be a function");
  return { target, input, end, toolType, attributes };
}

/** A derive runs on arguments the program chose: a mistake in one costs the field, never the call. */
function targetFrom<A extends unknown[]>(target: InstrumentOptions<A>["target"], args: A): string {
  if (typeof target === "string") return target;
  let value: unknown = args[0];
  if (typeof target === "function") {
    try {
      value = target(...args);
    } catch {
      // The target function could not read these arguments; the first argument names the call.
    }
  }
  return nameOf(value);
}

/**
 * A target's name, never by running the value's own `toString`. The arguments a bridge is called
 * with are chosen by the program, so `String(value)` on one of them is program code on the host's
 * request path, and a hostile `toString` would fail the call rather than the label.
 */
function nameOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && (typeof value === "object" || typeof value === "function")) return "[" + typeof value + "]";
  return String(value);
}

function inputFrom<A extends unknown[]>(input: InstrumentOptions<A>["input"], targetTookFirst: boolean, args: A): unknown {
  if (input !== undefined) {
    try {
      return input(...args);
    } catch {
      return undefined;
    }
  }
  const rest = targetTookFirst ? args.slice(1) : [...args];
  return rest.length === 1 ? rest[0] : rest.length === 0 ? undefined : rest;
}

function messageOf(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : undefined;
}

function put(attrs: Attributes, key: string, value: string | undefined): void {
  if (typeof value === "string" && value !== "") attrs[key] = value;
}

function toHrTime(time: TimeInput): HrTime {
  if (Array.isArray(time)) return time;
  const ms = time instanceof Date ? time.getTime() : (time as number);
  const seconds = Math.trunc(ms / 1000);
  return [seconds, Math.round((ms - seconds * 1000) * 1e6)];
}
