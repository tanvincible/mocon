# mocon provenance

Status: draft 1.0, 2026-09-17. Normative. Companion to `core.md`.

## 1. Why provenance exists

Some hosts build crossing records out of things the program wrote. A script can therefore print a line that becomes a crossing record for a call it never made, or a stack trace pointing at a line it never ran.

Consumers of mocon records are increasingly language models. A model reading "the script deleted contact 42" needs to know whether the host saw that happen or the program said so. Provenance is the answer: every field has a class fixed by this specification, and a host can upgrade specific fields by declaring that it observed them.

Provenance is not carried on the wire. It costs zero bytes. It is a table consumers apply.

## 2. Classes

- **H, host-observed.** Determined at a point the program cannot write through: the host's own clock, the host's own id generation, an exit status, a call boundary the host mediates. Relative to the declaring host and conditional on its isolation not being bypassed. H means "faithfully observed by this host", not "true" and not "safe".
- **P, program-determined.** Authored by the program, or computed by the host from a channel the program can write: the program text itself, standard output and error, thrown errors, files, return values, and anything the host derived from those.
- **T, target-relayed.** Passed by the host unchanged from the target of a crossing, or produced by the host's own handling of that crossing — a refusal, a policy error, a target the host implements in its own code. The program did not shape it. Only reachable through attestation.

Whether a program is adversarial is a deployment question, not an axiom. Provenance labels fidelity, not intent.

## 3. The table

Baseline provenance for every field in `core.md`. "After attestation" applies when the host's `attested` list contains the named entry.

**How to read a row.** Every row names *leaf* paths: the fields that carry a value on the wire. No row names a container. So the Payload inside an Error appears here as `…error.value.value`, and its envelope is covered once, by the Payload-envelope row. A segment written `<channel>` or `<key>` stands for every member of that open map. `core.md`'s own field tables do name containers — `program`, `input`, `end.error` — because they are giving those fields a type; the `prov` column there describes the container's `value`, which `core.md` 5.4 states directly.

| field | baseline | after attestation | entry |
|---|---|---|---|
| `kind`, `host`, and `id` — on every line that carries them | H | | |
| `execution.start`, `execution.end.time` | H | | |
| `execution.end.disposition` | H | | |
| `execution.program.value` | P | | |
| `execution.language` | P | | |
| `execution.context.session` | H | | |
| `execution.context.traceparent`, `crossing.context.traceparent` | H, relayed from the caller, unverified | | |
| `execution.end.result.value`, `execution.end.outputs.<channel>.value` | P | | |
| Payload envelope fields (`truncated`, `redacted`, `bytes`, `hash`) on every Payload anywhere | H | | |
| `execution.end.error.class` | P | H | `execution.error.class` |
| `execution.end.error.message`, `execution.end.error.value.value` | P | | |
| `crossing.execution_id` | H | | |
| `crossing.start`, `crossing.end.time` | H | | |
| `crossing.target` | P | H | `crossing.target` |
| `crossing.seq`, `crossing.end.outcome` | follow `crossing.target` | | |
| `crossing.input.value` | P | H | `crossing.input` |
| `crossing.end.output.value` | P | T | `crossing.output` |
| `crossing.end.error.class`, `crossing.end.error.message`, `crossing.end.error.value.value` | P | T | `crossing.error` |
| `ext.<key>` on an `execution`, `crossing`, or extension record | P | H, for the keys an extension documents — no entry is defined in 1.0 | `ext.<extension>` (section 4) |
| `host.spec_version`, `host.observes_crossings`, `host.unmediated_egress`, `host.crossing_edge`, `host.attested`, `host.ext.<key>` | H, self-asserted | | |

Reading the table:

- Payload envelope fields are always H because the host computes them from whatever it captured, and no entry in section 4 moves one. `hash` of a program-determined value is a host-observed hash of program-determined content.
- `context.traceparent` is H in the sense that the host copied it faithfully, but its content came from the caller. Consumers MUST NOT use it for authorization or billing attribution.
- The `host` record's `ext` keys are part of the declaration, not program output: the record is emitted before any program exists and no program channel can write it. That is why they sit in the last row with the rest of the declaration and not in the `ext.<key>` row above it.
- This table MUST cover every field in `core.md` exactly once. That is an obligation on this document, checked by reading it against `core.md`'s field tables and `schema/`, not a rule a stream validator can run; section 7's lint rules are about streams.

## 4. The `attested` list

`host.attested` is an array of entries from this closed list. Unknown entries MUST be ignored.

| entry | upgrades | to |
|---|---|---|
| `crossing.target` | `crossing.target`, `crossing.seq`, `crossing.end.outcome` | H |
| `crossing.input` | `crossing.input.value` | H |
| `crossing.output` | `crossing.end.output.value` | T |
| `crossing.error` | `crossing.end.error.class`, `crossing.end.error.message`, `crossing.end.error.value.value` | T |
| `execution.error.class` | `execution.end.error.class` | H |

Rules:

- No entry upgrades a Payload envelope field. `truncated`, `redacted`, `bytes` and `hash` are H wherever they appear and stay H, including inside `crossing.end.error.value` (section 3, and `otel-mapping.md` 6).
- A host MUST attest only what is true for every record it emits under that host string. A host with both an observed path and a parsed path for the same field MUST NOT attest it, or MUST use two host strings. `attested` is declared once per host string; there is no per-record attestation and no per-record opt-out. (`extensions/README.md` 3 reserves the name `attested` for a per-record form; nothing specifies it today, so the host-string split is the only mechanism.)
- A host that declares `crossing_edge: "dispatch"` SHOULD attest `crossing.target`: `dispatch` names what the host itself sent, so claiming that edge while not observing the target is contradictory. Lint warns. `crossing_edge: "invocation"` carries no such expectation — an invocation record is the program's view by definition (`core.md` 5.1), which the next rule is written for.
- A host that derives crossings from program-written channels MAY still emit them. It simply does not attest them, and consumers read them as program claims.
- A host that observes crossings at the network layer (`crossing_edge: "dispatch"`) MAY attest `crossing.target` and `crossing.input` because the host saw the request leave; it MAY attest `crossing.output` because the response came from the target.
- An extension under `spec/extensions/` MAY define an entry `ext.<extension>` (for example `ext.segments`) that upgrades to H exactly the `ext` keys that extension documents as host-observed. A host attests it only when every such key it emits under that host string is determined at a point the program cannot write through (section 2). A consumer that does not know the extension ignores the entry (core.md 8) and reads those keys as P. **No such entry exists in 1.0.** An extension defining one names it, and it becomes usable only once a later core minor version adds it to the table above (`core.md` 8, `extensions/README.md` 1); until then a 1.0 host that emits it is emitting an entry outside the list its `spec_version` knows, which this section's first paragraph forbids and section 7 warns on.

## 5. Consumer rules

For any field whose effective class is P:

1. **Display.** Render it distinguishably from H fields. A viewer shows a "program-reported" marker or a distinct style. A text export includes a per-record provenance map, for example `{"target": "P", "input": "P", "end.outcome": "P"}`.
2. **Aggregate.** Exclude it from any aggregate presented as host-observed fact. Aggregates over program claims are legitimate when labelled as such.
3. **Hand to a model.** When records are given to a language model, supply the provenance map alongside and state that P fields are unverified program output.
4. **Never parse.** Do not scan P values for structure or markers (core.md 5.4).

For T fields: the content came from the target, or from the host's own handling of the crossing, and was not shaped by the program; it is a claim about what the target did or returned, not something the host verified against the world.

For H fields: observed by the declaring host, subject to that host's isolation. A consumer that does not trust the host trusts nothing.

## 6. A forged trace, and what provenance does about it

A crossing a host reconstructs from a channel the program controls stays P unless attested, so a forged line displays as an unverified claim and never as an observation, and under `unmediated_egress: true` an absent crossing is not evidence that no call happened (core.md 5.1, 12); mocon does not detect the forgery itself, which takes a second in-path observer under its own host string.

## 7. Lint rules

A validator SHOULD warn when:

- `crossing_edge` is `"dispatch"` and `crossing.target` is not attested (section 4). Declaring `"invocation"` without attesting is expected, not suspicious, and MUST NOT warn.
- `attested` contains an unknown entry.
- `observes_crossings` is `"none"` and the stream contains crossings for that host. Not an error: the host may emit program-reported crossings, or may be a host that declared the weakest value because its substrate is opaque (core.md 5.1) while still recording what it observed; the combination deserves a look, not suppression.

Every rule here describes a legal stream that deserves a second look. None of them is a validation failure, and a runner MUST NOT fail a stream on one: `conformance/check.py lint` prints them and `check.py all` does not take its exit status from them. The obligation that this document's own table covers every field exactly once is stated where it belongs, in section 3, and is not one of these rules — a stream validator has no way to check it.
