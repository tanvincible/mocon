# Wrappers

## The run

```ts
observed.execution.run({ program: source, tool: "execute" }, async (execution) => {
  // your existing handler body
});
```

**Start it before your first rejection.** A run starts when you first see the submission, including
ones you then refuse for a bad key, a failed lint, or being at capacity. If you start the span after
those checks, every refused run is invisible, and an outage that rejects everything looks exactly
like no traffic.

For a refusal, end it on purpose:

```ts
execution.fail(new Error("unknown tool in script"), { errorType: "validation" });
```

**If your handler returns a failure object instead of throwing**, say so, or every failed run gets
recorded as a success:

```ts
observed.execution.run(
  {
    program: source,
    end: (value) => (value.ok ? undefined : { disposition: "failed", errorType: "runtime" }),
  },
  body,
);
```

Return `undefined` from `end` to mean "just use the default".

## The bridge

```ts
const callTool = execution.instrument(bridge.callTool);
```

**Wrap the outermost function the program can reach.** If your sandbox gets a function that calls
another one that then dispatches, wrap the one the sandbox holds. Anything above your wrapper that
can answer the program produces no span at all.

**It has to be your code, outside the sandbox.** A function the program can reach, swap out or watch
is just another thing the program controls. If yours is reachable from inside, your telemetry says
whatever the program wants.

**No function to wrap?** If your sandbox runs somewhere else and reports back, see
[No bridge](./no-bridge.md). You record the calls yourself and get the same spans.

### Envelopes

Lots of bridges return `{ ok: false, error }` instead of throwing. mocon reads a normal return as
success, so on a bridge like that every failure gets quietly recorded as working. One option fixes
it. Return only what you want changed: everything you leave out is filled in from what the bridge
actually answered, so the envelope still lands on the span as the reason.

```ts
const callTool = execution.instrument(bridge.callTool, {
  end: (answer) =>
    !answer.threw && !answer.value.ok
      ? { outcome: "error", errorType: "capability_error", dispatched: true }
      : undefined,
});
```

### Extra arguments

By default the first argument is the target and everything after it is the input. So a bridge shaped
`callTool(name, params, { signal, deadline })` ends up recording your own abort signal and deadline as
the program's arguments. Tell it what the input really is:

```ts
execution.instrument(bridge.callTool, { input: (_name, params) => params });
```

### Local calls

Span kind defaults to `client`, which says you forwarded the call somewhere remote. For a tool your
own process serves, say so:

```ts
execution.crossing.start({ target: "cache_get", kind: "local" });
```

## By hand

`instrument` covers the normal case. When you need more control, open and close a call yourself:

```ts
const crossing = execution.crossing.start({ target: "inventory_search", input: params });
try {
  const result = await dispatch(params);
  crossing.output(result, { dispatched: true });
} catch (e) {
  crossing.error(e, { errorType: "capability_error", dispatched: true });
}
```

A call you never close gets closed for you as `abandoned` when the run ends, so nothing dangles.
