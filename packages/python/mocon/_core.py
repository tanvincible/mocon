"""The two wrappers of ``spec/otel-code-mode.md``, on the OpenTelemetry API.

Wrapper one goes around the handler that runs a program, wrapper two around the function the sandbox
calls to reach the host. Both write the capability declaration on every span they start.

The package depends on the OpenTelemetry API and never the SDK, which is OpenTelemetry's own rule
for instrumentation and the reason this is worth doing: the host emits through the API and the
application owner's already-configured exporters receive it, with no new destination to wire.
"""

from __future__ import annotations

import inspect

from asyncio import CancelledError

import functools
import inspect
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping, MutableMapping, Sequence

from opentelemetry import context as otel_context
from opentelemetry import trace as otel_trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from .capture import Capture, CapturePolicy, write_notes
from .declare import Attestation, Capabilities, declaration
from .logs import Records
from .metrics import Meters
from .provenance import label, labels

NAME = "mocon"
VERSION = "0.1.0"
#: The version of ``spec/otel-code-mode.md`` these spans are written against.
SPEC_VERSION = "0.1.0"

Disposition = Literal["completed", "failed", "terminated", "abandoned"]
Outcome = Literal["output", "error", "abandoned"]

_DISPOSITIONS = frozenset(("completed", "failed", "terminated", "abandoned"))
_OUTCOMES = frozenset(("output", "error", "abandoned"))
#: 4.1: the two dispositions that set Status Error. Everything else, ``abandoned`` included, is Unset.
_ERRORED = frozenset(("failed", "terminated"))
#: The well-known fallback for ``error.type``, for a host with a failure and no reason it can name.
_OTHER = "_OTHER"
#: The namespaces section 8 reserves. A host's own attributes go in the host's own namespace.
_RESERVED = ("code_mode.", "gen_ai.", "mcp.", "otel.")


class _Unset:
    """Absent, as distinct from a recorded ``null``. A host that records ``None`` means null."""

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return "UNSET"


UNSET: Any = _Unset()


@dataclass(frozen=True, slots=True)
class BridgeAnswer:
    """One call's answer, as the bridge gave it. ``threw`` is the discriminant."""

    args: tuple[Any, ...]
    kwargs: Mapping[str, Any]
    threw: bool
    value: Any = None
    error: BaseException | None = None


def _host_attributes(given: Mapping[str, Any] | None) -> dict[str, Any]:
    """A host's own attributes, with any key inside a reserved namespace dropped. Section 8 states
    the rule; enforcing it here is what keeps a host attribute from overwriting the declaration or
    the disposition, which on a host whose attributes are built from the program's own output would
    be a channel the program rewrites its own trace through. Dropped rather than refused: no emitter
    fault may raise into the caller."""
    out: dict[str, Any] = {}
    if given is None:
        return out
    try:
        for key, value in given.items():
            if not isinstance(key, str) or not key.startswith(_RESERVED):
                out[key] = value
    except _INTERRUPT:
        raise
    except BaseException:
        # A property that raises, or a mapping that lies about its own keys, costs the attributes it
        # hid and nothing else. Whatever was read before the throw is kept.
        pass
    return out


def _mark(attrs: MutableMapping[str, Any], table: Mapping[str, str], observed: frozenset[str], relayed: frozenset[str]) -> None:
    """Labels every field a consumer must not read as fact: the fixed table for this span kind, plus
    the host's own keys, which are program-determined unless the host both attested
    ``host_attributes`` and named them. Absence of a label means host-observed, so a field this
    misses under-claims."""
    label(attrs, table)
    for key in list(attrs):
        if key.startswith(_RESERVED) or key == "error.type":
            continue
        if key in observed:
            continue
        attrs["code_mode.provenance." + key] = "T" if key in relayed else "P"


def _read_channels(outputs: Mapping[str, Any]) -> list[tuple[str, Any]]:
    """The channel map read once, under a guard, before anything is written: a mapping whose
    ``__getitem__`` raises must not throw out of the host's own ``complete()``. The values are
    captured afterwards, each under the capture guard. A container that is not a mapping at all is
    the host's own bug, refused here while the span is still untouched."""
    if not isinstance(outputs, Mapping):
        raise TypeError("mocon: outputs must be a mapping")
    pairs: list[tuple[str, Any]] = []
    try:
        for channel, value in outputs.items():
            pairs.append((channel, value))
    except _INTERRUPT:
        raise
    except BaseException:
        # Whatever was read before the throw still counts.
        pass
    return pairs


class CodeMode:
    """The emitter. One per host configuration, reused for every dispatch.

    ``capabilities`` is validated and frozen here, because 3.1 requires every span of one dispatch
    to carry the same declaration and because bad configuration must fail loudly at construction
    rather than quietly on a request path.
    """

    __slots__ = ("_declared", "_capture", "_tracer", "_ordered", "_attested", "_marks", "_meters", "_records", "_observed", "_relayed")

    def __init__(
        self,
        capabilities: Capabilities,
        *,
        capture: CapturePolicy | None = None,
        tracer: Any | None = None,
        meter: Any | None = None,
        metrics: bool = True,
        logs: bool = True,
    ) -> None:
        self._declared = declaration(capabilities)
        self._capture = Capture(capture)
        self._tracer = tracer if tracer is not None else otel_trace.get_tracer(NAME, VERSION)
        self._ordered = self._declared["code_mode.observes_crossings"] == "all"
        # Read back from the frozen declaration, never from the caller's object a second time: a
        # property that answered the closed-set check with one value could otherwise answer this
        # with another.
        attested: Sequence[Attestation] = self._declared.get("code_mode.attested", ())
        self._attested = tuple(attested)
        self._marks = labels(self._attested)
        self._meters = Meters(self._attested, meter) if metrics else None
        self._records = Records(logs)
        self._observed = frozenset(self._declared.get("code_mode.attested_attributes", ()))
        self._relayed = frozenset(self._declared.get("code_mode.relayed_attributes", ()))

    def execution(
        self,
        *,
        program: str,
        language: str | None = None,
        kind: Literal["server", "local"] = "server",
        tool: str | None = None,
        tool_call_id: str | None = None,
        conversation_id: str | None = None,
        session_id: str | None = None,
        execution_id: str | None = None,
        parent: Any | None = None,
        attributes: Mapping[str, Any] | None = None,
        start_time: int | None = None,
    ) -> "Execution":
        """Wrapper one. Starts the execution span now; use it as a context manager, or hold it and
        call ``complete()``/``fail()``/``end()`` yourself.

        ``parent`` is the caller's context, as the host's own propagator extracted it from the
        incoming request. It MUST NOT come from inside the sandbox: a program that supplies its own
        would choose where its execution appears in the trace, and could attach its records to
        another tenant's.
        """
        return Execution(
            self,
            program=program,
            language=language,
            kind=kind,
            tool=tool,
            tool_call_id=tool_call_id,
            conversation_id=conversation_id,
            session_id=session_id,
            execution_id=execution_id,
            parent=parent,
            attributes=attributes,
            start_time=start_time,
        )


class Execution:
    """One dispatch of one program. Never the session, the conversation or the container."""

    __slots__ = ("_m", "span", "context", "_id", "_notes", "_started_at", "_seq", "_ended", "_open", "_token", "_lock")

    def __init__(
        self,
        emitter: CodeMode,
        *,
        program: str,
        language: str | None,
        kind: Literal["server", "local"],
        tool: str | None,
        tool_call_id: str | None,
        conversation_id: str | None,
        session_id: str | None,
        execution_id: str | None,
        parent: Any | None,
        attributes: Mapping[str, Any] | None,
        start_time: int | None,
    ) -> None:
        if not isinstance(program, str):
            raise TypeError("mocon: program must be a str")
        self._m = emitter
        self._notes: dict[str, dict[str, Any]] = {}
        self._open: list[Crossing] = []
        self._seq = 0
        self._ended = False
        # A host serving dispatches on a thread pool has two threads in here at once. The lock
        # guards the two things a race would corrupt rather than merely reorder: ending twice, which
        # double-counts the metric and the log record, and handing two crossings the same `seq`,
        # which is the wrong order the document says is worse than no order.
        self._lock = threading.Lock()
        self._token: Any = None
        # 4.2: Required, so one is minted when the host has none. A minted id still answers "the
        # crossings of this execution", which is the query that silently returned nothing without
        # it. It cannot match a host log line, which is why a host that has an id should pass it.
        self._id = execution_id if isinstance(execution_id, str) and execution_id != "" else secrets.token_hex(8)

        attrs: dict[str, Any] = _host_attributes(attributes)
        attrs["gen_ai.operation.name"] = "execute_code"
        attrs.update(emitter._declared)
        emitter._capture.program(program, attrs, self._notes)
        attrs["code_mode.execution.id"] = self._id
        _put(attrs, "code_mode.program.language", language)
        _put(attrs, "gen_ai.tool.name", tool)
        _put(attrs, "gen_ai.tool.call.id", tool_call_id)
        _put(attrs, "gen_ai.conversation.id", conversation_id)
        _put(attrs, "mcp.session.id", session_id)
        _mark(attrs, emitter._marks.execution, emitter._observed, emitter._relayed)

        self._started_at = time.time_ns() if start_time is None else start_time
        parent_context = parent if parent is not None else otel_context.get_current()
        self.span = emitter._tracer.start_span(
            "execute_code" if tool is None else "execute_code " + tool,
            context=parent_context,
            kind=SpanKind.INTERNAL if kind == "local" else SpanKind.SERVER,
            attributes=attrs,
            start_time=self._started_at,
        )
        #: The execution span's context, for a bridge the host serves in another task or process.
        self.context = otel_trace.set_span_in_context(self.span, parent_context)
        # Written before anything else can happen, because the only thing this record is for is
        # saying that a dispatch is in flight right now, which no span can say until it has finished.
        ctx = self.span.get_span_context()
        emitter._records.started(attrs, _hex(ctx.trace_id, 32), _hex(ctx.span_id, 16))

    # -- context manager -------------------------------------------------------------------

    def __enter__(self) -> "Execution":
        # Activates the span so that OTHER instrumentation running inside the body nests under it.
        # Our own crossings are unaffected either way, because they are given their parent
        # explicitly rather than read from the active context.
        self._token = otel_context.attach(self.context)
        return self

    def __exit__(self, exc_type: Any, exc: BaseException | None, tb: Any) -> bool:
        if self._token is not None:
            try:
                otel_context.detach(self._token)
            except Exception:
                pass
            self._token = None
        if exc is not None:
            self.fail(exc)
        else:
            self.complete()
        return False

    # -- ending ----------------------------------------------------------------------------

    def complete(self, **options: Any) -> None:
        self.end("completed", **options)

    def fail(self, cause: Any = None, *, error_type: str = "runtime", **options: Any) -> None:
        """``error_type`` defaults to ``runtime``; pass ``validation`` for a rejection before the
        program ran."""
        options.setdefault("message", _message_of(cause))
        options.setdefault("error_body", cause if cause is not None else UNSET)
        self.end("failed", error_type=error_type, **options)

    def end(
        self,
        disposition: Disposition,
        *,
        error_type: str | None = None,
        message: str | None = None,
        result: Any = UNSET,
        outputs: Mapping[str, Any] | None = None,
        error_body: Any = UNSET,
        attributes: Mapping[str, Any] | None = None,
        end_time: int | None = None,
    ) -> None:
        if disposition not in _DISPOSITIONS:
            raise ValueError(f"mocon: unknown disposition {disposition!r}")
        # Read before any state changes, so a refusal leaves the span exactly as it was.
        channels = None if outputs is None else _read_channels(outputs)
        with self._lock:
            if self._ended:
                return
            self._ended = True
        # 5: every crossing still open is closed before the execution span ends, so a reader never
        # sees a crossing outlive the execution that owns it.
        for crossing in list(self._open):
            crossing._abandon()

        capture = self._m._capture
        attrs: dict[str, Any] = _host_attributes(attributes)
        attrs["code_mode.execution.disposition"] = disposition
        if result is not UNSET:
            capture.value("gen_ai.tool.call.result", result, attrs, self._notes)
        if channels is not None:
            for channel, value in channels:
                capture.value("code_mode.output." + channel, value, attrs, self._notes)
        if error_body is not UNSET:
            capture.value("code_mode.error.body", error_body, attrs, self._notes)
        if disposition in _ERRORED:
            error = error_type if error_type is not None else _OTHER
            attrs["error.type"] = error
            if message is not None:
                capture.value("code_mode.error.message", message, attrs, self._notes)
            # 4.1: the description is the one field that cannot carry a provenance label, so it
            # carries a closed-vocabulary host-observed value and never the program's words.
            self.span.set_status(Status(StatusCode.ERROR, error))
        # Swept a SECOND time. Capturing a value runs program-authored code, and that code can
        # reach the handle it is being captured for and open a crossing. One opened there missed the
        # sweep above and nothing later would close it: the handle stayed live forever and its span
        # was never exported. A crossing opened after this method RETURNS is a different case and
        # still records when the host settles it, which is 5.
        for crossing in list(self._open):
            crossing._abandon()
        write_notes(attrs, self._notes)
        _mark(attrs, self._m._marks.execution, self._m._observed, self._m._relayed)
        self.span.set_attributes(attrs)
        closed_at = time.time_ns() if end_time is None else end_time
        self.span.end(end_time=closed_at)
        if self._m._meters is not None:
            self._m._meters.record_execution(_elapsed(self._started_at, closed_at), disposition, attrs.get("error.type"))
        ctx = self.span.get_span_context()
        self._m._records.ended({**self._m._declared, **attrs}, _hex(ctx.trace_id, 32), _hex(ctx.span_id, 16))

    # -- crossings -------------------------------------------------------------------------

    def crossing(
        self,
        target: str,
        *,
        input: Any = UNSET,
        call_id: str | None = None,
        seq: int | None = None,
        tool_type: str | None = None,
        kind: Literal["client", "local"] = "client",
        name: str | None = None,
        dispatched: bool | None = None,
        mcp_method: str | None = None,
        mcp_session: str | None = None,
        mcp_resource_uri: str | None = None,
        attributes: Mapping[str, Any] | None = None,
        start_time: int | None = None,
    ) -> "Crossing":
        """Wrapper two, by hand. One recorded invocation from the program across the host boundary."""
        if not isinstance(target, str):
            raise TypeError("mocon: crossing target must be a str")
        # `seq` is auto-assigned only under `all`, which is the declaration that says the host
        # mediates every call and therefore has an initiation order to report. A supplied value that
        # is not a positive integer is refused rather than written: it carries C10, so a consumer
        # orders crossings by it, and a wrong order is worse than no order. The refusal falls back to
        # the counter, and costs the value rather than the call.
        usable = isinstance(seq, int) and not isinstance(seq, bool) and seq > 0
        if not usable:
            if self._m._ordered:
                with self._lock:
                    self._seq += 1
                    seq = self._seq
            else:
                seq = None
        crossing = Crossing(
            self,
            target=target,
            input=input,
            call_id=call_id,
            seq=seq,
            tool_type=tool_type,
            kind=kind,
            name=name,
            dispatched=dispatched,
            mcp_method=mcp_method,
            mcp_session=mcp_session,
            mcp_resource_uri=mcp_resource_uri,
            attributes=attributes,
            start_time=start_time,
        )
        with self._lock:
            # Tracked even once the execution has ended, so one opened re-entrantly from inside a
            # capture is closed by the second sweep rather than leaking. A genuinely late crossing
            # finds the sweep already done and settles on its own.
            self._open.append(crossing)
        return crossing

    def _release(self, crossing: "Crossing") -> None:
        try:
            self._open.remove(crossing)
        except ValueError:
            pass

    def instrument(
        self,
        fn: Callable[..., Any] | None = None,
        *,
        target: str | Callable[..., str] | None = None,
        input: Callable[..., Any] | None = None,
        end: Callable[[BridgeAnswer], Mapping[str, Any] | None] | None = None,
        tool_type: str | None = None,
        attributes: Mapping[str, Any] | None = None,
    ) -> Any:
        """Wrapper two. Wraps the function the sandbox calls to reach the host, so every call it
        makes is one crossing span. Usable as ``bridge = ex.instrument(call_tool)``, as a bare
        decorator, or as ``@ex.instrument(target="search")``.

        The wrapper must be host code, outside the sandbox: a wrapper the program can reach, replace
        or observe is a channel the program writes through, and a host in that position attests
        nothing.
        """
        if fn is None:
            return functools.partial(
                self.instrument, target=target, input=input, end=end, tool_type=tool_type, attributes=attributes
            )
        if not callable(fn):
            raise TypeError("mocon: instrument() takes a callable")
        if target is not None and not isinstance(target, str) and not callable(target):
            raise TypeError("mocon: instrument() target must be a str or a callable")
        if input is not None and not callable(input):
            raise TypeError("mocon: instrument() input must be a callable")
        if end is not None and not callable(end):
            raise TypeError("mocon: instrument() end must be a callable")

        def open_crossing(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Crossing:
            return self.crossing(
                _target_from(target, args, kwargs),
                input=_input_from(input, target is None, args, kwargs),
                tool_type=tool_type,
                attributes=attributes,
            )

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                crossing = open_crossing(args, kwargs)
                try:
                    value = await fn(*args, **kwargs)
                except BaseException as e:
                    _settle(crossing, end, BridgeAnswer(args, kwargs, True, error=e))
                    raise
                _settle(crossing, end, BridgeAnswer(args, kwargs, False, value=value))
                return value

            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            crossing = open_crossing(args, kwargs)
            try:
                value = fn(*args, **kwargs)
            except BaseException as e:
                _settle(crossing, end, BridgeAnswer(args, kwargs, True, error=e))
                raise
            if inspect.isawaitable(value):
                # The crossing settles when the bridge does, not when it was called.
                return _await(value, crossing, end, args, kwargs)
            _settle(crossing, end, BridgeAnswer(args, kwargs, False, value=value))
            return value

        return wrapper


class Crossing:
    """One invocation, initiated by the program, that crossed to the host-provided surface."""

    __slots__ = ("_ex", "span", "_target", "_notes", "_start", "_ended", "_lock")

    def __init__(
        self,
        execution: Execution,
        *,
        target: str,
        input: Any,
        call_id: str | None,
        seq: int | None,
        tool_type: str | None,
        kind: Literal["client", "local"],
        name: str | None,
        dispatched: bool | None,
        mcp_method: str | None,
        mcp_session: str | None,
        mcp_resource_uri: str | None,
        attributes: Mapping[str, Any] | None,
        start_time: int | None,
    ) -> None:
        self._ex = execution
        self._target = target
        self._notes: dict[str, dict[str, Any]] = {}
        self._ended = False
        self._lock = threading.Lock()
        emitter = execution._m

        attrs: dict[str, Any] = _host_attributes(attributes)
        attrs["gen_ai.operation.name"] = "execute_tool"
        attrs["gen_ai.tool.name"] = target
        attrs.update(emitter._declared)
        # 3.1 repeats the capability declaration on every span because it changes how one span is
        # read. `code_mode.declared` is about combining values across spans, so the execution span
        # carries it once and a crossing does not pay for it.
        attrs.pop("code_mode.declared", None)
        if seq is not None:
            attrs["code_mode.crossing.seq"] = seq
        _put(attrs, "code_mode.execution.id", execution._id)
        if isinstance(dispatched, bool):
            attrs["code_mode.crossing.dispatched"] = dispatched
        _put(attrs, "gen_ai.tool.call.id", call_id)
        _put(attrs, "gen_ai.tool.type", tool_type)
        _put(attrs, "mcp.method.name", mcp_method)
        _put(attrs, "mcp.session.id", mcp_session)
        _put(attrs, "mcp.resource.uri", mcp_resource_uri)
        if input is not UNSET:
            emitter._capture.value("gen_ai.tool.call.arguments", input, attrs, self._notes)
        _mark(attrs, emitter._marks.crossing, emitter._observed, emitter._relayed)

        self._start = time.time_ns() if start_time is None else start_time
        self.span = emitter._tracer.start_span(
            name if name is not None else "execute_tool " + target,
            context=execution.context,
            kind=SpanKind.INTERNAL if kind == "local" else SpanKind.CLIENT,
            attributes=attrs,
            start_time=self._start,
        )

    def __enter__(self) -> "Crossing":
        return self

    def __exit__(self, exc_type: Any, exc: BaseException | None, tb: Any) -> bool:
        if exc is not None:
            self.error(exc)
        else:
            self.output()
        return False

    def output(self, value: Any = UNSET, **options: Any) -> None:
        self.end("output", output=value, **options)

    def error(self, cause: Any = None, *, error_type: str = "capability_error", **options: Any) -> None:
        """``error_type`` defaults to ``capability_error``."""
        options.setdefault("message", _message_of(cause))
        options.setdefault("error_body", cause if cause is not None else UNSET)
        self.end("error", error_type=error_type, **options)

    def _abandon(self) -> None:
        """The execution ended first: 5.4's ``start_only``, closed where it began, with no outcome
        determined."""
        self.end("abandoned")

    def end(
        self,
        outcome: Outcome,
        *,
        output: Any = UNSET,
        error_type: str | None = None,
        message: str | None = None,
        error_body: Any = UNSET,
        dispatched: bool | None = None,
        attributes: Mapping[str, Any] | None = None,
        end_time: int | None = None,
    ) -> None:
        if outcome not in _OUTCOMES:
            raise ValueError(f"mocon: unknown outcome {outcome!r}")
        with self._lock:
            if self._ended:
                return
            self._ended = True
        self._ex._release(self)
        emitter = self._ex._m
        capture = emitter._capture

        attrs: dict[str, Any] = _host_attributes(attributes)
        attrs["code_mode.crossing.outcome"] = outcome
        if isinstance(dispatched, bool):
            attrs["code_mode.crossing.dispatched"] = dispatched
        # 5.4: a span always has two times, so a host with no end time closes the span at its start
        # and says so. A consumer MUST NOT read that zero duration as how long the crossing took.
        close = end_time
        if close is None and outcome == "abandoned":
            close = self._start
            attrs["code_mode.crossing.timing"] = "start_only"
        if outcome == "output" and output is not UNSET:
            capture.value("gen_ai.tool.call.result", output, attrs, self._notes)
        if outcome == "error":
            error = error_type if error_type is not None else _OTHER
            attrs["error.type"] = error
            if message is not None:
                capture.value("code_mode.error.message", message, attrs, self._notes)
            if error_body is not UNSET:
                capture.value("code_mode.error.body", error_body, attrs, self._notes)
            self.span.set_status(Status(StatusCode.ERROR, error))
        write_notes(attrs, self._notes)
        _mark(attrs, emitter._marks.crossing, emitter._observed, emitter._relayed)
        self.span.set_attributes(attrs)
        if close is None:
            close = time.time_ns()
        self.span.end(end_time=close)
        # An abandoned crossing is closed at its own start, so its duration is zero and means
        # nothing. Recording it would put a fictional zero in the distribution.
        if outcome != "abandoned" and emitter._meters is not None:
            emitter._meters.record_crossing(_elapsed(self._start, close), self._target, outcome, attrs.get("error.type"))


#: What ``Crossing.end`` accepts, so a hook's unknown key costs that key and not the whole answer.
_END_PARAMS = frozenset(inspect.signature(Crossing.end).parameters) - {"self", "outcome"}


def _settle(crossing: Crossing, end: Callable[[BridgeAnswer], Any] | None, answer: BridgeAnswer) -> None:
    """The crossing's end, from the bridge's own answer when the hook supplied one and from the
    default otherwise. A hook that raises, returns nothing, or returns a shape ``end`` refuses costs
    the reading and never the call: the default outcome still records the crossing."""
    if end is not None:
        try:
            given = end(answer)
            if isinstance(given, Mapping):
                # The hook says what it wants CHANGED, not what the whole end is, so whatever it
                # leaves out is filled from the answer. A bridge answering `{"ok": False}` needs
                # only the outcome overridden and still wants the envelope recorded as the reason.
                payload = answer.error if answer.threw else answer.value
                # `is None` rather than falsy: an outcome of "" is a hook bug, and letting it fall
                # through to the default would record the call as working and say nothing.
                outcome = given.get("outcome")
                if outcome is None:
                    outcome = "error" if answer.threw else "output"
                # Unknown keys are dropped rather than splatted. One key `end` does not take raises
                # TypeError from the call, which the guard below turns into the DEFAULT outcome, so a
                # failed call would be recorded as a success over a typo in a hook.
                rest = {k: v for k, v in given.items() if k != "outcome" and k in _END_PARAMS}
                if outcome == "error":
                    rest = {"error_type": "capability_error", "message": _message_of(payload), "error_body": payload, **rest}
                elif outcome == "output":
                    rest = {"output": payload, **rest}
                crossing.end(outcome, **rest)
                return
        except _INTERRUPT:
            raise
        except BaseException:
            # `end` validates before it touches the span, so the crossing is still open below.
            pass
    if answer.threw:
        crossing.error(answer.error)
    else:
        crossing.output(answer.value)


async def _await(awaitable: Any, crossing: Crossing, end: Callable[[BridgeAnswer], Any] | None, args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    try:
        value = await awaitable
    except BaseException as e:
        _settle(crossing, end, BridgeAnswer(args, kwargs, True, error=e))
        raise
    _settle(crossing, end, BridgeAnswer(args, kwargs, False, value=value))
    return value


def _target_from(target: str | Callable[..., str] | None, args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> str:
    """A derive runs on arguments the program chose: a mistake in one costs the field, never the
    call."""
    if isinstance(target, str):
        return target
    value: Any = args[0] if args else None
    if callable(target):
        try:
            value = target(*args, **kwargs)
        except _INTERRUPT:
            raise
        except BaseException:
            # The target function could not read these arguments; the first argument names the call.
            pass
    return _name_of(value)


def _name_of(value: Any) -> str:
    """A target's name, never by running the value's own ``__str__``. The arguments a bridge is
    called with are chosen by the program, so ``str(value)`` on one of them is program code on the
    host's request path, and a hostile ``__str__`` would fail the call rather than the label."""
    try:
        if isinstance(value, str):
            return value
        if value is None:
            return "None"
        if type(value) in (bool, int, float):
            return str(value)
        if callable(value):
            return "[function]"
    except _INTERRUPT:
        raise
    except BaseException:
        # `isinstance` and `callable` both read attributes off a value the program chose, and a
        # raising `__class__` escapes any guard placed deeper than the whole function.
        pass
    return "[object]"


def _input_from(input: Callable[..., Any] | None, target_took_first: bool, args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if input is not None:
        try:
            return input(*args, **kwargs)
        except _INTERRUPT:
            raise
        except BaseException:
            return UNSET
    rest: list[Any] = list(args[1:] if target_took_first else args)
    if kwargs:
        rest.append(dict(kwargs))
    if len(rest) == 1:
        return rest[0]
    return UNSET if not rest else rest


#: Raised to stop this process, never by a program describing itself. Containing these is what made
#: the host uninterruptible: a real SIGINT or SIGTERM arriving while the emitter held a
#: program-authored value was swallowed, and the program chooses how long it holds it. They are
#: re-raised, and the cost is that a program raising one of them can fail its own call, which it
#: could do anyway. ``CancelledError`` is here for the same reason: a cancelled task must cancel.
_INTERRUPT = (KeyboardInterrupt, SystemExit, CancelledError)


def _message_of(cause: Any) -> str | None:
    """The message by shape, matching the TypeScript emitter: anything carrying a non-empty string
    ``message`` has one, not only an exception. Reading it runs program-authored code, so every
    path here is guarded and a hostile ``__str__`` costs the message rather than the call."""
    try:
        if isinstance(cause, str):
            return cause or None
        if isinstance(cause, BaseException):
            return str(cause) or None
        message = getattr(cause, "message", None)
        return message if isinstance(message, str) and message else None
    except _INTERRUPT:
        raise
    except BaseException:
        # Every line above runs program-authored code, `isinstance` included: it reads __class__,
        # and CPython suppresses only AttributeError from that read, so a raising __class__ property
        # escapes an inner guard placed any deeper. BaseException rather than Exception, because a
        # program that raises KeyboardInterrupt is not the host being interrupted.
        return None


def _put(attrs: MutableMapping[str, Any], key: str, value: Any) -> None:
    if isinstance(value, str) and value != "":
        attrs[key] = value


def _elapsed(start_ns: int, end_ns: int) -> float:
    """Seconds between two readings, which is the unit both histograms use."""
    return max(0.0, (end_ns - start_ns) / 1e9)


def _hex(value: int, width: int) -> str:
    return f"{value:0{width}x}"
