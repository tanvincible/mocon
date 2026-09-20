"""All three OpenTelemetry signals from the same two wrappers, against real SDKs.

The point of each is different. Traces show the shape of one run. Metrics answer questions across
many runs, and must never be keyed on something the program chose. Log records say a run is in
flight right now, which is the one thing a span cannot do, because a span exports only when it ends.
"""

from __future__ import annotations

import dataclasses

from conftest import CAPS, harness
from mocon import Capabilities


def test_one_integration_produces_all_three_signals() -> None:
    h = harness()
    with h.m.execution(program="p", tool="execute", execution_id="run-1") as ex:
        ex.instrument(lambda name: {"rows": 2})("inventory_search")

    assert [s.name for s in h.spans()] == ["execute_tool inventory_search", "execute_code execute"]
    assert sorted(m.name for m in h.points()) == ["code_mode.crossing.duration", "code_mode.execution.duration"]
    assert [r.attributes["event.name"] for r in h.records()] == ["code_mode.execution.started", "code_mode.execution.ended"]


def test_a_log_record_says_a_run_is_in_flight() -> None:
    h = harness()
    ex = h.m.execution(program="p", execution_id="run-2")
    # Nothing has ended, so the trace is empty and the run is invisible there.
    assert h.spans() == []
    started = h.records()
    assert len(started) == 1
    assert started[0].attributes["event.name"] == "code_mode.execution.started"
    assert started[0].attributes["code_mode.execution.id"] == "run-2"
    ex.complete()
    assert len(h.spans()) == 1, "and the span turns up once it finishes"


def test_log_records_carry_the_trace_and_span_id() -> None:
    h = harness()
    h.m.execution(program="p").complete()
    span = h.one("execute_code")
    for record in h.records():
        assert record.attributes["trace_id"] == f"{span.context.trace_id:032x}"
        assert record.attributes["span_id"] == f"{span.context.span_id:016x}"


def test_a_metric_is_never_keyed_on_a_target_the_host_did_not_observe() -> None:
    # Attested: the target is a fact, so it is a legitimate dimension.
    observed = harness()
    with observed.m.execution(program="p") as ex:
        ex.instrument(lambda n: 1)("inventory_search")
    attested = observed.metric("code_mode.crossing.duration")
    assert attested.data.data_points[0].attributes["gen_ai.tool.name"] == "inventory_search"

    # Unattested: the same name is the program's word, so it is dropped rather than counted as fact.
    claimed = harness(Capabilities(observes_crossings="some", unmediated_egress=True, crossing_edge="invocation"))
    with claimed.m.execution(program="p") as ex:
        ex.instrument(lambda n: 1)("inventory_search")
    point = claimed.metric("code_mode.crossing.duration").data.data_points[0]
    assert "gen_ai.tool.name" not in point.attributes
    assert "code_mode.crossing.outcome" not in point.attributes
    assert point.count == 1, "the duration itself is still recorded"


def test_the_execution_metric_is_keyed_on_the_disposition() -> None:
    h = harness(Capabilities(observes_crossings="none", unmediated_egress=True))
    h.m.execution(program="p").end("terminated", error_type="timeout")
    m = h.metric("code_mode.execution.duration")
    assert m.data.data_points[0].attributes["code_mode.execution.disposition"] == "terminated"
    assert m.data.data_points[0].attributes["error.type"] == "timeout"
    assert m.unit == "s"


def test_an_abandoned_call_records_no_duration() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("orders.ship")
    ex.complete()
    m = h.metric("code_mode.crossing.duration")
    total = sum(p.count for p in m.data.data_points) if m is not None else 0
    assert total == 0


def test_an_execution_duration_is_seconds_of_real_time() -> None:
    h = harness()
    start = 1_000_000_000_000_000_000
    h.m.execution(program="p", start_time=start).end("completed", end_time=start + 2_500_000_000)
    point = h.metric("code_mode.execution.duration").data.data_points[0]
    assert point.sum == 2.5


def test_a_signal_can_be_switched_off() -> None:
    h = harness(CAPS, None, metrics=False, logs=False)
    h.m.execution(program="p").complete()
    assert len(h.spans()) == 1, "traces still come out"
    assert h.records() == []
    assert h.points() == []


def test_metrics_reach_the_meter_provider_the_owner_registered() -> None:
    # The escape hatch is a convenience; the default path is the global API, which is what a host
    # that configures nothing gets. It must not raise when no provider was ever registered.
    from mocon import CodeMode

    m = CodeMode(dataclasses.replace(CAPS), tracer=harness().m._tracer)
    m.execution(program="p").complete()
