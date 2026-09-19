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
    observes_crossings: "all",   // every call through our bridge is recorded
    unmediated_egress: false,    // the program has no path out we cannot see
    crossing_edge: "invocation", // spans describe what the program asked for
    attested: ["crossing.target", "crossing.input", "crossing.output"],
  },
});

// Wrapper one: around the handler that runs the program.
return observed.execution.run({ program: source, tool: "execute" }, (execution) => {
  // Wrapper two: around the function the sandbox calls to reach you.
  const callTool = execution.instrument(bridge.callTool);
  return runInSandbox(source, { callTool });
});
```

That is the whole integration. You get one `execute_code` span per dispatch and one `execute_tool`
span per call the program made, correctly parented, in whatever backend you already run.

## The capability declaration

Five attributes on every span say what your server can and cannot see. They are required because
without them an absence of crossing spans reads two ways a consumer cannot tell apart: the program
made no calls, or your server is blind to the calls it made. Declare the weakest values that are
true for every dispatch. Silence is read as `none`.

## Provenance

A code-mode program is agent-written and can lie. If you build telemetry out of something the
program printed, the program chooses what your trace says.

`attested` is how you say which fields your server actually observed rather than took from the
program. Everything you do not attest is read as a program claim, so forgetting something
under-claims rather than over-claims. Attest only what is true for **every** span you emit.

Two rules that are not optional:

- **Context flows into the sandbox, never out.** Never accept trace context the program supplies,
  or it chooses where its execution appears in the trace, including inside another tenant's.
- **Wrapper two must be host code, outside the sandbox.** A wrapper the program can reach or replace
  is a channel the program writes through, and a server in that position should attest nothing.

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
