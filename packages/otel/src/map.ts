/**
 * One mocon line to one OTLP span, otel-mapping.md sections 3 and 5 to 11,
 * over the wire shape declared at the top of this file. Everything here is
 * a pure function of the line's text, the host declaration the caller holds
 * for that host string, the receipt clock for a crossing with no times, and
 * the string cap.
 */

import type { HostLine } from "@mocon/core";
import { CLOSED, unixNanos } from "@mocon/core/fold";
import { crossingSpanIdOf, executionSpanIdOf, parseTraceparent, traceIdOf } from "./ids.js";
import { keysOf, parse, stringify, type KeyOrder } from "./json.js";

/* ------------------------------------------------------------------ */
/* The OTLP/JSON trace shape                                           */
/*                                                                     */
/* The part of it this package writes, in the protobuf JSON mapping:   */
/* ids as hex strings, times and int64 values as decimal strings,      */
/* enums as integers. Declared here so the package needs no            */
/* OpenTelemetry dependency.                                           */
/* ------------------------------------------------------------------ */

export type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  /** A number outside the finite range is the proto3 JSON string, `"Infinity"` or `"-Infinity"`. */
  | { doubleValue: number | "Infinity" | "-Infinity" }
  | { arrayValue: { values: AnyValue[] } };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

/** `code` is 0 (UNSET), 1 (OK) or 2 (ERROR). */
export interface Status {
  code: 0 | 1 | 2;
  message?: string;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
}

/** `kind` is 1 (INTERNAL) for an execution and 3 (CLIENT) for a crossing. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1 | 3;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: Status;
  links?: SpanLink[];
}

export interface ScopeSpans {
  scope: { name: string };
  spans: Span[];
}

export interface ResourceSpans {
  resource: { attributes: KeyValue[] };
  scopeSpans: ScopeSpans[];
}

export interface ExportTraceServiceRequest {
  resourceSpans: ResourceSpans[];
}

/** Why a line produced no span. A host line produces none and has no reason. */
export type SkipReason = "notice" | "malformed" | "unknown_kind" | "bad_enum" | "bad_timestamp";

export type Mapped =
  | { kind: "span"; host: string; span: Span }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "host"; declaration: HostLine };

/** The declaration the caller holds for a host string, if any, already known to be of this package's major version. */
type Declarations = (host: string) => HostLine | undefined;

type Rec = Record<string, unknown>;
/** A provenance label to write, or `undefined` for a host-observed field, which gets none. */
type Label = "P" | "T" | undefined;

const INT64 = 2 ** 63;
const NAME_CODE_POINTS = 128;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number | bigint => typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v) && v < INT64 && v >= -INT64);
const str = (s: string): AnyValue => ({ stringValue: s });
const bool = (b: boolean): AnyValue => ({ boolValue: b });
// Past 2^53 `String(n)` prints the shortest round-trip form, not the integer's digits; BigInt prints them. A bigint is an int64 token `parse` kept exact.
const int = (n: number | bigint): AnyValue => ({ intValue: typeof n === "bigint" || Number.isSafeInteger(n) ? String(n) : BigInt(n).toString() });
const TRUE = bool(true);
const skip = (reason: SkipReason): Mapped => ({ kind: "skip", reason });

/**
 * The receipt clock a crossing with no timestamps is placed at
 * (otel-mapping.md 5), as unix nanoseconds: the reading in whole
 * milliseconds, which is all `Date.now` carries. OTLP/JSON writes an
 * int64 as a decimal string, so nothing here goes through a double.
 */
function receiptNanos(): string {
  return (BigInt(Date.now()) * 1000000n).toString();
}

/** Maps one line of text. `cap` is the UTF-8 byte cap on string attributes (otel-mapping.md 9); `undefined` is no cap. */
export function mapLine(text: string, declarations: Declarations, cap: number | undefined): Mapped {
  const parsed = parse(text);
  if (parsed === undefined || !isRec(parsed.value)) return skip("malformed");
  const line = parsed.value;
  const kind = line["kind"];
  const host = line["host"];
  if (kind === "host") {
    return typeof host === "string" ? { kind: "host", declaration: line as unknown as HostLine } : skip("malformed");
  }
  if (kind !== "execution" && kind !== "crossing") return skip("unknown_kind");
  if (typeof host !== "string") return skip("malformed");
  const end = line["end"];
  if (end === undefined) return skip("notice");
  if (!isRec(end)) return skip("malformed");
  return (kind === "execution" ? executionSpan : crossingSpan)(line, host, end, declarations(host), parsed.order, cap);
}

/** Groups spans by host string: one `ResourceSpans` per host, `service.name` and the scope name from it (otel-mapping.md 11). */
export function buildRequest(mapped: ReadonlyArray<Extract<Mapped, { kind: "span" }>>): ExportTraceServiceRequest {
  const byHost = new Map<string, Span[]>();
  for (const m of mapped) {
    let spans = byHost.get(m.host);
    if (spans === undefined) byHost.set(m.host, (spans = []));
    spans.push(m.span);
  }
  const resourceSpans: ResourceSpans[] = [];
  for (const [host, spans] of byHost) {
    resourceSpans.push({
      resource: { attributes: [{ key: "service.name", value: str(host) }] },
      scopeSpans: [{ scope: { name: "mocon/" + host }, spans }],
    });
  }
  return { resourceSpans };
}

function executionSpan(line: Rec, host: string, end: Rec, declaration: HostLine | undefined, order: KeyOrder | undefined, cap: number | undefined): Mapped {
  // core.md 8: an unknown closed-set value reads as no `end`; a missing one is a missing required field (otel-mapping.md 3).
  const disposition = end["disposition"];
  if (disposition === undefined) return skip("malformed");
  if (!CLOSED.disposition.has(disposition)) return skip("bad_enum");
  const id = line["id"];
  const program = line["program"];
  if (typeof id !== "string" || !isRec(program) || typeof line["start"] !== "string" || typeof end["time"] !== "string") {
    return skip("malformed");
  }
  const start = unixNanos(line["start"]);
  const endTime = unixNanos(end["time"]);
  if (start === undefined || endTime === undefined) return skip("bad_timestamp");

  const context = isRec(line["context"]) ? line["context"] : undefined;
  const traceparent = context?.["traceparent"];
  const tp = parseTraceparent(traceparent);
  const derivedTraceId = traceIdOf(host, id);
  const spanId = executionSpanIdOf(host, id);
  const error = end["error"];
  // core.md 5.5 makes `class` required: an error object without one is a malformed line, not an error with no class (otel-mapping.md 3).
  if (error !== undefined && !classed(error)) return skip("malformed");
  const attested = attestedSet(declaration);

  const a = new Attributes(cap, order);
  a.put("mocon.host", str(host));
  if (declaration !== undefined) hostAttributes(a, declaration);
  a.put("mocon.execution.id", str(id));
  a.put("mocon.execution.disposition", str(disposition as string));
  const language = line["language"];
  if (typeof language === "string") a.text("mocon.execution.language", language, "P");
  if (context !== undefined) {
    const session = context["session"];
    if (typeof session === "string") a.text("mocon.context.session", session, undefined);
    if (typeof traceparent === "string") a.put("mocon.context.traceparent", str(traceparent));
  }
  a.payload("program", program, "P");
  a.payload("execution.result", end["result"], "P");
  const outputs = end["outputs"];
  if (isRec(outputs)) for (const channel of a.keys(outputs)) a.payload("execution.outputs." + channel, outputs[channel], "P");
  a.error("execution.error", error, attested.has("execution.error.class") ? undefined : "P", "P");
  a.ext(line["ext"]);
  a.put("gen_ai.operation.name", str("execute_tool"));

  const span: Span = {
    traceId: tp?.traceId ?? derivedTraceId,
    spanId,
    name: "mocon.execution",
    kind: 1,
    startTimeUnixNano: start,
    endTimeUnixNano: endTime,
    attributes: a.finish(),
    status: executionStatus(disposition as string, error),
  };
  if (tp !== undefined) {
    span.parentSpanId = tp.parentId;
    // The crossings may not have copied the value; the link leads from the caller's trace to the derived one (core.md 6).
    span.links = [{ traceId: derivedTraceId, spanId }];
  }
  return { kind: "span", host, span };
}

function executionStatus(disposition: string, error: unknown): Status {
  switch (disposition) {
    case "completed":
      return { code: 1 };
    case "failed":
      return { code: 2, message: "failed" };
    case "terminated":
      return isRec(error) && error["class"] === "cancelled" ? { code: 0 } : { code: 2, message: "terminated" };
    default:
      return { code: 0 };
  }
}

function crossingSpan(line: Rec, host: string, end: Rec, declaration: HostLine | undefined, order: KeyOrder | undefined, cap: number | undefined): Mapped {
  const outcome = end["outcome"];
  if (outcome === undefined) return skip("malformed");
  if (!CLOSED.outcome.has(outcome)) return skip("bad_enum");
  const id = line["id"];
  const executionId = line["execution_id"];
  const target = line["target"];
  const input = line["input"];
  if (typeof id !== "string" || typeof executionId !== "string" || typeof target !== "string" || !isRec(input)) {
    return skip("malformed");
  }
  // A present time that does not parse is a host bug, like a bad enum: the line is skipped rather than given a synthesized time.
  let start: string | undefined;
  let endTime: string | undefined;
  if (line["start"] !== undefined && (start = unixNanos(line["start"])) === undefined) return skip("bad_timestamp");
  if (end["time"] !== undefined && (endTime = unixNanos(end["time"])) === undefined) return skip("bad_timestamp");
  let timing: string | undefined;
  if (start === undefined && endTime === undefined) {
    start = endTime = receiptNanos();
    timing = "none";
  } else if (endTime === undefined) {
    endTime = start;
    timing = "start_only";
  } else if (start === undefined) {
    start = endTime;
    timing = "end_only";
  }

  // core.md 5.5 makes `class` required (otel-mapping.md 3). An `error` under any other outcome is not this line's error and is left alone.
  if (outcome === "error" && end["error"] !== undefined && !classed(end["error"])) return skip("malformed");

  const context = isRec(line["context"]) ? line["context"] : undefined;
  const traceparent = context?.["traceparent"];
  const tp = parseTraceparent(traceparent);
  const attested = attestedSet(declaration);
  const targetLabel: Label = attested.has("crossing.target") ? undefined : "P";

  const a = new Attributes(cap, order);
  a.put("mocon.host", str(host));
  a.put("mocon.execution.id", str(executionId));
  a.put("mocon.crossing.id", str(id));
  a.text("mocon.crossing.target", target, targetLabel);
  const seq = line["seq"];
  if (isInt(seq)) {
    a.put("mocon.crossing.seq", int(seq));
    a.label("crossing.seq", targetLabel);
  }
  if (typeof traceparent === "string") a.put("mocon.context.traceparent", str(traceparent));
  a.put("mocon.crossing.outcome", str(outcome as string));
  a.label("crossing.outcome", targetLabel);
  if (timing !== undefined) a.put("mocon.crossing.timing", str(timing));
  a.payload("crossing.input", input, attested.has("crossing.input") ? undefined : "P");
  if (outcome === "output") {
    a.payload("crossing.output", end["output"], attested.has("crossing.output") ? "T" : "P");
  } else if (outcome === "error") {
    const label: Label = attested.has("crossing.error") ? "T" : "P";
    a.error("crossing.error", end["error"], label, label);
  }
  a.ext(line["ext"]);
  a.put("gen_ai.operation.name", str("execute_tool"));
  a.put("gen_ai.tool.name", str(target));
  a.put("gen_ai.tool.call.id", str(id));

  const span: Span = {
    traceId: tp?.traceId ?? traceIdOf(host, executionId),
    spanId: crossingSpanIdOf(host, id),
    parentSpanId: executionSpanIdOf(host, executionId),
    name: spanName(target),
    kind: 3,
    startTimeUnixNano: start as string,
    endTimeUnixNano: endTime as string,
    attributes: a.finish(),
    status: outcome === "output" ? { code: 1 } : outcome === "error" ? { code: 2, message: "error" } : { code: 0 },
  };
  return { kind: "span", host, span };
}

/**
 * `target` cut to its first 128 code points; `mocon.crossing` for an empty
 * target (otel-mapping.md 7). The UTF-16 slice never splits a pair inside
 * those 128: a code point is at most two units, so 2 x 128 units always
 * reach at least that far.
 */
function spanName(target: string): string {
  if (target === "") return "mocon.crossing";
  return [...target.slice(0, NAME_CODE_POINTS * 2)].slice(0, NAME_CODE_POINTS).join("");
}

/** Whether an `end.error` is an object with the `class` core.md 5.5 requires. */
function classed(error: unknown): boolean {
  return isRec(error) && typeof error["class"] === "string";
}

/**
 * The `attested` entries of a declaration that this version knows, as a
 * set, computed once per declaration object.
 *
 * Once per declaration and not once per line: a caller holds one
 * declaration for a host string and maps every line of that host against
 * it, so rebuilding the set per line would make each span's cost
 * proportional to the length of a list the stream chose, for the life of
 * the sink. An entry outside `CLOSED.attested` is dropped here as it is
 * from `mocon.host.attested` (otel-mapping.md 3, provenance.md 4), which
 * changes no label: every lift this file asks about is a known entry.
 */
function attestedSet(declaration: HostLine | undefined): ReadonlySet<string> {
  if (declaration === undefined) return EMPTY;
  const held = ATTESTED.get(declaration);
  if (held !== undefined) return held;
  const list = declaration.attested;
  const set = new Set<string>();
  if (Array.isArray(list)) for (const entry of list) if (CLOSED.attested.has(entry)) set.add(entry as string);
  ATTESTED.set(declaration, set);
  return set;
}
const EMPTY: ReadonlySet<string> = new Set();
/** Keyed on the declaration object, so an entry goes when the caller stops holding it. */
const ATTESTED = new WeakMap<HostLine, ReadonlySet<string>>();

/** `mocon.host.*` from the declaration (otel-mapping.md 6.2). An unknown closed-set value drops that one attribute (core.md 8). */
function hostAttributes(a: Attributes, d: HostLine): void {
  if (typeof d.spec_version === "string") a.put("mocon.host.spec_version", str(d.spec_version));
  if (CLOSED.observes_crossings.has(d.observes_crossings)) a.put("mocon.host.observes_crossings", str(d.observes_crossings as string));
  if (typeof d.unmediated_egress === "boolean") a.put("mocon.host.unmediated_egress", bool(d.unmediated_egress));
  if (CLOSED.crossing_edge.has(d.crossing_edge)) a.put("mocon.host.crossing_edge", str(d.crossing_edge as string));
  if (Array.isArray(d.attested)) {
    // otel-mapping.md 3: an entry this version does not know is ignored (provenance.md 4).
    const values: AnyValue[] = [];
    for (const entry of d.attested) if (CLOSED.attested.has(entry)) values.push(str(entry as string));
    a.put("mocon.host.attested", { arrayValue: { values } });
  }
}

/**
 * The attribute list of one span. Values go in as they are met; the
 * provenance labels and `mocon.provenance.ext.p` are held back and
 * appended by `finish`, so every label sits after every value.
 */
class Attributes {
  private readonly list: KeyValue[] = [];
  private readonly labels: KeyValue[] = [];
  private readonly extKeys: string[] = [];

  constructor(
    private readonly cap: number | undefined,
    private readonly order: KeyOrder | undefined,
  ) {}

  put(key: string, value: AnyValue): void {
    this.list.push({ key, value });
  }

  label(field: string, label: Label): void {
    if (label !== undefined) this.labels.push({ key: "mocon.provenance." + field, value: str(label) });
  }

  /** The keys of an object from the line, in the order the line carried them. */
  keys(object: Rec): readonly string[] {
    return keysOf(object, this.order);
  }

  /** A string that is not a Payload value, under the cap, with `<key>.truncated` when cut, and its label. */
  text(key: string, value: string, label: Label): void {
    if (this.string(key, value)) this.put(key + ".truncated", TRUE);
    this.label(key.slice(6), label);
  }

  /** A Payload at `mocon.<prefix>` (otel-mapping.md 8.1). The label applies to `.value` and is written only when `.value` is. */
  payload(prefix: string, p: unknown, label: Label): void {
    if (!isRec(p)) return;
    const key = "mocon." + prefix;
    const value = p["value"];
    const present = value !== undefined;
    const cut = present && this.json(key + ".value", value);
    const truncated = p["truncated"];
    if (cut) this.put(key + ".truncated", TRUE);
    else if (typeof truncated === "boolean") this.put(key + ".truncated", bool(truncated));
    const redacted = p["redacted"];
    if (typeof redacted === "boolean") this.put(key + ".redacted", bool(redacted));
    const bytes = p["bytes"];
    if (isInt(bytes)) this.put(key + ".bytes", int(bytes));
    const hash = p["hash"];
    if (typeof hash === "string") this.put(key + ".hash", str(hash));
    if (present) this.label(prefix + ".value", label);
  }

  /** An Error object at `mocon.<prefix>` (core.md 5.5): `class` under its own label, `message` and `value` under the other. */
  error(prefix: string, e: unknown, classLabel: Label, restLabel: Label): void {
    if (!isRec(e)) return;
    const cls = e["class"];
    if (typeof cls === "string") this.text("mocon." + prefix + ".class", cls, classLabel);
    const message = e["message"];
    if (typeof message === "string") this.text("mocon." + prefix + ".message", message, restLabel);
    this.payload(prefix + ".value", e["value"], restLabel);
  }

  /** `mocon.ext.<key>` per key (otel-mapping.md 8.2). Every key is P in this version, so each is listed in `mocon.provenance.ext.p`. */
  ext(ext: unknown): void {
    if (!isRec(ext)) return;
    for (const key of this.keys(ext)) {
      if (this.json("mocon.ext." + key, ext[key])) this.put("mocon.ext." + key + ".truncated", TRUE);
      this.extKeys.push(key);
    }
  }

  finish(): KeyValue[] {
    const list = this.list;
    for (const label of this.labels) list.push(label);
    if (this.extKeys.length > 0) {
      list.push({ key: "mocon.provenance.ext.p", value: { arrayValue: { values: this.extKeys.map(str) } } });
    }
    return list;
  }

  /** A JSON value from the line as one attribute (otel-mapping.md 8.2). Returns whether a string was cut. */
  private json(key: string, value: unknown): boolean {
    switch (typeof value) {
      case "string":
        return this.string(key, value);
      case "boolean":
        this.put(key, bool(value));
        return false;
      case "number":
        // A number literal past the double range parses to an infinity, which proto3 JSON writes as a string.
        this.put(key, isInt(value) ? int(value) : { doubleValue: Number.isFinite(value) ? value : value > 0 ? "Infinity" : "-Infinity" });
        return false;
      case "bigint":
        this.put(key, int(value));
        return false;
      default:
        return this.string(key, stringify(value, this.order));
    }
  }

  private string(key: string, value: string): boolean {
    const kept = this.cap === undefined ? value : truncateUtf8(value, this.cap);
    this.put(key, str(kept));
    return kept !== value;
  }
}

/** The longest prefix of `s` that fits in `cap` UTF-8 bytes, cut on a code point boundary (otel-mapping.md 9). */
export function truncateUtf8(s: string, cap: number): string {
  if (s.length * 3 <= cap) return s;
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i) as number;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > cap) break;
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return i === s.length ? s : s.slice(0, i);
}
