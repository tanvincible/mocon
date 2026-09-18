# mocon provenance

Status: draft 1.1, 2026-09-19. Normative. Companion to `core.md`.

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
| `ext.<key>` on an `execution`, `crossing`, or extension record | P | H, for a declared key whose `dimensions` entry carries `observed: true`, or for the keys an extension documents | `ext.declared`, `ext.<extension>` (section 4) |
| `ext.mocon.target`, `ext.mocon.encoding`, `ext.mocon.message`, `ext.mocon.ext` — the reserved envelope notes (`core.md` 3) | H | | |
| `execution.links[].*`, `crossing.links[].*` (`extensions/links.md`) | H | | |
| `host.spec_version`, `host.observes_crossings`, `host.unmediated_egress`, `host.crossing_edge`, `host.attested`, `host.dimensions`, `host.ext.<key>` | H, self-asserted | | |

Reading the table:

- Payload envelope fields are always H because the host computes them from whatever it captured, and no entry in section 4 moves one. `hash` of a program-determined value is a host-observed hash of program-determined content. The four reserved `mocon.` `ext` notes are envelope fields by the same definition — each is the emitter's own record of what it did to its own capture — and they sit in their own row for that reason, not in the `ext.<key>` row above. No entry in section 4 moves them either, and a host does not author them, so a host neither declares them nor is asked to.
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
| `ext.declared` (1.1) | every `ext` key whose `host.dimensions` entry carries `observed: true` | H |

Rules:

- No entry upgrades a Payload envelope field. `truncated`, `redacted`, `bytes` and `hash` are H wherever they appear and stay H, including inside `crossing.end.error.value` (section 3, and `otel-mapping.md` 6).
- A host MUST attest only what is true for every record it emits under that host string. A host with both an observed path and a parsed path for the same field MUST NOT attest it, or MUST use two host strings. `attested` is declared once per host string; there is no per-record attestation and no per-record opt-out. (`extensions/README.md` 3 reserves the name `attested` for a per-record form; nothing specifies it today, so the host-string split is the only mechanism.)
- A host that declares `crossing_edge: "dispatch"` SHOULD attest `crossing.target`: `dispatch` names what the host itself sent, so claiming that edge while not observing the target is contradictory. Lint warns. `crossing_edge: "invocation"` carries no such expectation — an invocation record is the program's view by definition (`core.md` 5.1), which the next rule is written for.
- A host that derives crossings from program-written channels MAY still emit them. It simply does not attest them, and consumers read them as program claims.
- A host that observes crossings at the network layer (`crossing_edge: "dispatch"`) MAY attest `crossing.target` and `crossing.input` because the host saw the request leave; it MAY attest `crossing.output` because the response came from the target.
- `ext.declared` needs **both** gates: the entry in `attested`, and `observed: true` on that key's `dimensions` entry. An `ext` key is H when both hold and P otherwise — one condition, in one place. Two gates rather than one, because each alone is wrong. `observed` alone would be a second upgrade path invisible in `host.attested`, which is the one place `core.md`, this file and `otel-mapping.md` all point at for an observation claim; a consumer would see no claim while the key quietly stopped being labelled P. `ext.declared` alone would upgrade every declared key at once, forcing a host to choose between declaring a key the program shaped — a model name the caller passed in — and attesting its own meter. Section 4's standing rules carry over unchanged: a host attests only what is true for **every** record under that host string, so a host with an observed path and a parsed path for one key uses two host strings. `observed` never reaches **T**: a cost the host read out of a target's reply is honestly P-or-T and one boolean cannot say which, so such a host leaves the key unattested. T stays where this document put it, on crossing output and error.
- What `ext.declared` does **not** establish. It is the host's claim that it determined the value itself, and it is worth exactly what section 2 says H is worth: faithfully observed by that host, relative to its own isolation. Nothing in a record distinguishes a host reading its own meter from a host copying a number out of the program's return value and attesting it anyway. mocon does not detect that, any more than it detects a forged crossing (section 6); attestation makes the claim visible and attributable, which is all a format can do.
- An extension under `spec/extensions/` MAY define an entry `ext.<extension>` (for example `ext.segments`) that upgrades to H exactly the `ext` keys that extension documents as host-observed. A host attests it only when every such key it emits under that host string is determined at a point the program cannot write through (section 2). A consumer that does not know the extension ignores the entry (core.md 8) and reads those keys as P. **No `ext.<extension>` entry exists in 1.0 or 1.1.** (`ext.declared`, above, is not one: core defines it, so it needs no extension and no further sequencing.) An extension defining one names it, and it becomes usable only once a later core minor version adds it to the table above (`core.md` 8, `extensions/README.md` 1); until then a 1.0 host that emits it is emitting an entry outside the list its `spec_version` knows, which this section's first paragraph forbids and section 7 warns on.

## 5. Consumer rules

For any field whose effective class is P:

1. **Display.** Render it distinguishably from H fields. A viewer shows a "program-reported" marker or a distinct style. A text export includes a per-record provenance map, for example `{"target": "P", "input": "P", "end.outcome": "P"}`.
2. **Aggregate.** Exclude it from any aggregate presented as host-observed fact. Aggregates over program claims are legitimate when labelled as such. A declared `ext` key (`core.md` 5.1.1) that stays P is therefore chartable in a viewer that carries the label alongside, and is **not** exportable as a metric: an OpenTelemetry metric point has no per-point provenance channel, and a label added as a point attribute would become a cardinality dimension and make the metric un-summable across it. That is why `otel-mapping.md` 14 emits a metric only for a key this section makes H, and leaves every other declared value on the span with its `P` label, exactly as in 1.0.
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
- **`ext-key-undeclared`**: an `ext` key with no entry in its host's `dimensions`, *whose namespace that host already declares at least one key in*. This is the drift check a host runs in its own tests, and the namespace condition is what makes it runnable. A host that declares nothing is not nagged; a relay forwarding another vendor's keys verbatim (core.md 2 and 3 both license one) is not asked to declare keys it did not author and whose meaning it does not know; and a host that has started declaring is told about the key it forgot. The reserved `mocon.` namespace is skipped: no host authors those notes. One warning per (host, key), with a count.
- **`dimension-agg-mismatch`**: a key declared `sum` or `last` carried a value that is not a finite JSON number (core.md 5.1.1). Per (host, key), with a count.
- **`dimension-agg-unknown`** / **`dimension-card-unknown`**: an entry whose `agg` or `card` this checker does not know. Warn, never fail: both lists grow by minor version (core.md 8).
- **`dimension-observed-unattested`**: an entry carries `observed: true` while `attested` lacks `ext.declared`. The host describes an observation it does not claim, and consumers read the key as P.
- **`attested-declared-without-observed`**: `ext.declared` is attested while no entry carries `observed: true`. Harmless, but the host attested nothing and the drift should be visible.
- **`link-self`** / **`link-rel-unknown`**: a link entry naming its own carrier, or carrying a `rel` outside the known list (`extensions/links.md`).

Deliberately **not** a rule: "declared but never seen in this stream". One stream is not the population — a key on the error path appears only when something fails — and the warning would fire on every clean run. That leaves one half of drift uncaught: a key deleted from the code and left in the declaration is never flagged here. A host that wants that direction unions the `ext` keys over its whole fixture corpus and diffs against its own declaration, which is a few lines in its own test suite and needs nothing from this specification. Saying so is more honest than a rule that cries wolf.

Every rule here describes a legal stream that deserves a second look. None of them is a validation failure, and a runner MUST NOT fail a stream on one: `conformance/check.py lint` prints them and `check.py all` does not take its exit status from them. The obligation that this document's own table covers every field exactly once is stated where it belongs, in section 3, and is not one of these rules — a stream validator has no way to check it.
