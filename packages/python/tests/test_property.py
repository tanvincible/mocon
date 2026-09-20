"""Section 10 as a PROPERTY over the whole public surface, rather than one function at a time.

Every earlier hostile test picked a function, attacked it, and was fixed at that one call site. That
is how four sibling guards were left on ``except Exception`` after their neighbour was widened, and
how one time coercion sat on five entry points at once. This enumerates instead: every place a host
can hand the emitter a program-authored value, crossed with every shape of hostile value, asserting
the two things section 10 actually promises.

  1. Nothing raises into the caller. Telemetry costs the value, never the request.
  2. A span is still exported. A contained fault must not become a silently missing span.

A new entry point belongs in ENTRY_POINTS. A new way for a value to be hostile belongs in VALUES.
"""

from __future__ import annotations

from asyncio import CancelledError
from typing import Any, Callable, Iterator

import pytest

from conftest import CAPS
from mocon import CapturePolicy, CodeMode


class RaisingClass:
    @property
    def __class__(self) -> type:  # type: ignore[override]
        raise RuntimeError("__class__")


class RaisingStr:
    def __str__(self) -> str:
        raise RuntimeError("__str__")

    def __repr__(self) -> str:
        return "<RaisingStr>"


class RaisingDict:
    @property
    def __dict__(self) -> dict[str, Any]:  # type: ignore[override]
        raise RuntimeError("__dict__")


class RaisingGetattr:
    def __getattr__(self, key: str) -> Any:
        raise RuntimeError("__getattr__ " + key)


class BadEq:
    def __eq__(self, other: object) -> bool:
        raise RuntimeError("__eq__")

    def __hash__(self) -> int:
        raise RuntimeError("__hash__")


class BadMapping(dict):  # type: ignore[type-arg]
    def items(self) -> Any:
        raise RuntimeError("items")


def _cycle() -> dict[str, Any]:
    c: dict[str, Any] = {}
    c["self"] = c
    return c


def _boom(*args: Any, **kwargs: Any) -> Any:
    raise RuntimeError("derive")


#: Values a program can author, each hostile in a different way.
VALUES: list[tuple[str, Any]] = [
    ("a raising __class__", RaisingClass()),
    ("a raising __str__", RaisingStr()),
    ("a raising __dict__", RaisingDict()),
    ("a raising __getattr__", RaisingGetattr()),
    ("a raising __eq__ and __hash__", BadEq()),
    ("a cycle", _cycle()),
    ("nan", float("nan")),
    ("a string far past every cap", "x" * 5_000_000),
]

#: Mappings that lie about their own contents.
MAPPINGS: list[tuple[str, Any]] = [("a mapping whose items() raises", BadMapping())]

#: Functions a host supplies that a program's arguments make fail.
DERIVES: list[tuple[str, Callable[..., Any]]] = [("a derive that raises", _boom)]


def _fresh(values: bool = True) -> tuple[Any, CodeMode]:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return exporter, CodeMode(CAPS, capture=CapturePolicy(values=values), tracer=provider.get_tracer("t"))


def _raise_through(ex: Any, payload: Any) -> None:
    """A bridge that throws an exception CARRYING the hostile value, which is how one reaches the
    error path rather than the result path."""

    class Boom(Exception):
        def __init__(self) -> None:
            self.payload = payload

    def throws() -> Any:
        raise Boom()

    try:
        ex.instrument(throws, target="t")()
    except Boom:
        pass


def _entry_points() -> Iterator[tuple[str, Callable[[CodeMode], None]]]:
    """Every place a host hands the emitter something a program authored."""
    for name, v in VALUES:
        yield f"execution result <- {name}", lambda m, v=v: m.execution(program="p").complete(result=v)
        yield f"execution fail cause <- {name}", lambda m, v=v: m.execution(program="p").fail(v)
        yield f"output channel <- {name}", lambda m, v=v: m.execution(program="p").complete(outputs={"stdout": v})

        def crossing_input(m: CodeMode, v: Any = v) -> None:
            ex = m.execution(program="p")
            ex.crossing(target="t", input=v).output(1)
            ex.complete()

        def crossing_error(m: CodeMode, v: Any = v) -> None:
            ex = m.execution(program="p")
            ex.crossing(target="t").error(v)
            ex.complete()

        def bridge_argument(m: CodeMode, v: Any = v) -> None:
            ex = m.execution(program="p")
            ex.instrument(lambda x: 1)(v)
            ex.complete()

        def bridge_raises(m: CodeMode, v: Any = v) -> None:
            ex = m.execution(program="p")
            _raise_through(ex, v)
            ex.complete()

        yield f"crossing input <- {name}", crossing_input
        yield f"crossing error cause <- {name}", crossing_error
        yield f"bridge argument <- {name}", bridge_argument
        yield f"bridge raises carrying {name}", bridge_raises

    for name, mp in MAPPINGS:
        yield f"start attributes <- {name}", lambda m, mp=mp: m.execution(program="p", attributes=mp).complete()
        yield f"end attributes <- {name}", lambda m, mp=mp: m.execution(program="p").complete(attributes=mp)
        yield f"outputs <- {name}", lambda m, mp=mp: m.execution(program="p").complete(outputs=mp)

        def crossing_attributes(m: CodeMode, mp: Any = mp) -> None:
            ex = m.execution(program="p")
            ex.crossing(target="t", attributes=mp).output(1)
            ex.complete()

        yield f"crossing attributes <- {name}", crossing_attributes

    for name, d in DERIVES:

        def target_derive(m: CodeMode, d: Any = d) -> None:
            ex = m.execution(program="p")
            ex.instrument(lambda x: 1, target=d)(1)
            ex.complete()

        def input_derive(m: CodeMode, d: Any = d) -> None:
            ex = m.execution(program="p")
            ex.instrument(lambda x: 1, target="t", input=d)(1)
            ex.complete()

        def end_hook(m: CodeMode, d: Any = d) -> None:
            ex = m.execution(program="p")
            ex.instrument(lambda x: 1, target="t", end=d)(1)
            ex.complete()

        yield f"instrument target <- {name}", target_derive
        yield f"instrument input <- {name}", input_derive
        yield f"instrument end hook <- {name}", end_hook


PROBES = list(_entry_points())


@pytest.mark.parametrize("where,run", PROBES, ids=[w for w, _ in PROBES])
def test_no_emitter_fault_reaches_the_caller(where: str, run: Callable[[CodeMode], None]) -> None:
    exporter, m = _fresh()
    run(m)
    assert exporter.get_finished_spans(), f"{where}: contained the fault but lost the span"


def test_the_matrix_is_not_empty() -> None:
    """A generator that silently yields nothing would make every test above vacuous."""
    assert len(PROBES) >= 40


class _Interrupt:
    """A program raising one of these is indistinguishable from the host being stopped, and the two
    readings have opposite costs. See ``_core._INTERRUPT``."""

    def __init__(self, kind: type[BaseException]) -> None:
        self.kind = kind

    @property
    def __dict__(self) -> dict[str, Any]:  # type: ignore[override]
        raise self.kind()


def test_a_real_ctrl_c_is_the_one_thing_that_does_reach_the_caller() -> None:
    """The deliberate exception to the property above. Containing it made the host uninterruptible
    for as long as a program cared to hold a value, which is worse than a program being able to fail
    its own call."""
    _, m = _fresh()
    with pytest.raises(KeyboardInterrupt):
        m.execution(program="p").complete(result=_Interrupt(KeyboardInterrupt))


@pytest.mark.parametrize("kind", [SystemExit, CancelledError])
def test_a_program_cannot_exit_the_host_or_fake_a_cancellation(kind: type[BaseException]) -> None:
    """These two were briefly treated as interrupts, and that was worse than the bug it fixed.
    ``SystemExit`` let a program-authored property choose the host's EXIT CODE. ``CancelledError``
    made an uncancelled task report itself cancelled, which is telemetry changing control flow
    rather than describing it. Real cancellation arrives at an await and this path is synchronous."""
    exporter, m = _fresh()
    m.execution(program="p").complete(result=_Interrupt(kind))
    assert exporter.get_finished_spans(), "contained it but lost the span"
