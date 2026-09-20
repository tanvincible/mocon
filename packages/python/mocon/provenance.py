"""Per-field provenance, materialized as attributes (otel-code-mode.md 6.5).

``code_mode.attested`` alone tells a consumer what the host observed, but only if that consumer
finds this document and joins its table against the list. Nothing does. So the effective class of
every program-determined or target-relayed attribute is written beside the value, as
``code_mode.provenance.<attribute key>``, and a host-observed field carries no label at all.

This is the shape 6.3 rejected as "design A" on the grounds that an emitter which adds an attribute
and forgets to list it silently promotes a claim to an observation. That objection is about where
the classes come from, not about the wire shape: the table below is fixed by the document and cannot
drift with whatever an emitter happened to write, so it fails safe the same way the list does.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Literal, Mapping, MutableMapping

from .declare import Attestation

#: The class a consumer reads. A field that ends up host-observed is written with no label.
Provenance = Literal["P", "T"]

#: One row of 6.5: every field starts program-determined, and one ``attested`` entry may move it.
#: ``(key, entry that upgrades it, what it becomes)``. ``H`` is written as no label at all.
_EXECUTION: tuple[tuple[str, str | None, str | None], ...] = (
    ("code_mode.program.text", None, None),
    ("code_mode.program.language", None, None),
    ("gen_ai.tool.call.result", None, None),
    ("code_mode.error.body", None, None),
    ("code_mode.error.message", None, None),
    ("error.type", "execution.error.class", "H"),
)

_CROSSING: tuple[tuple[str, str | None, str | None], ...] = (
    ("gen_ai.tool.name", "crossing.target", "H"),
    ("code_mode.crossing.seq", "crossing.target", "H"),
    ("code_mode.crossing.outcome", "crossing.target", "H"),
    ("gen_ai.tool.call.arguments", "crossing.input", "H"),
    ("gen_ai.tool.call.result", "crossing.output", "T"),
    ("error.type", "crossing.error", "T"),
    ("code_mode.error.body", "crossing.error", "T"),
    ("code_mode.error.message", "crossing.error", "T"),
)

#: Output channels are an open set, so they are labelled by prefix rather than by name.
OUTPUT_PREFIX = "code_mode.output."

PREFIX = "code_mode.provenance."


@dataclass(frozen=True, slots=True)
class Labels:
    execution: Mapping[str, Provenance]
    crossing: Mapping[str, Provenance]


def labels(attested: Iterable[Attestation]) -> Labels:
    """The label for every field that is not host-observed, resolved once. ``attested`` cannot vary
    per span (3.1), so neither can this, and no part of it is recomputed while a request is in
    flight."""
    has = frozenset(attested)

    def resolve(rows: tuple[tuple[str, str | None, str | None], ...]) -> Mapping[str, Provenance]:
        out: dict[str, Provenance] = {}
        for key, entry, after in rows:
            upgraded = entry is not None and entry in has
            if upgraded and after == "H":
                continue
            out[key] = "T" if upgraded and after == "T" else "P"
        return out

    return Labels(execution=resolve(_EXECUTION), crossing=resolve(_CROSSING))


def label(attrs: MutableMapping[str, Any], table: Mapping[str, Provenance]) -> None:
    """Writes a label for each field present on the span that a consumer must not read as fact.
    Output channels are always program-determined, so any key under that prefix is labelled whatever
    it is called. Host-namespace keys are handled by the caller, which alone knows what was
    attested."""
    for key in list(attrs):
        if key.startswith(PREFIX):
            continue
        cls = table.get(key)
        if cls is None and key.startswith(OUTPUT_PREFIX):
            cls = "P"
        if cls is not None:
            attrs[PREFIX + key] = cls
