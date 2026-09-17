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

| field | baseline | after attestation | entry |
|---|---|---|---|
| `kind`, `host` (on execution and crossing lines) | H | | |
| `execution.id` | H | | |
| `execution.start`, `execution.end.time` | H | | |
| `execution.end.disposition` | H | | |
| `execution.program.value` | P | | |
| `execution.language` | P | | |
| `execution.context.session` | H | | |
| `execution.context.traceparent`, `crossing.context.traceparent` | H, relayed from the caller, unverified | | |
| `execution.end.result.value`, `execution.end.outputs.*.value` | P | | |
| Payload envelope fields (`truncated`, `redacted`, `bytes`, `hash`) anywhere | H | | |
| `execution.end.error.class` | P | H | `execution.error.class` |
| `execution.end.error.message`, `execution.end.error.value` | P | | |
| `crossing.id`, `crossing.execution_id` | H | | |
| `crossing.start`, `crossing.end.time` | H | | |
| `crossing.target` | P | H | `crossing.target` |
| `crossing.seq`, `crossing.end.outcome` | follow `crossing.target` | | |
| `crossing.input.value` | P | H | `crossing.input` |
| `crossing.end.output.value` | P | T | `crossing.output` |
| `crossing.end.error` (`class`, `message`, `value`) | P | T | `crossing.error` |
| `ext.*` on any record | P | H, for the keys an extension documents | `ext.<extension>` (section 4) |
| `host.*` (the declaration itself) | H, self-asserted | | |

Reading the table:

- Payload envelope fields are always H because the host computes them from whatever it captured. `hash` of a program-determined value is a host-observed hash of program-determined content.
- `context.traceparent` is H in the sense that the host copied it faithfully, but its content came from the caller. Consumers MUST NOT use it for authorization or billing attribution.

## 4. The `attested` list

`host.attested` is an array of entries from this closed list. Unknown entries MUST be ignored.

| entry | upgrades | to |
|---|---|---|
| `crossing.target` | `crossing.target`, `crossing.seq`, `crossing.end.outcome` | H |
| `crossing.input` | `crossing.input.value` | H |
| `crossing.output` | `crossing.end.output.value` | T |
| `crossing.error` | `crossing.end.error.*` | T |
| `execution.error.class` | `execution.end.error.class` | H |

Rules:

- A host MUST attest only what is true for every record it emits under that host string. A host with both an observed path and a parsed path for the same field MUST NOT attest it, or MUST use two host strings.
- A host that declares `crossing_edge` SHOULD attest `crossing.target`; declaring which edge a record describes while not observing the target is contradictory. Lint warns.
- A host that derives crossings from program-written channels MAY still emit them. It simply does not attest them, and consumers read them as program claims.
- A host that observes crossings at the network layer (`crossing_edge: "dispatch"`) MAY attest `crossing.target` and `crossing.input` because the host saw the request leave; it MAY attest `crossing.output` because the response came from the target.
- An extension under `spec/extensions/` MAY define an entry `ext.<extension>` (for example `ext.segments`) that upgrades to H exactly the `ext` keys that extension documents as host-observed. A host attests it only when every such key it emits under that host string is determined at a point the program cannot write through (section 2). A consumer that does not know the extension ignores the entry (core.md 8) and reads those keys as P.

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

- `crossing_edge` is declared and `crossing.target` is not attested.
- `attested` contains an unknown entry.
- `observes_crossings` is `"none"` and the stream contains crossings for that host. Not an error: the host may emit program-reported crossings, or may be a host that declared the weakest value because its substrate is opaque (core.md 5.1) while still recording what it observed; the combination deserves a look, not suppression.
- A field that appears in core.md but not in the table above, or appears in it twice. The table MUST cover every field exactly once.
