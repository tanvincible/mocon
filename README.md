# mocon

mocon makes code-mode MCP servers debuggable, in the observability stack you already run.

In code mode the agent submits a **program** instead of one structured tool call. The server runs it
in a sandbox, and from inside the program the server's tools are reached through a bridge. From
outside, that whole run is one opaque tool call: the calls the program made, what it passed, what
came back, and whether the server could see any of it are all invisible.

mocon is a set of OpenTelemetry semantic conventions that make it visible, and a small emitter that
implements them. OpenTelemetry is the wire format rather than an export target, so there is no
format here for anyone to learn and no destination of ours to wire.

## Install

**Not published to npm yet.** Today you install from this repository, with a git or `file:` path:

```sh
npm install github:tanvincible/mocon
npm install @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency you install yourself. You also need an OpenTelemetry SDK
and an exporter configured in your application, as for any OpenTelemetry instrumentation. **Without
a registered tracer provider the API is a no-op and nothing is emitted, silently, with exit code
zero.** That is OpenTelemetry's behaviour rather than ours, and it is the single most common way an
integration produces nothing at all.

**No trace pipeline, and no appetite for one?** Pass `logTracer(record => logger.info(record))` and
every span becomes a flat record in the logger you already run: the same vocabulary, the same
provenance labels, the same join key, no SDK and no backend. The same host code moves to real
tracing later by passing a different tracer.

If you do want a trace pipeline, the code change is the small half. [Rolling it
out](https://tanvincible.github.io/mocon/rollout.html) has the order that avoids making the day you
merge worse than the day before: destination first, code last.

## Use

Two wrappers. That is the whole integration.

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

// One: around the handler that runs the program.
return observed.execution.run({ program: source, tool: "execute" }, (execution) => {
  // Two: around the function the sandbox calls to reach you.
  const callTool = execution.instrument(bridge.callTool);
  return runInSandbox(source, { callTool });
});
```

You get one `execute_code` span per dispatch and one `execute_tool` span per call the program made,
correctly parented, in whatever backend you already run.

## What it contributes

OpenTelemetry already models spans, parentage and duration. Three things it has no answer for, and
they are why this exists.

- **Provenance.** A code-mode program is agent-written and can lie, and many hosts build their
  telemetry out of what that program printed. Every value carries its class, so a reader can tell
  what the host observed from what the program claimed. Nothing in OpenTelemetry's data model does
  this.
- **The capability declaration.** Without it, no crossing spans means either the program made no
  calls or the host is blind to them, and those are opposite conclusions.
- **Closed vocabularies.** Four execution dispositions and three crossing outcomes, so a consumer
  can be written once and work everywhere. Span status collapses them to two, which is why the
  attributes are normative and the status is a display hint.

## Documentation

**<https://tanvincible.github.io/mocon>** is the full guide: how to set it up, what the output looks
like, what goes wrong, the API, and the specification.

Build it locally with `npm run docs`, or `npm run docs:serve` to open it.

## Repository

- `spec/otel-code-mode.md` is the specification. It ends with the fifteen things it cannot do and
  the open questions it has not settled.
- `packages/trace` is `@mocon/trace`, the reference emitter, on the OpenTelemetry API only.
- `bench/trace.mjs` measures what it costs against the SDK's own floor.
- `collector/` and `dashboards/` are what turns arriving data into data something understands.
- `docs/` is the mdBook source for the site above.

Status: Development. The conventions are a draft, `code_mode.*` is a namespace this project owns and
nobody else has agreed to, and the `gen_ai.*` and `mcp.*` attributes it reuses are themselves
Development upstream with no compatibility guarantee.

This project previously specified a JSON Lines record format with its own schema, conformance suite
and viewer. It was retired in favour of these conventions; section 14 of the specification records
what that move gave up, and the history is in git.

## License

Licensed under either of the Apache License, Version 2.0 (LICENSE-APACHE) or the MIT license
(LICENSE-MIT), at your option. Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in this work by you shall be dual licensed as above, without any additional
terms or conditions.
