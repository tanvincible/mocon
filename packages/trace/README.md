# @mocon/trace

Makes a code-mode MCP server's executions visible in OpenTelemetry.

A code-mode server is one where the agent submits a program instead of one structured tool call.
The server runs it in a sandbox, and from inside the program the server's tools are reached through
a bridge. From outside, that whole run is one opaque tool call: the calls the program made, what it
passed, what came back, and whether the server could see any of it are all invisible.

This package emits two spans that make it visible, following
[the code-mode semantic conventions](../../spec/otel-code-mode.md). It depends on the OpenTelemetry
**API** and never the SDK, which is OpenTelemetry's own rule for instrumentation and the reason it
is worth using: you emit through the API, and whatever exporters the application owner already
configured receive it. There is no destination of ours to wire.

## Two wrappers

```ts
import { codeMode } from "@mocon/trace";

const observed = codeMode({
  capabilities: {
    // Start here and earn your way up. Read "Declaring honestly" below before changing it.
    observes_crossings: "some",
    unmediated_egress: true,
    crossing_edge: "invocation",
    attested: [],
  },
});

// Wrapper one: around the handler that runs the program.
return observed.execution.run({ program: source, tool: "execute" }, (execution) => {
  // Wrapper two: around the OUTERMOST function the program can reach.
  const callTool = execution.instrument(bridge.callTool);
  return runInSandbox(source, { callTool });
});
```

That is the whole integration. You get one `execute_code` span per dispatch and one `execute_tool`
span per call the program made, correctly parented, in whatever backend you already run.

## Declaring honestly

This is the part that goes wrong, and it goes wrong in the direction that does the most damage.
Everything else on the span is conditional on this declaration, and it is the one claim this library
cannot check for you.

**`observes_crossings: "all"` means nothing answers the program before your wrapper.** Not "my
wrapper sees every call that reaches it". Before you claim it, go and look for code that answers the
program itself: a rate limiter, a call-count cap, a deadline guard, a cache, a permission check. If
any of those can return to the program without passing through the function you wrapped, then some
calls produce no span, and `"all"` is false.

That mistake is easy to make and impossible to see afterwards. A real integration of this library
declared `"all"` on a host whose sandbox refuses calls over a cap before the bridge is reached. Four
calls, two spans, and a declaration saying two was all of them.

The test, concretely: instrument, then make the program hit every refusal path you have, and count.
If the spans do not match the calls, you are `"some"`.

**Attest nothing you derive from something the program wrote.** If your error class is computed
partly from a thrown value's name or message, a program can choose it. A host with both an observed
path and a parsed path for the same field does not attest that field. The same integration attested
its error class, and a program throwing a specially named error published its own choice as
host-observed fact.

Declare the weakest values true for every dispatch. Silence reads as `none`, which is safe.

## Provenance

A code-mode program is agent-written and can lie. If you build telemetry out of something the
program printed, the program chooses what your trace says.

`attested` is how you say which fields your server actually observed rather than took from the
program. Everything you do not attest is read as a program claim, so forgetting something
under-claims rather than over-claims. Attest only what is true for **every** span you emit.

Your own attributes are program claims too, until you say otherwise. Two lists say which:

```ts
capabilities: {
  // ...
  attested: ["crossing.target", "host_attributes"],
  attested_attributes: ["com.acme.sandbox_id"],   // you measured these
  relayed_attributes: ["com.acme.credits_used"],  // a target reported these
}
```

The second list matters more than it looks. A credit count your API returned is not something you
measured, so attesting it is a lie, and leaving it unlisted makes it a program claim and bars you
from summing it into a cost metric. Naming it as relayed is the honest option, and the only one that
gets you a billing number you can defend.

Two rules that are not optional:

- **Context flows into the sandbox, never out.** Never accept trace context the program supplies,
  or it chooses where its execution appears in the trace, including inside another tenant's.
- **Wrapper two must be host code, outside the sandbox.** A wrapper the program can reach or replace
  is a channel the program writes through, and a server in that position should attest nothing.

## Four traps, each of which has actually caught someone

**1. No provider means no spans, and no error.** If your application has not registered an
OpenTelemetry tracer provider, `trace.getTracer` returns a no-op and every call here does nothing,
silently, with exit code zero. Registering one in a test or a demo script does not count. Grep your
own `src/` for `NodeSDK` or `TracerProvider` and make sure you find something.

**2. Omitting `kind` on a crossing is a choice, not an abstention.** It defaults to `CLIENT`, which
says you forwarded the call to a remote target. If your host serves the call in its own code, pass
`kind: "local"`.

**3. A bridge with more than two parameters leaks host internals into the input.** The default takes
every argument after the target, so a bridge shaped `callTool(name, params, { signal, deadline })`
records your own abort signal and deadline as the program's arguments, and attesting
`crossing.input` then publishes them as observed fact. Pass `input: (_name, params) => params`.

**4. Rejected submissions need a span too.** An execution starts when the host first observes the
dispatch, which includes dispatches it then refuses for a bad key, a failed lint or being at
capacity. Start the span before your first rejection branch and use `execution.fail(cause, {
errorType: "validation" })`, or those runs are invisible in a way that looks like no traffic.

**Also worth knowing:** register a context manager, or use `NodeSDK` which does it for you.
Without one, *other* instrumentation running inside your dispatch will not nest under the execution
span. The spans here are unaffected, because a crossing is given its parent explicitly, which is
exactly why it is easy to miss: your own trace looks perfect and everything else floats.

## Payload capture

Program text, call arguments and call results are **opt-in**, because they are agent-written code
and customer data:

```ts
codeMode({ capabilities, capture: { values: true, cap: 8192 } });
```

The program's hash is always written, so two dispatches of the same text still match when the text
itself is withheld. Whatever the emitter shortens or removes is recorded in `code_mode.capture`,
because OpenTelemetry has no way to say a value on a record was cut.

## Cost

About 5 microseconds per span on top of what the OpenTelemetry SDK itself costs, and about 8 with
payload capture on and kilobyte-sized values. Measure it yourself with `node bench/trace.mjs`. An
execution runs a whole program and a crossing is usually a network call, so this sits several
orders of magnitude below the work it describes. The emitter retains nothing between executions.

One trap, because it will look like ours: **`SimpleSpanProcessor` retains every span it exports**,
roughly a kilobyte each, so a load test wired to it grows without bound and eventually exhausts the
heap. That is the processor, not this package, and OpenTelemetry documents it for debugging rather
than production. Use `BatchSpanProcessor`.

## What this cannot do

Read section 16 of the conventions for the full list. The two that bite most:

- **Span status collapses four dispositions into two.** A completed execution and an abandoned one
  are both `Unset`. Read `code_mode.execution.disposition`, not the status.
- **An execution that never ends is not in the trace at all**, and is indistinguishable from one
  that never happened. Close it `abandoned` at a later reconciliation; that is your job, not a
  consumer's.

## Status

Development, version 0.1.0. The conventions it implements are a draft, and the `gen_ai.*` and
`mcp.*` attributes it reuses are themselves Development upstream with no compatibility guarantee.
