# mocon

OpenTelemetry for code-mode MCP servers.

**Full documentation: <https://tanvincible.github.io/mocon>**

In code mode the agent sends you a program instead of calling one tool. You run it in a sandbox, and
the program calls your tools from inside. From outside, the whole run is one opaque tool call: which
tools it called, what it passed, what came back, none of it recorded.

This gives you one span for the program and one per call it made, in whatever backend you already
run.

## Install

```sh
git clone https://github.com/tanvincible/mocon
cd mocon && npm install && npm run build && npm pack -w @mocon/core && cd ..
npm install ./mocon/mocon-core-0.1.0.tgz @opentelemetry/api
```

Not on npm yet, so it installs from the repo.

## Use

```ts
import { codeMode } from "@mocon/core";

const observed = codeMode({
  capabilities: {
    observes_crossings: "some",
    unmediated_egress: true,
    crossing_edge: "invocation",
    attested: [],
  },
});

return observed.execution.run({ program: source, tool: "execute" }, (execution) => {
  const callTool = execution.instrument(bridge.callTool);
  return runInSandbox(source, { callTool });
});
```

That's the whole integration. Two things to know before you ship it:

**Nothing comes out without a tracer provider.** The OpenTelemetry API silently does nothing if your
app hasn't registered one. No trace backend and don't want one? Pass
`tracer: logTracer(r => logger.info(r))` and every span becomes a flat record in the logger you
already have.

**Those capability values claim almost nothing.** Sharpening them is what makes the data worth
trusting, and it's the one thing that quietly ruins everything else if you get it wrong. See
[Declaring](https://tanvincible.github.io/mocon/declaring.html).

## Docs

| | |
|---|---|
| [Quick start](https://tanvincible.github.io/mocon/quickstart.html) | ten minute setup |
| [Output](https://tanvincible.github.io/mocon/output.html) | the actual output |
| [Mistakes](https://tanvincible.github.io/mocon/mistakes.html) | five things that go wrong |
| [API](https://tanvincible.github.io/mocon/api.html) | every option |
| [Limits](https://tanvincible.github.io/mocon/limits.html) | what it can't do |

Version 0.1.0. Everything can still change.
