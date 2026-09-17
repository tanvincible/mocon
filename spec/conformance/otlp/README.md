# mocon OTLP conformance fixtures

Status: draft 1.0, 2026-09-17. Companion to `../../otel-mapping.md`, which is
the normative source for everything in this directory. Where this file and
`otel-mapping.md` disagree, `otel-mapping.md` wins.

## 1. What this is

`../streams/` holds 23 golden mocon streams. `../expected/` holds, for each
one, the canonical view a stateful mocon consumer builds from it (core.md
section 4's supersede rule applied once per key). Neither of those is an
OTLP export. `../README.md` section 6 says so directly: "OpenTelemetry
export ... is a separate concern with its own normative document."

This directory is that separate concern. Each file here is the literal
OTLP `ExportTraceServiceRequest` JSON a conforming stateless sink emits for
one golden stream, built attribute by attribute from `otel-mapping.md`. It
currently covers 3 of the 23 streams:

| file | stream | what it exercises |
|---|---|---|
| `sync-bridge.json` | `../streams/sync-bridge.jsonl` | The base case: same general shape as `../README.md`'s `sync-bridge` entry: the start notice is dropped, and the host's partial `attested` list (`crossing.target`/`crossing.input` only) leaves the crossing output and `ext` credits labeled `P`. |
| `unresolved.json` | `../streams/unresolved.jsonl` | A stream whose only execution never resolves. Zero spans, ever. |
| `no-timing-blob-ref.json` | `../streams/no-timing-blob-ref.jsonl` | Crossings with neither `seq` nor any timing at all, so the sink synthesizes zero-duration spans and flags them with `mocon.crossing.timing`. |

The other 20 golden streams (13 from the original set, plus 7 added later)
do not yet have OTLP fixtures here. Adding one means repeating the method
in section 3 below against `otel-mapping.md`, not inventing a new one.

## 2. The `_note` key

Every file whose OTLP output needs explanation carries a top-level
`_note` string. It is not part of the OTLP `ExportTraceServiceRequest`
schema and no sink under test is expected to produce it. It exists only so
that a reader of this fixture, or an implementer building a checker
against it, can see why the file looks the way it does without cross
referencing this README for every line. `sync-bridge.json` carries a
`_note` explaining why `mocon.provenance.ext.p` lists both `ext` keys
present on the execution span; every other field in it maps by the
ordinary rule in `otel-mapping.md`.

## 3. Checking a sink against these files

1. **Run the sink.** Feed the sink under test the corresponding
   `../streams/<name>.jsonl` and capture the `ExportTraceServiceRequest`
   JSON it produces (or would produce, for a sink that does not literally
   speak OTLP JSON but can be made to serialize one for testing).

2. **Canonicalize both sides.** Parse each side as JSON and reduce it to
   one deterministic form:
   - Drop every `_note` key, at any depth. It is documentation, not data,
     per section 2 above.
   - Recursively sort every JSON object's keys.
   - Sort the `resourceSpans` array by its resource's `service.name`
     attribute value, the `scopeSpans` array within each by `scope.name`,
     and the `spans` array within each by `spanId`.
   - Sort each span's `attributes` array by `key`.

   The last two steps matter because nothing in `core.md` or
   `otel-mapping.md` gives array order meaning here. `otel-mapping.md`
   Appendix A says it directly for spans: "The spans are listed in the
   order the lines arrived... a backend assembles the tree from ids, not
   from order." The same reasoning extends to `resourceSpans`,
   `scopeSpans` and each span's `attributes`: a sink that reads a stream
   in a different order, or that builds attributes from an internal map,
   produces the same spans with the same fields, just not necessarily in
   the same array positions. Sorting before comparing removes that
   difference so the check is about content, not iteration order. This is
   this checker's own method, not a rule `otel-mapping.md` states; a
   checker is free to compare unsorted and require the sink to match this
   file's literal array order instead, which is also legitimate but
   stricter than anything in either normative document requires.

3. **Compare.** The two canonicalized values MUST be structurally equal:
   same keys, same values, same types (an `intValue` string must match an
   `intValue` string, not a numeric `5` some serializer coerced it to).
   Any difference is a nonconformance and should be reported with the
   JSON pointer or path to the first field that differs.

4. **The one documented exception.** `no-timing-blob-ref.json`'s two
   crossing spans (`list_tools`, `render_chart`) have neither `start` nor
   `end.time` in the source stream. `otel-mapping.md` section 7.3 says a
   sink facing that fills both the span's start and its end with its own
   receipt time for that line and sets `mocon.crossing.timing` to `"none"`.
   That receipt time is the sink's wall clock at the moment it happened to
   process the line. It is not reproducible and not specified by either
   normative document, so a real conforming sink will not produce the
   exact constant this fixture used (`2026-09-16T16:05:00.000Z`,
   `1789574700000000000` unix nanoseconds, explained in the file's
   `_note`). A checker comparing against `no-timing-blob-ref.json`:
   - MUST NOT require `startTimeUnixNano` or `endTimeUnixNano` on those
     two spans to equal the literal value in this file.
   - MUST still require, on each of those two spans, that
     `startTimeUnixNano` equals `endTimeUnixNano` (the span is
     zero-duration, as `otel-mapping.md` section 7.3 requires for a
     synthesized time) and that the `mocon.crossing.timing` attribute is
     present with value `"none"`.
   - MUST require every other field on those two spans, and every field
     on every other span in the file, including the execution span's
     `startTimeUnixNano`/`endTimeUnixNano` (copied from the stream's
     host-clock `start`/`end.time`, which are ordinary required fields
     and do match exactly), to compare equal in the normal way.

   No other file and no other field carries this exception.
   `sync-bridge.json`'s crossing timestamps are host-clock values copied
   from the stream and are required to match exactly, same as everything
   else in `sync-bridge.json` and `unresolved.json`.

## 4. Why `unresolved.json` has an empty `resourceSpans`

Not the exception in section 3 item 4; it needs no special checker
handling. See `unresolved.json`'s own `_note` for the full chain (core.md
section 4 rules 2/5/7, otel-mapping.md section 3's "Unresolved executions"
paragraph, and otel-mapping.md section 12 on the host line producing no
span). An empty array compares equal only to another empty array.

## 5. What this directory does not cover

- **Sink behavior this format does not fix.** `otel-mapping.md` section 9
  lets a sink cap string attribute length and section 11 lets it choose
  `service.name` freely as long as `mocon.host` is still present on every
  span. None of these three fixtures exercises a capped value, so a sink
  that caps differently from here on a stream these fixtures do not cover
  is not thereby nonconformant; only exact disagreement on one of these
  three exact streams, outside the exception in section 3.4, is.
- **The other 20 golden streams**, per section 1.
- **`../invalid/*.jsonl`.** Those lines are not legal mocon to begin with;
  nothing here says what OTLP a sink should produce for them, because
  `otel-mapping.md` section 3 has the sink skip and count a line that
  fails the checks `../invalid/` exercises, the same as a malformed line.
