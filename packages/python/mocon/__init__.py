"""mocon: traces, metrics and log records for code-mode MCP servers, on the OpenTelemetry API.

    from mocon import Capabilities, CapturePolicy, CodeMode

    observed = CodeMode(
        Capabilities(observes_crossings="all", unmediated_egress=False, crossing_edge="invocation"),
        capture=CapturePolicy(values=True),
    )

    with observed.execution(program=source, tool="execute") as ex:
        call_tool = ex.instrument(bridge.call_tool)
        run_sandbox(source, call_tool)

Two wrappers, no SDK: the host emits through the OpenTelemetry API and the application owner's
already-configured exporters receive it. See ``spec/otel-code-mode.md``.
"""

from .capture import DEFAULT_CAP, DEFAULT_MEASURE, DEFAULT_PROGRAM_CAP, CapturePolicy
from ._core import (
    SPEC_VERSION,
    UNSET,
    BridgeAnswer,
    CodeMode,
    Crossing,
    Disposition,
    Execution,
    Outcome,
)
from .declare import (
    Aggregation,
    Attestation,
    Capabilities,
    Cardinality,
    CrossingEdge,
    Dimension,
    Observes,
)
from .provenance import Provenance

__version__ = "0.1.0"

__all__ = [
    "Aggregation",
    "Attestation",
    "BridgeAnswer",
    "SPEC_VERSION",
    "Capabilities",
    "Cardinality",
    "CapturePolicy",
    "CodeMode",
    "Crossing",
    "CrossingEdge",
    "DEFAULT_CAP",
    "DEFAULT_MEASURE",
    "DEFAULT_PROGRAM_CAP",
    "Dimension",
    "Disposition",
    "Execution",
    "Observes",
    "Outcome",
    "Provenance",
    "UNSET",
    "__version__",
]
