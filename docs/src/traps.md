# Traps

Each of these has actually caught someone, in a real integration, and been found by someone else
running the code rather than reading it.

## No provider means no spans, and no error

If your application has not registered an OpenTelemetry tracer provider, `trace.getTracer` returns a
no-op and every call here does nothing, silently, with exit code zero. Registering one in a test or
a demo script does not count.

This is the single most common way an integration produces nothing, and it decided an entire parity
trial.

## Omitting `kind` is a choice, not an abstention

It defaults to `CLIENT`, which says you forwarded the call to a remote target. If your host serves
the call in its own code, pass `kind: "local"`. Leaving it unset commits you to a claim.

## A bridge with more than two parameters leaks host internals

The default input derivation takes every argument after the target. A bridge shaped
`callTool(name, params, { signal, deadline })` therefore records your own abort signal and deadline
as the program's arguments, and attesting `crossing.input` publishes them as observed fact.

```ts
execution.instrument(bridge.callTool, { input: (_name, params) => params });
```

## Rejected submissions need a span too

An execution starts when the host first observes the dispatch, which includes dispatches it then
refuses for a bad key, a failed lint or being at capacity. Start the span before your first
rejection branch and use `execution.fail(cause, { errorType: "validation" })`. Otherwise the failure
classes an operator most wants to see are absent, in a way that looks like no traffic.

## Activating the span does nothing without a context manager

The emitter puts the execution span in the active context so that *other* instrumentation inside
your dispatch nests under it. With the OpenTelemetry API's default `NoopContextManager` that call
has no effect, and `BasicTracerProvider.register()` installs no manager. `NodeSDK` does.

The spans here are unaffected, because a crossing is given its parent explicitly. Which is exactly
why it is easy to miss: your own trace looks perfect and everything else floats.
