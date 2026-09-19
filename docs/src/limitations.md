# What it cannot do

The [specification](./spec.md) ends with seventeen limitations, stated as facts rather than argued
away. These are the ones that will actually affect you.

## A running execution is not in the trace at all

A span is exported when it ends. A dispatch the host never closed is indistinguishable from one that
never happened, so "which run is stuck, and where" is unanswerable until it finishes.

The fix is the host closing it `abandoned` at a later reconciliation, which is work inside your
server. There is no way for a consumer to synthesize it, and it must not try.

This is a real regression against structured logs, which are written as things happen. The
hand-rolled arm that won three trials won partly on exactly this.

## Span status collapses four dispositions into two

Covered in [Closed vocabularies](./vocabularies.md). Every default dashboard, alert and error rate in
every backend reads that field and not the attributes, and most consumers will never be told
otherwise.

## A span's name is a program claim, and standard tooling reads it as fact

On a host that does not attest its targets, the crossing span's name is what the program said it
called. Span-metrics connectors, service maps and span-name-keyed alerting all key on it, and none
of them reads provenance.

[The collector](./collector.md) blocks the metric the conventions themselves recommend. It cannot
block a connector someone else configured from deriving one out of span names.

## There is no representation for "settled, duration unknown"

A span always has two times, therefore always a duration. A call that settled without the host
learning when becomes a zero-duration span rendering as a tick, and no trace viewer reads the
attribute that says so.

## Attestation is a claim, not proof

Nothing in a trace distinguishes a host reading its own call boundary from a host copying a value out
of the program's return and attesting it anyway. Detecting that needs a second observer in the path,
under its own identity. No format detects it.

## A closed vocabulary cannot be extended by a host

Covered in [Closed vocabularies](./vocabularies.md). It is the price of a consumer being writable
once, and it is not resolved.

## Nothing here is upstream

`code_mode.*` is a namespace this project owns and nobody else has agreed to. The `gen_ai.*` and
`mcp.*` attributes it reuses are Development with no compatibility guarantee, and
`gen_ai.operation.name = execute_code` is not an upstream value, so a consumer filtering on known
operation names does not see code-mode executions at all.

## Things outside instrumentation's reach

Sampling can drop part of a trace, so a missing call can mean sampled rather than not observed. A
parent-based sampler keeps a run together, and that is a recommendation to the application owner
rather than something a host can enforce.

The SDK's attribute length limit truncates after the emitter has recorded what it did, so a value the
host captured whole can arrive shortened with nothing saying so.
