"""The claim the whole move rests on: a host that emits through the OpenTelemetry API reaches the
exporters the application owner already configured, with no destination of ours to wire. Here the
owner registers a provider the way any application does, the host passes no tracer, and the spans
arrive at the owner's exporter.
"""

from __future__ import annotations

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from mocon import Capabilities, CodeMode


def test_a_host_that_passes_no_tracer_reaches_the_owners_exporter() -> None:
    # What an application owner writes once, for every library in the process. Nothing here is ours.
    owner = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(owner))
    trace.set_tracer_provider(provider)

    # What a code-mode host writes. No exporter, no sink, no destination.
    m = CodeMode(Capabilities(observes_crossings="all", unmediated_egress=False, crossing_edge="invocation"))
    with m.execution(program="await call_tool('search', {})", tool="execute") as execution:
        call_tool = execution.instrument(lambda name: {"rows": 2})
        call_tool("search")

    spans = owner.get_finished_spans()
    assert [s.name for s in spans] == ["execute_tool search", "execute_code execute"]
    assert spans[1].instrumentation_scope.name == "mocon", "the scope names the instrumentation"
    assert spans[0].parent.span_id == spans[1].context.span_id
    assert spans[1].attributes["code_mode.execution.disposition"] == "completed"
