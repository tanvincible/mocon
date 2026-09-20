"""The harness: a real OpenTelemetry SDK and real in-memory exporters, so what is asserted is what
an exporter receives rather than what a mock was told."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from opentelemetry import _logs as otel_logs
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from mocon import Capabilities, CapturePolicy, CodeMode

ATTESTED = ("crossing.target", "crossing.input", "crossing.output")
CAPS = Capabilities(
    observes_crossings="all",
    unmediated_egress=False,
    crossing_edge="invocation",
    attested=ATTESTED,
)

# One logger provider per process: the API keeps the first one registered and ignores later ones,
# exactly as it does in every real application. The exporter is cleared per harness instead.
_LOGS = InMemoryLogRecordExporter()


@pytest.fixture(scope="session", autouse=True)
def _logger_provider() -> Any:
    provider = LoggerProvider()
    provider.add_log_record_processor(SimpleLogRecordProcessor(_LOGS))
    otel_logs.set_logger_provider(provider)
    return provider


class Harness:
    def __init__(self, capabilities: Capabilities = CAPS, capture: CapturePolicy | None = None, **options: Any) -> None:
        self.exporter = InMemorySpanExporter()
        tracer_provider = TracerProvider()
        tracer_provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.reader = InMemoryMetricReader()
        meter_provider = MeterProvider(metric_readers=[self.reader])
        _LOGS.clear()
        self.m = CodeMode(
            capabilities,
            capture=capture,
            tracer=tracer_provider.get_tracer("test"),
            meter=meter_provider.get_meter("test"),
            **options,
        )

    def spans(self) -> list[Any]:
        return list(self.exporter.get_finished_spans())

    def one(self, prefix: str) -> Any:
        found = [s for s in self.spans() if s.name.startswith(prefix)]
        assert len(found) == 1, f"exactly one {prefix} span, got {len(found)}"
        return found[0]

    def crossings(self) -> list[Any]:
        return [s for s in self.spans() if s.name.startswith("execute_tool")]

    def executions(self) -> list[Any]:
        return [s for s in self.spans() if "code_mode.execution.disposition" in s.attributes]

    def points(self) -> list[Any]:
        data = self.reader.get_metrics_data()
        out: list[Any] = []
        for resource in data.resource_metrics if data else []:
            for scope in resource.scope_metrics:
                out.extend(scope.metrics)
        return out

    def metric(self, name: str) -> Any:
        for m in self.points():
            if m.name == name:
                return m
        return None

    def records(self) -> list[Any]:
        return [d.log_record for d in _LOGS.get_finished_logs()]


def harness(capabilities: Capabilities = CAPS, capture: CapturePolicy | None = None, **options: Any) -> Harness:
    return Harness(capabilities, capture, **options)


def note(span: Any) -> dict[str, dict[str, Any]]:
    """The ``code_mode.capture`` envelope: what the host did to each value it captured."""
    return json.loads(span.attributes.get("code_mode.capture", "{}"))
