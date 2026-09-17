# mocon extensions

Status: draft, 2026-09-17. Companion to `core.md` and `provenance.md`. This file is not itself a normative record format. It explains the extension mechanism `core.md` section 11 defines, and it reserves a set of names that no file in this repository specifies yet.

## 1. What an extension is

mocon core defines three record kinds, `host`, `execution`, `crossing`, and closes several of their fields against new values for the life of a major version. Everything else a specific implementation, sink, or analyzer wants to say rides in `ext`, or in a new kind that a core consumer skips without complaint, by the wire rule in `core.md` section 3: a consumer skips a kind it does not know and ignores unknown top-level keys. An extension is a specification for one of those: a new kind, or a documented shape for a namespaced `ext` key, published under `spec/extensions/`.

`core.md` section 11 states plainly what an extension is allowed to do: "Extensions live under `spec/extensions/` and are additive kinds or fields. Core consumers ignore them." The same section fixes the general versioning rule an extension must fit inside: "Within a major version, changes are additive only: new optional fields, new record kinds, new recommended values for open sets, new entries usable in `attested`. Never new required fields, new values in closed sets, or a change to the supersede rule."

Concretely, an extension:

- MAY add a new record kind, as `events.md` does with `event`.
- MAY add a new optional field to a documented `ext` key.
- MAY add a new recommended value to an open set (`error.class`, output channel names, `language`, `ext` namespaces).
- MAY define an `ext.<extension>` entry usable in `host.attested` (`provenance.md` section 4), naming the `ext` keys it upgrades to host-observed. (An `ext.<extension>` attested entry becomes usable only once a later core minor version adds it to `provenance.md`'s list; using the extension's kind or its `ext` keys needs no such bump.)
- MUST NOT add a required field to `host`, `execution`, or `crossing`. A field an extension needs cannot be required, because a stream that predates the extension, or a host that never implements it, would then be unable to produce a conformant complete record.
- MUST NOT add a value to any of `core.md` section 8's closed sets. A new terminal state or a new capability value is a core change, not an extension.
- MUST NOT change the supersede rule in `core.md` section 4: whole records replace start notices with the same key, two complete records with the same key are a conflict, order is irrelevant. An extension kind gets to say what "complete" means for its own records, the way `events.md` does, but it cannot make supersede work differently once that meaning is fixed.

## 2. How an extension is added

1. Write the shape down in a file under `spec/extensions/`, in the terms `core.md` and `provenance.md` already use: a field table, a provenance class for every field, and the problem the field solves.
2. Do not bump `spec_version` for the extension itself. `spec_version` names the core specification version a host implements (`core.md` section 11); using an extension's kind or its documented `ext` keys is not a core version change and does not move it. A consumer discovers an extension by the extension kind itself (an `event` line) or by the documented `ext` key, never by reading `spec_version`. The one exception is an `ext.<extension>` attested entry, sequenced as section 1 says.
3. Leave core consumers alone. Nothing about shipping an extension requires touching a core-only reader. A consumer that wants to understand the extension reads its file and adds handling for the new kind or field; every other consumer's behavior is unchanged, because unknown kinds are skipped and unknown fields are ignored by rule, not by convention.
4. Never make it required. If a field would need to be present for a record to make sense, it belongs in a future core major version with a real migration, not in an extension.

## 3. Reserved names

The names below are reserved. No other extension should reuse them for something else, and a future file at this path is expected to give each of them a specified shape. None of them has one yet. Where a paragraph below describes a shape, that shape illustrates the problem; it is not a commitment, and `core.md` is silent on all of it. This file does not resolve that silence, it names it.

- `links[]`: relates one execution record to another via a closed `rel` (`parent`, `replay_of`, `forked_from`, `continues`); shape unspecified today.
- `ext.segments`: an ordered array, one Payload-shaped entry per part of a multi-part submission (`ran`/`not_run`, optional `exit`), upgradable through an `ext.segments` attested entry; shape unspecified today.
- `attempts[]` on crossings: per-dispatch retry/fallback detail subordinate to one crossing record, so a silent retry needs no extra crossing (core.md 5.3 already routes it to `ext` meanwhile); shape unspecified today.
- `execution_host` on crossings: lets a crossing-only observer (a network proxy, say) name the execution it is watching without claiming to be its owning host; shape unspecified today.
- per-record `attested`: would let one host string carry records of differing fidelity honestly instead of forcing a host-string split; shape unspecified today.
- `positions`: a place to record a line/column or other notation-specific location for an error, distinct from `message`; shape unspecified today.
- `limits`: lets a host declare what it enforces (wall time, memory, step count, output size, concurrency) so a consumer can tell "no limits" from "unpublished limits"; shape unspecified today.

## 4. What this file leaves open

Each name above is reserved, not specified. A future extension for any of them still has open questions to settle.
