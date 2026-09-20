# Quick start

A working integration, start to finish. About ten minutes.

## 1. Hooks

mocon needs two hooks.

**The handler that runs a submitted program.** Usually whatever sits behind your `execute` tool, just
before it hands the program to the sandbox.

**The function you give the sandbox so it can call your tools.** Whatever you inject as `callTool` or
similar. Take the outermost one, the thing the sandbox actually holds.

## 2. Instance

```ts
import { codeMode } from "@mocon/core";

export const observed = codeMode({
  capabilities: {
    observes_crossings: "some",
    unmediated_egress: true,
    crossing_edge: "invocation",
    attested: [],
  },
});
```

Those four values say what your server can see. These are the cautious defaults and they're a safe
place to start. [Declaring](./declaring.md) covers how to sharpen them once
you've checked.

## 3. Wrappers

```ts
return observed.execution.run(
  { program: source, tool: "execute" },
  async (execution) => {
    const callTool = execution.instrument(bridge.callTool);
    return runInSandbox(source, { callTool });
  },
);
```

That's both wrappers. The outer one covers the run, and `instrument` covers every call the program
makes through that function.

## 4. Provider

mocon emits through the OpenTelemetry API and nothing else, so until something registers a provider
your spans go to a no-op and you see nothing. That is the usual reason a first run looks silent.

If you already register one somewhere, you are done, skip this. If you don't, the SDK is a separate
install:

```sh
npm install @opentelemetry/sdk-node
```

Then in your real entrypoint, before anything else loads:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
new NodeSDK({ /* your exporter */ }).start();
```

Or skip the SDK entirely and write to [your logger](./logs.md), which needs no extra install.

## 5. Run it

Send a program that makes a couple of calls, including one that fails. You should get one
`execute_code` span with two or three `execute_tool` spans under it.

[Output](./output.md) shows exactly what's on them.

## Before shipping

**[Declare honestly](./declaring.md).** The defaults above claim almost nothing. Sharpening them is
what makes the data worth trusting, and getting it wrong is the one mistake that quietly ruins
everything else.

**Check how your bridge reports failure.** If your `callTool` returns `{ ok: false }` instead of
throwing, mocon will record every failure as a success until you tell it otherwise. One option fixes
it, see [Wrappers](./wrappers.md).
