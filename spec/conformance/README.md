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
  streams/         26 golden *.jsonl streams, each a legal mocon stream
  expected/        the canonical view (see below) each stream must produce
  invalid/         one *.jsonl line per file that MUST fail validation, plus a
                   sibling *.reason.txt naming the rule it breaks
  check.py         the runner: validate | view | order | permute [N] | invalid | lint | all
  requirements.txt what check.py needs for its full run
  README.md        this file
```

## 2. The 26 golden streams

The first 16 rows below are shaped after real code-mode implementations
(noted below as "X-shaped"), so the fixtures exercise real, not
hypothetical, combinations of the host declaration's fields. The next 7
rows extend that set to implementation classes the first 16 did not cover
(durable jobs, notebook kernels, multi-block executors, WASM hosts); each
is a golden stream that validates, permutes and self-concatenates cleanly,
and each earns its place by exercising some shape the original 16 lacked.
The last 3 rows are not shaped after a named product: each exists to pin a
rule that two conforming implementations could otherwise read differently,
and each is named in core.md at the rule it pins.
Every stream opens with the `host` line for each host string it carries,
which `check.py order` now checks directly against file order (section 4);
no fixture here is *about* that line's absence.

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
| `base64-input-null-value` | Wasmtime-shaped WASM host (component model). Exercises core.md 5.4's base64 pattern on a crossing input (`bytes` the pre-encoding length), an output whose `value` key is present holding JSON `null` (a consumer must not read that as absent), WIT-style targets containing `@`, `#` and `[]`, `language: "rust"`. The stream's `ext.wasmtime.input_encoding: "base64"` is a vendor key and nothing more: core carries no encoding marker and a core consumer MUST NOT read one (core.md 5.4, 12), so to this suite that input is a 44-character string whose `bytes` and `hash` describe the 32 bytes it encodes. |
| `two-hosts` | Two hosts' streams merged into one file, which core.md 3 explicitly allows. The only golden stream with more than one `host` string: it exercises `check.py permute` and `check.py order` across host strings, and it is what "Id scope" below is about — its execution and crossing ids are distinct across the two hosts, because this suite's view is keyed by bare `id`. |
| `notice-drift` | Two differing start notices for one execution key, no complete record ever: the host emits a provisional notice and re-emits it once it learns `context.session`, which core.md 4.2 contemplates. core.md 4.3 settles it — the same content-only tie-break as for two completes, and not a conflict. Before that sentence existed, two suite-passing, permutation-stable consumers attributed this execution to different sessions. |
| `oom-terminated` | A container-based host whose own 512 MiB memory limit was enforced by the kernel's OOM killer rather than by the host itself. core.md 5.2 now fixes this as `terminated` with `error.class: "resource_limit"` — the limit was the host's, whoever performed the stop — where the earlier text supported `failed` just as well. `observes_crossings: "none"`, `unmediated_egress: true`, an empty-but-captured `stderr`, exit code and cgroup detail in `ext`. |

`batch-at-end` doubles as the fixture for one more settled rule: its
`end.outputs.stdout` is an empty-but-present channel next to a non-empty
`stderr`. core.md 5.2 makes that a MUST — a host that captures a channel
emits it on every complete record, empty or not — so in this suite an
absent channel means "this host does not capture it" and nothing else.

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
  The stored value is the record's fields as a consumer reads them
  (including its own `kind`, `host` and `id`), not a re-shaped summary.
  "As a consumer reads them" is core.md 8: an object carrying an unknown
  value in a closed field is absent, so a record whose `end` fails that
  rule is stored without its `end` and counts as a notice, and a `host`
  record with an unknown `observes_crossings` or `crossing_edge` is stored
  without that key. core.md 8 also asks a consumer to *flag* such a line;
  `flagged` is a counter of the consumer's own (`@mocon/core`'s `fold`
  exposes one) and is deliberately not a field of this suite's view, since
  no golden stream can contain the case — a line that triggers it is one
  `check.py validate` rejects, and lives under `invalid/`. `check.py
  invalid` asserts the view behaviour on those fixtures instead.
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
  None of the 26 golden streams exercises this — `check.py` supports it so a
  future fixture or a real stream containing one does not crash the runner.
- **`skipped`.** The count of lines that failed to parse as JSON at all, that
  carry an unknown `kind`, or that have no string `host` — or no string `id`
  on a kind that needs one, since a record a consumer cannot key is one it
  cannot hold (core.md 3). A line with a known kind that fails *schema*
  validation is not one of those things and is out of scope for this counter;
  the golden streams never contain such a line (that is what `invalid/` is
  for). What counts as blank, and what `NaN`, `Infinity` or a byte-order mark
  do, are fixed by core.md 3 rather than by the reading language's own trim
  function, so that two implementations produce the same number; `invalid/`
  carries the `NaN` case.

### Id scope

`executions` and `crossings` are keyed by bare `id`, because core.md 6 scopes
ids to `(host, kind)`, not globally, and no stream in this suite gives two
hosts the same id. A consumer merging multiple hosts into one view MUST key
on `(host, id)` instead, or two different hosts that independently chose the
same id would collide — `@mocon/core`'s `fold` keys on `host + "\0" + id` for
exactly that reason, and a comparison against `expected/` strips the prefix.

This is a property of the *suite's view shape*, not a licence for `check.py`
to be wrong about it. `check.py`'s view builder resolves by `(host, id)` and
raises a named `SuiteScopeError` if two of those keys would project onto one
bare `id`, rather than silently producing an order-dependent answer in which
one of the two records disappears. `two-hosts` is the golden stream that
keeps `check.py permute` honest about more than one host string.

### Conflicts and order

core.md 4.3 requires keeping, of two conflicting complete records, the one
whose canonical JSON (keys sorted, no whitespace) sorts first. That is one
named function, not one choice among content-deterministic functions: a
consumer picking last-sorting instead is content-only and permutation-stable
and still shows a different disposition for the same execution, which is the
interoperability the format exists to provide. core.md 4.4 separately
requires the same view for any permutation of a stream. Because the tie-break
is a pure function of content, not of where a record falls in the file, both
hold together: `check.py`'s view builder (`pick()`) sorts each key's distinct
complete records by canonical JSON and keeps the first, which is why
`check.py permute` passes on `conflicting-resend` even though that stream's
two records arrive in a fixed order on disk. `expected/conflicting-resend.json`
is therefore the one view a conforming consumer produces, not one of several.

Two differing *notices* for one key take the same tie-break and are not a
conflict — core.md 4.3 says so, where it used to say nothing. `check.py`'s
`resolve()` has always applied the same dedupe-then-pick logic to notices as
to completes; that is now what core.md requires rather than an implementation
convenience, and `notice-drift` is the fixture that holds it.

## 4. Running

```sh
cd spec/conformance
pip install -r requirements.txt   # jsonschema + referencing; see below

python3 check.py all        # everything below; exit 0 iff all of it passes
                             # (lint prints, but does not decide the exit code)
python3 check.py validate   # streams/*.jsonl validate against schema/line.json
                             # (jsonschema, if importable) plus the built-in
                             # structural checks (always)
python3 check.py view       # rebuild each stream's canonical view, diff vs expected/
python3 check.py order      # read each stream in file order and check core.md 10's
                             # two ordering MUSTs, which no view can express
python3 check.py permute 5  # shuffle each stream 5x and re-check the view;
                             # also concatenate each stream with itself
python3 check.py invalid    # every invalid/*.jsonl line must fail validation, and
                             # a bad `end` must leave the record unresolved in a view
python3 check.py lint       # provenance.md 7's lint rules, plus end.time >= start,
                             # over streams/*.jsonl (warnings about legal streams;
                             # a clean golden suite should print none)
```

`check.py` imports nothing outside the standard library at module scope, but
`requirements.txt` is a real requirement, not an optimisation: it names the
third-party `jsonschema` package and the `referencing` package it depends on
(for resolving `$ref`s across the schema files without the deprecated
`RefResolver`). Without them `check.py` prints a two-line notice saying the
run was degraded and falls back to the built-in structural checks alone.

The structural checks are written to be independently sufficient: required
keys per kind, the type of every core field, the closed enums,
end-completeness, the Payload rule, the timestamp `Z` suffix, the `hash` and
`spec_version` patterns, and `seq`/`bytes` ranges (core.md 3, 4, 5, 7, 8).
They are not a summary of the schema — they are a second implementation of
the same rules, and `invalid/` is rejected identically on both paths, which
is what the per-fixture output lets you check. Two fixtures are rejected by
the structural path *only*: `hash-with-trailing-newline` and
`timestamp-with-trailing-newline`. That is not a gap in the schema files —
JSON Schema specifies ECMA-262 regular expressions, where `$` matches at the
end of the string — but in python-`jsonschema`, which evaluates `pattern`
with Python `re`, where `$` also matches just before a trailing newline. Every
`$`-anchored pattern in `../schema/` is therefore under-enforced by the Python
schema path; `check.py`'s own patterns anchor with `\Z` instead, and those two
fixtures pin it.

## 5. Producer conformance

An adaptor claims producer conformance, per `host` string (an adaptor
emitting under two host strings with different observability must satisfy
all four points for each one independently), when: (1) `python3 check.py
validate` reports no failures on its emitted stream; (2) `check.py`'s view
builder (or `check.py permute`) reports zero conflicts, where a conflict
means a reused id or a second, differing complete record for a key it
already closed (core.md 6, 10); (3) `check.py order`, run over its emitted
stream, reports no problems: its `host` declaration is the first line that
host string appears on in every stream it opens, re-declared identically or
not at all thereafter, and every crossing it abandons is written before its
execution's complete record (core.md 5.1, 5.3, 10). These are the two
obligations no canonical view can express, because core.md 4.4 requires the
same view for any permutation, which is why they have a command of their own
and are checked against the stream as written; and (4) every
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
  no `streams/*.jsonl` file contains one, since none of the 26 named cases
  calls for it. `check.py view`'s permutation and
  self-concatenation checks would catch a regression here if one were added.
  `invalid/nan-and-infinity` covers the one shape where two parsers plausibly
  disagree about whether a line is a record at all.
- **The emitter in core.md section 13.** It is a worked example inside a
  normative document, not a fixture here, so nothing in this suite runs it.
  It is written to be total — every input produces valid records and none
  makes it throw its own error into the caller — but that is a property of
  the snippet, checked by reading and by running it, not by `check.py`.
