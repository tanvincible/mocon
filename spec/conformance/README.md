# mocon conformance suite

Status: draft 1.0, 2026-09-17. Normative for the term "producer conformant" used
below. Companion to `../core.md`, `../provenance.md` and `../schema/`.

This suite is executable, not just descriptive. `check.py` is the reference
implementation of the rules below; the golden streams and their expected
views are regression-checked against it. Where this README and `check.py`
ever disagree, treat that as a bug in one of them, not a second source of
truth: `core.md` and `provenance.md` are the actual spec.

## 1. Layout

```
conformance/
  streams/    23 golden *.jsonl streams, each a legal mocon stream
  expected/   the canonical view (see below) each stream must produce
  invalid/    one *.jsonl line per file that MUST fail validation, plus a
              sibling *.reason.txt naming the rule it breaks
  check.py    the runner: validate | view | permute [N] | invalid | lint | all
  README.md   this file
```

## 2. The 23 golden streams

The first 16 rows below are shaped after real code-mode implementations
(noted below as "X-shaped"), so the fixtures exercise real, not
hypothetical, combinations of the host declaration's fields. The last 7
rows extend that set to implementation classes the first 16 did not cover
(durable jobs, notebook kernels, multi-block executors, WASM hosts); each
is a golden stream that validates, permutes and self-concatenates cleanly,
and each earns its place by exercising some shape the original 16 lacked.
Every stream opens with its `host` line, because none of these 23 cases is
*about* that line's absence (core.md 5.1's requirement that a host
declaration precede every other record for that host is instead exercised
structurally: `check.py view` would have nothing to resolve `hosts`
against if it were skipped, and no fixture here omits it).

| stream | exercises |
|---|---|
| `sync-bridge` | A synchronous bridge host. A start notice, two overlapping crossings carrying host-clock `start`/`end.time` and `seq`, one truncated output (`truncated` + `bytes` + `hash`, no full `value`), a complete execution with `end.result` and `ext` credits. This is the shape of core.md Appendix A with fresh ids and real hashes. |
| `batch-at-end` | aggregate-blob-shaped, like open-ptc-agent. One complete execution line, nothing else: `observes_crossings: "none"`, `unmediated_egress: true`, zero crossings, `failed` with `error.class: "runtime"`, `end.outputs.stdout`/`stderr`, `ext` process exit code. Models a host that only sees an aggregate stdout/stderr/exit-code blob after a subprocess exits. |
| `unmediated` | open-ptc-agent-shaped. Notice plus complete, zero crossings ever (calls happen entirely inside a remote sandbox the host never mediates), `completed`, `end.outputs.stdout`. |
| `anthropic-ptc` | A developer-side host spanning what the calling application sees as three HTTP turns (initial call, then one resume per paused tool call). `context.traceparent` on the execution, copied onto both crossings, two sequential (not overlapping) crossings each carrying `ext` with an `anthropic.tool_use_id`, `completed` with `end.outputs.stdout`. |
| `abandoned-at-end` | Cloudflare-shaped. One crossing completes normally; a second, paused on an approval gate, is left `abandoned` with no `end.time` because the execution's own TTL elapses before the approval decision arrives and the host terminates it first; the execution then ends `terminated` with `error.class: "timeout"`. Exercises core.md 5.3's abandon-before-end ordering rule directly, without relabeling a host-determined per-call decision as `abandoned` (5.3's MUST NOT). |
| `seq-no-times` | UTCP-shaped. Three crossings carrying `seq` and no `start` or `end.time` at all (both are optional), execution `completed`. |
| `no-timing-blob-ref` | tool-sandbox-mcp-shaped. Crossings with neither `seq` nor any timestamp. One crossing's output `value` is an ordinary JSON object that happens to look like `{"type":"blob_ref",...}` — mocon does not interpret `value`, so this is just content, not a distinct payload kind — with `redacted: false` set explicitly alongside a present `value`. |
| `pre-run-rejection` | A single complete execution, `failed`, `error.class: "validation"` (the class core.md 5.2 fixes by rule for every pre-execution rejection), zero crossings, `end.time` a few milliseconds after `start`. |
| `terminated-timeout` | smolagents-shaped. A crossing is abandoned first (no `end.time`; the watchdog cannot actually stop the call), then the execution ends `terminated` with `error.class: "timeout"`. |
| `unresolved` | A host line and one execution start notice. Nothing else, ever. The execution has no disposition and none should be invented for it. |
| `hash-only-program` | `program` is `{"redacted": true, "hash": ..., "bytes": ...}` on both the notice and the complete record, no `value`. Execution `completed`. |
| `complete-before-notice` | The complete execution line is written before its own start notice. core.md 4.4: order is irrelevant. |
| `identical-resend` | One complete crossing line, byte-for-byte repeated. core.md 4.3: identical re-sends are no-ops, not a conflict. |
| `conflicting-resend` | Two complete execution lines, same `(host, id)`, different `end.disposition` (`completed` vs `failed`). core.md 4.3: this is a genuine conflict. See "Conflicts and order" below for how `check.py` resolves which one appears in the view. |
| `unknown-kind` | An otherwise-valid stream plus one line with `kind: "metric"`. core.md 3: a consumer MUST skip a kind it does not know; `skipped` counts it. |
| `unknown-field` | An otherwise-valid stream where every line also carries a top-level `x-debug` field. core.md 3: unknown top-level keys MUST be ignored, not rejected. |
| `none-no-egress` | Judge0-shaped durable job. `observes_crossings: "none"` and `unmediated_egress: false` together, the only golden stream with that combination: a consumer must not apply section 12's "no external calls" inference, which needs `all"`, not `"none"`. Zero crossings, `execution.error.class` attested with none to attest, an `ext` value that is JSON `null` and a nested object side by side, a 47-second polled-job span. |
| `crossing-notice-superseded` | Temporal-shaped durable workflow. A crossing start notice superseded by its `output` complete record, the only golden stream where that happens (the two existing abandoned crossings in `abandoned-at-end` and `terminated-timeout` never resolve). Six-digit fractional seconds, a 52-second crossing, `all`/`true`/`invocation` with `crossing.target` and `crossing.input` attested but not `crossing.output`. |
| `multi-block-error-value` | nbclient-shaped multi-block notebook. First golden stream with `execution.end.error.value` as a Payload, a non-recommended output channel (`execute_result`) holding an object, and the stop-on-error segment shape in `ext` (`nbclient.cells[3].status: "not_run"`) core.md 5.2's segment wording and the `segments` extension (`../extensions/README.md`) are written for. |
| `language-absent` | AutoGen-shaped multi-block executor. The only golden stream with no `language` field at all (a python+bash+python submission has no honest single label), `failed` with `end.result` carrying the executor's aggregate envelope and no `end.outputs`, a trailing block recorded `executed: false` in `ext`. |
| `egress-unknown` | OpenAI code-interpreter-shaped notebook kernel. The only golden stream whose `host` line omits both `unmediated_egress` (reads as unknown, treated like `true`) and `crossing_edge`; also the by-reference output shape core.md 5.4's reference-value rule covers, a URL as the `image` channel's value instead of inlined bytes. |
| `crossing-error` | Extism-shaped WASM host. The only golden stream with a crossing settling `end.outcome: "error"`, carrying `end.error` with an open class (`conflict`) and an `error.value` Payload, under a fully attested host; the execution still `completed` because the program caught the error. `all`/`unmediated_egress: true`/`invocation`, `ext` memory offsets. |
| `base64-input-null-value` | Wasmtime-shaped WASM host (component model). Exercises core.md 5.4's base64 pattern on a crossing input (`ext.wasmtime.input_encoding: "base64"`, `bytes` the pre-encoding length), an output whose `value` key is present holding JSON `null` (a consumer must not read that as absent), WIT-style targets containing `@`, `#` and `[]`, `language: "rust"`. |

## 3. The canonical view

`expected/<name>.json` is the view a conforming consumer builds after reading
a whole stream and applying the supersede rule (core.md 4) once per key. Every
suite file uses this exact shape:

```json
{
  "hosts": { "<host>": { ...the host record... } },
  "executions": { "<id>": { ...the execution record... } },
  "crossings": { "<id>": { ...the crossing record... } },
  "unresolved": [ { "kind": "...", "host": "...", "id": "..." } ],
  "conflicts": [ { "kind": "...", "host": "...", "id": "..." } ],
  "skipped": 0
}
```

Rules:

- **`hosts` / `executions` / `crossings`.** One entry per key seen in the
  stream (`host` alone for `hosts`; `id` for the other two — see "Id scope"
  below). The value is the *complete* record when at least one complete
  record was seen for that key, otherwise the *notice*. This is core.md
  2's "complete record ... has every field the record will ever have" and
  core.md 4.5's "a record that only ever has a start notice is unresolved",
  read together: the view always shows the best record available, and
  `unresolved` separately flags which entries are notice-only so a viewer
  can render them as running/unknown rather than as a finished record.
  The stored value is the record's fields exactly as written on the wire
  (including its own `kind`, `host` and `id`), not a re-shaped summary.
- **`unresolved`.** One `{"kind","host","id"}` entry for every execution or
  crossing key that has a notice and no complete record, sorted by
  `(kind, host, id)` for a deterministic diff. `hosts` has no notice/complete
  distinction (core.md 5.1 defines only one shape for it), so it never
  appears here.
- **`conflicts`.** One `{"kind","host","id"}` entry for every key with two or
  more *distinct* complete records (core.md 4.3). Byte-identical re-sends are
  deduplicated first and never produce a conflict entry. Sorted the same way.
  A host redeclared with different capabilities is a conflict too (core.md
  5.1); such an entry carries `"id": null` since host records have no id.
  None of the 23 golden streams exercises this — `check.py` supports it so a
  future fixture or a real stream containing one does not crash the runner.
- **`skipped`.** The count of lines with an unknown `kind` or that failed to
  parse as JSON at all (core.md 3). A line with a known kind that fails
  *schema* validation is not one of these two things and is out of scope for
  this counter; the golden streams never contain such a line (that is what
  `invalid/` is for).

### Id scope

`executions` and `crossings` are keyed by bare `id`, because core.md 6 scopes
ids to `(host, kind)`, not globally, and every stream in this suite is
single-host. A consumer merging multiple hosts into one view MUST key on
`(host, id)` instead, or two different hosts that independently chose the
same id would collide. This suite does not need that because it never mixes
hosts within one file.

### Conflicts and order

core.md 4.3 requires keeping exactly one of two conflicting complete
records, chosen by a function of their content alone; the tie-break this
suite uses (its recommended one) is canonical-JSON (keys sorted, no
whitespace) sort order. core.md
4.4 separately requires that a consumer produce the same view for any
permutation of a stream. Because the tie-break is a pure function of content,
not of where a record falls in the file, both hold together: `check.py`'s
view builder (`pick()`) sorts each key's distinct complete records by
canonical JSON and keeps the first, which is why `check.py permute` passes on
`conflicting-resend` even though that stream's two records arrive in a fixed
order on disk. A producer's own consumer-side tooling MAY choose a different
content-deterministic function; what it MUST do, per core.md 4.3, is keep
exactly one by such a function, and count and surface the conflict.

A second, smaller gap in the same neighborhood: core.md defines the
supersede rule for *complete* records, and separately says a start notice is
"optional" and carries "the fields known when the record began." It does not
say what happens when two *notices* for the same key disagree (for example,
a host that re-emits a running execution's notice with an updated
`context.session`). No fixture in this suite has two differing notices for
one key, so `check.py` is never exercised on that path; for symmetry its
`resolve()` helper applies the same dedupe-then-lexicographic-pick logic to
notices as to completes, but that is an implementation convenience, not a
claim about what core.md requires.

## 4. Running

```sh
cd spec/conformance
python3 check.py all        # everything below; exit 0 iff all of it passes
python3 check.py validate   # streams/*.jsonl validate against schema/line.json
                             # (jsonschema, if importable) plus the built-in
                             # structural checks (always)
python3 check.py view       # rebuild each stream's canonical view, diff vs expected/
python3 check.py permute 5  # shuffle each stream 5x and re-check the view;
                             # also concatenate each stream with itself
python3 check.py invalid    # every invalid/*.jsonl line must fail validation
python3 check.py lint       # provenance.md 7's lint rules, plus end.time >= start,
                             # over streams/*.jsonl (warnings; a clean golden
                             # suite should print none)
```

`check.py` is stdlib-only. It uses the third-party `jsonschema` package (and
the `referencing` package it depends on, for resolving `$ref`s across the
schema files without the deprecated `RefResolver`) when importable, and
prints a one-line notice and falls back to the built-in structural checks
alone when it is not. The structural checks independently cover every rule
schema validation would (required keys per kind, the closed enums,
end-completeness, the Payload rule, the timestamp `Z` suffix, and the
`hash` pattern; core.md 3, 4, 5, 7, 8), so `invalid/` fails the same way
whichever path runs.

## 5. Producer conformance

An adaptor claims producer conformance, per `host` string (an adaptor
emitting under two host strings with different observability must satisfy
all four points for each one independently), when: (1) `python3 check.py
validate` reports no failures on its emitted stream; (2) `check.py`'s view
builder (or `check.py permute`) reports zero conflicts, where a conflict
means a reused id or a second, differing complete record for a key it
already closed (core.md 6, 10); (3) its `host` declaration is the first
line that host string appears on in every stream it opens, re-declared
identically or not at all thereafter (core.md 5.1); and (4) every
`attested` entry it emits is one its declared `spec_version` knows and is
true of every record it emits under that host string (provenance.md 4; a
host with both an observed and a parsed path for one field uses two host
strings instead). This restates core.md 10 and provenance.md 4; it adds no
new obligation.

## 6. What this suite does not cover

- **OpenTelemetry export** (core.md 6's id derivation, `otel-mapping.md`).
  No fixture here derives trace/span ids or checks sink behavior; that is a
  separate concern with its own normative document.
- **The `event` extension kind** (`../extensions/events.md`). Core consumers
  ignore unknown kinds by design (core.md 3), which `unknown-kind` already
  exercises generically; this suite does not additionally model `event`
  lines.
- **Malformed-JSON lines as a golden-stream fixture.** `skipped` covers them
  by rule (section 3 above) and `check.py`'s line parser handles them, but
  no `streams/*.jsonl` file contains one, since none of the 23 named cases
  calls for it. `check.py view`'s permutation and
  self-concatenation checks would catch a regression here if one were added.
