/**
 * @mocon/adapter-mastra: mocon records into Mastra's span tree.
 *
 * `mastraSink(span)` is the whole surface: a `Sink` for `@mocon/core` that turns each complete
 * record into a Mastra span under `span`, instead of a line in a file. Every exporter already
 * wired into the framework consumes that tree, so the records reach Langfuse, Datadog, Sentry,
 * Braintrust, Arize, LangSmith, Laminar and PostHog without any of them learning the format.
 *
 * The mapping is `spec/otel-mapping.md` where Mastra's span shape allows it; README.md lists the
 * four places it does not. No runtime dependency: the span is typed structurally, so this package
 * builds and ships without `@mastra/core` present.
 */

import type { Sink } from "@mocon/core";

type Rec = Record<string, unknown>;

/**
 * The part of Mastra's `AnySpan` this sink uses. Structural, so any `AnySpan` satisfies it and
 * nothing here imports the framework.
 */
export interface MastraSpanLike {
  readonly isValid?: boolean;
  createChildSpan(options: {
    type: any;
    name: string;
    attributes?: any;
    metadata?: Rec;
    entityType?: any;
    entityId?: string;
    entityName?: string;
    input?: any;
    startTime?: Date;
  }): MastraSpanLike;
  end(options?: { output?: any; attributes?: any; metadata?: Rec }): void;
  error(options: { error: Error; endSpan?: boolean; attributes?: any; metadata?: Rec }): void;
}

const NOOP: Sink = { write() {} };

/** The four `mocon.` envelope notes are host-observed wherever they appear (core.md 3). */
const RESERVED = new Set(["mocon.target", "mocon.encoding", "mocon.message", "mocon.ext"]);

/**
 * A `Sink` that writes each complete record as a span under `span`. Null-safe the way
 * `createToolObserve` is: no span, or a no-op span, and the sink drops everything.
 *
 * Holds two things and nothing else: the host declaration (the one piece of state otel-mapping.md 2
 * allows a sink) and the execution span currently open, so its crossings can nest under it. No
 * registry, no timer, no buffer.
 */
export function mastraSink(span: MastraSpanLike | undefined | null): Sink {
  if (!span || span.isValid === false) return NOOP;

  let declaration: Rec | undefined;
  let open: { id: string; span: MastraSpanLike } | undefined;

  const attested = (): Set<string> => {
    const list = declaration?.attested;
    return new Set(Array.isArray(list) ? (list.filter((e) => typeof e === "string") as string[]) : []);
  };

  const execution = (line: Rec): void => {
    const id = str(line.id);
    if (id === undefined) return;
    if (open?.id !== id) {
      open?.span.end(); // a second dispatch through one sink: close the stale span rather than leak it
      open = {
        id,
        span: span.createChildSpan({
          type: "generic",
          name: "mocon.execution",
          startTime: date(line.start),
          input: valueOf(line.program),
          metadata: executionStart(line),
        }),
      };
    }
    const end = obj(line.end);
    if (!end) return; // a start notice: the span is open, the record is not done

    const error = obj(end.error);
    const metadata = { ...executionStart(line), ...executionEnd(line, end) };
    // otel-mapping.md 6.1, with Mastra's two-way end in place of a status code: OK and UNSET end
    // the span, ERROR records the error on it.
    if (end.disposition === "failed" || (end.disposition === "terminated" && str(error?.class) !== "cancelled")) {
      open.span.error({ error: toError(error, str(end.disposition) ?? "failed"), endSpan: true, metadata });
    } else {
      open.span.end({ output: valueOf(end.result), metadata });
    }
    open = undefined;
  };

  const crossing = (line: Rec): void => {
    const end = obj(line.end);
    if (!end) return; // start notices are dropped (otel-mapping.md 3)
    const target = str(line.target) ?? "";
    const parent = open && open.id === line.execution_id ? open.span : span;
    const outcome = str(end.outcome);
    const child = parent.createChildSpan({
      // A crossing is a tool call, and TOOL_CALL is the shape every Mastra exporter already reads:
      // entityName becomes gen_ai.tool.name, toolCallId becomes gen_ai.tool.call.id, and the span's
      // input and output become gen_ai.tool.call.arguments and .result.
      type: "tool_call",
      name: `tool: '${cut(target, 128)}'`,
      entityType: "tool",
      entityId: target,
      entityName: target,
      input: valueOf(line.input),
      startTime: date(line.start) ?? date(end.time),
      attributes: { toolType: "code-mode", toolCallId: str(line.id) },
      metadata: crossingMeta(line, end),
    });
    if (outcome === "error") {
      child.error({ error: toError(obj(end.error), "error"), endSpan: true, attributes: { success: false } });
    } else if (outcome === "output") {
      child.end({ output: valueOf(end.output), attributes: { success: true } });
    } else {
      child.end(); // abandoned: UNSET, and no success claim either way
    }
  };

  const executionStart = (line: Rec): Rec => {
    const context = obj(line.context);
    const m: Rec = {
      "mocon.host": line.host,
      "mocon.execution.id": line.id,
      "mocon.execution.language": line.language,
      "mocon.context.session": context?.session,
      "mocon.context.traceparent": context?.traceparent,
    };
    payloadEnvelope(m, "mocon.program", line.program);
    if (declaration) {
      m["mocon.host.spec_version"] = declaration.spec_version;
      m["mocon.host.observes_crossings"] = declaration.observes_crossings;
      m["mocon.host.unmediated_egress"] = declaration.unmediated_egress;
      m["mocon.host.crossing_edge"] = declaration.crossing_edge;
      m["mocon.host.attested"] = declaration.attested;
    }
    return m;
  };

  const executionEnd = (line: Rec, end: Rec): Rec => {
    const att = attested();
    const error = obj(end.error);
    const outputs = obj(end.outputs);
    const m: Rec = {
      "mocon.execution.disposition": end.disposition,
      "mocon.execution.error.class": error?.class,
      "mocon.execution.error.message": error?.message,
      "mocon.links": line.links,
    };
    payloadEnvelope(m, "mocon.execution.result", end.result);
    // Mastra's errorInfo holds a message, a name and a stack, so the raw error object the host
    // captured — an MCP isError result, a { ok: false, status } — travels here or nowhere.
    m["mocon.execution.error.value.value"] = valueOf(error?.value);
    payloadEnvelope(m, "mocon.execution.error.value", error?.value);
    for (const [channel, payload] of Object.entries(outputs ?? {})) {
      m[`mocon.execution.outputs.${channel}.value`] = valueOf(payload);
      payloadEnvelope(m, `mocon.execution.outputs.${channel}`, payload);
    }
    // otel-mapping.md 10. Host-observed fields carry no label; no label means H.
    label(m, "program.value", hasValue(line.program) && "P");
    label(m, "execution.language", line.language !== undefined && "P");
    label(m, "execution.result.value", hasValue(end.result) && "P");
    for (const [channel, payload] of Object.entries(outputs ?? {})) {
      label(m, `execution.outputs.${channel}.value`, hasValue(payload) && "P");
    }
    label(m, "execution.error.class", error?.class !== undefined && !att.has("execution.error.class") && "P");
    label(m, "execution.error.message", error?.message !== undefined && "P");
    label(m, "execution.error.value.value", hasValue(error?.value) && "P");
    ext(m, line.ext, att);
    return m;
  };

  const crossingMeta = (line: Rec, end: Rec): Rec => {
    const att = attested();
    const error = obj(end.error);
    const context = obj(line.context);
    const targetIsHost = att.has("crossing.target");
    const m: Rec = {
      "mocon.host": line.host,
      "mocon.execution.id": line.execution_id,
      "mocon.crossing.id": line.id,
      "mocon.crossing.target": line.target,
      "mocon.crossing.seq": line.seq,
      "mocon.crossing.outcome": end.outcome,
      "mocon.crossing.timing": timing(line.start, end.time),
      "mocon.context.traceparent": context?.traceparent,
      "mocon.crossing.error.class": error?.class,
      "mocon.crossing.error.message": error?.message,
      "mocon.links": line.links,
    };
    m["mocon.crossing.error.value.value"] = valueOf(error?.value);
    payloadEnvelope(m, "mocon.crossing.input", line.input);
    payloadEnvelope(m, "mocon.crossing.output", end.output);
    payloadEnvelope(m, "mocon.crossing.error.value", error?.value);
    label(m, "crossing.target", !targetIsHost && "P");
    label(m, "crossing.seq", line.seq !== undefined && !targetIsHost && "P");
    label(m, "crossing.outcome", !targetIsHost && "P");
    label(m, "crossing.input.value", hasValue(line.input) && !att.has("crossing.input") && "P");
    label(m, "crossing.output.value", hasValue(end.output) && (att.has("crossing.output") ? "T" : "P"));
    const errorLabel = att.has("crossing.error") ? "T" : "P";
    label(m, "crossing.error.class", error?.class !== undefined && errorLabel);
    label(m, "crossing.error.message", error?.message !== undefined && errorLabel);
    label(m, "crossing.error.value.value", hasValue(error?.value) && errorLabel);
    ext(m, line.ext, att);
    return m;
  };

  /** `ext` keys, plus the one array naming those still program-determined (otel-mapping.md 10). */
  const ext = (m: Rec, value: unknown, att: Set<string>): void => {
    const keys = obj(value);
    if (!keys) return;
    const declared = obj(declaration?.dimensions);
    const programDetermined: string[] = [];
    for (const [key, v] of Object.entries(keys)) {
      m[`mocon.ext.${key}`] = v;
      const observed = att.has("ext.declared") && obj(declared?.[key])?.observed === true;
      if (!RESERVED.has(key) && !observed) programDetermined.push(key);
    }
    if (programDetermined.length) m["mocon.provenance.ext.p"] = programDetermined;
  };

  return {
    write(lines) {
      for (const text of lines) {
        let line: Rec;
        try {
          const parsed: unknown = JSON.parse(String(text));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          line = parsed as Rec;
        } catch {
          continue; // malformed: skipped, as a consumer must (core.md 3)
        }
        // A declaration cannot vary per host string here: one sink serves one span. First wins,
        // so a re-declaration cannot move a record that already went out under the old one.
        if (line.kind === "host") declaration ??= line;
        else if (line.kind === "execution") execution(line);
        else if (line.kind === "crossing") crossing(line);
        // every other kind, extensions included, is skipped (core.md 3)
      }
    },
  };
}

function label(m: Rec, field: string, value: string | false): void {
  if (value) m[`mocon.provenance.${field}`] = value;
}

/** The Payload envelope: the flags the host set, never recomputed (otel-mapping.md 8.1). */
function payloadEnvelope(m: Rec, prefix: string, value: unknown): void {
  const p = obj(value);
  if (!p) return;
  if (p.truncated !== undefined) m[`${prefix}.truncated`] = p.truncated;
  if (p.redacted !== undefined) m[`${prefix}.redacted`] = p.redacted;
  if (p.bytes !== undefined) m[`${prefix}.bytes`] = p.bytes;
  if (p.hash !== undefined) m[`${prefix}.hash`] = p.hash;
}

/** otel-mapping.md 7.3, minus the `none` fallback's receipt time, which Mastra stamps itself. */
function timing(start: unknown, end: unknown): string | undefined {
  if (start !== undefined && end !== undefined) return undefined;
  if (start !== undefined) return "start_only";
  if (end !== undefined) return "end_only";
  return "none";
}

/**
 * The record's own error, as the Error an exporter expects. The frames are dropped: this object is
 * made in the sink, so its stack would name the sink and nothing the program did. The stack the
 * host actually captured is in the error's Payload, under `mocon.<kind>.error.value.value`.
 */
function toError(error: Rec | undefined, fallback: string): Error {
  const e = new Error(str(error?.message) ?? fallback);
  e.name = str(error?.class) ?? fallback;
  e.stack = `${e.name}: ${e.message}`;
  return e;
}

function valueOf(payload: unknown): unknown {
  return obj(payload)?.value;
}

function hasValue(payload: unknown): boolean {
  const p = obj(payload);
  return p !== undefined && "value" in p;
}

function obj(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function date(value: unknown): Date | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Code points, not UTF-16 units, so a surrogate pair is never cut in half. */
function cut(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join("");
}
