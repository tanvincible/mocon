# Limits

Things this genuinely can't do. Worth knowing before you rely on it.

## A run in progress isn't in the trace

A span only exports when it ends. So a run that's still going, or one that hung, isn't there at all,
and it looks exactly like a run that never happened.

"Which run is stuck right now" is not a question you can answer this way. If you need that, close
long-running work as `abandoned` on a timer in your own server, or emit a log line at start.

This is a real step back from plain logging, which writes things as they happen.

## Status can't hold four outcomes

Span status has three values and instrumentation shouldn't set `ok`, so in practice you get two.
`completed` and `abandoned` both look unset. `failed` and `terminated` both look like errors.

Every default dashboard reads that field. Yours needs to read
`code_mode.execution.disposition` instead, which is what the [dashboard](./dashboard.md) does.

## A span's name can be a program claim

If you don't attest `crossing.target`, the call span's name is whatever the program said it called.
Span-metrics tools, service maps and name-keyed alerts all key on span names, and none of them read
provenance.

[The collector](./collector.md) blocks the metrics mocon defines from doing this. It can't stop a
connector somebody else configured.

## No way to say "it finished, I don't know when"

A span always has a start and an end, so it always has a duration. A call you know settled but can't
time becomes a zero-duration span rendering as a tick. There's an attribute saying so, and no trace
viewer reads it.

## Attesting is a claim, not proof

Nothing in a trace can tell apart a server genuinely watching its call boundary from one copying a
value out of the program's return and attesting it anyway. Catching that needs a second observer in
the path under its own identity. No format does it.

## A fixed vocabulary can't be extended

You can add a field next to a disposition. You can't add a value to it, and a reader following the
rules treats the fixed value as the real answer.

The case that bites: a run that pauses at the end of one dispatch and picks up in a later one. Each
dispatch is its own run, so the paused one reports `completed`, and one logical run looks like three
completed ones.

## Things outside a library's reach

**Sampling** can drop part of a trace, so a missing call might mean sampled rather than never
happened. Use a parent-based sampler.

**Attribute length limits** in the SDK cut values after mocon has already recorded what it did, so
something captured whole can arrive shortened with nothing saying so. Set your own cap lower.

## None of this is standard yet

`code_mode.*` is this project's own namespace and nobody else has agreed to it. The `gen_ai.*` and
`mcp.*` attributes it reuses are still in development upstream with no compatibility promise, and
`gen_ai.operation.name = execute_code` isn't an upstream value, so anything filtering on known
operation names won't see these runs at all.
