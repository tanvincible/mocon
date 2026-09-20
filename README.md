<p align="center">
  <img src="./docs/src/assets/logo.svg" width="76" height="76" alt="mocon">
</p>

<h1 align="center">mocon</h1>

<p align="center"><strong>OpenTelemetry for code-mode MCP servers.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tanvincible/mocon"><img src="https://img.shields.io/npm/v/@tanvincible/mocon?color=0891b2&label=npm" alt="npm"></a>
  <a href="https://tanvincible.github.io/mocon"><img src="https://img.shields.io/badge/docs-tanvincible.github.io%2Fmocon-0891b2" alt="Documentation"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-0891b2" alt="MIT OR Apache--2.0"></a>
</p>

mocon is a set of OpenTelemetry attributes for servers that run agent-written programs, and a small
emitter for them in TypeScript and Python.

It is an attempt to make a code-mode run observable in the stack you already have, rather than
something every server ends up logging its own way.

This project is early. The specification is a draft. Attribute names will change.

## Overview

In code mode the agent does not call your tools.

It sends you a program. You run it in a sandbox, and the program calls your tools from inside.

From the outside, that whole run is one tool call. Which tools it used, what it passed, what came
back, how long each took, whether any of it failed: none of it is recorded.

OpenTelemetry already has spans, parentage and duration, so most of the shape exists. What it has no
answer for is:

* whether the host saw a call, or is repeating what the program said about it
* whether no calls recorded means no calls happened, or means the host is blind
* what to call the four ways a run can end

mocon is those three things written down, plus the code that emits them.

<p align="center">
  <img src="./docs/src/assets/demo.svg" alt="A code-mode run traced: an execute_code span, four execute_tool spans with their arguments and results, a 16kB result truncated with its real size and hash, and a declined payment" width="880">
</p>

An order failed, and the trace says why, with nobody adding a log line.

That is a real run of `examples/server.mjs`, a whole code-mode server with a sandbox in it. The
durations are what its tools took. The 16 kB search result did not fit on a span, so it was cut at
96 bytes and the note carries the real size and a hash of the whole value.

## Core idea

Two spans.

* **execution**, one per program you run
* **crossing**, one per call that program made back to you

Then one rule about every value on them:

> a reader must be able to tell what the host observed from what the program claimed

A code-mode program is written by a model and can say anything. Plenty of hosts build their
telemetry out of what that program printed. So each value carries its class, and the host declares
up front how much it can actually see.

## Install

```sh
npm install @tanvincible/mocon @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency, so you choose the version.

Python is not on PyPI yet. For now it comes from a clone:

```sh
git clone https://github.com/tanvincible/mocon
pip install ./mocon/packages/python
```

The distribution will be `pymocon`, because `mocon` on PyPI is an unrelated project. The import is
`mocon` either way.

## Use

Two wrappers. That is the whole integration.

```ts
import { codeMode } from "@tanvincible/mocon";

const observed = codeMode({
  capabilities: {
    observes_crossings: "all",   // every call the program makes comes through our bridge
    unmediated_egress: false,    // and it has no other way out
    crossing_edge: "invocation", // spans describe what the program asked for
    attested: ["crossing.target", "crossing.input", "crossing.output"],
  },
});

// One: around the handler that runs a submitted program.
return observed.execution.run({ program: source, tool: "execute" }, (execution) => {
  // Two: around the function you give the sandbox to reach you.
  const callTool = execution.instrument(bridge.callTool);
  return runInSandbox(source, { callTool });
});
```

Python is the same shape, with a context manager:

```python
from mocon import CodeMode, Capabilities

observed = CodeMode(Capabilities(observes_crossings="all", unmediated_egress=False,
                                 crossing_edge="invocation", attested=["crossing.target"]))

with observed.execution(program=source, tool="execute") as execution:
    call_tool = execution.instrument(bridge.call_tool)
    return run_in_sandbox(source, call_tool)
```

Both emit the same names and the same values. A harness runs one scenario through each and diffs
every attribute, so that is checked rather than claimed.

## Output

Three signals, each inert until your application configures a provider for it:

* **traces**, one `execute_code` span per run and one `execute_tool` span per call
* **metrics**, two duration histograms
* **logs**, a record when a run starts and another when it ends

No trace pipeline, and no appetite for one? Pass `logTracer(record => logger.info(record))` and each
span becomes a flat record in the logger you already run. Same attributes, same join key, no SDK and
no backend. Moving to real tracing later is a different tracer, not different host code.

One thing to know before you start.

mocon emits through the OpenTelemetry API and never the SDK. If nothing in your application
registers a tracer provider, the API does nothing. No spans, no error, exit code zero. That is
OpenTelemetry's own behaviour, and it is the most common reason a first integration looks dead.

## Design principles

- **Nothing of ours on the wire**  
OpenTelemetry is the format, not an export target. There is no schema to learn and no destination of
ours to configure.

- **Absence must not lie**  
A missing span should never read as a fact. A host that cannot see something says so, and forgetting
to declare something under-claims rather than over-claims.

- **The emitter never fails the request**  
Every value it touches was written by a model. A hostile one costs you that value, never the call.

- **Payloads are off by default**  
Arguments and results are agent-written code and target data. Capturing them is a decision you make
deliberately, not one you inherit.

- **Two wrappers, no framework**  
One around the handler, one around the bridge. No config file, no background thread, nothing kept
between requests.

## What mocon is not

It is intentionally limited in scope.

It is not:

* a backend, a collector, or a dashboard
* an SDK, or a replacement for one
* a sandbox, or anything that stops a program doing something
* a general MCP tracing library, since ordinary tool calls are already covered upstream

It is a vocabulary for one shape of problem, and the smallest emitter that produces it.

## Current status

**v0.1.0, pre-1.0, and the attribute names will move.**

What works today:

* **Both languages, checked against each other.** A parity harness runs one scenario through the
  TypeScript and Python emitters and diffs every attribute. They agree on all of them except number
  formatting, which no rule can fix and which the specification marks as permanent.
* **All three signals**, with metrics and log records inert unless you configure a provider.
* **`logTracer`**, so this runs with a logger and nothing else.
* **Payload capture that survives hostile input.** Cycles, throwing getters, errors from another
  realm, values larger than memory. Three adversarial rounds went at this and what they found is
  fixed.
* **A specification** in `spec/otel-code-mode.md` that ends with seventeen things it cannot do.

What is missing, and will bite you before anything else does:

* **Python is not published.** It installs from a clone until `pymocon` is on PyPI.
* **The TypeScript package needs Node.** It uses `Buffer`, `node:crypto` and `node:util`, so it will
  not run on Workers, Deno or in a browser. The attributes are runtime-neutral even where this
  package is not.
* **`code_mode.*` is a namespace this project owns and nobody else has agreed to.** The `gen_ai.*`
  and `mcp.*` attributes it reuses are themselves Development upstream, with no compatibility
  guarantee.
* **Nobody outside has used it.** Every trial so far was run by the author.

The version is the point. Pin it exactly.

## Non-goals

For now, mocon does not aim to:

* model anything outside a code-mode run
* ship a backend, a storage format, or a query language
* support hosts that cannot place code on either side of the sandbox boundary
* grow attributes faster than someone can be persuaded to adopt them

## Repository

| | |
|---|---|
| `spec/otel-code-mode.md` | the specification, ending with its limits and its open questions |
| `packages/typescript` | `@tanvincible/mocon`, on the OpenTelemetry API only |
| `packages/python` | `pymocon`, the same attributes, imported as `mocon` |
| `packages/python/parity` | runs one scenario through both and diffs every attribute |
| `examples/server.mjs` | a working code-mode server, and the run pictured above |
| `examples/record.mjs` | regenerates that picture from a real run, so it cannot drift |
| `bench/trace.mjs` | what it costs against the SDK's own floor |
| `collector/`, `dashboards/` | optional examples, since it is all ordinary OpenTelemetry |

Docs are at **<https://tanvincible.github.io/mocon>**. Build them with `npm run docs`, or
`npm run docs:serve` to open them. Releasing is `npm run release:npm`, which builds first and aims at
the package rather than the workspace root.

## Getting involved

If you run a code-mode server, the useful thing is to try wiring this into it and tell me where the
model does not fit. That is the part no amount of testing here settles.

You can also:

* read `spec/otel-code-mode.md` and argue with it
* say an attribute is missing, or that one of them earns nothing
* open an issue for anything that was confusing on a first read

## Final note

mocon is an experiment, but a serious one.

The aim is for the vocabulary to outlive this implementation.

If a code-mode server somewhere emits these attributes without ever installing this package, that is
the outcome worth having.

## License

Licensed under either of the Apache License, Version 2.0 (LICENSE-APACHE) or the MIT license
(LICENSE-MIT), at your option. Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in this work by you shall be dual licensed as above, without any additional
terms or conditions.
