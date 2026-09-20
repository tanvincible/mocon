"""The emitter against a real OpenTelemetry SDK and a real in-memory exporter, so what is asserted
is what an exporter receives rather than what a mock was told. Each test is named for the rule in
spec/otel-code-mode.md that it protects.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest
from opentelemetry.trace import SpanKind, StatusCode

from conftest import ATTESTED, CAPS, harness, note
from mocon import Capabilities, CapturePolicy, CodeMode, Dimension


def sha(s: str) -> str:
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()


ON = CapturePolicy(values=True)


def test_the_declaration_is_on_every_span() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").output(1)
    ex.complete()
    assert len(h.spans()) == 2
    for span in h.spans():
        assert span.attributes["code_mode.observes_crossings"] == "all"
        assert span.attributes["code_mode.unmediated_egress"] is False
        assert span.attributes["code_mode.crossing_edge"] == "invocation"
        assert tuple(span.attributes["code_mode.attested"]) == ATTESTED


def test_a_host_that_attests_nothing_still_emits_the_list() -> None:
    h = harness(Capabilities(observes_crossings="none", unmediated_egress=True))
    h.m.execution(program="p").complete()
    span = h.one("execute_code")
    assert tuple(span.attributes["code_mode.attested"]) == ()
    assert "code_mode.crossing_edge" not in span.attributes, "no edge to declare when nothing is mediated"


def test_the_execution_span_is_named_kinded_and_operation_named_as_section_4_defines() -> None:
    h = harness()
    h.m.execution(
        program="p",
        tool="execute",
        tool_call_id="toolu_1",
        session_id="s1",
        execution_id="ex_1",
        language="javascript",
    ).complete()
    span = h.one("execute_code")
    assert span.name == "execute_code execute"
    assert span.kind is SpanKind.SERVER
    assert span.attributes["gen_ai.operation.name"] == "execute_code"
    assert span.attributes["gen_ai.tool.name"] == "execute"
    assert span.attributes["gen_ai.tool.call.id"] == "toolu_1"
    assert span.attributes["mcp.session.id"] == "s1"
    assert span.attributes["code_mode.execution.id"] == "ex_1"
    assert span.attributes["code_mode.program.language"] == "javascript"


def test_an_in_process_dispatch_is_internal_and_an_unnamed_one_drops_the_tool() -> None:
    h = harness()
    h.m.execution(program="p", kind="local").complete()
    span = h.one("execute_code")
    assert span.name == "execute_code"
    assert span.kind is SpanKind.INTERNAL


@pytest.mark.parametrize(
    "disposition,code",
    [("completed", StatusCode.UNSET), ("abandoned", StatusCode.UNSET), ("failed", StatusCode.ERROR), ("terminated", StatusCode.ERROR)],
)
def test_four_dispositions_collapse_to_two_statuses(disposition: str, code: StatusCode) -> None:
    h = harness()
    h.m.execution(program="p").end(disposition, error_type="timeout")
    span = h.one("execute_code")
    assert span.attributes["code_mode.execution.disposition"] == disposition, "the vocabulary is normative"
    assert span.status.status_code is code, "status is a display hint"


def test_instrumentation_never_sets_ok() -> None:
    h = harness()
    h.m.execution(program="p").complete()
    span = h.one("execute_code")
    assert span.status.status_code is StatusCode.UNSET
    assert "error.type" not in span.attributes


def test_a_failure_with_no_reason_carries_the_well_known_fallback() -> None:
    h = harness()
    h.m.execution(program="p").end("failed")
    assert h.one("execute_code").attributes["error.type"] == "_OTHER"


def test_the_status_description_carries_a_closed_vocabulary() -> None:
    h = harness()
    h.m.execution(program="p").fail(RuntimeError("boom"))
    span = h.one("execute_code")
    assert span.attributes["error.type"] == "runtime"
    assert span.attributes["code_mode.execution.disposition"] == "failed"
    # The description is the one field nothing can label, so it never carries a program claim.
    assert span.status.description == "runtime"
    assert "code_mode.error.message" not in span.attributes, "the reason is Opt-In, and capture is off here"


def test_with_capture_on_the_reason_is_written_where_it_can_be_labelled() -> None:
    h = harness(capture=ON)
    h.m.execution(program="p").fail(RuntimeError("boom"))
    span = h.one("execute_code")
    assert span.attributes["code_mode.error.message"] == '"boom"'
    assert span.attributes["code_mode.provenance.code_mode.error.message"] == "P"
    assert span.status.description == "runtime", "and the description still says nothing the program chose"


def test_a_crossing_span_is_a_child_of_its_execution() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("orders.cancel", call_id="c1", tool_type="function").output({"deleted": True})
    ex.complete()
    crossing = h.one("execute_tool")
    execution = h.one("execute_code")
    assert crossing.name == "execute_tool orders.cancel"
    assert crossing.kind is SpanKind.CLIENT
    assert crossing.parent.span_id == execution.context.span_id
    assert crossing.context.trace_id == execution.context.trace_id
    assert crossing.attributes["gen_ai.operation.name"] == "execute_tool"
    assert crossing.attributes["gen_ai.tool.name"] == "orders.cancel"
    assert crossing.attributes["gen_ai.tool.call.id"] == "c1"
    assert crossing.attributes["gen_ai.tool.type"] == "function"
    assert crossing.attributes["code_mode.crossing.outcome"] == "output"
    assert crossing.status.status_code is StatusCode.UNSET


@pytest.mark.parametrize(
    "outcome,code",
    [("output", StatusCode.UNSET), ("abandoned", StatusCode.UNSET), ("error", StatusCode.ERROR)],
)
def test_three_outcomes_collapse_to_two_statuses(outcome: str, code: StatusCode) -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").end(outcome)
    ex.complete()
    span = h.one("execute_tool")
    assert span.attributes["code_mode.crossing.outcome"] == outcome
    assert span.status.status_code is code


def test_an_abandoned_crossing_carries_no_error_type() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").end("abandoned")
    ex.complete()
    assert "error.type" not in h.one("execute_tool").attributes


def test_a_crossing_open_at_the_executions_end_is_closed_first_at_its_own_start() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("orders.ship")
    ex.end("terminated", error_type="timeout")
    first, second = h.spans()
    assert first.name == "execute_tool orders.ship", "the crossing ends before the execution that owns it"
    assert second.name == "execute_code"
    assert first.attributes["code_mode.crossing.outcome"] == "abandoned"
    assert first.attributes["code_mode.crossing.timing"] == "start_only"
    assert first.end_time == first.start_time, "closed where it began, which renders as a tick"


def test_a_crossing_that_settled_normally_has_real_timing_and_no_timing_attribute() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").output(1)
    ex.complete()
    assert "code_mode.crossing.timing" not in h.one("execute_tool").attributes


def test_seq_is_assigned_from_1_under_all() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("a").output(1)
    ex.crossing("b").output(2)
    ex.complete()
    assert [s.attributes["code_mode.crossing.seq"] for s in h.crossings()] == [1, 2]


def test_seq_is_not_assigned_under_some() -> None:
    h = harness(Capabilities(observes_crossings="some", unmediated_egress=True, crossing_edge="invocation"))
    ex = h.m.execution(program="p")
    ex.crossing("a").output(1)
    ex.complete()
    assert "code_mode.crossing.seq" not in h.one("execute_tool").attributes


def test_values_are_opt_in() -> None:
    h = harness()
    h.m.execution(program="const x = 1;").complete(result={"rows": 3})
    span = h.one("execute_code")
    assert span.attributes["code_mode.program.hash"] == sha("const x = 1;")
    assert "code_mode.program.text" not in span.attributes
    assert "gen_ai.tool.call.result" not in span.attributes
    assert "code_mode.capture" not in span.attributes, "an absent Opt-In attribute claims nothing"


def test_with_values_on_payloads_are_json_and_the_note_carries_size_and_hash() -> None:
    h = harness(capture=ON)
    ex = h.m.execution(program="const x = 1;")
    ex.crossing("t", input={"limit": 50}).output({"ok": True})
    ex.complete(result={"rows": 3}, outputs={"stdout": "hello"})
    execution = h.one("execute_code")
    crossing = h.one("execute_tool")
    assert execution.attributes["code_mode.program.text"] == "const x = 1;"
    assert execution.attributes["gen_ai.tool.call.result"] == '{"rows":3}'
    assert execution.attributes["code_mode.output.stdout"] == '"hello"'
    assert crossing.attributes["gen_ai.tool.call.arguments"] == '{"limit":50}'
    assert crossing.attributes["gen_ai.tool.call.result"] == '{"ok":true}'
    entry = note(crossing)["gen_ai.tool.call.arguments"]
    assert entry["bytes"] == 12
    assert entry["hash"] == sha('{"limit":50}')
    assert "truncated" not in entry


def test_a_value_past_the_cap_is_a_prefix_and_the_note_says_so() -> None:
    h = harness(capture=CapturePolicy(values=True, cap=64))
    rows = [{"name": "Person " + str(i)} for i in range(40)]
    whole = json.dumps(rows, separators=(",", ":"))
    ex = h.m.execution(program="p")
    ex.crossing("t", input=rows).output(1)
    ex.complete()
    crossing = h.one("execute_tool")
    written = crossing.attributes["gen_ai.tool.call.arguments"]
    # A cut value travels as a JSON string literal, so what it holds is a prefix of the whole.
    assert whole.startswith(json.loads(written)), "the written value is a prefix of the whole serialization"
    assert len(written.encode("utf-8")) <= 64
    entry = note(crossing)["gen_ai.tool.call.arguments"]
    assert entry["truncated"] is True
    assert entry["bytes"] == len(whole.encode("utf-8")), "the size describes the whole, not the prefix"


def test_a_value_past_the_measure_limit_keeps_no_size_it_did_not_read() -> None:
    h = harness(capture=CapturePolicy(values=True, cap=32, measure=64))
    ex = h.m.execution(program="p")
    ex.crossing("t", input=["x" * 20] * 40).output(1)
    ex.complete()
    entry = note(h.one("execute_tool"))["gen_ai.tool.call.arguments"]
    assert entry["truncated"] is True
    assert "bytes" not in entry, "the whole was never read, so its size is not claimed"
    assert "hash" not in entry


def test_a_program_past_its_own_cap_is_cut_and_still_hashed_whole() -> None:
    h = harness(capture=CapturePolicy(values=True, program_cap=16))
    program = "console.log('a very long program');"
    h.m.execution(program=program).complete()
    span = h.one("execute_code")
    assert span.attributes["code_mode.program.text"] == program[:16]
    assert span.attributes["code_mode.program.hash"] == sha(program)
    entry = note(span)["code_mode.program.text"]
    assert entry["truncated"] is True
    assert entry["bytes"] == len(program.encode("utf-8"))


def test_instrument_makes_one_crossing_per_call_and_reraises_the_exact_error() -> None:
    h = harness()
    ex = h.m.execution(program="p")

    def call_tool(name: str, args: Any) -> Any:
        if name == "bad":
            raise RuntimeError("refused")
        return {"ok": name, "args": args}

    bridge = ex.instrument(call_tool)
    assert bridge.__name__ == "call_tool"
    assert bridge("good", {"a": 1}) == {"ok": "good", "args": {"a": 1}}
    with pytest.raises(RuntimeError, match="refused"):
        bridge("bad", {})
    ex.complete()
    crossings = h.crossings()
    assert [s.attributes["gen_ai.tool.name"] for s in crossings] == ["good", "bad"]
    assert [s.attributes["code_mode.crossing.outcome"] for s in crossings] == ["output", "error"]
    assert crossings[1].attributes["error.type"] == "capability_error"
    assert crossings[1].status.description == "capability_error", "the description is the closed error type"


def test_instrument_reads_a_bridges_error_envelope_in_the_end_hook() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    bridge = ex.instrument(
        lambda name: {"ok": False, "error": "quota"},
        end=lambda answer: {"outcome": "error", "error_type": "refused"} if not answer.threw and answer.value["ok"] is False else None,
    )
    bridge("t")
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.attributes["code_mode.crossing.outcome"] == "error"
    assert crossing.attributes["error.type"] == "refused"


@pytest.mark.parametrize(
    "end",
    [
        lambda answer: (_ for _ in ()).throw(RuntimeError("hook")),
        lambda answer: "error",
        lambda answer: {"outcome": "exploded"},
        lambda answer: {"outcome": "output", "nonsense": 1},
    ],
)
def test_a_hook_that_raises_or_answers_badly_costs_the_reading_never_the_call(end: Any) -> None:
    h = harness()
    ex = h.m.execution(program="p")
    bridge = ex.instrument(lambda name: {"got": name}, end=end)
    assert bridge("t") == {"got": "t"}, "the call still returns what the bridge returned"
    ex.complete()
    assert h.one("execute_tool").attributes["code_mode.crossing.outcome"] == "output", "the default outcome still records it"


def test_the_context_manager_settles_completed_and_records_a_raise_as_failed() -> None:
    h = harness()
    with h.m.execution(program="p") as ex:
        assert ex.span is not None
    assert h.one("execute_code").attributes["code_mode.execution.disposition"] == "completed"

    f = harness()
    with pytest.raises(RuntimeError):
        with f.m.execution(program="p"):
            raise RuntimeError("boom")
    span = f.one("execute_code")
    assert span.attributes["code_mode.execution.disposition"] == "failed"
    assert span.attributes["error.type"] == "runtime"


def test_an_execution_the_body_ended_itself_is_not_ended_again() -> None:
    h = harness()
    with h.m.execution(program="p") as ex:
        ex.end("terminated", error_type="cancelled")
    assert len(h.executions()) == 1
    assert h.one("execute_code").attributes["code_mode.execution.disposition"] == "terminated"


def test_an_execution_ends_once() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.complete()
    ex.fail(RuntimeError("late"))
    assert len(h.executions()) == 1
    assert h.one("execute_code").attributes["code_mode.execution.disposition"] == "completed"


def test_a_capability_the_conventions_close_is_refused_at_construction() -> None:
    with pytest.raises(ValueError):
        CodeMode(Capabilities(observes_crossings="most", unmediated_egress=False))
    with pytest.raises(TypeError):
        CodeMode(Capabilities(observes_crossings="all", unmediated_egress="no"))
    with pytest.raises(ValueError):
        CodeMode(Capabilities(observes_crossings="all", unmediated_egress=False))
    with pytest.raises(ValueError):
        CodeMode(Capabilities(observes_crossings="all", unmediated_egress=False, crossing_edge="sideways"))
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, attested=("crossing.everything",)))
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, attested=("host_attributes",)))
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, attested_attributes=("com.acme.credits",)))
    with pytest.raises(TypeError):
        CodeMode(CAPS, capture={"values": True})


def test_the_declaration_is_frozen() -> None:
    attested = ["crossing.target", "crossing.input"]
    h = harness(Capabilities(observes_crossings="all", unmediated_egress=False, crossing_edge="invocation", attested=attested))
    attested.append("crossing.error")
    attested.clear()
    h.m.execution(program="p").complete()
    assert tuple(h.one("execute_code").attributes["code_mode.attested"]) == ("crossing.target", "crossing.input")


def test_an_mcp_crossing_is_one_span_carrying_both_vocabularies() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("search", mcp_method="tools/call", mcp_session="s1").output(1)
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.attributes["mcp.method.name"] == "tools/call"
    assert crossing.attributes["mcp.session.id"] == "s1"
    assert crossing.attributes["gen_ai.tool.name"] == "search"


def test_an_unbounded_target_keeps_the_span_name_bounded() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("https://api.example.com/v1/people/12345", name="execute_tool fetch").output(1)
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.name == "execute_tool fetch"
    assert crossing.attributes["gen_ai.tool.name"] == "https://api.example.com/v1/people/12345"


def test_the_worked_example_in_section_15_comes_out_as_the_document_prints_it() -> None:
    h = harness(capture=ON)
    program = "await orders.cancel({id: 'rec_50'});\n"
    ex = h.m.execution(program=program, tool="execute", language="javascript", execution_id="3c95e2578dd5e0169e81c566e43fac92")
    ex.crossing("orders.cancel", input={"id": "rec_50"}).output({"deleted": True})
    ex.crossing("orders.ship", input={"amountCents": 500000, "to": "acct_9"})
    ex.end("terminated", error_type="timeout", message="execution TTL (300s) elapsed while orders.ship awaited approval")

    settled, abandoned, execution = h.spans()
    assert execution.name == "execute_code execute"
    assert execution.kind is SpanKind.SERVER
    assert execution.status.status_code is StatusCode.ERROR
    assert execution.attributes["code_mode.execution.disposition"] == "terminated"
    assert execution.attributes["error.type"] == "timeout"
    assert execution.attributes["code_mode.execution.id"] == "3c95e2578dd5e0169e81c566e43fac92"
    assert execution.attributes["code_mode.program.hash"] == sha(program)

    assert settled.attributes["code_mode.crossing.outcome"] == "output"
    assert settled.attributes["code_mode.crossing.seq"] == 1

    assert abandoned.name == "execute_tool orders.ship"
    assert abandoned.kind is SpanKind.CLIENT
    assert abandoned.parent.span_id == execution.context.span_id
    assert abandoned.status.status_code is StatusCode.UNSET, "abandoned is not a failure"
    assert abandoned.attributes["code_mode.crossing.outcome"] == "abandoned"
    assert abandoned.attributes["code_mode.crossing.timing"] == "start_only"
    assert abandoned.attributes["code_mode.crossing.seq"] == 2
    assert abandoned.end_time == abandoned.start_time
    assert note(abandoned)["gen_ai.tool.call.arguments"]["bytes"] == 36, "the input size the fixture records"
    assert "gen_ai.tool.call.result" not in abandoned.attributes, "no result: the host never determined one"


def test_a_host_attribute_cannot_overwrite_the_declaration_or_the_target() -> None:
    h = harness()
    ex = h.m.execution(
        program="p",
        attributes={"code_mode.observes_crossings": "none", "gen_ai.operation.name": "invoke_agent", "com.acme.sandbox": "sb_1"},
    )
    # Not only the keys the emitter writes itself: a reserved-namespace key it happens not to write
    # on this span would otherwise survive as a forged payload, or a forged provenance label.
    ex.crossing(
        "real",
        attributes={
            "gen_ai.tool.name": "forged",
            "gen_ai.tool.call.arguments": '{"forged":1}',
            "code_mode.provenance.gen_ai.tool.name": "H",
            "mcp.resource.uri": "file:///etc/passwd",
            "otel.status_code": "OK",
        },
    ).output(1)
    ex.end("failed", attributes={"code_mode.execution.disposition": "completed"})
    execution = h.one("execute_code")
    assert execution.attributes["code_mode.observes_crossings"] == "all"
    assert execution.attributes["gen_ai.operation.name"] == "execute_code"
    assert execution.attributes["code_mode.execution.disposition"] == "failed"
    assert execution.attributes["com.acme.sandbox"] == "sb_1", "the host's own namespace is untouched"
    crossing = h.one("execute_tool")
    assert crossing.attributes["gen_ai.tool.name"] == "real"
    for forged in ("gen_ai.tool.call.arguments", "mcp.resource.uri", "otel.status_code"):
        assert forged not in crossing.attributes, f"{forged} is not the host's own namespace"
    assert "code_mode.provenance.gen_ai.tool.name" not in crossing.attributes, "a label cannot be supplied from outside"


def test_a_crossing_span_carries_the_execution_id() -> None:
    h = harness()
    ex = h.m.execution(program="p", execution_id="exec_42")
    ex.crossing("inventory_search").output({"rows": 4})
    ex.crossing("item_fetch").error(RuntimeError("429"), error_type="rate_limited")
    ex.complete()

    # The query a backend actually runs: one span at a time, both terms on the same span. Parentage
    # cannot answer it, which is why the id is repeated rather than left to the parent.
    failed = [
        s
        for s in h.spans()
        if s.attributes.get("code_mode.execution.id") == "exec_42" and s.attributes.get("code_mode.crossing.outcome") == "error"
    ]
    assert len(failed) == 1, "the failing crossing is reachable by the execution's own id"
    assert failed[0].attributes["gen_ai.tool.name"] == "item_fetch"
    assert failed[0].attributes["error.type"] == "rate_limited"
    assert len([s for s in h.spans() if s.attributes.get("code_mode.execution.id") == "exec_42"]) == 3


def test_crossings_of_an_execution_that_never_ended_still_carry_the_id() -> None:
    h = harness()
    ex = h.m.execution(program="p", execution_id="exec_43")
    ex.crossing("t").output(1)
    # The execution span is deliberately never ended: the process died. Its span was never exported,
    # so a consumer holding the crossing has no parent to resolve and only this key to work with.
    assert len(h.spans()) == 1
    assert h.spans()[0].attributes["code_mode.execution.id"] == "exec_43"


def test_a_host_with_no_id_of_its_own_gets_one_minted() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").output(1)
    ex.complete()
    crossing, execution = (s.attributes["code_mode.execution.id"] for s in h.spans())
    assert isinstance(execution, str)
    assert crossing == execution, "both spans of one dispatch answer to the same key"
    other = harness()
    other.m.execution(program="p").complete()
    assert other.one("execute_code").attributes["code_mode.execution.id"] != execution


def test_an_unattested_host_labels_every_program_claim_beside_the_value() -> None:
    h = harness(Capabilities(observes_crossings="none", unmediated_egress=True), capture=ON)
    ex = h.m.execution(program="p")
    ex.crossing("item_fetch", input={"q": 1}).output({"ok": True})
    ex.complete()
    crossing = h.one("execute_tool")
    # The target names the span and is what every span-metrics connector keys on. Unattested, it is
    # something the program said, and this is the only thing on the span that says so.
    assert crossing.attributes["gen_ai.tool.name"] == "item_fetch"
    assert crossing.attributes["code_mode.provenance.gen_ai.tool.name"] == "P"
    assert crossing.attributes["code_mode.provenance.code_mode.crossing.outcome"] == "P"
    assert crossing.attributes["code_mode.provenance.gen_ai.tool.call.arguments"] == "P"
    assert crossing.attributes["code_mode.provenance.gen_ai.tool.call.result"] == "P"


def test_attestation_removes_the_label_and_an_attested_output_reads_as_target_relayed() -> None:
    h = harness(capture=ON)
    ex = h.m.execution(program="p")
    ex.crossing("t", input={"q": 1}).output({"ok": True})
    ex.complete()
    crossing = h.one("execute_tool")
    assert "code_mode.provenance.gen_ai.tool.name" not in crossing.attributes, "observed, so no label at all"
    assert "code_mode.provenance.gen_ai.tool.call.arguments" not in crossing.attributes
    assert crossing.attributes["code_mode.provenance.gen_ai.tool.call.result"] == "T", "the target said it, not the host"


def test_an_output_channel_is_always_a_program_claim() -> None:
    h = harness(capture=ON)
    h.m.execution(program="p").complete(outputs={"stdout": "hi", "files": ["a.txt"]})
    span = h.one("execute_code")
    assert span.attributes["code_mode.provenance.code_mode.output.stdout"] == "P"
    assert span.attributes["code_mode.provenance.code_mode.output.files"] == "P"


def test_a_hosts_own_attribute_is_a_program_claim_until_both_gates_are_passed() -> None:
    claimed = harness()
    claimed.m.execution(program="p", attributes={"com.acme.credits": 5}).complete()
    assert claimed.one("execute_code").attributes["code_mode.provenance.com.acme.credits"] == "P"

    observed = harness(_replace(CAPS, attested=ATTESTED + ("host_attributes",), attested_attributes=("com.acme.credits",)))
    observed.m.execution(program="p", attributes={"com.acme.credits": 5, "com.acme.plan": "pro"}).complete()
    span = observed.one("execute_code")
    assert "code_mode.provenance.com.acme.credits" not in span.attributes, "named and attested, so observed"
    assert span.attributes["code_mode.provenance.com.acme.plan"] == "P", "attested but unnamed is still a claim"


def test_a_number_the_target_reported_is_target_relayed() -> None:
    # The case that has no honest expression without this: a host bills from a credit count its API
    # returned. Attesting it claims the host measured it, which is false. Leaving it a program claim
    # is also false, and forbids the cost metric an operator actually needs.
    h = harness(
        _replace(
            CAPS,
            attested=ATTESTED + ("host_attributes",),
            attested_attributes=("com.acme.engine",),
            relayed_attributes=("com.acme.credits_used",),
        )
    )
    ex = h.m.execution(program="p", attributes={"com.acme.engine": "quickjs"})
    ex.crossing("search", attributes={"com.acme.credits_used": 5, "com.acme.cache_hit": True}).output(1)
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.attributes["code_mode.provenance.com.acme.credits_used"] == "T", "the target's number, passed through"
    assert crossing.attributes["code_mode.provenance.com.acme.cache_hit"] == "P", "named in neither list, so still a claim"
    assert "code_mode.provenance.com.acme.engine" not in h.one("execute_code").attributes


def test_an_attribute_cannot_be_both_measured_and_relayed() -> None:
    with pytest.raises(ValueError):
        CodeMode(
            _replace(
                CAPS,
                attested=ATTESTED + ("host_attributes",),
                attested_attributes=("com.acme.x",),
                relayed_attributes=("com.acme.x",),
            )
        )
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, relayed_attributes=("com.acme.x",)))
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, attested=ATTESTED + ("host_attributes",)))


def test_a_crossing_says_whether_it_left_the_host() -> None:
    h = harness(_replace(CAPS, attested=ATTESTED + ("crossing.error",)))
    ex = h.m.execution(program="p")
    # A refusal the host answered itself. Its error is not the program's, so it reads target-relayed,
    # which alone would send an operator to an API the call never reached.
    ex.crossing("t", dispatched=False).error(RuntimeError("over cap"), error_type="refused")
    ex.crossing("t", dispatched=True).error(RuntimeError("upstream"), error_type="capability_error")
    ex.complete()
    refused, upstream = h.crossings()
    assert refused.attributes["code_mode.crossing.dispatched"] is False
    assert upstream.attributes["code_mode.crossing.dispatched"] is True
    assert refused.attributes["code_mode.provenance.error.type"] == "T", "both read T, which is why the bit is needed"
    assert upstream.attributes["code_mode.provenance.error.type"] == "T"
    assert "code_mode.provenance.code_mode.crossing.dispatched" not in refused.attributes


def test_a_host_that_cannot_tell_whether_a_call_left_writes_nothing() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").output(1)
    ex.complete()
    assert "code_mode.crossing.dispatched" not in h.one("execute_tool").attributes


def test_a_host_says_what_its_own_attributes_mean() -> None:
    h = harness(
        _replace(
            CAPS,
            attested=ATTESTED + ("host_attributes",),
            relayed_attributes=("com.acme.credits_used",),
            declared={
                "com.acme.credits_used": Dimension(agg="sum", unit="{credit}", card="low", name="Credits"),
                "com.acme.tenant_id": Dimension(agg="none", card="high"),
            },
        )
    )
    ex = h.m.execution(program="p", attributes={"com.acme.tenant_id": "t_9"})
    ex.crossing("search", attributes={"com.acme.credits_used": 5}).output(1)
    ex.complete()
    declared = json.loads(h.one("execute_code").attributes["code_mode.declared"])
    assert declared["com.acme.credits_used"] == {"agg": "sum", "unit": "{credit}", "card": "low", "name": "Credits"}
    assert declared["com.acme.tenant_id"] == {"agg": "none", "card": "high"}
    # Summable by declaration, believable by provenance. A consumer needs both and they are separate
    # claims: this one says the number adds up, the label says whose number it is.
    assert h.one("execute_tool").attributes["code_mode.provenance.com.acme.credits_used"] == "T"


def test_the_meaning_declaration_rides_the_execution_span_only() -> None:
    h = harness(_replace(CAPS, declared={"com.acme.x": Dimension(agg="sum")}))
    ex = h.m.execution(program="p")
    ex.crossing("t").output(1)
    ex.complete()
    assert "code_mode.declared" not in h.one("execute_tool").attributes, "a crossing does not pay for it"
    assert "code_mode.declared" in h.one("execute_code").attributes


def test_a_meaning_nobody_could_act_on_is_refused_at_construction() -> None:
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, declared={"com.acme.x": Dimension(agg="average")}))
    with pytest.raises(ValueError):
        CodeMode(_replace(CAPS, declared={"com.acme.x": Dimension(agg="sum", card="medium")}))
    with pytest.raises(TypeError):
        CodeMode(_replace(CAPS, declared={"com.acme.x": "sum"}))


def test_the_parent_context_places_the_execution_under_the_callers_span() -> None:
    from opentelemetry import trace as otel_trace

    h = harness()
    caller = h.m._tracer.start_span("caller")
    parent = otel_trace.set_span_in_context(caller)
    h.m.execution(program="p", parent=parent).complete()
    caller.end()
    execution = h.one("execute_code")
    assert execution.parent.span_id == caller.get_span_context().span_id
    assert execution.context.trace_id == caller.get_span_context().trace_id


def _replace(caps: Capabilities, **changes: Any) -> Capabilities:
    import dataclasses

    return dataclasses.replace(caps, **changes)


def test_instrument_reads_as_a_decorator() -> None:
    h = harness()
    ex = h.m.execution(program="p")

    @ex.instrument
    def call_tool(name: str) -> str:
        return name

    @ex.instrument(target="fixed", tool_type="datastore")
    def query(sql: str) -> int:
        return 1

    call_tool("search")
    query("select 1")
    ex.complete()
    crossings = h.crossings()
    assert [s.attributes["gen_ai.tool.name"] for s in crossings] == ["search", "fixed"]
    assert crossings[1].attributes["gen_ai.tool.type"] == "datastore"


def test_a_crossing_reads_as_a_context_manager() -> None:
    h = harness()
    with h.m.execution(program="p") as ex:
        with ex.crossing("orders.cancel") as crossing:
            crossing.output({"deleted": True})
        with pytest.raises(RuntimeError):
            with ex.crossing("orders.ship"):
                raise RuntimeError("upstream")
    settled, failed, _ = h.spans()
    assert settled.attributes["code_mode.crossing.outcome"] == "output"
    assert failed.attributes["code_mode.crossing.outcome"] == "error"
    assert failed.attributes["error.type"] == "capability_error"


def test_the_target_and_input_hooks_derive_from_the_arguments() -> None:
    h = harness(capture=ON)
    ex = h.m.execution(program="p")
    bridge = ex.instrument(
        lambda server, tool, params: 1,
        target=lambda server, tool, params: f"{server}.{tool}",
        input=lambda server, tool, params: params,
    )
    bridge("orders", "cancel", {"id": 50})
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.attributes["gen_ai.tool.name"] == "orders.cancel"
    assert crossing.attributes["gen_ai.tool.call.arguments"] == '{"id":50}'


def test_keyword_arguments_are_captured_as_the_default_input() -> None:
    h = harness(capture=ON)
    ex = h.m.execution(program="p")
    ex.instrument(lambda name, **params: 1)("search", limit=5)
    ex.complete()
    assert h.one("execute_tool").attributes["gen_ai.tool.call.arguments"] == '{"limit":5}'


def test_none_is_a_recorded_null_and_an_omitted_value_is_absent() -> None:
    h = harness(capture=ON)
    ex = h.m.execution(program="p")
    ex.crossing("explicit").output(None)
    ex.crossing("omitted").output()
    ex.complete()
    explicit, omitted = h.crossings()
    assert explicit.attributes["gen_ai.tool.call.result"] == "null", "a host that records None means null"
    assert "gen_ai.tool.call.result" not in omitted.attributes, "an absent Opt-In attribute claims nothing"
