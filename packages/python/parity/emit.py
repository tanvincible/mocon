"""Drives the Python emitter (packages/python/mocon) through parity/scenario.json and prints a
canonical JSON dump of every span, plus the metric points, on stdout.

    .venv/bin/python packages/python/parity/emit.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from opentelemetry import metrics as otel_metrics  # noqa: E402
from opentelemetry.sdk.metrics import MeterProvider  # noqa: E402
from opentelemetry.sdk.metrics.export import InMemoryMetricReader  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter  # noqa: E402

from mocon import Capabilities, CapturePolicy, CodeMode, Dimension, UNSET  # noqa: E402

SCENARIO = json.loads((HERE / "scenario.json").read_text(encoding="utf-8"))

_NUMBERS = {"nan": math.nan, "inf": math.inf, "-inf": -math.inf}


def expand(v: Any) -> Any:
    """The two scenario directives, expanded before anything sees the value."""
    if isinstance(v, list):
        return [expand(x) for x in v]
    if isinstance(v, dict):
        if isinstance(v.get("$repeat"), dict):
            return v["$repeat"]["unit"] * v["$repeat"]["times"]
        if isinstance(v.get("$number"), str):
            return _NUMBERS[v["$number"]]
        return {k: expand(x) for k, x in v.items()}
    return v


def pick(o: dict[str, Any], pairs: list[tuple[str, str]]) -> dict[str, Any]:
    """Only pass what the scenario names: an absent key must stay absent, not become None."""
    return {to: expand(o[frm]) for to, frm in pairs if frm in o}


def canon_value(v: Any) -> Any:
    if isinstance(v, (list, tuple)):
        return ["array", [canon_value(x) for x in v]]
    if isinstance(v, bool):
        return ["bool", v]
    if isinstance(v, str):
        return ["str", v]
    if isinstance(v, int):
        return ["int", str(v)]
    if isinstance(v, float):
        # What the OTLP exporter keys on: a Python float travels as doubleValue and an int as
        # intValue, whatever the value is. So the distinction is real on the wire.
        return ["double", repr(v)]
    return ["other", str(v)]


_KINDS = {0: "INTERNAL", 1: "SERVER", 2: "CLIENT", 3: "PRODUCER", 4: "CONSUMER"}
_STATUS = {0: "UNSET", 1: "OK", 2: "ERROR"}


def canon_span(span: Any, index: dict[int, int], base: int) -> dict[str, Any]:
    parent = None if span.parent is None else index.get(span.parent.span_id, "root")
    return {
        "name": span.name,
        "kind": _KINDS[span.kind.value],
        "status": {"code": _STATUS[span.status.status_code.value], "description": span.status.description},
        "parent": "root" if parent is None else parent,
        "start_offset_ns": span.start_time - base,
        "end_offset_ns": span.end_time - base,
        "events": [e.name for e in span.events],
        "attributes": {k: canon_value(span.attributes[k]) for k in sorted(span.attributes)},
    }


def capabilities_of(c: dict[str, Any]) -> Capabilities:
    declared = c.get("declared")
    return Capabilities(
        observes_crossings=c["observes_crossings"],
        unmediated_egress=c["unmediated_egress"],
        crossing_edge=c.get("crossing_edge"),
        attested=tuple(c["attested"]) if "attested" in c else None,
        attested_attributes=tuple(c["attested_attributes"]) if "attested_attributes" in c else None,
        relayed_attributes=tuple(c["relayed_attributes"]) if "relayed_attributes" in c else None,
        declared=None if declared is None else {k: Dimension(**d) for k, d in declared.items()},
    )


def run(case: dict[str, Any]) -> dict[str, Any]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    reader = InMemoryMetricReader()
    meter_provider = MeterProvider(metric_readers=[reader])

    cap = case["capture"]
    emitter = CodeMode(
        capabilities_of(case["capabilities"]),
        capture=CapturePolicy(values=cap["values"], cap=cap["cap"], program_cap=cap["program_cap"], measure=cap["measure"]),
        tracer=provider.get_tracer("parity"),
        meter=meter_provider.get_meter("mocon", "0.1.0"),
        logs=False,
    )

    e = case["execution"]
    execution = emitter.execution(
        **pick(
            e,
            [
                ("program", "program"),
                ("language", "language"),
                ("kind", "kind"),
                ("tool", "tool"),
                ("tool_call_id", "tool_call_id"),
                ("conversation_id", "conversation_id"),
                ("session_id", "session_id"),
                ("execution_id", "execution_id"),
                ("attributes", "attributes"),
            ],
        ),
        start_time=e["start_ns"],
    )

    for x in case["crossings"]:
        crossing = execution.crossing(
            x["target"],
            **pick(
                x,
                [
                    ("input", "input"),
                    ("call_id", "call_id"),
                    ("seq", "seq"),
                    ("tool_type", "tool_type"),
                    ("kind", "kind"),
                    ("name", "name"),
                    ("dispatched", "dispatched"),
                    ("mcp_method", "mcp_method"),
                    ("mcp_session", "mcp_session"),
                    ("mcp_resource_uri", "mcp_resource_uri"),
                    ("attributes", "attributes"),
                ],
            ),
            start_time=x["start_ns"],
        )
        if "settle" in x:
            s = x["settle"]
            crossing.end(
                s["outcome"],
                **pick(
                    s,
                    [
                        ("output", "output"),
                        ("error_type", "error_type"),
                        ("message", "message"),
                        ("error_body", "error_body"),
                        ("dispatched", "dispatched"),
                        ("attributes", "attributes"),
                        ("end_time", "end_ns"),
                    ],
                ),
            )

    end = case["end"]
    execution.end(
        end["disposition"],
        **pick(
            end,
            [
                ("error_type", "error_type"),
                ("message", "message"),
                ("result", "result"),
                ("outputs", "outputs"),
                ("error_body", "error_body"),
                ("attributes", "attributes"),
                ("end_time", "end_ns"),
            ],
        ),
    )

    spans = exporter.get_finished_spans()
    index = {s.context.span_id: i for i, s in enumerate(spans)}
    base = e["start_ns"]

    points: list[dict[str, Any]] = []
    data = reader.get_metrics_data()
    for rm in data.resource_metrics if data is not None else []:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                for p in metric.data.data_points:
                    attributes = {k: canon_value(p.attributes[k]) for k in sorted(p.attributes or {})}
                    points.append(
                        {
                            "instrument": metric.name,
                            "unit": metric.unit,
                            "attributes": attributes,
                            "count": p.count,
                            "sum": round(p.sum, 6),
                        }
                    )
    points.sort(key=lambda p: json.dumps(p, sort_keys=False))
    meter_provider.shutdown()
    otel_metrics._internal._METER_PROVIDER = None  # noqa: SLF001 - one provider per case

    return {"name": case["name"], "spans": [canon_span(s, index, base) for s in spans], "metrics": points}


if __name__ == "__main__":
    sys.stdout.write(json.dumps({"cases": [run(c) for c in SCENARIO["cases"]]}, indent=2, ensure_ascii=False) + "\n")
