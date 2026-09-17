# mocon core specification

Status: draft 1.0, 2026-09-17. Not yet stable. Additive changes only once marked 1.0.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119.

## 1. Purpose

A code-mode MCP is a server where the agent submits a program instead of one structured tool call. The host executes the program in an environment it controls, and from inside the program the server's capabilities are invoked through a mechanism the host provides. To everyone outside the host, that whole execution is one opaque tool call.

mocon is a record format that makes it visible. A host that runs code-mode executions emits mocon records. Anything that wants to see them, a local viewer, an OpenTelemetry pipeline, an analyzer, reads mocon records. Each implementation writes one emitter, each backend gets one reader, and the record format is the only contract between them.

The core is limited to what every code-mode implementation shares: a program was run, and while it ran, control crossed the boundary between the program and the host some number of times. Everything an implementation can additionally say about itself is a declared capability. Everything a consumer might want beyond that is an extension.

The invariants behind each field are listed in Appendix B. Field tables cite them by number.

## 2. Terms

- **Host.** The party that emits records and whose clock, ids and isolation the records are relative to. Usually the process that runs the program. May be a client-side observer that only sees the execution from outside.
- **Execution.** One dispatch of one program by a host. Never the session or conversation that contains it.
- **Program.** The text the agent submitted for that execution. A submission MAY be an ordered sequence of segments (fenced code blocks, notebook cells) the host runs in order and may stop before the last one runs; `program` names the whole submission, not only the part that ran.
- **Crossing.** One invocation, initiated by the program, that crosses from the program to the host-provided surface: a tool call, a binding method, a proxied fetch, a file read served by the host. What the host records about it depends on where the host sits, which the host declares.
- **Target.** The host-defined identifier of what a crossing invoked.
- **Consumer.** Anything that reads records: a viewer, an analyzer, a sink.
- **Sink.** A consumer that forwards records to another system, such as an OpenTelemetry collector.
- **Adaptor.** The code inside a host that emits mocon records. Written once per implementation.
- **Complete record.** A line that carries `end`. It has every field the record will ever have.
- **Start notice.** A line without `end`. Optional. Carries the fields known when the record began.

## 3. Wire

A mocon stream is JSON Lines: one UTF-8 JSON object per line, terminated by `\n`, with no raw newlines inside a line (JSON escapes them). Empty lines are skipped. Malformed lines are skipped and counted.

Every line carries these reserved top-level keys:

| key | required | meaning |
|---|---|---|
| `kind` | yes | One of `host`, `execution`, `crossing`. A consumer MUST skip lines with a kind it does not know. |
| `host` | yes | Opaque string identifying the declaring host. It scopes every id. Recommended form `vendor/product[/profile]`. |
| `id` | yes, except `kind: host` | Opaque string, unique within `(host, kind)`. |
| `ext` | no | Open map of namespaced keys, `vendor.key`. Core consumers ignore it; relays preserve it. |

`host` is on every line so that a stream can be split, rotated, concatenated, tailed from the middle, or merged with another host's stream without any stream state. There is no per-line version field; the version lives on the `host` record (section 11).

Transport is out of scope. A stream may be a file, standard error, an HTTP request body (`application/x-ndjson`), a WebSocket, or an in-process array. A consumer MUST NOT rely on any framing beyond newlines. Lines SHOULD be under 1 MiB; consumers MUST still accept larger lines.

Unknown top-level keys MUST be ignored by consumers and SHOULD be preserved by relays.

## 4. Whole records and start notices

mocon is stateless. No party keeps state across executions, and no consumer has to merge fragments.

1. A line with `end` is a **complete record**. It carries every field the record has, including `program`, `target` and `input`. A host emits it exactly once.
2. A line without `end` is a **start notice**: the same `(host, kind, id)`, carrying the fields known at start. It is optional and exists so a live viewer can show running work. A notice MAY omit a field the tables mark required on the complete record when its value is not yet known to the host — a program still streaming into the tool call — since omission says the host does not hold the value, whereas `truncated` and `redacted` describe a value it holds (5.4).
3. **Supersede rule.** A complete record replaces any start notice with the same key. Two complete records with the same key are a conflict: a consumer MUST keep exactly one of them, chosen by a function of the records' content alone — the recommended choice is the record whose canonical JSON (keys sorted, no whitespace) sorts first — and SHOULD count and surface the conflict. Identical re-sends are no-ops.
4. **Order is irrelevant.** A complete record before its start notice, a start notice with no complete record ever, a crossing before its execution, a `host` record after records it governs: all legal. A consumer MUST produce the same view for any permutation of a stream.
5. A record that only ever has a start notice is **unresolved**. A consumer MUST show it as running or unknown, never with any disposition.
6. Two observers of one execution MUST use distinct `host` strings and therefore never share a key. Core defines no cross-host join. Section 6 explains how an OpenTelemetry sink joins them when the execution id was propagated.
7. **Sinks are stateless.** Each complete line becomes one span, one log line, or one row. A sink that cannot represent a running record, such as an OTLP trace exporter, drops start notices. A stateless sink performs no cross-line deduplication: rule 3's obligation to keep exactly one of two conflicting complete records binds consumers that hold state, and a sink MAY forward more than one span, log line or row for a conflicting key.

## 5. Record kinds

Provenance column: H is host-observed, P is program-determined, T is target-relayed. `provenance.md` defines these and lists what `attested` can change.

### 5.1 `host`

The capabilities declaration. Key `(host, "host")`. No `id`.

A host MUST emit its `host` record before any other record for that host in every stream it opens. It MAY re-emit it at any time; identical re-sends are no-ops. A re-declaration with different values is a conflict. To change capabilities, change the host string.

| field | type | absent reads as | license |
|---|---|---|---|
| `spec_version` | string, `"MAJOR.MINOR"`, currently `"1.0"` | the consumer's own major | section 11 |
| `observes_crossings` | `"all"`, `"some"`, `"none"` | `"none"` | C5 |
| `unmediated_egress` | boolean | unknown | C5 |
| `crossing_edge` | `"invocation"`, `"dispatch"` | unknown | X2 |
| `attested` | array of strings, entries from the list in `provenance.md` section 4 (grows by minor version, section 8) | `[]` | X1 |

Semantics:

- `observes_crossings: "all"` claims that every invocation routed through the host-provided surface is recorded. `"some"` claims the host mediates but records a subset by policy or mechanism. `"none"` says the host does not mediate calls at a call boundary. The value says nothing about whether other paths out of the program exist; that is `unmediated_egress`.
- `unmediated_egress: true` says the program has a way to reach the outside that the host does not see: raw network access, subprocess execution, an isolation layer that can be escaped. Consumers use it to refuse the inference "N crossings recorded, therefore N external calls". Absent means unknown, which consumers treat like `true`.
- `crossing_edge` says which edge a crossing record describes. `"invocation"`: what the program asked for at the call boundary. `"dispatch"`: what the host sent toward the target. A network-layer observer is `"dispatch"`; a retry or refusal can make one invocation map to zero or several dispatches, and under `"invocation"` the record is the program's view.
- Capabilities cannot vary per execution. A host whose observability differs per executor or per configuration MUST either use a distinct host string per profile or declare the weakest value that covers all its executions. A profile MAY be selected per execution from a parameter the caller supplies, provided the host itself enforces the resulting capability (a network flag its own sandbox honours) rather than recording the caller's claim; the host string then names the enforced profile. A host that cannot determine which profile served a given execution MUST declare the weakest value covering every reachable profile; it MAY still emit `crossing` records and Payload fields at the fidelity it actually observed for an execution, and those records are not eligible for `attested`.
- There is no negotiation: mocon is push-only, the host declares and consumers adapt. A consumer that has not yet seen a declaration applies the "absent reads as" column; a consumer that holds state MUST apply a later-arriving declaration retroactively. A stateless sink (section 4, rule 7) cannot revise output it has already emitted; it applies whatever declaration it has seen so far to each line as that line is emitted.

### 5.2 `execution`

Key `(host, "execution", id)`.

| field | notice | complete | type | prov | license |
|---|---|---|---|---|---|
| `id` | yes | yes | string | H | C3 |
| `program` | opt | yes | Payload; `value` is the submitted text; absent from a notice only while the host has not yet received the submission in full | P | C1 |
| `start` | yes | yes | RFC 3339 UTC | H | C7 |
| `language` | opt | opt | open string; a role hint, not a guarantee | P | C2 |
| `context.session` | opt | opt | open string: host-defined grouping under which executions are related | H | C11 |
| `context.traceparent` | opt | opt | W3C `traceparent` string, relayed from the caller | H | C13 |
| `end.time` | no | yes | RFC 3339 UTC | H | C7 |
| `end.disposition` | no | yes | closed: `"completed"`, `"failed"`, `"terminated"`, `"abandoned"` | H | C3, C4 |
| `end.error` | no | opt | Error | see Error | C4 |
| `end.result` | no | opt | Payload: the value the host returned on its return channel | P | C8 |
| `end.outputs` | no | opt | object mapping channel name to Payload | P | X4 |

Semantics:

- One execution is one dispatch of one submission (C1). It is never the session, conversation or container that contains it. A submission MAY comprise ordered segments the host runs in sequence and may stop partway through; the host still records one `program` and one `end.disposition`, which describes the dispatch, not the fate of each segment (per-segment detail is the `segments` extension). A program the host runs again — from a log, a retry, or a checkpoint restored as a fresh or additional branch, including a re-run its own substrate performs without the caller asking — is a new execution with its own id. A paused-and-resumed execution (same host string) continues the same execution: the record stays unresolved across the gap (`extensions/events.md`'s `suspended`/`resumed`) and its open crossings stay open.
- `start` is the host-clock time at which the declaring host first observed the execution. For a host that runs the program, that is acceptance of the submission, including submissions it then rejects. For a client-side observer, it is first observation.
- `program.value` is the text the host received. It is not guaranteed to be everything that ran (dynamic imports, persisted state) or byte-identical to what the runtime parsed (wrapping, transforms). `program.hash` and `program.bytes` SHOULD always be present so that two executions of the same text can be matched even when `value` is truncated or withheld. Nor is everything in it guaranteed to have run: a multi-segment submission can carry trailing segments the host never reached, and a consumer MUST NOT infer from `end.disposition` that any particular part of `program.value` executed.
- Dispositions. `completed`: the host confirms normal completion. `failed`: the host confirms a non-normal outcome that the program or its admission produced, including rejection before the program ran. `terminated`: the host itself acted at this moment on its own limit or an external cancel — it stopped waiting, signalled the program or its runtime, or killed it — and closes the record knowing computation may continue after it; a host that gives up waiting at its own deadline without being able to interrupt the program still reports `terminated`. `abandoned`: the host closes the record without having observed an end and without itself acting at that moment, usually during a later reconciliation or after a restart; the later timing is typical, not the criterion. The host draws the `completed`/`failed` line from the program's native execution-level outcome as it can observe it — an exit status the host did not itself force, an interpreter or kernel reply with an error status, an uncaught exception surfaced as data — not merely from whether the host's own dispatch call returned without raising. A separate judgment about whether the produced value was correct (a checker verdict, an expected-output comparison) MUST NOT influence `disposition`; it belongs in `end.result`, `end.outputs` or `ext`. When the host cannot tell whether its own enforcement or the program caused a non-normal end, it reports `failed`, never `terminated`, and SHOULD use `error.class` `unknown`.
- A pre-execution rejection is a complete record with `failed` and `error.class` `validation`.
- An execution MAY stay unresolved forever. A sink MUST NOT invent a disposition for it. A host that itself enforces a maximum runtime and stops the execution when that limit is reached closes it `terminated` at that moment. A host that later finds an execution past its known maximum runtime with no recorded end, because it restarted or because nothing was watching when the limit passed, SHOULD close it `abandoned` at that later point, because the host is the record-keeper and a sink is not.
- `context.session` groups executions the host considers related: an MCP session id, a container id, an agent run id. It is whatever the host has; mocon derives nothing. Finer identities go in `ext`.
- `context.traceparent` is copied from the caller's request, for MCP from `_meta`, unmodified. It is a correlation hint supplied by the caller, not a verified fact. A host that still holds the value it captured at start carries that same value on the complete record, so the supersede rule does not move the record into a different trace; when both a start notice and a complete record carry the field they MUST agree. A host that no longer holds the value it captured at start omits `context.traceparent` from the complete record rather than substituting a later, unrelated caller's value.
- `end.outputs` carries non-crossing output channels. Recommended channel names: `stdout`, `stderr`, `logs`, `files`. Presence of a channel is the only declaration that the host captures it.

### 5.3 `crossing`

Key `(host, "crossing", id)`.

| field | notice | complete | type | prov | license |
|---|---|---|---|---|---|
| `id` | yes | yes | string | H | C6 |
| `execution_id` | yes | yes | id of an execution under the same host | H | C6 |
| `target` | yes | yes | host-defined identifier on the declared edge | P, attestable to H | C6 |
| `input` | yes | yes | Payload, fixed at initiation | P, attestable to H | C6 |
| `seq` | opt | opt | integer, initiation order within the execution | follows `target` | C10 |
| `context.traceparent` | opt | opt | the execution's W3C `traceparent`, copied onto the crossing | H | C13 |
| `start` | opt | opt | RFC 3339 UTC, host clock | H | C7 |
| `end.time` | no | opt | RFC 3339 UTC, host clock | H | C7 |
| `end.outcome` | no | yes | closed: `"output"`, `"error"`, `"abandoned"` | follows `target` | C6 |
| `end.output` | no | only with `"output"` | Payload | P, attestable to T | C6, C9 |
| `end.error` | no | only with `"error"` | Error | P, attestable to T | C6, C4 |

Semantics:

- A crossing is understood alone. `execution_id` is on every crossing line, so a consumer that never sees the execution can still attribute it.
- A host that put `context.traceparent` on an execution SHOULD copy the same value onto every crossing of that execution. A stateless sink cannot look it up from the execution, and without it the crossing cannot be placed in the caller's trace (section 6).
- `target` is whatever the host uses to name what was invoked: a tool name, `namespace.method`, a server and tool pair, a URL, a path. Core does not interpret it.
- `input` is fixed at initiation. What the host recorded of it is subject to the Payload rules.
- `seq` is the host's initiation order. A host that declares `observes_crossings: "all"` and has an order SHOULD emit `seq`. Consumers MUST NOT infer order from line order or from ids.
- Crossings may overlap in time. A consumer MUST NOT assume they are sequential.
- `end.time` is the instant the host itself determined the crossing's outcome, not the instant it wrote the record. When one host action settles several crossings at once, each of those crossings carries that action's instant; a host MUST NOT assign them distinct timestamps merely because its emitter iterated over them in a loop. A host whose transport observed the targets answering at different instants before it bundled them MAY keep those instants, and applies one definition consistently under one host string.
- Outcomes describe what the declaring host itself determined at its own instrumentation point, not whether the program observed it. The outcome is fixed at the instant the host accepts the target's answer, or its own refusal; a fault in a later delivery step never changes it after that instant. `output`: the host determined that the target returned a value for this crossing, even when a later delivery step then keeps that value from reaching the program; the outcome stays `output`. `error`: the host determined that the crossing failed — the target reported a failure, the host refused to dispatch (`error.class` `refused`), host policy intervened, or a host-level fault occurred before any answer was accepted, so no outcome had been determined yet for the fault to overturn. `abandoned`: the host stopped observing and closed the record before it had determined either, usually because the execution ended first; it is not a claim that the target never responded. A host records the outcome it determined even when delivery then fails, and MUST NOT relabel a determined outcome `abandoned` or `error`.
- Under `"output"`, `end.output` MAY be absent when the host did not capture the value. Under `"error"`, `end.error` MAY be absent likewise.
- A host that silently retries emits one crossing with the final outcome. Per-dispatch detail goes in `ext` until an `attempts` extension exists.
- When an execution ends, the host MUST emit a complete `abandoned` record for every crossing of that execution that is still open and that it can still account for, before the execution's complete record. A crossing whose bookkeeping was lost with the process that opened it stays unresolved; section 4 rule 5 shows it as unknown. A settlement that arrives after the crossing was abandoned is not attributed to it (its key is closed, section 4 rule 3); a host that observes one SHOULD emit a `late_settlement` event (`extensions/events.md`) and MAY omit it only when its architecture cannot observe the settlement, for example because it tore down the crossing's channel on close.

### 5.4 Payload

Atomic: always emitted whole within one line. No required fields. A Payload with no `value` MUST set `truncated` or `redacted`.

| field | type | prov | license |
|---|---|---|---|
| `value` | any JSON value; binary as a base64 string, and a reference the host holds instead of content (a URL, a file id) as that reference, each with a note in the record's `ext` | P or T | C9 |
| `truncated` | boolean, out of band | H | C9 |
| `redacted` | boolean: the host removed or replaced content by policy | H | C9 |
| `bytes` | integer: size in bytes of the host's serialization of the original | H | C9 |
| `hash` | `"sha256:"` followed by 64 lowercase hex digits over the host's serialization of the original | H | C1, C9 |

Rules:

- `value` is opaque. A consumer MAY display it and MUST NOT interpret it beyond that. In particular a consumer MUST NOT scan it for markers.
- When `truncated` is `true`, `value` is a string holding a prefix of the host's serialization of the original. It need not parse as JSON. `bytes` and `hash`, when present, describe the original, not the prefix.
- A host that also inserts an in-band marker into a value, such as a truncation note, MUST still set `truncated`. The out-of-band flag is authoritative; the marker is content.
- `redacted` covers removal, replacement and outright dropping by policy. `{"redacted": true}` with no `value` is legal.
- `hash` is comparable only within one host, because serialization is host-defined. For `program`, the serialization SHOULD be the UTF-8 bytes of the text itself. For binary content carried as a base64 string, `bytes` and `hash` SHOULD describe the pre-encoding bytes, not the base64 text. A host that can capture a value at more than one altitude captures at one altitude and serializes one way per field under a given host string.
- A reference the host holds instead of content is the value: `bytes` and `hash` describe the reference as captured, `truncated` and `redacted` keep their meanings.
- A program that is withheld for privacy is `{"redacted": true, "hash": "sha256:…", "bytes": N}`.

### 5.5 Error

Atomic. `class` is required. `message` and `value` are optional.

| field | type | prov | license |
|---|---|---|---|
| `class` | open string; recommended values in `vocabulary.md` | P, attestable to H on executions and to T on crossings | C4 |
| `message` | string | P | C4 |
| `value` | Payload: the raw error object as the host or target produced it | P or T | C4, C9 |

`class` derived from anything the program can write, such as a thrown error or a substring of standard error, is program-determined unless the host attests it. `value` preserves structured target errors, such as an MCP `isError` result or a `{ok: false, status}` object, that would otherwise be lost in export.

## 6. Ids

Ids are opaque strings, unique within `(host, kind)`. A host MUST NOT reuse an id for a different record. Counters that reset violate this, whether the reset is a restart or an in-process operation — restoring a checkpoint or snapshot, forking a paused execution, resetting a session — that can recur many times within one long-lived process. A host that cannot guarantee uniqueness across its own restarts MUST fold an instance component into its `host` string; a host whose native counter resets without a restart MUST mint its own id (the recommended shapes below) and MAY place the native value in `ext`.

Recommended shapes: execution ids as 32 lowercase hex digits from 128 random bits; crossing ids as 16 lowercase hex digits from 64 random bits. With these shapes, export to OpenTelemetry uses the ids verbatim.

Native ids (a server's own execution id, a tool-use block id) MAY be used as `id` directly when they are unique, or placed in `ext` next to a generated id. Both are conformant.

Derivation to OpenTelemetry ids is normative for sinks so that any two sinks agree:

- trace id: the execution id itself when it is 32 lowercase hex digits and not all zeros; otherwise the first 16 bytes of SHA-256 over `host + "\0" + execution_id`, as hex.
- execution span id: the first 8 bytes of SHA-256 over `"execution\0" + host + "\0" + id`, as hex. Always derived, even when the execution id is 32 hex digits, because the trace id and the span id must differ.
- crossing span id: the crossing id itself when it is 16 lowercase hex digits and not all zeros; otherwise the first 8 bytes of SHA-256 over `"crossing\0" + host + "\0" + id`, as hex.
- When `context.traceparent` is present on an execution line, its trace id replaces the derived trace id for the execution span and its parent id becomes the execution span's parent; the execution then nests under the caller's trace.
- When `context.traceparent` is present on a crossing line, its trace id replaces the derived trace id for the crossing span; the parent stays the derived execution span id. A host copies the execution's value onto its crossings (section 5.3), so the execution span and its crossing spans land in the caller's trace together.
- When a crossing line carries no `context.traceparent`, its span keeps the derived trace id. If the execution it belongs to did carry one, the two end up in different traces; a sink MUST then add a span link on the execution span to `{trace_id: derived trace id, span_id: execution span id}` so a consumer can navigate from the caller's trace to the crossings. This is the degraded path for hosts that did not copy the value.

Because derivation is deterministic, a crossing span can be exported before, after, or without its execution span, and two observers that share an execution id land in one trace.

## 7. Timestamps

All timestamps are RFC 3339 strings in UTC with a `Z` suffix and up to nine fractional digits.

- `execution.start` and `execution.end.time` are on the declaring host's clock (C7): a reading the host's own process took at the moment it observed the event.
- `crossing.start` and `crossing.end.time`, when present, are on the same clock. Presence is the declaration; there is no separate capability for crossing timing. A timestamp authored by any other process MUST NOT be put in these fields and MAY go in `ext`: a time the sandbox or kernel produced, a backend row's own `created_at`/`finished_at` when the host merely fronts that backend. A field's name or its presence inside an otherwise host-authored object is not evidence of its clock; the host stamps its own observation instead.
- Within one record, `start` and `end.time` are both the declaring host's own readings, under the same host string; ordinarily that means the same process, but a host whose execution can be paused and resumed under one host string (5.2) may have `start` read by one process and `end.time` by another. A host whose executions can span more than one process or machine this way synchronizes their clocks as far as it can and treats the result as one clock; it MUST still ensure `end.time >= start` on it, to that precision. Consumers tolerate violations. Across records — not within one — timestamps from different processes carry order only to the same synchronization precision.
- Consumers MUST NOT infer order from line order or from ids. Only `seq` and these timestamps carry order. For a multi-process host, `seq` is the only exact order signal within an execution; timestamps from different processes MAY disagree with it under skew.

## 8. Enum policy

Closed sets, which never grow within a major version: `end.disposition`, `end.outcome`, `observes_crossings`, `crossing_edge`. A host MUST NOT emit other values in these fields. A consumer that sees an unknown value in one of these closed fields MUST treat the containing object (`end`, or the capability key) as absent and SHOULD flag it.

`attested` is an array whose entries come from the list in `provenance.md` section 4. That list grows by minor version. A host MUST NOT emit an entry outside the list its declared `spec_version` knows, and a consumer MUST ignore an entry it does not know. `ext.<extension>` entries are defined by extensions (`provenance.md` section 4) under the same minor-version rule.

Open sets with recommended values, listed in `vocabulary.md`: `error.class`, output channel names, `language`, `ext` namespaces. Consumers display unknown values verbatim. Adding a recommended value is a minor version change.

## 9. Provenance

Every field has a provenance class fixed by this specification: host-observed, program-determined, or target-relayed. Provenance is not carried on the wire. The `attested` list in the `host` record upgrades specific fields. `provenance.md` is normative and holds the table, the `attested` list (section 8 above says how it grows), and the rules consumers apply when displaying, aggregating, or handing records to a language model.

## 10. Emitter obligations

A conforming emitter:

- MUST emit the `host` record before any other record for that host in each stream.
- MUST emit each complete record exactly once, with every field the record has. MAY emit start notices.
- MUST NOT reuse an id and MUST NOT emit a second complete record for a key.
- MUST emit an `execution` record (at least a start notice) for every dispatch of a program that reaches the host-provided surface, including retries, forks and speculative branches its substrate performs without the caller's request, and MUST attach the crossings of such a dispatch to that dispatch's own execution id, never to a sibling's.
- MUST, when an execution ends, first emit a complete `abandoned` record for every crossing of that execution still open that it can still account for, then the execution's complete record.
- MUST capture program text in full at the host; what travels MAY be truncated or withheld with the Payload flags set.
- MUST put only host-clock times in `start` and `end.time`.
- SHOULD emit `seq` on crossings when it declares `observes_crossings: "all"` and has an order.
- SHOULD close a past-deadline execution `abandoned` on later discovery, or `terminated` at the moment its own limit fires (section 5.2).
- SHOULD NOT block the host's request path on any sink. This is guidance, not a wire rule.

## 11. Versioning and extensions

`spec_version` on the `host` record is `"MAJOR.MINOR"`. Within a major version, changes are additive only: new optional fields, new record kinds, new recommended values for open sets, new entries usable in `attested`. Never new required fields, new values in closed sets, or a change to the supersede rule. Because consumers ignore unknown fields and kinds, a 1.0 consumer reads any 1.x stream. A consumer seeing a different major SHOULD warn and MAY refuse. A stream with no `host` record is read as the consumer's own major.

Extensions live under `spec/extensions/` and are additive kinds or fields. Core consumers ignore them. The first extension is the `event` kind, `extensions/events.md`.

## 12. What a consumer may rely on, and must not

A consumer MAY rely on:

- `kind` and `host` are present on every line, and `id` on every line except `kind: host`.
- A complete record has every required field for its kind.
- Supersede is order-independent and conflicts are detectable.
- `end`, when present, is complete: an execution has `time` and `disposition`; a crossing has `outcome`, with `output` only under `"output"` and `error` only under `"error"`.
- Timestamps are the declaring host's clock, and crossing times are on the same clock as execution times.
- `truncated` and `redacted` are authoritative. Absent or false means `value` is the host's full capture of the value it holds, which may itself be a reference to content the host did not inline (5.4).
- Under `observes_crossings: "all"`, no invocation through the host-provided surface went unrecorded for that host's executions, short of lost lines.
- Attested fields are host-observed relative to the declaring host.

A consumer MUST NOT:

- Infer order from line order or from ids, or assume crossings are sequential.
- Assume a complete record will arrive, that `terminated` means computation stopped, or that `abandoned` means failure.
- Treat an unresolved crossing as evidence the call is still in progress, or an `abandoned` crossing as evidence the target never responded; both say only that the host stopped observing (5.3).
- Assume one crossing record is one dispatch to the target.
- Parse or interpret `value` beyond displaying it.
- Conclude "no external calls happened" from the absence of crossings unless the host declared `observes_crossings: "all"` and `unmediated_egress: false`.
- Treat `ext` keys as meaningful, assume a declaration exists, assume ids have a shape, or assume the declaring host is trustworthy. Host-observed means observed by that host, relative to its own isolation.

## 13. Emitting without a library

The protocol is small enough that a host can conform with no dependency. A complete emitter for a host with an `execute({code})` tool and a `callTool(name, args)` bridge, in plain JavaScript:

```js
import { randomBytes, createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const HOST = "example/mcp";
const hex = (n) => randomBytes(n).toString("hex");
const now = () => new Date().toISOString();
const emit = (o) => appendFileSync("mocon.jsonl", JSON.stringify({ host: HOST, ...o }) + "\n");
const payload = (v, cap = 16384) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const p = { bytes: Buffer.byteLength(s), hash: "sha256:" + createHash("sha256").update(s).digest("hex") };
  return p.bytes > cap ? { ...p, value: s.slice(0, cap), truncated: true } : { ...p, value: v };
};

emit({ kind: "host", spec_version: "1.0", observes_crossings: "all", unmediated_egress: false,
       crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] });

export async function execute(code, rawCallTool) {
  const id = hex(16), start = now(), open = new Map(), program = payload(code);
  let seq = 0;
  emit({ kind: "execution", id, program, language: "javascript", start });
  const callTool = async (target, args) => {
    const cid = hex(8), cstart = now(), input = payload(args);
    open.set(cid, { target, input, seq: ++seq, start: cstart });
    try {
      const out = await rawCallTool(target, args);
      if (open.has(cid)) {
        emit({ kind: "crossing", id: cid, execution_id: id, target, input, seq: open.get(cid).seq, start: cstart,
               end: { time: now(), outcome: "output", output: payload(out) } });
        open.delete(cid);
      }
      // else: cid was already emitted abandoned (5.3). This core-only emitter observes the
      // late settlement but does not record it; a host that wants the extensions/events.md
      // late_settlement event emits one here instead of falling through.
      return out;
    } catch (e) {
      if (open.has(cid)) {
        emit({ kind: "crossing", id: cid, execution_id: id, target, input, seq: open.get(cid).seq, start: cstart,
               end: { time: now(), outcome: "error", error: { class: "capability_error", message: String(e?.message ?? e) } } });
        open.delete(cid);
      }
      // else: same late-settlement case, on the error path.
      throw e;
    }
  };
  const abandonOpen = () => {
    for (const [cid, c] of open) emit({ kind: "crossing", id: cid, execution_id: id, ...c, end: { outcome: "abandoned" } });
    open.clear();
  };
  try {
    const result = await runInSandbox(code, { callTool });
    abandonOpen();
    emit({ kind: "execution", id, program, language: "javascript", start,
           end: { time: now(), disposition: "completed", result: payload(result) } });
    return result;
  } catch (e) {
    abandonOpen();
    emit({ kind: "execution", id, program, language: "javascript", start,
           end: { time: now(), disposition: "failed", error: { class: "runtime", message: String(e?.message ?? e) } } });
    throw e;
  }
}
```

The emitter holds state only inside one call to `execute`, emits every record whole, abandons every still-open crossing before emitting the execution's complete record on both the success and failure paths, observes but does not record a settlement that arrives for a crossing already abandoned (5.3's SHOULD is for a host willing to take on the `events.md` extension; this core-only emitter is not), and never writes anything a consumer would have to merge. The start notice for the execution is the only optional line; a host that does not want live views omits it.

## Appendix A. A complete stream

A synchronous bridge host, one execution, two overlapping crossings, one truncated output. Hashes shortened for display.

```jsonl
{"kind":"host","host":"example/mcp","spec_version":"1.0","observes_crossings":"all","unmediated_egress":false,"crossing_edge":"invocation","attested":["crossing.target","crossing.input"]}
{"kind":"execution","host":"example/mcp","id":"a3f1c2d4e5b6978081726354a1b2c3d4","program":{"value":"const [co, people] = await Promise.all([callTool('company_identify',{query:'acme.example'}), callTool('person_search',{domain:'acme.example',limit:200})]); return {company: co.name, count: people.length};","bytes":204,"hash":"sha256:6d2c…"},"language":"javascript","start":"2026-09-16T10:00:00.000Z","context":{"session":"mcp-9a1f0c"}}
{"kind":"crossing","host":"example/mcp","id":"1a2b3c4d5e6f7081","execution_id":"a3f1c2d4e5b6978081726354a1b2c3d4","seq":1,"target":"company_identify","input":{"value":{"query":"acme.example"},"bytes":24,"hash":"sha256:11aa…"},"start":"2026-09-16T10:00:00.118Z","end":{"time":"2026-09-16T10:00:00.402Z","outcome":"output","output":{"value":{"name":"Acme Robotics","id":8842},"bytes":34,"hash":"sha256:22bb…"}}}
{"kind":"crossing","host":"example/mcp","id":"2b3c4d5e6f708192","execution_id":"a3f1c2d4e5b6978081726354a1b2c3d4","seq":2,"target":"person_search","input":{"value":{"domain":"acme.example","limit":200},"bytes":37,"hash":"sha256:33cc…"},"start":"2026-09-16T10:00:00.119Z","end":{"time":"2026-09-16T10:00:01.874Z","outcome":"output","output":{"value":"[{\"name\":\"Jordan Ellis\",\"title\":\"CEO\"},{\"name\":\"Mira Okafor\",\"title\":\"CTO\"},{\"na","truncated":true,"bytes":1843211,"hash":"sha256:9e77…"}}}
{"kind":"execution","host":"example/mcp","id":"a3f1c2d4e5b6978081726354a1b2c3d4","program":{"value":"const [co, people] = await Promise.all([callTool('company_identify',{query:'acme.example'}), callTool('person_search',{domain:'acme.example',limit:200})]); return {company: co.name, count: people.length};","bytes":204,"hash":"sha256:6d2c…"},"language":"javascript","start":"2026-09-16T10:00:00.000Z","context":{"session":"mcp-9a1f0c"},"end":{"time":"2026-09-16T10:00:01.902Z","disposition":"completed","result":{"value":{"company":"Acme Robotics","count":200},"bytes":39,"hash":"sha256:44dd…"}}}
```

Line 2 is a start notice; line 5 supersedes it. The second crossing started before the first ended, which is visible only because both carry host-clock times. The truncated output's `value` is a string prefix of the serialization and does not parse; `bytes` and `hash` describe the original.

## Appendix B. Invariants

These are the claims about every code-mode host that the core is built on, not claims about any one implementation. Field tables above cite them by number.

- **C1. One submission per execution.** One execution is one dispatch of one submission, never the session that contains it. The host receives the submission in full. It is not guaranteed that the text is everything that ran or that it matches what the runtime parsed.
- **C2. Language is a hint.** A host may not know the language it runs. The label exists for display and routing only.
- **C3. Identity and disposition.** Every execution has an id unique within its host and a host-observed start. If it ends, it ends with exactly one of `completed`, `failed`, `terminated`, `abandoned`. It may never end.
- **C4. Completed or not.** When an end exists, the host can tell `completed` from every other disposition. Error detail is optional.
- **C5. Mediation is declared, not assumed.** Whether the host observes crossings, and whether the program has a path out that the host does not see, differ by implementation and are declared.
- **C6. Crossing shape.** Every recorded crossing has a target and an input fixed at initiation, and if it settles it settles as exactly one of `output`, `error`, `abandoned`.
- **C7. Host clock.** Execution start and end are on the declaring host's clock. Crossing times exist only where the host observed the crossing.
- **C8. Delivery varies.** How an outcome reaches the caller, and whether the caller sees crossings, differ by implementation and are outside the contract.
- **C9. Opaque payloads.** Inputs, outputs and results have no standard shape. Truncation and redaction are annotated out of band; consumers never parse values.
- **C10. No implicit order.** Crossings within an execution are unordered unless `seq` or host-clock timestamps are present, and they may overlap.
- **C11. No universal session.** Session, user and conversation identity are optional context the host passes through.
- **C12. Discovery is not universal.** How the agent learns the callable surface is outside the contract.
- **C13. Nesting is a link.** A crossing may be served by another execution. Correlation is by `traceparent`, not by a core field.
- **C14. Positions are not universal.** Source positions for errors and crossings are not guaranteed and are not in core.
- **C15. Limits are not universal.** Host-enforced limits and termination are not guaranteed.
- **X1. Provenance.** Every field is host-observed, program-determined or target-relayed by a rule fixed in this specification. Only the `attested` list upgrades a field.
- **X2. Two edges.** A crossing record describes either the program-facing invocation or the host's dispatch toward the target. The host declares which.
- **X3. Environment is not fixed.** The callable surface can change during an execution. Core does not record it.
- **X4. No universal output channel.** Non-crossing outputs such as standard output are optional, per channel.
