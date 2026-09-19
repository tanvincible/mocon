# @mocon/adapter-mastra

mocon records into Mastra's span tree, instead of a file.

A Mastra host that adopts mocon and writes it to `mocon.jsonl` has swapped its observability for a
file nothing in the framework reads: the exporters already wired into it — Langfuse, Datadog,
Sentry, Braintrust, Arize, LangSmith, Laminar, PostHog and the rest — all consume the span tree, and
they never see that file. This package is the one function that fixes that. Every record becomes a
span under the span the host already has, so adopting mocon adds to what a team already sees rather
than moving it somewhere they do not look.

Zero runtime dependencies. `@mastra/core` is a peer dependency and nothing here imports it: the span
is typed structurally, so the package builds, tests and ships on its own and works against any
Mastra whose span carries `createChildSpan`, `end` and `error`.

## Wiring it

One line inside the code-mode tool, where the host already holds its span:

```ts
import { mocon } from "@mocon/core";
import { mastraSink } from "@mocon/adapter-mastra";

execute: async ({ code }, ctx) => {
  const m = mocon({
    host: "mastra/code-mode",
    capabilities: { observes_crossings: "all", crossing_edge: "invocation", unmediated_egress: true },
    sinks: [mastraSink(ctx.tracingContext?.currentSpan)],
  });

  return m.execution.run({ program: code, language: "typescript" }, (ex) => {
    const dispatch = ex.instrument(rawDispatch); // the closure every transport crosses back through
    return transport.run({ ...options, dispatch });
  });
};
```

`mastraSink` is null-safe the way `createToolObserve` is: no span, or a no-op span, and it drops
everything and costs the host nothing. It holds the host declaration and the execution span it has
open, and nothing else — no registry, no timer, no buffer. One sink serves one dispatch; build it
where the span is.

## What lands where

| record | span |
|---|---|
| `execution` | a `GENERIC` child named `mocon.execution`, `input` the program, `output` the result |
| `crossing` | a `TOOL_CALL` child of that, named `tool: '<target>'`, `input` and `output` the crossing's |
| `host` | no span; it fills the `mocon.host.*` fields and the provenance labels |

Every other field is **span metadata**, under its `spec/otel-mapping.md` name:
`mocon.crossing.target`, `mocon.crossing.seq`, `mocon.crossing.outcome`, `mocon.execution.disposition`,
`mocon.program.hash`, `mocon.execution.outputs.<channel>.value`, `mocon.ext.<key>`,
`mocon.provenance.<field>`, and the rest.

Metadata, not attributes, because that is the difference between a field an exporter forwards and a
field it drops. Mastra's `attributes` are typed per span type and each exporter reads only the keys
it knows; `metadata` is passed through whole — the OTel exporter writes every key as
`mastra.metadata.<key>`, Braintrust spreads it, Sentry sets each as an attribute, PostHog carries it
as custom metadata. So each mocon field arrives as its own named, faceted field rather than one blob.
The span's `attributes` carry only the three Mastra-native ones a tool call needs: `toolType`,
`toolCallId` and `success`.

A crossing is a `TOOL_CALL` span for the same reason: it is the shape the framework's own conversion
already understands. `entityName` becomes `gen_ai.tool.name`, `toolCallId` becomes
`gen_ai.tool.call.id`, and the span's `input` and `output` become `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result` — the attributes `otel-mapping.md` 7.2 names, produced by Mastra rather
than by this package.

## Where it differs from `spec/otel-mapping.md`

The mapping is written for a stateless sink producing OTLP spans. A Mastra span is a live object in a
tree the host already owns, and that forces five differences. Everything else — the attribute names,
the Payload envelope, the status rules, the provenance labels, the timing table — is as written.

1. **An execution's start notice opens the span.** Section 3 drops every line without `end`. A child
   span needs a parent that exists, and a crossing settles before its execution does, so the
   execution's notice opens the span and its complete record settles it. A crossing without `end` is
   still dropped.
2. **Mastra mints the ids.** Section 4's derivation does not apply: the span tree already has a trace
   id, and the parent span is the caller's. The record's own ids ride as `mocon.execution.id` and
   `mocon.crossing.id`, and `context.traceparent` is carried verbatim rather than used to reparent.
3. **Payload values go in the span's own `input` and `output`.** `mocon.program.value`,
   `mocon.crossing.input.value`, `mocon.crossing.output.value` and `mocon.execution.result.value` are
   the span's native slots, which is what makes an exporter render them as a tool call's arguments
   and result. Their `truncated`, `redacted`, `bytes` and `hash` stay named as the mapping has them,
   and their provenance labels still name the field. The two error Payloads keep their
   `mocon.<kind>.error.value.value` name, because a span has nowhere else to put the raw error the
   host captured — Mastra's own `errorInfo` holds only a message, a name and a stack.
4. **A crossing span is named `tool: '<target>'`,** Mastra's tool-span convention, not the bare
   `target` of section 7. The uncut target is in `mocon.crossing.target`.
5. **The span's end time is the sink's.** `createChildSpan` takes a `startTime`, so a span begins
   where the record says; `end()` takes no time and stamps now. The sink runs inline at the settle
   point, so the difference is one emitter write. `mocon.crossing.timing` still reports which host
   times were missing.

Three smaller notes. Section 14's metrics need a metrics endpoint; this is a trace-only sink, so it
emits none and the declared values ride their span, which is what that section asks for. Section 9's
size cap is not applied here, because `@mocon/core` already caps at capture. And a second host
declaration is ignored rather than resolved by canonical sort: one sink serves one dispatch, so the
case is a re-send.

One thing to expect that the mapping does not describe: Mastra copies a parent's metadata onto its
children, so a crossing span also carries the execution's `mocon.host.*` and `mocon.program.*`. That
is more than section 6.2 puts on a crossing span, never less.

## Tests

`npm test` runs the unit tests against a recording span. The integration proof — a real code-mode
execution in a Mastra checkout, with a real `ObservabilityExporter` behind it — lives with that
checkout; see the repository's report for what the exporter received.
