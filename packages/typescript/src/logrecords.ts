/**
 * Log records, emitted through the OpenTelemetry logs API.
 *
 * These exist for one reason the trace cannot cover. A span is exported when it ends, so a dispatch
 * still running is not in the trace at all and is indistinguishable from one that never happened.
 * That is limitation L5, and the document's own answer is a log record it never defined. This is it.
 *
 * A record is written when a dispatch starts and again when it ends, both carrying the trace and span
 * ids, so a query joins them to the spans. The starting record is the one that matters: it is the
 * only thing in the whole model that says a run is in flight right now.
 *
 * `@opentelemetry/api-logs` is an optional peer. It is resolved once, lazily, and if it is absent
 * this does nothing at all rather than failing to load.
 */

import { createRequire } from "node:module";
import type { Attributes } from "@opentelemetry/api";

const NAME = "mocon";
const VERSION = "0.1.0";

interface LoggerLike {
  emit(record: { severityNumber?: number; severityText?: string; body?: unknown; attributes?: Attributes }): void;
}

let resolved = false;
let logsApi: { getLogger(n: string, v?: string): LoggerLike } | undefined;

/**
 * The API's logger, or nothing when the optional package is not installed. The module is resolved
 * once; the logger is not cached, because an application may register its provider after the first
 * dispatch, and a cached logger from before that would keep writing into a no-op forever.
 */
function get(): LoggerLike | undefined {
  if (!resolved) {
    resolved = true;
    try {
      // `require` rather than `import()`, because emitting is synchronous and an optional dependency
      // must not turn it into a promise. This module is ESM, so the require has to be made.
      const api = createRequire(import.meta.url)("@opentelemetry/api-logs") as {
        logs?: { getLogger(n: string, v?: string): LoggerLike };
      };
      logsApi = api.logs;
    } catch {
      logsApi = undefined;
    }
  }
  return logsApi?.getLogger(NAME, VERSION);
}

/** INFO. A dispatch that is merely running is not an event anyone should be paged about. */
const INFO = 9;

export class Records {
  constructor(private readonly enabled: boolean) {}

  started(attributes: Attributes, traceId: string, spanId: string): void {
    this.emit("code_mode.execution.started", "a program dispatch started", attributes, traceId, spanId);
  }

  ended(attributes: Attributes, traceId: string, spanId: string): void {
    this.emit("code_mode.execution.ended", "a program dispatch ended", attributes, traceId, spanId);
  }

  private emit(event: string, body: string, attributes: Attributes, traceId: string, spanId: string): void {
    if (!this.enabled) return;
    try {
      // `get` is inside the guard too: it calls the provider's own `getLogger`, and a provider that
      // throws there would otherwise raise out of `execution.complete()`, which ends the span before
      // this runs. The dispatch would fail after its own telemetry said it succeeded.
      const log = get();
      if (log === undefined) return;
      log.emit({
        severityNumber: INFO,
        severityText: "INFO",
        body,
        attributes: { ...attributes, "event.name": event, trace_id: traceId, span_id: spanId },
      });
    } catch {
      // A logging pipeline that fails must not fail the dispatch it describes.
    }
  }
}
