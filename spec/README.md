# mocon specification

Status: draft 1.0, 2026-09-17. Not yet stable. Additive changes only once marked 1.0. If this file and the normative files ever disagree, `core.md` and `provenance.md` win.

## What mocon is

mocon is a record format that makes a code-mode MCP execution visible: that a program ran, and how many times control crossed between the program and the host while it ran (`core.md` section 1). The format is stateless: every line is a complete record or an optional start notice, and a complete record supersedes any start notice with the same key regardless of arrival order (`core.md` section 4).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY in every file under `spec/` are to be interpreted as described in RFC 2119.

## File index

- `core.md` — normative. The wire format, the reserved top-level keys, complete records and start notices and the supersede rule, the three record kinds (`host`, `execution`, `crossing`) with the `Payload` and `Error` shared types, id uniqueness rules and the derivation to OpenTelemetry ids for sinks, timestamp rules, the closed and open enum policy, emitter obligations, and versioning.
- `provenance.md` — normative, companion to `core.md`. The three provenance classes (host-observed, program-determined, target-relayed), the field-by-field provenance table, the closed `attested` list a host can use to upgrade specific fields, and the rules a consumer applies when displaying, aggregating, or handing records to a language model.
- `vocabulary.md` — non-normative. Recommended values for the fields `core.md` leaves as open sets: `error.class`, output channel names, `language`, `ext` namespaces.
- `otel-mapping.md` — normative for sinks. Worked guidance for a sink applying the OpenTelemetry id derivation and export rules that `core.md` section 6 already states normatively, plus the export shape for every core field and the provenance labels a sink writes as attributes.
- `schema/` — JSON Schema for the wire format. `line.json` validates the reserved envelope (`kind`, `host`, `id`, `ext`) every line carries; the per-kind files validate the `host`, `execution`, and `crossing` record bodies against `core.md` section 5.
- `extensions/README.md` — how an extension adds a record kind or field that core consumers can ignore, per `core.md` section 11.
- `extensions/events.md` — the `event` kind, the first extension named in `core.md` section 11.
- `conformance/README.md` — normative for the term "producer conformant." How to run the conformance suite and what each conformance level below requires.
- `conformance/streams/` — example mocon streams used as conformance input.
- `conformance/expected/` — the parsed view each stream in `streams/` must produce, for consumer conformance.
- `conformance/invalid/` — lines a producer MUST NOT emit; `check.py invalid` proves the schema and structural checks reject them. A consumer that receives one anyway applies `core.md` section 8 (treat the offending object as absent) or section 3 (skip a line that is not a JSON object or carries a `kind` it does not know).
- `conformance/otlp/` — expected OpenTelemetry export for sink conformance against the id derivation in `core.md` section 6.
- `conformance/check.py` — the conformance test runner: `validate | view | order | permute [N] | invalid | lint | all`.
- `conformance/requirements.txt` — what `check.py` needs for its full run. Without it the schema pass is skipped and the run says so.

## Conformance levels

mocon defines three conformance levels. An implementation can claim any subset of them.

- **Producer.** Emits valid mocon lines and obeys the emitter obligations in `core.md` section 10; the checklist is `conformance/README.md` section 5.
- **Consumer.** Applies the supersede rule order-independently, per `core.md` section 4, and the provenance display, aggregation and hand-to-model rules in `provenance.md` section 5.
- **Sink.** Derives OpenTelemetry ids per `core.md` section 6 and is stateless per `core.md` section 4 rule 7: one complete line, one span, log line or row; start notices dropped.

## Reading this if you are writing an adaptor

Read `core.md` sections 3 to 5 first: the wire format, the whole-record and start-notice rule, and the three record kinds. Then read section 13, an emitter with no library dependency, in plain JavaScript, for a host with an `execute({code})` tool and a `callTool` bridge. It is the shape of a conforming producer, and it is written so that no input makes it emit an invalid line or throw its own error into the caller; what it leaves to the host is marked in the snippet. It is not a conformance fixture, and nothing in `conformance/` runs it — the thing to check your own adaptor against is `conformance/README.md` section 5, which names the four commands.
