"""The values a code-mode emitter captures come from the program, which is agent-written.
Serializing one runs its code: a property, a ``__getattr__``, a ``__dict__`` that lies, a ``__str__``
that raises. Every test here asserts the same rule from otel-code-mode.md 10, the one that decides
whether this library is safe to put on a request path: no emitter fault may raise into the caller,
and the span is still recorded.
"""

from __future__ import annotations

from typing import Any, Iterator, Mapping

import pytest

from mocon import capture
from conftest import harness, note


class Boom(Exception):
    pass


class LyingDict:
    """Its own ``__dict__`` raises, which is where ``json`` looks when it meets an object."""

    @property
    def __dict__(self) -> dict[str, Any]:  # type: ignore[override]
        raise Boom("hostile")


class HostileItems(dict):
    """Serializes part of itself and then raises, the way a property that fails mid-walk does."""

    def items(self) -> Iterator[tuple[str, Any]]:  # type: ignore[override]
        yield ("ok", 1)
        raise Boom("hostile")


class HostileMapping(Mapping):
    """A mapping that answers with one entry and then raises, for the containers the emitter reads
    itself: output channels and the host's own attributes."""

    def __init__(self, first: tuple[str, Any]) -> None:
        self._first = first

    def __iter__(self) -> Iterator[str]:
        yield self._first[0]
        raise Boom("hostile")

    def __getitem__(self, key: str) -> Any:
        if key == self._first[0]:
            return self._first[1]
        raise Boom("hostile")

    def __len__(self) -> int:
        return 2


def _cycle() -> dict[str, Any]:
    c: dict[str, Any] = {}
    c["self"] = c
    return c


#: Each returns a value whose serialization runs code that fails.
HOSTILE: list[tuple[str, Any]] = [
    ("a __dict__ that lies", LyingDict),
    ("a mapping that raises mid-walk", lambda: HostileItems(a=1)),
    ("a cycle", _cycle),
    ("a set, which JSON refuses", lambda: {"n": {1, 2}}),
    ("a NaN, which JSON has no value for", lambda: {"n": float("nan")}),
    ("an object json cannot reach at all", lambda: {"n": object()}),
]


@pytest.mark.parametrize("what,make", HOSTILE, ids=[w for w, _ in HOSTILE])
def test_hostile_result_costs_the_value_not_the_execution(what: str, make: Any) -> None:
    h = harness(capture=_values(True))
    h.m.execution(program="p").complete(result=make())
    span = h.one("execute_code")
    assert span.attributes["code_mode.execution.disposition"] == "completed", "the execution still records"
    assert "gen_ai.tool.call.result" not in span.attributes, "the value it could not serialize is not written"
    assert note(span)["gen_ai.tool.call.result"]["redacted"] is True, "and the note says the host dropped it"


@pytest.mark.parametrize("what,make", HOSTILE, ids=[w for w, _ in HOSTILE])
def test_hostile_input_costs_the_value_not_the_call(what: str, make: Any) -> None:
    h = harness(capture=_values(True))
    ex = h.m.execution(program="p")
    bridge = ex.instrument(lambda name, args: {"ok": True})
    assert bridge("search", make()) == {"ok": True}, "the bridge still ran and answered"
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.attributes["code_mode.crossing.outcome"] == "output"
    assert note(crossing)["gen_ai.tool.call.arguments"]["redacted"] is True


def test_a_hostile_str_on_a_bridge_argument_names_the_target_without_running_it() -> None:
    class Hostile:
        def __str__(self) -> str:
            raise Boom("hostile")

        __repr__ = __str__

    h = harness()
    ex = h.m.execution(program="p")
    bridge = ex.instrument(lambda first: 1)
    assert bridge(Hostile()) == 1, "the call still ran"
    ex.complete()
    assert h.one("execute_tool").attributes["gen_ai.tool.name"] == "[object]", "labelled by type, never by its own __str__"


def test_a_raising_channel_costs_that_channel_not_the_execution() -> None:
    h = harness(capture=_values(True))
    h.m.execution(program="p").complete(outputs=HostileMapping(("stdout", "fine")))
    span = h.one("execute_code")
    assert span.attributes["code_mode.execution.disposition"] == "completed"
    assert span.attributes["code_mode.output.stdout"] == '"fine"', "the channels read before the raise survive"


def test_a_raising_host_attribute_costs_that_attribute_not_the_execution() -> None:
    h = harness()
    h.m.execution(program="p", attributes=HostileMapping(("com.acme.ok", 1))).complete()
    span = h.one("execute_code")
    assert span.attributes["code_mode.execution.disposition"] == "completed"
    assert span.attributes["com.acme.ok"] == 1


def test_an_outputs_container_that_is_not_a_mapping_is_refused_before_the_span_changes() -> None:
    h = harness(capture=_values(True))
    ex = h.m.execution(program="p")
    with pytest.raises(TypeError):
        ex.complete(outputs="stdout")
    assert h.spans() == [], "the span is untouched, so the host can still end it correctly"
    ex.complete()
    assert h.one("execute_code").attributes["code_mode.execution.disposition"] == "completed"


# Ported from the retired format's negative corpus. Those fixtures were the reason it could not ship
# a defect this emitter did ship, so the cases that still apply are asserted here instead.


def test_a_sequence_number_that_is_not_a_positive_integer_is_refused() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    for seq in (-1, 0, 1.5, "two", float("nan"), None, True):
        ex.crossing("t", seq=seq).output(1)
    ex.complete()
    written = [s.attributes["code_mode.crossing.seq"] for s in h.crossings()]
    assert written == [1, 2, 3, 4, 5, 6, 7], "each falls back to the host's own counter, which is trustworthy"


def test_a_supplied_sequence_number_is_kept_when_it_is_a_positive_integer() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t", seq=7).output(1)
    ex.complete()
    assert h.one("execute_tool").attributes["code_mode.crossing.seq"] == 7


def test_an_end_with_no_disposition_is_refused_before_the_span_is_touched() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    with pytest.raises(ValueError):
        ex.end("nonsense")
    with pytest.raises(TypeError):
        ex.end()  # type: ignore[call-arg]
    assert h.spans() == [], "the span is untouched, so the host can still end it correctly"
    ex.complete()
    assert h.one("execute_code").attributes["code_mode.execution.disposition"] == "completed"


def test_an_unknown_outcome_is_refused_and_leaves_the_crossing_open() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    crossing = ex.crossing("t")
    with pytest.raises(ValueError):
        crossing.end("exploded")
    crossing.output(1)
    ex.complete()
    assert h.one("execute_tool").attributes["code_mode.crossing.outcome"] == "output"


def test_an_execution_id_that_is_not_a_string_gets_a_minted_one() -> None:
    h = harness()
    h.m.execution(program="p", execution_id=42).complete()
    written = h.one("execute_code").attributes["code_mode.execution.id"]
    assert isinstance(written, str)
    assert written != "42", "a number is not silently stringified into the host's own id space"


def test_a_program_that_is_not_a_string_is_the_hosts_own_bug() -> None:
    h = harness()
    with pytest.raises(TypeError):
        h.m.execution(program=object())
    assert h.spans() == []


def test_an_error_field_passed_with_a_successful_outcome_is_ignored() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    ex.crossing("t").end("output", error_type="timeout", message="nope")
    ex.complete()
    crossing = h.one("execute_tool")
    assert crossing.attributes["code_mode.crossing.outcome"] == "output"
    assert "error.type" not in crossing.attributes, "the closed outcome decides, not the stray field"
    assert crossing.status.status_code.name == "UNSET", "and the status stays Unset"


def test_a_target_that_is_not_a_string_is_refused_before_a_span_exists() -> None:
    h = harness()
    ex = h.m.execution(program="p")
    with pytest.raises(TypeError):
        ex.crossing(42)
    ex.complete()
    assert h.crossings() == []


def _values(on: bool) -> Any:
    from mocon import CapturePolicy

    return CapturePolicy(values=on)


def test_a_deeply_nested_value_costs_the_value_not_the_execution() -> None:
    """Recursion is a serializer fault like any other: json recurses per container, and a program
    that nests ten thousand deep gets its value redacted rather than the host's call unwound."""
    deep: Any = {}
    node = deep
    for _ in range(20000):
        node["n"] = {}
        node = node["n"]
    h = harness(capture=_values(True))
    h.m.execution(program="p").complete(result=deep)
    span = h.one("execute_code")
    assert span.attributes["code_mode.execution.disposition"] == "completed"
    assert note(span)["gen_ai.tool.call.result"]["redacted"] is True


def test_an_endless_value_is_read_no_further_than_the_measure_limit() -> None:
    """A mapping that never stops answering. The walk stops at `measure`, so the emitter reads a
    bounded prefix of an unbounded value and says it could not size the whole."""

    class Endless(dict):
        def __bool__(self) -> bool:
            return True

        def items(self) -> Iterator[tuple[str, Any]]:  # type: ignore[override]
            i = 0
            while True:
                yield (f"k{i}", "x" * 32)
                i += 1

    from mocon import CapturePolicy

    h = harness(capture=CapturePolicy(values=True, cap=64, measure=4096))
    h.m.execution(program="p").complete(result=Endless())
    span = h.one("execute_code")
    written = span.attributes["gen_ai.tool.call.result"]
    assert len(written.encode("utf-8")) <= 64
    entry = note(span)["gen_ai.tool.call.result"]
    assert entry["truncated"] is True
    assert "bytes" not in entry, "the whole was never read, so no size is claimed for it"


def test_a_cut_value_lands_on_a_code_point_boundary() -> None:
    import json

    from mocon import CapturePolicy

    h = harness(capture=CapturePolicy(values=True, cap=11))
    # Each e-acute is two UTF-8 bytes, so an odd cap lands inside one unless the cut is guarded, and
    # the cut is taken before escaping so it can never land inside an escape either.
    h.m.execution(program="p").complete(result="é" * 40)
    written = h.one("execute_code").attributes["gen_ai.tool.call.result"]
    assert len(written.encode("utf-8")) <= 11
    assert json.dumps("é" * 40, ensure_ascii=False).startswith(json.loads(written))
    assert written.encode("utf-8").decode("utf-8") == written, "the prefix is valid UTF-8"


def test_a_program_with_a_lone_surrogate_is_still_hashed() -> None:
    from mocon import CapturePolicy

    h = harness(capture=CapturePolicy(values=True))
    h.m.execution(program="a\ud800b").complete()
    span = h.one("execute_code")
    assert span.attributes["code_mode.program.hash"].startswith("sha256:")
    assert span.attributes["code_mode.execution.disposition"] == "completed"


def test_a_crossing_that_starts_after_its_execution_ended_is_still_recorded() -> None:
    """The bookkeeping lesson: a late crossing is emitted rather than buffered into oblivion. It
    carries the execution id, so a reader groups it back onto the run it belongs to."""
    h = harness()
    ex = h.m.execution(program="p", execution_id="exec_late")
    ex.complete()
    late = ex.crossing("orders.ship")
    late.output(1)
    crossing = h.one("execute_tool")
    assert crossing.attributes["code_mode.crossing.outcome"] == "output"
    assert crossing.attributes["code_mode.execution.id"] == "exec_late"


def test_instrumenting_something_that_is_not_a_function_still_works_or_is_refused() -> None:
    class Bridge:
        def __call__(self, name: str) -> str:
            return name

    h = harness()
    ex = h.m.execution(program="p")
    assert ex.instrument(Bridge())("search") == "search"
    with pytest.raises(TypeError):
        ex.instrument("not a callable")
    ex.complete()
    assert h.one("execute_tool").attributes["gen_ai.tool.name"] == "search"


def test_a_string_far_past_the_cap_is_refused_rather_than_read() -> None:
    """The refusal is its own path, not a fault caught on the way out: an exception here would be
    swallowed by the same handler that catches a program's throwing getter, so a defect in it would
    report the right note for the wrong reason and stay invisible."""
    cap = capture.CapturePolicy(values=True, cap=64)
    encoded = capture.Capture(cap)._encode("x" * (64 * 64 + 1))
    assert encoded.text is None

    h = harness(capture=cap)
    ex = h.m.execution(program="p")
    ex.crossing("orders.list").output("x" * (64 * 64 + 1))
    ex.complete()
    assert note(h.one("execute_tool"))["gen_ai.tool.call.result"] == {"redacted": True}


def test_an_exception_body_carries_the_name_and_message_rather_than_an_empty_object() -> None:
    """An exception's ``__dict__`` is almost always empty, so the body would serialize to ``{}`` and
    the capture note would attest a hash of nothing. The class and the message are what a reader
    needs, and a hostile ``__str__`` costs the message rather than the call."""

    class HttpError(Exception):
        def __init__(self, message: str, code: int) -> None:
            super().__init__(message)
            self.code = code

    class Hostile(Exception):
        def __str__(self) -> str:
            raise RuntimeError("TRAP")

    cap = capture.CapturePolicy(values=True)
    for raised, expected in [
        (ValueError("disk full"), '{"name":"ValueError","message":"disk full"}'),
        (HttpError("gone", 410), '{"name":"HttpError","message":"gone","code":410}'),
        (Hostile(), '{"name":"Hostile"}'),
    ]:
        h = harness(capture=cap)
        ex = h.m.execution(program="p")
        ex.fail(raised)
        assert h.one("execute_code").attributes["code_mode.error.body"] == expected


def test_a_message_is_read_from_anything_carrying_one() -> None:
    """Matching the TypeScript emitter, which reads by shape because an error raised inside a
    sandbox fails an identity check against the host's own error type."""

    class Envelope:
        message = "disk full"

    cap = capture.CapturePolicy(values=True)
    for raised, expected in [(Envelope(), '"disk full"'), ("disk full", '"disk full"'), (object(), None)]:
        h = harness(capture=cap)
        ex = h.m.execution(program="p")
        ex.fail(raised)
        assert h.one("execute_code").attributes.get("code_mode.error.message") == expected
