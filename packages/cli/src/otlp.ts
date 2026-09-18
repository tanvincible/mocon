/**
 * `mocon otlp`: the stream as one write to `@mocon/otel`'s `otlpSink`, the
 * batch an emitter would hand it, so the command and the sink cannot
 * disagree on a span, a skip reason or which host declaration is held
 * (otel-mapping.md 2 and 3). Lines are mapped in file order, as a sink
 * receives them. Without a URL the request is captured instead of posted.
 */

import { otlpSink, type ExportTraceServiceRequest, type SkipReason } from "@mocon/otel";
import { safeJson } from "./text.js";

/**
 * The request as the command prints it with no URL: indented JSON with
 * every character that would move a terminal's cursor, start an escape
 * sequence or reorder what the reader sees written as a `\u` escape,
 * which is still valid JSON. Targets, messages and traceparents in it are
 * a program's or a host's choice. The body posted to a collector is the
 * sink's own and is never touched.
 */
export function requestText(request: ExportTraceServiceRequest): string {
  return safeJson(JSON.stringify(request, null, 2));
}

export interface OtlpTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface OtlpExport {
  /** The request posted, or that would have been. A stream with no complete record gives no `resourceSpans`. */
  request: ExportTraceServiceRequest;
  spans: number;
  /** Lines that produced no span, by reason. */
  skipped: Readonly<Record<SkipReason, number>>;
  /** Host re-declarations whose values differed from the declaration held. */
  conflicts: number;
  /** Host declarations of another major version, which are not held (core.md 11). */
  versionMismatches: number;
  /** The collector's HTTP status, when it answered. */
  status?: number;
  /** Why the POST failed. Present exactly when it did. */
  error?: unknown;
}

export async function exportStream(stream: string, target?: OtlpTarget): Promise<OtlpExport> {
  let body: string | undefined;
  let status: number | undefined;
  const sink = otlpSink({
    url: target?.url ?? "memory:",
    headers: target?.headers,
    fetch: async (url, init) => {
      body = init.body;
      if (target === undefined) return { ok: true, status: 200, body: null };
      const response = await fetch(url, init);
      status = response.status;
      return response;
    },
  });
  let failure: { error: unknown } | undefined;
  try {
    await sink.write(stream.split("\n").filter((line) => line.trim() !== ""));
  } catch (error) {
    failure = { error };
  }
  const request: ExportTraceServiceRequest = body === undefined ? { resourceSpans: [] } : JSON.parse(body);
  let spans = 0;
  for (const rs of request.resourceSpans) for (const ss of rs.scopeSpans) spans += ss.spans.length;
  const result: OtlpExport = { request, spans, skipped: sink.skipped, conflicts: sink.conflicts, versionMismatches: sink.versionMismatches };
  if (status !== undefined) result.status = status;
  if (failure !== undefined) result.error = failure.error;
  return result;
}
