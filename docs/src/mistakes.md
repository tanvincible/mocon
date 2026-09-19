# Common mistakes

Five things that go wrong, roughly in order of how much damage they do.

## Claiming you see everything when you don't

`observes_crossings: "all"` means nothing can answer the program before your wrapper. If your sandbox
refuses calls over a cap, or a deadline guard answers early, or a cache returns without dispatching,
those calls make no span and `"all"` is a lie.

It's the worst one because everything else rests on it, and you can't spot it afterwards from the
data. Four calls, two spans, and a declaration saying two was all of them looks completely normal.

**Fix:** write a program that hits every refusal path you have, and count spans against calls. If
they don't match, you're `"some"`. [Declaring what your server sees](./declaring.md).

## No tracer provider, so nothing comes out

The OpenTelemetry API does nothing when no provider is registered. No spans, no error, no warning,
exit code zero. Registering one in a test or a demo script doesn't count.

**Fix:** grep your own `src/` for `NodeSDK` or `TracerProvider` and make sure you find something
outside a test. Or use [your logger](./logs.md), which needs no provider at all.

## Your bridge doesn't throw, so every failure looks fine

If `callTool` returns `{ ok: false }` instead of throwing, the default reads that as success. Every
failed call gets recorded as working, and the trace looks healthy while your users don't.

**Fix:** the `end` option on `instrument`. See [The two wrappers](./wrappers.md).

## The span starts after your rejection checks

Runs you refuse for a bad key, a failed lint or being at capacity never produce a span at all. The
failure modes you most want to see are the ones that vanish, and they vanish in a way that looks
like nobody called you.

**Fix:** start the run span first, then `execution.fail(cause, { errorType: "validation" })`.

## Leaking your own internals into the program's input

The default treats every argument after the first as the program's input. A bridge shaped
`callTool(name, params, { signal, deadline })` therefore records your abort signal and deadline as
things the program passed, and attesting `crossing.input` publishes that as fact.

**Fix:** `input: (_name, params) => params`.

## Smaller ones

**Leaving `kind` unset is a choice.** It defaults to `client`, which says you forwarded the call
somewhere remote. Pass `kind: "local"` for tools your own process serves.

**No context manager means neighbouring instrumentation floats.** mocon puts the run span in the
active context so other instrumentation nests under it, but that only works if your app registered a
context manager. `NodeSDK` does. A hand-assembled provider doesn't. mocon's own spans are fine either
way, which is exactly why it's easy to miss: your trace looks perfect and everything else drifts off.
