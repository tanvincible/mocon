"""The capability declaration: the attributes that say what the host can and cannot see
(otel-code-mode.md 3). Without them an absence of crossing spans reads two ways a consumer cannot
tell apart, which is the one inference the declaration exists to make possible.

Validated once at construction and frozen, because 3.1 requires every span of one dispatch to carry
the same values, and because a host must compute them from its own configuration rather than from
anything the program wrote.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, Mapping, Sequence

Observes = Literal["all", "some", "none"]
CrossingEdge = Literal["invocation", "dispatch"]
Attestation = Literal[
    "crossing.target",
    "crossing.input",
    "crossing.output",
    "crossing.error",
    "execution.error.class",
    "host_attributes",
]
#: How a value combines across records. ``none`` means it must not be added up at all.
Aggregation = Literal["sum", "last", "none"]
#: Whether grouping by a value is safe. ``high`` is per-user, per-run or otherwise unbounded.
Cardinality = Literal["low", "high"]

_OBSERVES = frozenset(("all", "some", "none"))
_EDGES = frozenset(("invocation", "dispatch"))
_ATTESTED = frozenset(
    (
        "crossing.target",
        "crossing.input",
        "crossing.output",
        "crossing.error",
        "execution.error.class",
        "host_attributes",
    )
)
_AGG = frozenset(("sum", "last", "none"))
_CARD = frozenset(("low", "high"))


@dataclass(frozen=True, slots=True)
class Dimension:
    """What one of the host's own attributes means, in the only terms a stranger needs: whether it
    can be summed, what it counts, and whether grouping by it is safe."""

    agg: Aggregation
    #: UCUM where one exists, ``ms``, ``By``, ``s``; a curly-brace annotation otherwise, ``{credit}``.
    unit: str | None = None
    card: Cardinality | None = None
    #: A display name, for a key that reads badly in a legend.
    name: str | None = None


@dataclass(frozen=True, slots=True)
class Capabilities:
    #: ``all`` and ``some`` claim the host mediates; ``none`` says it does not observe a boundary.
    observes_crossings: Observes
    #: True when the program has a path out the host does not see. It blocks "N spans, N calls".
    unmediated_egress: bool
    #: Which edge a crossing span describes: what the program asked for, or what the host sent.
    crossing_edge: CrossingEdge | None = None
    #: What the host observed rather than took from the program. Empty means it attests nothing.
    attested: Sequence[Attestation] = ()
    #: Requires ``host_attributes``: keys in the host's own namespace the host itself observed.
    attested_attributes: Sequence[str] | None = None
    #: Requires ``host_attributes``: keys passed through unchanged from a target, such as a credit
    #: count an API reported. Target-relayed: the host did not measure it and does not vouch for
    #: it, but the program did not shape it either.
    relayed_attributes: Sequence[str] | None = None
    #: What the host's own attributes MEAN, so a consumer that has never heard of this host can add
    #: them up and group by them correctly. Needs no attestation: it is a claim about meaning
    #: rather than about fidelity, and provenance still decides whether the value can be believed.
    declared: Mapping[str, Dimension] | None = None


def declaration(capabilities: Capabilities) -> Mapping[str, Any]:
    """Each field is read once and the attribute written from what was read, then the result is
    frozen: a host that mutates its own capabilities later cannot make one dispatch's spans
    disagree."""
    if not isinstance(capabilities, Capabilities):
        raise TypeError("mocon: capabilities must be a Capabilities")

    observes = capabilities.observes_crossings
    egress = capabilities.unmediated_egress
    edge = capabilities.crossing_edge

    if observes not in _OBSERVES:
        raise ValueError('mocon: observes_crossings must be "all", "some" or "none"')
    if not isinstance(egress, bool):
        raise TypeError("mocon: unmediated_egress must be a bool")

    out: dict[str, Any] = {
        "code_mode.observes_crossings": observes,
        "code_mode.unmediated_egress": egress,
    }

    if edge is None:
        # 3: Conditionally Required when the host mediates. A host that claims an edge it cannot
        # name has not said which side its crossing spans describe, and the two do not agree on
        # cardinality.
        if observes != "none":
            raise ValueError('mocon: crossing_edge is required unless observes_crossings is "none"')
    else:
        if edge not in _EDGES:
            raise ValueError('mocon: crossing_edge must be "invocation" or "dispatch"')
        out["code_mode.crossing_edge"] = edge

    entries = tuple(capabilities.attested or ())
    for entry in entries:
        if entry not in _ATTESTED:
            raise ValueError(f"mocon: unknown attested entry {entry!r}")
    # Written even when empty: 3 makes it Required, and an absent list is read as empty anyway, so
    # emitting it is what distinguishes a host that attests nothing from one that never declared.
    out["code_mode.attested"] = entries

    observed = _names(capabilities.attested_attributes, "attested_attributes")
    relayed = _names(capabilities.relayed_attributes, "relayed_attributes")
    if "host_attributes" in entries:
        if not observed and not relayed:
            raise ValueError('mocon: "host_attributes" is attested but no attribute is named, so it claims nothing')
        # A key cannot be both measured by the host and passed through from a target, and a host
        # that says both has not decided which claim it is making.
        for key in relayed:
            if key in observed:
                raise ValueError(f"mocon: {key!r} is in both attested_attributes and relayed_attributes")
        if observed:
            out["code_mode.attested_attributes"] = observed
        if relayed:
            out["code_mode.relayed_attributes"] = relayed
    elif capabilities.attested_attributes is not None or capabilities.relayed_attributes is not None:
        raise ValueError('mocon: naming host attributes needs "host_attributes" in attested, which is the gate a consumer reads')

    dimensions = _declared_json(capabilities.declared)
    if dimensions is not None:
        out["code_mode.declared"] = dimensions

    return MappingProxyType(out)


def _declared_json(given: Mapping[str, Dimension] | None) -> str | None:
    """Read once and rebuilt from what was read, then serialized at construction so the per-span
    cost is one string and nothing of the caller's runs on a request path."""
    if given is None:
        return None
    if not isinstance(given, Mapping):
        raise TypeError("mocon: declared must be a mapping")
    out: dict[str, dict[str, Any]] = {}
    for key, d in given.items():
        if not isinstance(d, Dimension):
            raise TypeError(f"mocon: declared[{key!r}] must be a Dimension")
        if d.agg not in _AGG:
            raise ValueError(f'mocon: declared[{key!r}].agg must be "sum", "last" or "none"')
        entry: dict[str, Any] = {"agg": d.agg}
        if d.unit is not None:
            if not isinstance(d.unit, str) or d.unit == "":
                raise TypeError(f"mocon: declared[{key!r}].unit must be a non-empty string")
            entry["unit"] = d.unit
        if d.card is not None:
            if d.card not in _CARD:
                raise ValueError(f'mocon: declared[{key!r}].card must be "low" or "high"')
            entry["card"] = d.card
        if d.name is not None:
            if not isinstance(d.name, str) or d.name == "":
                raise TypeError(f"mocon: declared[{key!r}].name must be a non-empty string")
            entry["name"] = d.name
        out[key] = entry
    return json.dumps(out, separators=(",", ":"), ensure_ascii=False) if out else None


def _names(given: Sequence[str] | None, field: str) -> tuple[str, ...]:
    if given is None:
        return ()
    if isinstance(given, str) or not isinstance(given, Sequence):
        raise TypeError(f"mocon: {field} must be a sequence of strings")
    keys = tuple(given)
    for key in keys:
        if not isinstance(key, str) or key == "":
            raise TypeError(f"mocon: {field} entries must be non-empty strings")
    return keys
