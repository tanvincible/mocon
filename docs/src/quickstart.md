# Your first trace

A working integration, start to finish. About ten minutes.

## 1. Find your two spots

mocon needs two hooks.

**The handler that runs a submitted program.** Usually whatever sits behind your `execute` tool, just
before it hands the program to the sandbox.

**The function you give the sandbox so it can call your tools.** Whatever you inject as `callTool` or
similar. Take the outermost one, the thing the sandbox actually holds.

## 2. Make an instance, once

```ts
import { codeMode } from "@mocon/trace";

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
place to start. [Declaring what your server sees](./declaring.md) covers how to sharpen them once
you've checked.

## 3. Wrap the handler

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

## 4. Make sure a provider is registered

In your real entrypoint, not in a test:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
new NodeSDK({ /* your exporter */ }).start();
```

Or if you'd rather not run tracing at all, use [your logger instead](./logs.md).

## 5. Run something and look

Send a program that makes a couple of calls, including one that fails. You should get one
`execute_code` span with two or three `execute_tool` spans under it.

[What you get](./output.md) shows exactly what's on them.

## Two things before you call it done

**[Declare honestly](./declaring.md).** The defaults above claim almost nothing. Sharpening them is
what makes the data worth trusting, and getting it wrong is the one mistake that quietly ruins
everything else.

**Check how your bridge reports failure.** If your `callTool` returns `{ ok: false }` instead of
throwing, mocon will record every failure as a success until you tell it otherwise. One option fixes
it, see [The two wrappers](./wrappers.md).
