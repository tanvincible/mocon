/**
 * One mocon line to one OTLP span, otel-mapping.md sections 3 and 5 to 11,
 * over the wire shape declared at the top of this file. Everything here is
 * a pure function of the line's text, the host declaration the caller holds
 * for that host string, the receipt clock for a crossing with no times, and
 * the string cap.
 */

import type { HostLine } from "@mocon/core";
import { CLOSED, dimensionsOf, unixNanos, type Dimension } from "@mocon/core/fold";
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
  /** `mocon.rel` and `mocon.counts` on a link from `links`; absent on the one core.md 6 requires (otel-mapping.md 13). */
  attributes?: KeyValue[];
}

/**
 * One data point a declared `sum` or `last` dimension produces
 * (otel-mapping.md 14). The instrument is `(name, unit, agg)`; the point
 * carries its own attributes, which are the closed list section 14 gives.
 */
export interface MetricPoint {
  host: string;
  /** `mocon.ext.<key>`, the key verbatim. */
  name: string;
  /** The declared `unit`, or `1`. */
  unit: string;
  agg: "sum" | "last";
  /** As OTLP writes a number data point: an integer within int64 keeps its digits. */
  value: { asInt: string } | { asDouble: number };
  attributes: KeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
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
  | { kind: "span"; host: string; span: Span; points: MetricPoint[] }
  | { kind: "skip"; reason: SkipReason }
  | { kind: "host"; declaration: HostLine };

/** The declaration the caller holds for a host string, if any, already known to be of this package's major version. */
type Declarations = (host: string) => HostLine | undefined;

type Rec = Record<string, unknown>;
/** A provenance label to write, or `undefined` for a host-observed field, which gets none. */
type Label = "P" | "T" | undefined;

const INT64 = 2 ** 63;
const NAME_CODE_POINTS = 128;
/** The four reserved envelope notes (core.md 3), host-observed wherever they appear and never declared (provenance.md 3). Any other `mocon.` key is an ordinary host-written one. */
const RESERVED: ReadonlySet<string> = new Set(["mocon.target", "mocon.encoding", "mocon.message", "mocon.ext"]);
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number | bigint => typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v) && v < INT64 && v >= -INT64);
const str = (s: string): AnyValue => ({ stringValue: s });
const bool = (b: boolean): AnyValue => ({ boolValue: b });
// Past 2^53 `String(n)` prints the shortest round-trip form, not the integer's digits; BigInt prints them. A bigint is an int64 token `parse` kept exact.
const intText = (n: number | bigint): string => (typeof n === "bigint" || Number.isSafeInteger(n) ? String(n) : BigInt(n).toString());
const int = (n: number | bigint): AnyValue => ({ intValue: intText(n) });
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
  // provenance.md 4: a declared key is host-observed only under both gates, so without the entry no key is, and none becomes a metric (otel-mapping.md 14).
  const dimensions = attested.has("ext.declared") ? dimensionsFor(declaration) : undefined;

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
  a.ext(line["ext"], dimensions);
  const links = a.links(line["links"], host, "execution", id, undefined);
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
    links.unshift({ traceId: derivedTraceId, spanId });
  }
  if (links.length > 0) span.links = links;
  // Nothing declared and attested: no point can qualify, so the record kind's point attributes are not built either.
  const points = dimensions === undefined ? [] : metricPoints(host, line["ext"], dimensions, [{ key: "mocon.execution.disposition", value: str(disposition as string) }], order, start, endTime);
  return { kind: "span", host, span, points };
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
  // otel-mapping.md 14: a point's window is the record's own times, falling back to receipt where 7.3 does, so it is read before 7.3 fills the span's.
  const receipt = endTime === undefined ? receiptNanos() : undefined;
  const pointStart = start ?? endTime ?? (receipt as string);
  const pointTime = endTime ?? (receipt as string);
  let timing: string | undefined;
  if (start === undefined && endTime === undefined) {
    start = endTime = receipt;
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
  const dimensions = attested.has("ext.declared") ? dimensionsFor(declaration) : undefined;
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
  a.ext(line["ext"], dimensions);
  const links = a.links(line["links"], host, "crossing", id, executionId);
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
  if (links.length > 0) span.links = links;
  const points =
    dimensions === undefined
      ? []
      : metricPoints(
          host,
          line["ext"],
          dimensions,
          [
            { key: "mocon.crossing.target", value: str(target) },
            { key: "mocon.crossing.outcome", value: str(outcome as string) },
          ],
          order,
          pointStart,
          pointTime,
        );
  return { kind: "span", host, span, points };
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

/**
 * The declaration's `dimensions` with core.md 5.1.1's "absent reads as"
 * column applied, computed once per declaration for the same reason
 * `attestedSet` is: a host declaring forty keys must not cost every line a
 * pass over all forty. The map has a null prototype, so a `__proto__` or
 * `constructor` entry is an own key and an undeclared key stays undeclared.
 */
function dimensionsFor(declaration: HostLine | undefined): Record<string, Dimension> | undefined {
  if (declaration === undefined) return undefined;
  const held = DIMENSIONS.get(declaration);
  if (held !== undefined) return held;
  const dimensions = dimensionsOf(declaration);
  DIMENSIONS.set(declaration, dimensions);
  return dimensions;
}
const DIMENSIONS = new WeakMap<HostLine, Record<string, Dimension>>();

/**
 * The metric points one complete line's `ext` produces (otel-mapping.md 14):
 * one per key the host declared `sum` or `last` whose value here is a finite
 * JSON number. The caller has already established that `ext.declared` is
 * attested, and each entry must carry `observed: true`, so only a
 * host-observed value becomes a point — a metric point has no provenance
 * channel to carry a program claim's label (provenance.md 5).
 *
 * `scope` is the record kind's share of the point attributes; the rest are
 * `mocon.host` and this record's low-cardinality declared `none` keys. The
 * list is closed, so nothing here caps a string: a cap would need a
 * `truncated` flag beside it, and there is no room in the list for one.
 */
function metricPoints(
  host: string,
  ext: unknown,
  dimensions: Record<string, Dimension>,
  scope: KeyValue[],
  order: KeyOrder | undefined,
  startTimeUnixNano: string,
  timeUnixNano: string,
): MetricPoint[] {
  if (!isRec(ext)) return [];
  const keys = keysOf(ext, order);
  let attributes: KeyValue[] | undefined;
  const points: MetricPoint[] = [];
  for (const key of keys) {
    const d = dimensions[key];
    if (d === undefined || d.observed !== true) continue;
    const value = ext[key];
    if (d.agg === "none") {
      if (d.card === "low") (attributes ??= [{ key: "mocon.host", value: str(host) }, ...scope]).push({ key: "mocon.ext." + key, value: encode(value, order) });
      continue;
    }
    // An aggregation a later minor version adds has no shape here (core.md 8), so it stays on the span like any other value.
    if (d.agg !== "sum" && d.agg !== "last") continue;
    if (typeof value === "bigint") points.push(point(host, key, d.agg, d.unit, { asInt: intText(value) }, startTimeUnixNano, timeUnixNano));
    // core.md 5.1.1: a value that is not a finite number is a mismatch, displayed on the span and not exported.
    else if (typeof value === "number" && Number.isFinite(value)) points.push(point(host, key, d.agg, d.unit, isInt(value) ? { asInt: intText(value) } : { asDouble: value }, startTimeUnixNano, timeUnixNano));
  }
  if (points.length === 0) return points;
  attributes ??= [{ key: "mocon.host", value: str(host) }, ...scope];
  for (const p of points) p.attributes = attributes;
  return points;
}

function point(host: string, key: string, agg: "sum" | "last", unit: string | undefined, value: MetricPoint["value"], startTimeUnixNano: string, timeUnixNano: string): MetricPoint {
  // `dimensionsOf` fills the unit; the fallback is core.md 5.1.1's "absent reads as 1" for a declaration read some other way.
  return { host, name: "mocon.ext." + key, unit: unit ?? "1", agg, value, attributes: [], startTimeUnixNano, timeUnixNano };
}

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

  /**
   * `mocon.ext.<key>` per key (otel-mapping.md 8.2), and the key's name in
   * `mocon.provenance.ext.p` unless it is host-observed: a reserved envelope
   * note, or a declared key under both of provenance.md 4's gates, which
   * `dimensions` being defined is half of.
   */
  ext(ext: unknown, dimensions: Record<string, Dimension> | undefined): void {
    if (!isRec(ext)) return;
    for (const key of this.keys(ext)) {
      if (this.json("mocon.ext." + key, ext[key])) this.put("mocon.ext." + key + ".truncated", TRUE);
      if (!RESERVED.has(key) && dimensions?.[key]?.observed !== true) this.extKeys.push(key);
    }
  }

  /**
   * `mocon.links` holding the array's JSON text, and the span links each
   * entry derives from its own fields (otel-mapping.md 13). An entry this
   * version cannot read — an unknown `rel`, `counts` or `kind`, no `id`, a
   * crossing entry with no execution to derive a trace id from, or one
   * naming the record carrying it (links.md 7) — is dropped from the span
   * links and stays in `mocon.links`. `links` is H, so it takes no label.
   */
  links(value: unknown, host: string, kind: "execution" | "crossing", id: string, executionId: string | undefined): SpanLink[] {
    if (!Array.isArray(value)) return [];
    this.text("mocon.links", stringify(value, this.order), undefined);
    const links: SpanLink[] = [];
    for (const entry of value as unknown[]) {
      if (!isRec(entry)) continue;
      const { rel, counts, id: linkId } = entry;
      const linkKind = entry["kind"];
      if (!CLOSED.rel.has(rel) || !CLOSED.counts.has(counts) || !CLOSED.linked.has(linkKind) || typeof linkId !== "string") continue;
      const linkHost = typeof entry["host"] === "string" ? entry["host"] : host;
      if (linkHost === host && linkKind === kind && linkId === id) continue;
      let traceId: string;
      let spanId: string;
      if (linkKind === "execution") {
        traceId = traceIdOf(linkHost, linkId);
        spanId = executionSpanIdOf(linkHost, linkId);
      } else {
        // links.md 2: absent on a crossing line means this line's own execution; on an execution line there is nothing to default from.
        const linkExecution = typeof entry["execution_id"] === "string" ? entry["execution_id"] : executionId;
        if (linkExecution === undefined) continue;
        traceId = traceIdOf(linkHost, linkExecution);
        spanId = crossingSpanIdOf(linkHost, linkId);
      }
      links.push({
        traceId,
        spanId,
        attributes: [
          { key: "mocon.rel", value: str(rel as string) },
          { key: "mocon.counts", value: str(counts as string) },
        ],
      });
    }
    return links;
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
    const encoded = encode(value, this.order);
    if ("stringValue" in encoded) return this.string(key, encoded.stringValue);
    this.put(key, encoded);
    return false;
  }

  private string(key: string, value: string): boolean {
    const kept = this.cap === undefined ? value : truncateUtf8(value, this.cap);
    this.put(key, str(kept));
    return kept !== value;
  }
}

/** One JSON value from a line as an attribute value (otel-mapping.md 8.2), before any cap: a primitive stays primitive, anything else is its JSON text. */
function encode(value: unknown, order: KeyOrder | undefined): AnyValue {
  switch (typeof value) {
    case "string":
      return str(value);
    case "boolean":
      return bool(value);
    case "number":
      // A number literal past the double range parses to an infinity, which proto3 JSON writes as a string.
      return isInt(value) ? int(value) : { doubleValue: Number.isFinite(value) ? value : value > 0 ? "Infinity" : "-Infinity" };
    case "bigint":
      return int(value);
    default:
      return str(stringify(value, order));
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
