# mocon OpenTelemetry mapping

Status: draft 1.0, 2026-09-17. Normative for sinks. Companion to `core.md` and `provenance.md`.

## 1. Scope

This document says how a sink turns a mocon stream into OpenTelemetry spans. It exists so that any two sinks produce the same trace ids, the same span ids, the same span names and the same attributes from the same stream, and so that every core field survives the trip.

It covers the three core kinds: `host`, `execution`, `crossing`. It does not cover extension kinds. A sink skips lines with a kind it does not know, as `core.md` section 3 requires.

`core.md` is the source of truth for field names, enum values, the supersede rule, timestamps and id derivation. `provenance.md` is the source of truth for provenance classes and the `attested` list. Where this document restates either, the original wins. Where `core.md` is silent, this document says so at the point of use.

Everything in this document is normative.

## 2. The sink

A sink (`core.md` section 2) is a consumer whose other system speaks OTLP.

The sink is stateless, per `core.md` section 4 rule 7. Nothing is merged, nothing is buffered, nothing waits for a matching line.

One exception is allowed. The `host` record is small and does not change for a given host string (`core.md` section 5.1). A sink MAY hold one `host` declaration per host string: whichever declaration it has seen sorts first by canonical JSON, the same content-deterministic tie-break `core.md` section 4 defines for any conflicting complete records. This is the only state a conforming sink holds.

The sink never blocks the host (`core.md` section 10).

## 3. Line handling

| line | what the sink does |
|---|---|
| malformed JSON | skip and count (`core.md` section 3) |
| unknown `kind` | skip (`core.md` section 3) |
| `kind: host` | no span; MAY store the declaration (section 2); see below for conflicts |
| `kind: execution` with `end` | one execution span (section 6) |
| `kind: crossing` with `end` | one crossing span (section 7) |
| any line without `end` | a start notice; drop it, MAY count it |

Start notices are dropped because an OTLP trace exporter has no way to show a running record (`core.md` section 4, rule 7). A viewer that wants live records reads the stream directly.

Closed enum values. An unknown `end.disposition`/`end.outcome` value makes `end` read as absent (`core.md` section 8). The line is then a start notice and the sink drops it. The sink SHOULD count this separately from ordinary start notices, because it is a host bug. If a `host` capability field holds an unknown value, that one capability key reads as absent and its `mocon.host.*` attribute is omitted. Unknown entries in `attested` are ignored (`provenance.md` section 4).

Required fields. `core.md` section 12 promises that a complete record has every required field for its kind. `core.md` does not say what a consumer does when that promise is broken. This document: a complete line missing a field that `core.md` marks required is treated like a malformed line. The sink skips it and counts it.

Conflicts. A stateless sink cannot apply `core.md` section 4 rule 3 (it has no state to compare against); it forwards both records, the backend receives two spans with the same trace id and span id, and identical re-sends look the same.

Host declaration conflicts. Because the sink MAY hold the declaration, it can see a re-declaration with different values. It keeps whichever sorts first by canonical JSON, the tie-break named in section 2, and SHOULD count and surface the conflict. Identical re-sends are no-ops.

Unresolved executions. An execution with only a start notice produces no span; closing it is the host's job (`core.md` sections 5.2 and 10). A sink MUST NOT synthesize an `abandoned` span after a timeout of its own. A sink MUST NOT invent a disposition for anything.

Version. `mocon.host.spec_version` carries the declared version; a sink follows `core.md` section 11 for a different major and for a stream with no `host` record.

Unknown top-level keys are ignored. A sink is a consumer, not a relay, so it does not preserve them.

Retroactive declarations. A sink cannot apply a late `host` record retroactively (`core.md` section 5.1); its already-exported spans are final. Spans exported before the declaration arrived carry no `mocon.host.*` attributes and carry provenance labels computed with `attested` read as `[]` (section 10).

## 4. Ids

The derivation is fixed by `core.md` section 6: trace id, execution span id, crossing span id, and the `context.traceparent` overrides. Two points `core.md` leaves implicit: every hashed id renders as lowercase hex, as in the worked table below, and an all-zero id, which `core.md` excludes from the verbatim rule, is hashed like an id of the wrong length.

`"\0"` is a single NUL byte. `host` and the ids are UTF-8. The sink MUST NOT lowercase, trim or otherwise normalize an id before testing its shape. An id with an uppercase hex digit is not "32 lowercase hex digits" and is hashed.

A crossing line carries `execution_id` and, when the host copied it, `context.traceparent`, so a crossing span computes its trace id and its parent span id from its own line alone. It never needs the execution line.

Worked derivations, all with host `example/mcp`:

| input | rule | result |
|---|---|---|
| execution id `a3f1c2d4e5b6978081726354a1b2c3d4` | trace id, verbatim | `a3f1c2d4e5b6978081726354a1b2c3d4` |
| execution id `a3f1c2d4e5b6978081726354a1b2c3d4` | execution span id, hashed | `4edd2d736dd0892d` |
| crossing id `1a2b3c4d5e6f7081` | crossing span id, verbatim | `1a2b3c4d5e6f7081` |
| execution id `run-42` | trace id, hashed | `9517adfb3444518031fe879bc136c334` |
| execution id `run-42` | execution span id, hashed | `81712fb065e103b6` |
| crossing id `call-7` | crossing span id, hashed | `dcbb7a0fe90e11fd` |

Two observers with distinct host strings that share a 32-hex execution id land in one trace, because the trace id does not include the host. Their execution span ids differ, because those do.

### 4.1 `context.traceparent`

The value is a W3C `traceparent` string: `version-traceid-parentid-flags`. The sink uses it when it is well formed: a two-digit hex version that is not `ff`, a 32-digit lowercase hex trace id that is not all zeros, a 16-digit lowercase hex parent id that is not all zeros, and two hex flag digits. `core.md` does not say what to do with a malformed value. This document: the sink ignores a malformed value for id purposes, uses the derived ids, and still carries the string verbatim in `mocon.context.traceparent`.

The sink does not sample on the caller's flags and does not set the OTLP span `flags` or `traceState` fields from them. Sampling is the sink operator's policy, outside this document.

### 4.2 An execution's crossings under `context.traceparent`

When `context.traceparent` is present on the execution line, the execution span moves into the caller's trace. `core.md` section 5.3 says the host SHOULD copy the same value onto every crossing line of that execution, and section 6 says a crossing line that carries it uses its trace id. In the normal case, then, the execution span and all its crossing spans land in the caller's trace, the crossings parented to the derived execution span id, and no state is involved: every span's ids come from its own line.

The degraded case is a host that did not copy the value. Its crossing lines carry no `context.traceparent`, so their spans keep the derived trace id and sit in a different trace from the execution span. `core.md` section 6 requires the sink to add a span link on the execution span to `{trace_id: derived trace id, span_id: execution span id}` so that a backend can jump from the caller's trace to the trace that holds the crossings. Consequences for a sink:

- A sink MUST add that link whenever the execution line carries a well-formed `context.traceparent` (section 4.1), whether or not the crossings copied it.
- A sink MUST NOT hold per-execution state for any of this. Both halves of the link come from the execution line itself, and the crossing span's ids come from the crossing line itself.

## 5. Timestamps

Timestamps (`core.md` section 7) convert to unix nanoseconds; nine fractional digits is nanosecond precision, so nothing is lost.

`execution.start` and `execution.end.time` become the span's start and end. `end.time >= start` is the host's obligation; a violation is forwarded as given. The sink does not repair times.

Crossing times are optional. Section 7.3 says what the sink does when they are missing.

A required timestamp that does not parse as RFC 3339 makes the line unusable, because an OTLP span cannot exist without times. `core.md` does not address this. This document: skip the line and count it, as for a malformed line.

## 6. Execution span

One complete `execution` line becomes one span.

| span field | value |
|---|---|
| name | `mocon.execution` |
| kind | `INTERNAL` |
| trace id | section 4 |
| span id | derived execution span id, section 4 |
| parent span id | the parent id from `context.traceparent` when present and well formed; otherwise none (root span) |
| start | `start` |
| end | `end.time` |
| status | section 6.1 |
| instrumentation scope | section 11 |

### 6.1 Status

| `end.disposition` | status code |
|---|---|
| `completed` | `OK` |
| `failed` | `ERROR` |
| `terminated` | `ERROR`, except `UNSET` when `end.error.class` is `cancelled` |
| `abandoned` | `UNSET` |

The `cancelled` exception applies whether or not the host attested `execution.error.class`, so sinks agree before and after seeing the declaration; the status is a display hint, not an audit fact (`provenance.md` section 3).

The status description is set only when the code is `ERROR`, and it is the disposition string (`failed` or `terminated`). It is never `end.error.message`. The status description carries no provenance label, and `end.error.message` is always program-determined. The message is in `mocon.execution.error.message`, next to its label.

### 6.2 Attributes

Every attribute is present when its source field is present, and absent otherwise, unless the table says "always".

| attribute | type | source |
|---|---|---|
| `mocon.host` | string | `host`, always |
| `mocon.host.spec_version` | string | declaration `spec_version` |
| `mocon.host.observes_crossings` | string | declaration `observes_crossings` |
| `mocon.host.unmediated_egress` | bool | declaration `unmediated_egress` |
| `mocon.host.crossing_edge` | string | declaration `crossing_edge` |
| `mocon.host.attested` | string array | declaration `attested`; an empty array when declared empty |
| `mocon.execution.id` | string | `id`, always |
| `mocon.execution.disposition` | string | `end.disposition`, always |
| `mocon.execution.language` | string | `language` |
| `mocon.context.session` | string | `context.session` |
| `mocon.context.traceparent` | string | `context.traceparent`, verbatim |
| `mocon.program.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `program` |
| `mocon.execution.result.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `end.result` |
| `mocon.execution.outputs.<channel>.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `end.outputs.<channel>`, one set per channel, channel name verbatim |
| `mocon.execution.error.class` | string | `end.error.class` |
| `mocon.execution.error.message` | string | `end.error.message` |
| `mocon.execution.error.value.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `end.error.value` |
| `mocon.ext.<key>` | section 8 | `ext.<key>`, one per key, key verbatim |
| `gen_ai.operation.name` | string | the constant `execute_tool`, always |
| `mocon.provenance.<field>` | string | section 10 |

The `mocon.host.*` attributes come from the declaration, not from the line. When the sink has not seen the declaration for this host string, it omits them. `mocon.host` itself is on every line and is never omitted. `mocon.host.*` attributes appear on execution spans only. A crossing span carries `mocon.host` and its provenance labels, which already fold the declaration in.

The declaration's own `ext` keys do not export. The five attributes above are the whole of what a `host` record contributes, and `mocon.ext.<key>` on a span always comes from that span's own line. A sink MUST NOT lift `host.ext` keys onto execution spans, because it would then have to choose a provenance label for them and the span's `mocon.provenance.ext.p` array names keys of the line, not of the declaration. A sink that wants to carry them exports the declaration under its own name in `ext` on each line, or leaves them out.

`core.md` has no field for the tool's name or the caller's tool-use id, so an execution span carries no `gen_ai.tool.name` or `gen_ai.tool.call.id`; a sink MUST NOT invent them.

## 7. Crossing span

One complete `crossing` line becomes one span.

| span field | value |
|---|---|
| name | `target`, cut to its first 128 Unicode code points; `mocon.crossing` when `target` is the empty string |
| kind | `CLIENT` |
| trace id | the trace id from the crossing line's own `context.traceparent` when present and well formed (section 4.1); otherwise derived from `execution_id`, section 4 |
| span id | derived crossing span id, section 4 |
| parent span id | derived execution span id, computed from `execution_id`, always |
| start, end | section 7.3 |
| status | section 7.1 |
| instrumentation scope | section 11 |

The parent is always set, whether or not the execution span has been or will be exported. The full `target` is in `mocon.crossing.target`; the span name is display only.

### 7.1 Status

| `end.outcome` | status code |
|---|---|
| `output` | `OK` |
| `error` | `ERROR` |
| `abandoned` | `UNSET` |

The status description is set only for `ERROR` and is the string `error`. It is never `end.error.message`, for the reason given in section 6.1.

### 7.2 Attributes

| attribute | type | source |
|---|---|---|
| `mocon.host` | string | `host`, always |
| `mocon.execution.id` | string | `execution_id`, always |
| `mocon.crossing.id` | string | `id`, always |
| `mocon.crossing.target` | string | `target`, always, uncut |
| `mocon.crossing.seq` | int | `seq` |
| `mocon.context.traceparent` | string | `context.traceparent`, verbatim, when the crossing line carries it |
| `mocon.crossing.outcome` | string | `end.outcome`, always |
| `mocon.crossing.timing` | string | section 7.3; present only when the sink synthesized a time |
| `mocon.crossing.input.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `input` |
| `mocon.crossing.output.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `end.output`; only under outcome `output` |
| `mocon.crossing.error.class` | string | `end.error.class`; only under outcome `error` |
| `mocon.crossing.error.message` | string | `end.error.message` |
| `mocon.crossing.error.value.value`, `.truncated`, `.redacted`, `.bytes`, `.hash` | section 8 | `end.error.value` |
| `mocon.ext.<key>` | section 8 | `ext.<key>`, one per key |
| `gen_ai.operation.name` | string | the constant `execute_tool`, always |
| `gen_ai.tool.name` | string | `target`, uncut, always |
| `gen_ai.tool.call.id` | string | `id`, always |
| `mocon.provenance.<field>` | string | section 10 |

A sink MAY additionally copy the same (already-capped, per section 9) `mocon.crossing.input.value`/`mocon.crossing.output.value` strings into `gen_ai.tool.call.arguments`/`gen_ai.tool.call.result`, off by default; the section 10 provenance labels still apply to them.

`mcp.method.name` and `mcp.session.id` are not set. `core.md` has no field saying whether a crossing was an MCP request, and `context.session` is a host-defined grouping that is not necessarily an MCP session id.

### 7.3 Times

Crossing `start` and `end.time` are optional. Their presence is the host's declaration that it has host-clock timing for the crossing (`core.md` section 7). A span needs both times, so the sink fills what is missing and always says that it did.

| `start` | `end.time` | span start | span end | `mocon.crossing.timing` |
|---|---|---|---|---|
| present | present | `start` | `end.time` | absent |
| present | absent | `start` | `start` | `start_only` |
| absent | present | `end.time` | `end.time` | `end_only` |
| absent | absent | sink receipt time | sink receipt time | `none` |

The attribute is present exactly when a time was synthesized. The three synthesized cases are zero-duration spans, and a reader MUST NOT read their duration as the crossing's duration. Under `none`, the position is on the sink's clock, not the host's; the span is placed where the sink saw the line, which says nothing about when the crossing happened relative to the execution. Under `start_only` and `end_only`, the position is host clock but the duration is unknown.

`abandoned` crossings usually arrive without `end.time` (`core.md` section 13 shows this). They fall into `start_only` or `none` like any other crossing.

## 8. Value encoding

### 8.1 Payloads

A Payload (`core.md` section 5.4) at attribute prefix `p` becomes up to five attributes:

| attribute | type | rule |
|---|---|---|
| `p.value` | string, bool, int or double | present when the Payload has `value`; encoded per section 8.2 |
| `p.truncated` | bool | copied when present; set to `true` by the sink when it shortens `p.value` (section 9) |
| `p.redacted` | bool | copied when present |
| `p.bytes` | int | copied when present, never computed by the sink |
| `p.hash` | string | copied verbatim when present, never computed by the sink |

`bytes` and `hash` describe the host's serialization of the original (`core.md` section 5.4). The sink's encoding of `p.value` is not that serialization, so the sink MUST NOT recompute either. Absent and `false` mean the same thing for the boolean flags (`core.md` section 12), so a sink MAY omit a flag that is `false` in the record.

The prefixes are `mocon.program`, `mocon.execution.result`, `mocon.execution.outputs.<channel>`, `mocon.execution.error.value`, `mocon.crossing.input`, `mocon.crossing.output`, `mocon.crossing.error.value`. The Error `value` field is itself a Payload, which is why the error prefixes end in `.value` and their value attribute is `.value.value`.

### 8.2 JSON values to attribute values

| JSON value | attribute value |
|---|---|
| string | string, verbatim |
| boolean | bool |
| integer within int64 | int |
| any other number | double |
| object, array, null | the sink's JSON serialization, as a string: compact, no added whitespace, object key order as received, non-ASCII characters unescaped |

The same rule encodes `mocon.ext.<key>`: a primitive stays primitive, anything else is JSON-stringified.

This encoding does not record whether a string attribute began life as a JSON string or as the serialization of something else. When `p.truncated` is `true`, the value is always a string prefix of the host's serialization, so there is no ambiguity there. Otherwise a reader who needs the original JSON type keeps the mocon stream; OTLP is a projection of it. This is the one place the mapping loses information, and it is a type, not a field.

`value` stays opaque. The sink MUST NOT parse, scan or interpret it beyond serializing it (`core.md` section 5.4, `provenance.md` section 5).

## 9. Size caps

A sink MAY cap the length of any string attribute it writes from a record value. Backends and SDKs have limits; a sink SHOULD set its cap below every downstream limit it knows of (SDK, collector, backend). A value that is silently cut somewhere downstream would misrepresent the record, so the sink does the cutting itself and says so.

When the sink shortens a string it MUST:

1. Keep a prefix, cut on a UTF-8 code point boundary.
2. Set `mocon.<field>.truncated = true`. For a Payload value `p.value`, `<field>` is `p`, so the flag is `p.truncated`, the same flag the host would set. For a string that is not a Payload value, the flag is the attribute name plus `.truncated`: `mocon.crossing.target.truncated`, `mocon.execution.error.message.truncated`, `mocon.context.session.truncated`, `mocon.ext.<key>.truncated`.
3. Keep `mocon.<field>.bytes` and `mocon.<field>.hash` exactly as the host emitted them. They describe the original.

The cap applies to values. It MUST NOT be applied to `mocon.host`, ids, hashes, closed-enum values, `gen_ai.*` names, span names beyond the 128 code point rule in section 7, or provenance labels.

OpenTelemetry SDKs also apply an attribute count limit, commonly 128 by default, and drop attributes past it without changing the record. A span with many output channels or many `ext` keys can exceed that. A sink built on an SDK MUST raise the count limit or MUST count what it dropped.

After sink-side shortening, a reader cannot tell whether the host or the sink cut the value. Both cuts are out of band and both leave `bytes` and `hash` describing the original, so the record's meaning is the same either way.

A sink that must not forward a value has no defined way to mark that in this version; the host is the right place to redact.

## 10. Provenance labels

Provenance is not on the wire (`provenance.md` section 1); the sink applies the table and writes the answer as attributes, so any backend shows the label next to the value.

For each labeled attribute present on the span whose effective class is `P` or `T`, the sink adds `mocon.provenance.<field> = "P"` or `"T"`, where `<field>` is the attribute name with the leading `mocon.` removed. Host-observed fields get no label; no label means `H`. The effective class comes from `provenance.md` section 3 and the host's `attested` list. When the sink has not seen the declaration, `attested` reads as `[]` (`core.md` section 5.1) and every labeled field is at its baseline.

| attribute | baseline | `attested` entry | after |
|---|---|---|---|
| `mocon.program.value` | P | | |
| `mocon.execution.language` | P | | |
| `mocon.execution.result.value` | P | | |
| `mocon.execution.outputs.<channel>.value` | P | | |
| `mocon.execution.error.class` | P | `execution.error.class` | H |
| `mocon.execution.error.message` | P | | |
| `mocon.execution.error.value.value` | P | | |
| `mocon.crossing.target` | P | `crossing.target` | H |
| `mocon.crossing.seq` | P | `crossing.target` | H |
| `mocon.crossing.outcome` | P | `crossing.target` | H |
| `mocon.crossing.input.value` | P | `crossing.input` | H |
| `mocon.crossing.output.value` | P | `crossing.output` | T |
| `mocon.crossing.error.class` | P | `crossing.error` | T |
| `mocon.crossing.error.message` | P | `crossing.error` | T |
| `mocon.crossing.error.value.value` | P | `crossing.error` | T |
| `mocon.ext.<key>`, all keys | P | | |

`ext` is mostly an exception to the naming rule, because its keys are not fixed ahead of time: baseline `ext.<key>` attributes get no per-key label. Instead the sink writes one string-array attribute, `mocon.provenance.ext.p = [<key>, ...]`, listing every `mocon.ext.<key>` name present on the span whose class is still P — the baseline for every `ext` key `core.md` and `provenance.md` name today. A key an extension documents and the host's `attested` list names as an `ext.<extension>` entry (`provenance.md` section 4) is H and is left out of that array. `mocon.provenance.ext.p` is omitted entirely when every present `ext` key on the span is H, and is `[]` only if the sink chooses to write it for a span with no `ext` keys at all, which it need not.

Everything else is H and unlabeled: ids, times, `end.disposition`, `context.session`, `context.traceparent`, every Payload envelope field, and `mocon.host.*`. `context.traceparent` is H but caller-supplied; it MUST NOT be used for authorization or billing (`provenance.md` section 3).

Labels are added only for attributes that are present. A redacted program with no `value` has no `mocon.program.value` and so no `mocon.provenance.program.value`.

Label values are `P` and `T` (`provenance.md` section 2); a T label is the target's claim relayed by the host, not the host's own observation (`provenance.md` section 5), and is written so that an attested output does not read as host-observed.

The crossing span name is `target` and has no label of its own; `mocon.provenance.crossing.target` covers it. The status code follows `disposition` and `outcome`; `outcome` follows `target`, so under an unattested host the crossing status is itself a program claim.

The aggregate and hand-to-model rules of `provenance.md` section 5 are applied by whoever queries the backend; the labels exist so they can.

## 11. Scope and resource

Instrumentation scope name: `mocon/` followed by the host string, for example `mocon/example/mcp`. Scope version is not set. `core.md` gives the sink no emitter version; `spec_version` is the format version and lives in `mocon.host.spec_version`.

Resource: `core.md` says nothing about it. A sink SHOULD set `service.name` on the resource, because several backends use it to group or route spans, and SHOULD use the host string, grouping the spans of each host string into their own `ResourceSpans`. Everything a reader needs is also in `mocon.host` on every span, so a sink that sets a different `service.name` is still conformant.

## 12. Not exported

The `host` line has no span, so its `ext` is not exported; unknown top-level keys on any line are not exported. Every other core field is placed by sections 4 to 8, 10 and 11.

## Appendix A. Worked example

Input: the stream in `core.md` Appendix A, unchanged. Host `example/mcp`, one execution, two overlapping crossings, one truncated output.

Line 1 is the `host` record. It produces no span. The sink stores it, which is how `mocon.host.*` and the provenance labels below are filled.

Line 2 (the start notice) is dropped; line 5 (the complete record) becomes the execution span.

Provenance, with `attested: ["crossing.target", "crossing.input"]`: `target`, `seq`, `outcome` and `input.value` are H and unlabeled. `output.value` is P and labeled. On the execution, `program.value`, `language` and `result.value` are P and labeled.

The Payload `hash` values are copied exactly as `core.md` prints them. `core.md` shortens them for display, and a sink copies `hash` verbatim and never recomputes it, so the shortened strings pass through. In a real stream each is `sha256:` followed by 64 hex digits: hashing the UTF-8 bytes of the program text directly, as `core.md` section 5.4 recommends, `program.hash` would be `sha256:7736542c4a55183c6bebe63fd34637eb6fff9ffb6f57602a0b6bfbe4a8b4b28c` and `program.bytes` is 204, matching the example stream.

Encoding is OTLP JSON (unix-nanosecond strings for times, hex strings for ids, integers for enums); `service.name` follows section 11.

The spans are listed in the order the lines arrived. The execution span comes last because its complete record is the last line; a backend assembles the tree from ids, not from order.

```json
{
  "resourceSpans": [{
    "resource": {"attributes": [{"key":"service.name","value":{"stringValue":"example/mcp"}}]},
    "scopeSpans": [{
      "scope": {"name":"mocon/example/mcp"},
      "spans": [
        {
          "traceId": "a3f1c2d4e5b6978081726354a1b2c3d4",
          "spanId": "1a2b3c4d5e6f7081",
          "parentSpanId": "4edd2d736dd0892d",
          "name": "company_identify",
          "kind": 3,
          "startTimeUnixNano": "1789552800118000000",
          "endTimeUnixNano": "1789552800402000000",
          "attributes": [
            {"key":"mocon.host","value":{"stringValue":"example/mcp"}},
            {"key":"mocon.execution.id","value":{"stringValue":"a3f1c2d4e5b6978081726354a1b2c3d4"}},
            {"key":"mocon.crossing.id","value":{"stringValue":"1a2b3c4d5e6f7081"}},
            {"key":"mocon.crossing.target","value":{"stringValue":"company_identify"}},
            {"key":"mocon.crossing.seq","value":{"intValue":"1"}},
            {"key":"mocon.crossing.outcome","value":{"stringValue":"output"}},
            {"key":"mocon.crossing.input.value","value":{"stringValue":"{\"query\":\"acme.example\"}"}},
            {"key":"mocon.crossing.input.bytes","value":{"intValue":"24"}},
            {"key":"mocon.crossing.input.hash","value":{"stringValue":"sha256:11aa…"}},
            {"key":"mocon.crossing.output.value","value":{"stringValue":"{\"name\":\"Acme Robotics\",\"id\":8842}"}},
            {"key":"mocon.crossing.output.bytes","value":{"intValue":"34"}},
            {"key":"mocon.crossing.output.hash","value":{"stringValue":"sha256:22bb…"}},
            {"key":"gen_ai.operation.name","value":{"stringValue":"execute_tool"}},
            {"key":"gen_ai.tool.name","value":{"stringValue":"company_identify"}},
            {"key":"gen_ai.tool.call.id","value":{"stringValue":"1a2b3c4d5e6f7081"}},
            {"key":"mocon.provenance.crossing.output.value","value":{"stringValue":"P"}}
          ],
          "status": {"code":1}
        },
        {
          "traceId": "a3f1c2d4e5b6978081726354a1b2c3d4",
          "spanId": "2b3c4d5e6f708192",
          "parentSpanId": "4edd2d736dd0892d",
          "name": "person_search",
          "kind": 3,
          "startTimeUnixNano": "1789552800119000000",
          "endTimeUnixNano": "1789552801874000000",
          "attributes": [
            {"key":"mocon.host","value":{"stringValue":"example/mcp"}},
            {"key":"mocon.execution.id","value":{"stringValue":"a3f1c2d4e5b6978081726354a1b2c3d4"}},
            {"key":"mocon.crossing.id","value":{"stringValue":"2b3c4d5e6f708192"}},
            {"key":"mocon.crossing.target","value":{"stringValue":"person_search"}},
            {"key":"mocon.crossing.seq","value":{"intValue":"2"}},
            {"key":"mocon.crossing.outcome","value":{"stringValue":"output"}},
            {"key":"mocon.crossing.input.value","value":{"stringValue":"{\"domain\":\"acme.example\",\"limit\":200}"}},
            {"key":"mocon.crossing.input.bytes","value":{"intValue":"37"}},
            {"key":"mocon.crossing.input.hash","value":{"stringValue":"sha256:33cc…"}},
            {"key":"mocon.crossing.output.value","value":{"stringValue":"[{\"name\":\"Jordan Ellis\",\"title\":\"CEO\"},{\"name\":\"Mira Okafor\",\"title\":\"CTO\"},{\"na"}},
            {"key":"mocon.crossing.output.truncated","value":{"boolValue":true}},
            {"key":"mocon.crossing.output.bytes","value":{"intValue":"1843211"}},
            {"key":"mocon.crossing.output.hash","value":{"stringValue":"sha256:9e77…"}},
            {"key":"gen_ai.operation.name","value":{"stringValue":"execute_tool"}},
            {"key":"gen_ai.tool.name","value":{"stringValue":"person_search"}},
            {"key":"gen_ai.tool.call.id","value":{"stringValue":"2b3c4d5e6f708192"}},
            {"key":"mocon.provenance.crossing.output.value","value":{"stringValue":"P"}}
          ],
          "status": {"code":1}
        },
        {
          "traceId": "a3f1c2d4e5b6978081726354a1b2c3d4",
          "spanId": "4edd2d736dd0892d",
          "name": "mocon.execution",
          "kind": 1,
          "startTimeUnixNano": "1789552800000000000",
          "endTimeUnixNano": "1789552801902000000",
          "attributes": [
            {"key":"mocon.host","value":{"stringValue":"example/mcp"}},
            {"key":"mocon.host.spec_version","value":{"stringValue":"1.0"}},
            {"key":"mocon.host.observes_crossings","value":{"stringValue":"all"}},
            {"key":"mocon.host.unmediated_egress","value":{"boolValue":false}},
            {"key":"mocon.host.crossing_edge","value":{"stringValue":"invocation"}},
            {"key":"mocon.host.attested","value":{"arrayValue":{"values":[{"stringValue":"crossing.target"},{"stringValue":"crossing.input"}]}}},
            {"key":"mocon.execution.id","value":{"stringValue":"a3f1c2d4e5b6978081726354a1b2c3d4"}},
            {"key":"mocon.execution.disposition","value":{"stringValue":"completed"}},
            {"key":"mocon.execution.language","value":{"stringValue":"javascript"}},
            {"key":"mocon.context.session","value":{"stringValue":"mcp-9a1f0c"}},
            {"key":"mocon.program.value","value":{"stringValue":"const [co, people] = await Promise.all([callTool('company_identify',{query:'acme.example'}), callTool('person_search',{domain:'acme.example',limit:200})]); return {company: co.name, count: people.length};"}},
            {"key":"mocon.program.bytes","value":{"intValue":"204"}},
            {"key":"mocon.program.hash","value":{"stringValue":"sha256:6d2c…"}},
            {"key":"mocon.execution.result.value","value":{"stringValue":"{\"company\":\"Acme Robotics\",\"count\":200}"}},
            {"key":"mocon.execution.result.bytes","value":{"intValue":"39"}},
            {"key":"mocon.execution.result.hash","value":{"stringValue":"sha256:44dd…"}},
            {"key":"gen_ai.operation.name","value":{"stringValue":"execute_tool"}},
            {"key":"mocon.provenance.program.value","value":{"stringValue":"P"}},
            {"key":"mocon.provenance.execution.language","value":{"stringValue":"P"}},
            {"key":"mocon.provenance.execution.result.value","value":{"stringValue":"P"}}
          ],
          "status": {"code":1}
        }
      ]
    }]
  }]
}
```
