"""A code-mode host serves many dispatches at once, and one program's calls overlap. These assert
the two things that break first under that: a crossing must be parented to its own execution rather
than to whichever was most recent, and an execution must not end while its own work is in flight.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from conftest import harness


def test_concurrent_executions_keep_their_own_crossings_traces_and_counters() -> None:
    h = harness()

    async def dispatch(tag: str, calls: int) -> None:
        with h.m.execution(program=tag, tool=tag) as execution:

            async def call_tool(name: str) -> str:
                await asyncio.sleep(0.001)
                return name

            bridge = execution.instrument(call_tool)
            await asyncio.gather(*(bridge(f"{tag}.call{i}") for i in range(calls)))

    async def main() -> None:
        await asyncio.gather(dispatch("a", 3), dispatch("b", 2), dispatch("c", 4))

    asyncio.run(main())

    for tag, calls in (("a", 3), ("b", 2), ("c", 4)):
        execution = next(s for s in h.spans() if s.name == f"execute_code {tag}")
        crossings = [s for s in h.spans() if str(s.attributes.get("gen_ai.tool.name", "")).startswith(tag + ".")]
        assert len(crossings) == calls, f"{tag} recorded every call it made"
        for crossing in crossings:
            assert crossing.parent.span_id == execution.context.span_id, f"{tag}'s crossing belongs to {tag}"
            assert crossing.context.trace_id == execution.context.trace_id
            assert crossing.attributes["code_mode.execution.id"] == execution.attributes["code_mode.execution.id"]
        seqs = sorted(s.attributes["code_mode.crossing.seq"] for s in crossings)
        assert seqs == list(range(1, calls + 1)), f"{tag} counts its own crossings from 1"


def test_an_async_body_holds_the_execution_open_until_it_settles() -> None:
    h = harness()

    async def body() -> str:
        with h.m.execution(program="p") as execution:
            bridge = execution.instrument(_echo)
            await bridge("one")
            assert len(h.spans()) == 1, "the crossing ended, the execution has not"
            await bridge("two")
            return "done"

    assert asyncio.run(body()) == "done"
    spans = h.spans()
    assert [s.name for s in spans] == ["execute_tool one", "execute_tool two", "execute_code"]
    assert spans[2].attributes["code_mode.execution.disposition"] == "completed"


def test_a_raising_async_body_fails_the_execution_and_reraises_the_original_error() -> None:
    h = harness()
    boom = RuntimeError("boom")

    async def body() -> None:
        with h.m.execution(program="p") as execution:
            execution.crossing("left-open")
            raise boom

    with pytest.raises(RuntimeError) as caught:
        asyncio.run(body())
    assert caught.value is boom

    spans = h.spans()
    assert [
        s.attributes.get("code_mode.crossing.outcome", s.attributes.get("code_mode.execution.disposition")) for s in spans
    ] == ["abandoned", "failed"]
    assert spans[0].attributes["code_mode.crossing.timing"] == "start_only", "the crossing in flight is closed where it began"


def test_a_failing_bridge_settles_the_crossing_and_reraises() -> None:
    h = harness()

    async def body() -> None:
        with h.m.execution(program="p") as execution:

            async def bridge(name: str) -> None:
                raise TimeoutError("upstream")

            wrapped = execution.instrument(bridge)
            with pytest.raises(TimeoutError):
                await wrapped("t")

    asyncio.run(body())
    crossing = h.one("execute_tool")
    assert crossing.attributes["code_mode.crossing.outcome"] == "error"
    assert crossing.attributes["error.type"] == "capability_error"


def test_a_sync_bridge_that_returns_an_awaitable_settles_when_it_does() -> None:
    h = harness()

    async def body() -> None:
        with h.m.execution(program="p") as execution:
            # Not a coroutine function: it returns the coroutine, the way a sync facade over an
            # async transport does. The crossing must still settle when the awaitable does.
            wrapped = execution.instrument(lambda name: _echo(name))
            pending = wrapped("search")
            assert h.spans() == [], "nothing has settled yet"
            assert await pending == "search"

    asyncio.run(body())
    assert h.one("execute_tool").attributes["code_mode.crossing.outcome"] == "output"


def test_overlapping_crossings_are_recorded_independently() -> None:
    h = harness()

    async def body() -> None:
        with h.m.execution(program="p") as execution:
            slow = execution.crossing("slow")
            fast = execution.crossing("fast")
            fast.output(1)
            await asyncio.sleep(0.002)
            slow.output(2)

    asyncio.run(body())
    spans = h.spans()
    assert [s.name for s in spans] == ["execute_tool fast", "execute_tool slow", "execute_code"]
    assert spans[0].attributes["code_mode.crossing.seq"] == 2, "seq is initiation order, not settlement order"
    assert spans[1].attributes["code_mode.crossing.seq"] == 1


async def _echo(name: str) -> Any:
    await asyncio.sleep(0)
    return name


def test_threads_sharing_one_execution_get_unique_sequence_numbers() -> None:
    """A synchronous host serves its bridge on a thread pool, so two crossings are opened at once.
    Seq carries C10: a consumer orders crossings by it, and two calls holding the same number is the
    wrong order the document says is worse than no order."""
    import threading

    h = harness()
    ex = h.m.execution(program="p")
    ready = threading.Barrier(8)

    def call(i: int) -> None:
        ready.wait()
        ex.crossing(f"t{i}").output(i)

    threads = [threading.Thread(target=call, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ex.complete()
    seqs = sorted(s.attributes["code_mode.crossing.seq"] for s in h.crossings())
    assert seqs == list(range(1, 9)), "every crossing has its own number"


def test_two_threads_ending_one_execution_produce_one_span() -> None:
    import threading

    for _ in range(50):
        h = harness()
        ex = h.m.execution(program="p")
        ready = threading.Barrier(2)

        def close(disposition: str) -> None:
            ready.wait()
            ex.end(disposition)

        a = threading.Thread(target=close, args=("completed",))
        b = threading.Thread(target=close, args=("terminated",))
        a.start()
        b.start()
        a.join()
        b.join()
        assert len(h.executions()) == 1, "an execution ends once, whichever thread got there first"
