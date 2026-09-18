/**
 * @mocon/otel: mocon lines to OpenTelemetry spans, as OTLP/JSON.
 *
 * `otlpSink` is the whole surface: a `Sink` the emitter writes to, which
 * posts each write batch as one request. The package implements
 * spec/otel-mapping.md and depends only on `@mocon/core`.
 */

export { otlpSink, type FetchLike, type OtlpSink, type OtlpSinkOptions } from "./sink.js";
export type { ExportTraceServiceRequest, SkipReason } from "./map.js";
