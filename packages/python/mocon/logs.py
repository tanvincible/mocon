"""Log records, emitted through the OpenTelemetry logs API.

These exist for one reason the trace cannot cover. A span is exported when it ends, so a dispatch
still running is not in the trace at all and is indistinguishable from one that never happened.
That is limitation L5, and the document's own answer is a log record it never defined. This is it.

A record is written when a dispatch starts and again when it ends, both carrying the trace and span
ids, so a query joins them to the spans. The starting record is the one that matters: it is the only
thing in the whole model that says a run is in flight right now.

The logs API is still ``opentelemetry._logs``, underscore and all. It is resolved once, lazily, and
if it is absent this does nothing at all rather than failing to import.
"""

from __future__ import annotations

from typing import Any

NAME = "mocon"
VERSION = "0.1.0"

#: INFO. A dispatch that is merely running is not an event anyone should be paged about.
_INFO_TEXT = "INFO"

_resolved = False
_logs: Any = None


def _logger() -> Any:
    """The API's logger, or nothing when the logs API is not importable. The module is resolved
    once; the logger is not cached, because an application may register its provider after the first
    dispatch, and a cached logger from before that would keep writing into a no-op forever."""
    global _resolved, _logs
    if not _resolved:
        _resolved = True
        try:
            from opentelemetry import _logs as api

            _logs = api
        except Exception:
            _logs = None
    if _logs is None:
        return None
    try:
        return _logs.get_logger(NAME, VERSION)
    except Exception:
        return None


class Records:
    __slots__ = ("_enabled",)

    def __init__(self, enabled: bool) -> None:
        self._enabled = enabled

    def started(self, attributes: dict[str, Any], trace_id: str, span_id: str) -> None:
        self._emit("code_mode.execution.started", "a program dispatch started", attributes, trace_id, span_id)

    def ended(self, attributes: dict[str, Any], trace_id: str, span_id: str) -> None:
        self._emit("code_mode.execution.ended", "a program dispatch ended", attributes, trace_id, span_id)

    def _emit(self, event: str, body: str, attributes: dict[str, Any], trace_id: str, span_id: str) -> None:
        if not self._enabled:
            return
        logger = _logger()
        if logger is None:
            return
        try:
            logger.emit(
                severity_number=_logs.SeverityNumber.INFO,
                severity_text=_INFO_TEXT,
                body=body,
                event_name=event,
                attributes={**attributes, "event.name": event, "trace_id": trace_id, "span_id": span_id},
            )
        except Exception:
            # A logging pipeline that fails must not fail the dispatch it describes.
            pass
