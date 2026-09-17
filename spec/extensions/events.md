# mocon events

Status: draft, 2026-09-17. Extension to `core.md` and `provenance.md`, and the one extension `core.md` section 11 names directly: "the first extension is the `event` kind, `extensions/events.md`." A core-only consumer that has never read this file still behaves correctly on a stream that contains `event` lines: it skips them, by the wire rule in `core.md` section 3.

## 1. Purpose

Things happen around an execution that are not a program-initiated crossing and not a change to the execution's own disposition: the host pauses and later resumes the whole run, an approval gate opens and closes, a settlement for an abandoned crossing shows up too late to attribute to it, the emitter itself loses records. `core.md` gives none of these a home. `ext` would take them, but a namespaced `ext` key is invisible to any consumer that has not specifically been told to look for that vendor's key, and it carries no shared shape across implementations. `event` gives these occurrences a small, closed line shape that any mocon-aware consumer can read the same way, while staying, to a core-only consumer, exactly as harmless as an unrecognized `ext` key would have been.

## 2. Line shape

Key `(host, "event", id)`.

| field | required | type | prov |
|---|---|---|---|
| `kind` | yes | literal `"event"` | |
| `host` | yes | string, the declaring host, per `core.md` section 3 | H |
| `id` | yes | string, unique within `(host, "event")`, per the id rules in `core.md` section 6 | H |
| `execution_id` | yes | id of an execution under the same host | H |
| `crossing_id` | opt | id of a crossing under the same host | H |
| `time` | opt | RFC 3339 UTC with a `Z` suffix, host clock, per core.md section 7 | H |
| `name` | yes | string | H when a reserved name (section 5), P otherwise |
| `data` | opt | any JSON value | P by default, see section 6 |
| `ext` | opt | open map of namespaced keys, `vendor.key`, per `core.md` section 3 | P |

Semantics:

- An event is understood alone, the same way `core.md` section 5.3 says a crossing is understood alone: `execution_id` is on every event line, so a consumer that never sees the execution record can still attribute the event to it.
- `crossing_id`, when present, MUST name a crossing under the same host and the same `execution_id` as the event. It names the one outstanding crossing an event is about, for the reserved names that have one: a suspension tied to a pending call, an approval gate on one specific tool invocation, a late settlement for one specific abandoned crossing.
- `time`, when present, is on the declaring host's clock, under the same rule `core.md` section 7 states for `execution.start` and `crossing.start`: "A host that only has times authored inside the sandbox MUST NOT put them in these fields and MAY put them in `ext`." `core.md` defines no `seq` for events and no other field that carries order. When `time` is present on two events for the same execution, it orders them; when it is absent, this file gives a consumer no way to order them, and does not invent one.
- `id` follows `core.md` section 6's id rules in full: opaque, unique within `(host, "event")`, never reused. `core.md`'s recommended id shapes for executions and crossings exist so that OpenTelemetry export can use the id verbatim as a span id; an event is never exported as its own span (section 7 below), so this file recommends no particular shape for it.

## 3. Complete records only

Every event is a complete record. There is no start notice for the `event` kind: nothing about an event is knowable only in part, the way a running execution or crossing is, so there is no partial state for a notice to carry. This does not change the supersede rule in `core.md` section 4, it specializes it: because every event line is complete, two event lines with the same `(host, "event", id)` key follow rule 3 directly, identical re-sends are no-ops, and two different complete lines for the same key are a conflict, resolved as `core.md` section 4 rule 3 says.

## 4. An event MUST NOT represent a program-initiated crossing

`core.md` defines a crossing as "one invocation, initiated by the program, that crosses from the program to the host-provided surface." Anything that fits that definition MUST be recorded as a `crossing`, never as an `event`. This is not a style preference: `crossing` carries `target`, `input`, and a closed `end.outcome`, all subject to the provenance and attestation rules in `provenance.md`, and it carries the obligation in `core.md` section 5.3 and section 10 to be abandoned when its execution ends. An `event` carries none of that machinery. A host that recorded a program-initiated invocation as an `event` instead of a `crossing` would be quietly opting that invocation out of every rule `core.md` writes for crossings, which this file forbids.

## 5. Recommended names

`name` is an open set, the same policy `core.md` section 8 states for `error.class`, output channel names, and `language`: a consumer displays an unrecognized value verbatim, and adding a recommended value here is a minor version change, not a breaking one. These are recommended, not exhaustive; a host MAY emit a `name` not listed here.

- **`suspended`**: the host paused the execution before it ended, without confirming a disposition, typically while waiting on something outside the sandbox: a pending crossing's settlement, an approval decision, caller input for a later turn, including a checkpoint the host persists so the same paused state can be resumed later, possibly in another process under the same host string; the execution is not ended and its pending crossing is not abandoned. This is not a disposition. The execution stays unresolved while suspended, or resolves normally later if the host does confirm one; `suspended` only marks that a gap in forward progress happened and, when known, why. `crossing_id`, when the suspension is tied to one outstanding crossing, names it. `data` MAY carry `reason` (`awaiting_crossing`, `awaiting_approval`, `awaiting_input`, `checkpointed`). A host that instead hands the checkpoint to a different host string leaves its own execution unresolved and MAY carry the continuing host's identity in `data`; the continuing host's execution links back with `links[]` `continues`.
- **`resumed`**: the suspension most recently marked by a `suspended` event for this `execution_id` (and, when present, this `crossing_id`) ended, and the program continued running.
- **`approval_requested`**: the host is holding a crossing, or the whole execution, open pending a decision from outside the program: a human reviewer, a policy service. `crossing_id` names the crossing under review, when there is one.
- **`approval_decided`**: the approval named by the matching `approval_requested` event was decided. `data` SHOULD carry the decision, for example `{"decision": "approved"}` or `{"decision": "rejected"}`, and MAY carry who or what decided.
- **`late_settlement`**: a settlement for a crossing arrived after the host had already closed that crossing `abandoned`, the case `core.md` section 5.3 names: a host that observes one SHOULD emit this event and MAY omit it only when its architecture cannot observe the settlement. The crossing record itself stays `abandoned`; this event carries what arrived instead. `crossing_id` names the abandoned crossing. `data` carries `outcome` (`"output"` or `"error"`, the same closed vocabulary as `crossing.end.outcome`) and `payload` (the late value, in the same shape `core.md` gives `crossing.end.output` or `crossing.end.error`).
- **`dropped`**: the emitter itself lost records, a buffer overflowed, a process restarted mid-batch, a sink was unreachable and the host chose not to block its request path on it (`core.md` section 10's "SHOULD NOT block the host's request path on any sink"). `data` carries `count`, the number of records the host believes it lost. This is distinct from the malformed-line handling in `core.md` section 3, "Malformed lines are skipped and counted": that rule is for a consumer discarding lines it received but could not parse. `dropped` is for records the host never managed to emit at all.
- **`conflict`**: the host itself observed, or caused, a same-key conflict as `core.md` section 4 rule 3 defines one: two complete records for one `(host, kind, id)`. A host emits this when its own bookkeeping tells it so, a crash-restart that re-ran an already-completed record, a bug that double-emitted one. A consumer that detects a conflict on its own does not need this event to act correctly: `core.md`'s rule already tells it to keep exactly one of the two records (the one whose canonical JSON sorts first) and count the conflict regardless of whether the host ever says anything about it.

## 6. Provenance

- `time`: H, unconditionally, under the same rule that makes `execution.start` and `crossing.start` H.
- `name`: H when it is one of the reserved names in section 5, because this file fixes their meaning and a host declaring one is making a host-determined claim about what kind of occurrence this is. P for any other value: an unreserved name is the host's own free-form label, and this file makes no claim about how the host arrived at it.
- `data`: P by default, unattested, the conservative default `provenance.md` section 2 states for anything the program could have shaped. Two exceptions, both host-observed (H), and nothing else in this list is:
  - `dropped`'s `count`, because only the host's own accounting can know what it failed to emit; nothing about that number passes through the program or a target.
  - `approval_requested` and `approval_decided`, because the shipped implementation motivating them, Cloudflare's `CodemodeRuntime` facet, gates the decision through a host API, `pending()` / `approve()` / `reject()`, invoked by an external reviewer, not a channel the sandboxed program can write through.
  
  `late_settlement`'s `data.outcome` and `data.payload` are deliberately left P, not H: the value reached the host from the target after the crossing was abandoned, the same relationship `provenance.md`'s table gives `crossing.end.output.value` and `crossing.end.error` to their target, P at baseline and reachable to T only through the `crossing.output` or `crossing.error` entries in `host.attested`. `provenance.md`'s `attested` list is closed, and this file does not add an entry to it for `late_settlement`; a consumer treats a late settlement's payload with the same baseline caution it gives an unattested crossing output, never as target-relayed fact by default.
- `ext.*` on an event: P, the same as `ext.*` anywhere else in `provenance.md`'s table.

## 7. OTel mapping

A sink exports an event as one of two shapes, depending on what it already holds for the execution the event names:

- The default form is one OTel `LogRecord` per event. `trace_id` is the trace id derived from `execution_id`, exactly as `core.md` section 6 defines it. `span_id` is the derived execution span id, or, when `crossing_id` is present, the derived crossing span id instead, as the more specific correlation target. `body` is `name`. `attributes` carries `data`, flattened or JSON-encoded per the sink's own convention; mocon defines no attribute schema for it. `severity_text` is left to the sink's judgment; mocon defines no severity for an event. This form needs no live span: the id derivation is deterministic, so a `LogRecord` for an event can be exported before, after, or without the sink ever holding the execution or crossing span it correlates to, the same guarantee `core.md` section 6 gives a crossing span relative to its execution span. When the execution carries a `context.traceparent`, its span moves into the caller's trace per `core.md` section 6. This `LogRecord`'s `trace_id` stays the derived one regardless, because `event` defines no `context.traceparent` field of its own. A crossing line is different: `core.md` section 5.3 says the host SHOULD copy the execution's `context.traceparent` onto it, and when it does, the crossing's span lands in the caller's trace alongside the execution's; only a crossing whose host did not copy the value keeps the derived trace id, the degraded path `otel-mapping.md` section 4.2 describes. An event has no `context.traceparent` at all, so its `LogRecord` keeps the derived trace id plainly, not as a degraded fallback. A consumer that wants every record of one execution regardless of trace queries `execution_id` on the event line, or `mocon.execution.id` on a span, either way.
- When the sink already holds the execution's, or crossing's, span open, because it is exporting spans directly rather than relaying log lines, it MAY instead call the span's native `AddEvent`, using `name` as the span event name and `data` as its attributes. This is preferable when available, since it keeps the event visibly attached to its span in a trace viewer, but it is not required: a sink that only ever sees an event after the relevant span has closed has no live span to attach to, and falls back to the log-record form.

## 8. Examples

Hashes and some payload values shortened for display, in the style of `core.md` Appendix A. Byte counts and hashes in these examples are illustrative; they are not computed from the shown text.

### 8.1 Programmatic tool calling, pausing across HTTP turns

A host in the shape of Anthropic's programmatic tool calling: a tool call pauses the whole interpreter and returns control to the caller over HTTP; the caller answers in a later request, which resumes it. The crossing's own start notice and complete record already show the tool call itself; `suspended` and `resumed` mark the execution-level pause that spans the gap between the two HTTP turns, something the crossing record alone does not carry.

```jsonl
{"kind":"host","host":"anthropic/ptc","spec_version":"1.0","observes_crossings":"all","unmediated_egress":false,"crossing_edge":"invocation","attested":["crossing.target","crossing.input"]}
{"kind":"execution","host":"anthropic/ptc","id":"b7e2a1c4d5f6978081726354a1b2c3d4","program":{"value":"result = await get_weather(city=\"Lisbon\")\nreturn summarize(result)","bytes":58,"hash":"sha256:7a1b…"},"language":"python","start":"2026-09-16T14:00:00.000Z","context":{"session":"msg_01H9X…"}}
{"kind":"crossing","host":"anthropic/ptc","id":"3c4d5e6f70819203","execution_id":"b7e2a1c4d5f6978081726354a1b2c3d4","seq":1,"target":"get_weather","input":{"value":{"city":"Lisbon"},"bytes":17,"hash":"sha256:11aa…"},"start":"2026-09-16T14:00:00.118Z"}
{"kind":"event","host":"anthropic/ptc","id":"e1a2b3c4d5e6f708","execution_id":"b7e2a1c4d5f6978081726354a1b2c3d4","crossing_id":"3c4d5e6f70819203","time":"2026-09-16T14:00:00.121Z","name":"suspended","data":{"reason":"awaiting_tool_result"}}
{"kind":"event","host":"anthropic/ptc","id":"f2b3c4d5e6f70819","execution_id":"b7e2a1c4d5f6978081726354a1b2c3d4","crossing_id":"3c4d5e6f70819203","time":"2026-09-16T14:00:07.402Z","name":"resumed"}
{"kind":"crossing","host":"anthropic/ptc","id":"3c4d5e6f70819203","execution_id":"b7e2a1c4d5f6978081726354a1b2c3d4","seq":1,"target":"get_weather","input":{"value":{"city":"Lisbon"},"bytes":17,"hash":"sha256:11aa…"},"start":"2026-09-16T14:00:00.118Z","end":{"time":"2026-09-16T14:00:07.400Z","outcome":"output","output":{"value":{"tempC":14,"condition":"cloudy"},"bytes":32,"hash":"sha256:22bb…"}}}
{"kind":"execution","host":"anthropic/ptc","id":"b7e2a1c4d5f6978081726354a1b2c3d4","program":{"value":"result = await get_weather(city=\"Lisbon\")\nreturn summarize(result)","bytes":58,"hash":"sha256:7a1b…"},"language":"python","start":"2026-09-16T14:00:00.000Z","context":{"session":"msg_01H9X…"},"end":{"time":"2026-09-16T14:00:07.520Z","disposition":"completed","result":{"value":"Lisbon: 14°C, cloudy.","bytes":21,"hash":"sha256:33cc…"}}}
```

The gap between `suspended` at 14:00:00.121Z and `resumed` at 14:00:07.402Z is real wall-clock time the container spent torn down between two separate HTTP responses, not sandbox time; both timestamps are host clock, per section 2 above, so the gap is comparable the same way any two `core.md` timestamps are. The crossing's own `start` and `end.time` bracket the same interval from the crossing's side; a consumer does not need the events to know the tool call took about 7.3 seconds, but does need them to know the delay was a host-level suspension and not the target being slow.

`approval_requested`/`approval_decided` follow the same event-then-crossing shape as 8.1's `suspended`/`resumed` pair.
