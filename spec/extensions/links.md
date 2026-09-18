# mocon links

Status: draft, 2026-09-19. Extension to `core.md` and `provenance.md`. It specifies the `links[]` name `extensions/README.md` section 3 reserved. A core-only consumer that has never read this file behaves correctly on a stream carrying `links`: it ignores the key, by the wire rule in `core.md` section 3.

## 1. Purpose

Retries, replays and fan-out have no causal expression in core. `core.md` 5.2 already settles what each of them *is* — a program the host runs again is a new execution with its own id — but nothing relates the new record to the old one, so every host that wants to show "this is the second attempt" invents its own shape in `ext`.

`links` is one optional array with a closed set of relations. It is deliberately small, and section 6 says plainly what it does not reach.

## 2. Shape

A new optional top-level array on `execution` and `crossing` lines. Extension kinds MAY carry it with the same shape and meaning.

Top-level rather than inside `ext`, because it has a closed vocabulary and a fixed shape: inside `ext` it would be vendor-namespaced and program-determined at baseline, which is the opposite of what it is.

```json
"links":[{"rel":"retry_of","kind":"crossing","id":"1a2b3c4d5e6f7081","counts":"additive"}]
```

| field | required | type | meaning |
|---|---|---|---|
| `rel` | yes | closed: `retry_of`, `replay_of`, `forked_from`, `continues` | the relation **this** record has to the named one: "this record is a `<rel>` the named record" |
| `kind` | yes | `"execution"` or `"crossing"` | ids are unique only within `(host, kind)` (`core.md` 6) |
| `id` | yes | string | the named record's `id` |
| `counts` | yes | closed: `"additive"`, `"duplicate"` | whether this record's values are additional to the named record's, or repeat them (section 4) |
| `host` | no | string | the named record's host string; absent means this line's own host (section 6) |
| `execution_id` | no | string | only meaningful under `kind: "crossing"`; on a crossing line, absent means this line's own `execution_id`. A sink needs it to derive the named crossing's trace id (section 7) |

## 3. The newer record carries the link

**A link is always carried by the newer record and points back at the older one.** This is forced, not preferred. A complete record is emitted exactly once and carries every field it will ever have (`core.md` 2, 4.1, 10), so a host cannot add a child to a parent's record without emitting a second, differing complete record for a key it already closed — which `core.md` 4 rule 3 makes a *conflict*. A forward link is not a design choice a host could make; it is unrepresentable. Three things follow for free: the new record is the only one that knows the relation at the moment it is written; one-to-many fans out on the many side, so a dispatch retried ten thousand times stays one line and the ten thousand retries carry one entry each; and OpenTelemetry span links point the same way, so the export is the identity mapping.

## 4. `counts`, and why it is required

A relation alone is not enough for anything that adds values up. Temporal replays a workflow from history on worker restart, and `core.md` 5.2 requires each replay to be a new execution with its own id. A workflow replayed fifty times emits fifty-one executions, all `replay_of` the same original, and the replays re-emit crossings that were served from history and cost nothing. A consumer totalling a declared `sum` dimension across that chain over-counts spend fifty-one-fold. The relation says the records are related; only `counts` says whether they are additional.

- `additive`: this record's work happened in addition to the named record's. A retry after a failure really did spend again.
- `duplicate`: this record repeats the named record's work and its values are not additional to it. A history replay, a determinism re-run that consumed nothing.

It is required on every entry rather than defaulted, because there is no safe default: over-counting spend is loud and wrong, under-counting is silent and wrong, and a host always knows which its own case is. A consumer totalling a declared dimension over a set of records MUST count a `duplicate`-linked record's values at most once against the record it names, or exclude it and say so. A consumer that does not resolve links at all totals every record it holds, which is 1.0's behaviour.

## 5. The relations

Closed to hosts, growing by minor version, the same policy `core.md` 8 gives `attested`. A consumer that meets an unknown `rel` drops that entry and SHOULD flag it.

- **`retry_of`** — this record repeats the named record's work after it produced no usable outcome. Executions and crossings both. `core.md` 5.3's rule stands: a host that retries *silently* still emits **one** crossing with the final outcome and puts the count in `ext`. `retry_of` is for a retry the host chose to record as its own record.
- **`replay_of`** — this record deliberately re-runs the named record's work with the same inputs, not because it failed: a replay from a log, a determinism check, a debugging re-run. `core.md` 5.2 already requires such a run to be a new execution with its own id; this is what relates it to the original.
- **`forked_from`** — this record began from the named record's state or input and proceeds independently: a speculative branch, a shard of a fan-out, a checkpoint restored as an *additional* branch. Every shard of a fan-out carries `forked_from` naming the one record they came from.
- **`continues`** — this record is the same logical run as the named record, resumed: after a checkpoint handed to a different host string, which is the case `extensions/events.md` 5's `suspended` points at, or across a process boundary where the host minted a new id. The named record is typically left unresolved forever.

`parent` was reserved by `extensions/README.md` 3 and is **not** specified here. See section 6.

## 6. What `links` does not reach, and why

**Cross-host nesting is `traceparent`'s job, not this file's.** `core.md`'s invariant C13 says a crossing may be served by another execution and resolves it with "correlation is by `traceparent`, not by a core field", and `core.md` 4 rule 6 says core defines no cross-host join. That edge is cross-host by construction: the nested execution belongs to a different host string, and it does not hold — and has no way to learn — the mocon crossing id of the call that reached it. It receives a `traceparent`. A `parent` relation would therefore be a relation almost no host could populate truthfully, and hosts would reach for it for exactly the case it cannot serve. It is not specified, and `context.traceparent` remains the mechanism that actually nests traces.

**`links` is within-host by default.** `host` on an entry exists for one case, `continues` across a host-string change, which `events.md` 5 already promises. A cross-host entry is the carrying host's claim about a record it does not own. It creates none of the cross-host key join `core.md` 4 rule 6 refuses: a consumer MAY display it and MUST NOT merge the two records, and a sink cannot derive the named record's ids if that host moved them into a caller's trace (section 7).

**The boundary with the reserved `attempts[]`.** `extensions/README.md` 3 reserves `attempts[]` for per-dispatch detail subordinate to one crossing record. Two names covering one problem is how two hosts model fallback routing incompatibly, so the line is drawn here, in one sentence each way: **a retry that the host recorded as one crossing is `attempts[]` on that crossing; a retry the host recorded as a second crossing record is two crossings related by `retry_of`.** Which of the two a host does is `core.md` 5.3's existing choice between a silent retry and a recorded one. `attempts[]` stays reserved and unspecified.

**Execution cardinality is prose, and a host may not follow it.** `core.md` 5.2 fixes what counts as one execution: a program the host runs again is a new execution with its own id, retries and replays included. A host mapping mocon onto an existing runtime may not do that — Temporal's own shape is one activity carrying an attempt number, not two activities — and nothing in a stream lets a consumer detect the difference. That is a limitation of the spine, not of this file, and `links` cannot adjudicate it: a host that follows 5.2 uses `retry_of`, and a host that does not has one record and no link to write. Stated here because a consumer comparing execution counts across hosts needs to know it.

## 7. Rules

- A link entry MUST NOT name the record carrying it. A consumer drops such an entry; lint warns.
- A consumer MUST tolerate cycles and MUST NOT walk the graph without a visited set. A host bug can write `A retry_of B` and `B retry_of A`.
- A consumer MUST NOT assume a chain terminates within one stream. `replay_of` routinely names a record in last month's file. Core performs no referential check on `links`, exactly as it performs none on `crossing.execution_id`.
- No cap on entries per record. `core.md` 3's "lines SHOULD be under 1 MiB" already covers it.

## 8. Provenance

`links` is **H**, unconditionally, with no `attested` entry — the same treatment and the same reasoning `provenance.md` 3 gives `crossing.execution_id`. The ids being related are ids the host itself minted (`core.md` 6) and that no program can see or name; the relation is the host's own bookkeeping. H carries its standing caveat: faithfully recorded by that host, not verification that the named record exists or agrees.

## 9. OpenTelemetry

Each entry becomes one OTel **span link** on the span for the carrying record, plus one `mocon.links` span attribute holding the array's JSON text (`otel-mapping.md` 8.2's rule for a non-primitive). Derivation is from the link entry alone: no state, no lookup.

- `kind: "execution"`: `trace_id` is `core.md` 6's trace id from (link `host`, link `id`); `span_id` is the derived execution span id from the same pair.
- `kind: "crossing"`: `span_id` is the derived crossing span id from (link `host`, link `id`); `trace_id` is derived from (link `host`, link `execution_id`).
- Each span link carries two attributes, `mocon.rel` and `mocon.counts`. Those also distinguish these links from the one `core.md` 6 requires on the traceparent degraded path, which carries none.
- When `execution_id` is neither present nor defaulted, the sink MUST NOT emit a span link for that entry — it cannot derive a trace id — and records it in `mocon.links` only.

Honest limitation: if the named record's host moved it into a caller's trace through `context.traceparent`, the derived `trace_id` will not match and the link dangles. A link entry carries no traceparent of its own, deliberately: adding one would turn a four-field entry into a six-field one to buy one-click navigation, and the exact `(host, kind, id)` is still in `mocon.links` for a query. Revisit if traceparent adoption turns out to be common among hosts that also emit links.

## 10. Examples

Hashes and payload values shortened for display, in the style of `core.md` Appendix A.

### 10.1 A retried crossing

The first dispatch failed and the host recorded it; the second is its own crossing pointing back. Both spent credits, so the retry is `additive`.

```jsonl
{"kind":"crossing","host":"example/mcp","id":"c100000000000001","execution_id":"e1","seq":1,"target":"person_search","input":{"value":{"limit":200},"bytes":13},"end":{"outcome":"error","error":{"class":"capability_error","message":"upstream 503"}}}
{"kind":"crossing","host":"example/mcp","id":"c100000000000002","execution_id":"e1","seq":2,"target":"person_search","input":{"value":{"limit":200},"bytes":13},"links":[{"rel":"retry_of","kind":"crossing","id":"c100000000000001","counts":"additive"}],"end":{"outcome":"output","output":{"value":[],"bytes":2}}}
```

### 10.2 A fan-out

One dispatch shards into three executions. Each shard points back at the record it came from; each did its own work, so each is `additive`.

```jsonl
{"kind":"execution","host":"example/mcp","id":"shard-a","program":{"hash":"sha256:…","bytes":180,"redacted":true},"start":"2026-09-18T09:00:01.000Z","links":[{"rel":"forked_from","kind":"execution","id":"fan-out-root","counts":"additive"}],"end":{"time":"2026-09-18T09:00:04.000Z","disposition":"completed"}}
```

### 10.3 A replay

A durable runtime re-runs a workflow from history. The replay consumed nothing, so it is `duplicate` and an aggregator counts the chain once.

```jsonl
{"kind":"execution","host":"example/durable","id":"run-2","program":{"hash":"sha256:…","bytes":96,"redacted":true},"start":"2026-09-18T10:05:00.000Z","links":[{"rel":"replay_of","kind":"execution","id":"run-1","counts":"duplicate"}],"end":{"time":"2026-09-18T10:05:02.000Z","disposition":"completed"}}
```
