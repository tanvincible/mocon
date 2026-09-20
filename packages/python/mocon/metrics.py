"""Metrics, emitted through the OpenTelemetry metrics API.

Section 9 forbids a metric keyed by, or measured from, a program-determined value: a metric point
has no provenance channel, so a claim exported as a metric silently becomes a fact. The document
says a host cannot enforce that, which is true of a span-metrics connector running downstream and
false of the host's own instruments. Here the rule is enforced rather than stated: the target is a
dimension only when the host attested it, and it is dropped otherwise.

Nothing here needs configuring. If the application registered no meter provider, the API returns a
no-op meter and every recording costs a function call.
"""

from __future__ import annotations

from typing import Any, Iterable

from opentelemetry import metrics as otel_metrics

from .declare import Attestation

NAME = "mocon"
VERSION = "0.1.0"


class Meters:
    __slots__ = ("_execution", "_crossing", "_target_is_fact")

    def __init__(self, attested: Iterable[Attestation], meter: Any | None = None) -> None:
        m = meter if meter is not None else otel_metrics.get_meter(NAME, VERSION)
        #: The target names a dimension only where the host observed it, per section 9.
        self._target_is_fact = "crossing.target" in frozenset(attested)
        self._execution = m.create_histogram(
            "code_mode.execution.duration",
            description="How long one dispatch of one program took.",
            unit="s",
        )
        self._crossing = m.create_histogram(
            "code_mode.crossing.duration",
            description="How long one call from a program across the host boundary took.",
            unit="s",
        )

    def record_execution(self, seconds: float, disposition: str, error_type: str | None) -> None:
        """Always sound on every host: the disposition and the error type on an execution are
        host-observed whatever the host attests, so neither can carry a program's claim into a
        metric."""
        attributes: dict[str, Any] = {"code_mode.execution.disposition": disposition}
        if error_type is not None:
            attributes["error.type"] = error_type
        self._execution.record(seconds, attributes)

    def record_crossing(self, seconds: float, target: str, outcome: str, error_type: str | None) -> None:
        """The outcome and the error type follow the target, so on a host that did not attest it
        they are the program's words and all three are dropped. What survives is a duration
        distribution with no dimensions, which is worth little and is not a lie."""
        attributes: dict[str, Any] = {}
        if self._target_is_fact:
            attributes["gen_ai.tool.name"] = target
            attributes["code_mode.crossing.outcome"] = outcome
            if error_type is not None:
                attributes["error.type"] = error_type
        self._crossing.record(seconds, attributes)
