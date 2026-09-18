/**
 * The part of the OTLP/JSON trace shape this package writes, in the
 * protobuf JSON mapping: ids as hex strings, times and int64 values as
 * decimal strings, enums as integers. Declared here so the package needs
 * no OpenTelemetry dependency.
 */

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
