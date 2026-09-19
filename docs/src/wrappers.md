# Two wrappers

That is the whole code change.

```ts
import { codeMode } from "@mocon/trace";

const observed = codeMode({
  capabilities: {
    // Start here and earn your way up. Read "Declaring honestly" before changing it.
    observes_crossings: "some",
    unmediated_egress: true,
    crossing_edge: "invocation",
    attested: [],
  },
});

// Wrapper one: around the handler that runs the program.
return observed.execution.run({ program: source, tool: "execute" }, (execution) => {
  // Wrapper two: around the outermost function the program can reach.
  const callTool = execution.instrument(bridge.callTool);
  return runInSandbox(source, { callTool });
});
```

You get one `execute_code` span per dispatch and one `execute_tool` span per call the program made,
correctly parented, in whatever backend you already run.

## Where the wrappers go

**Wrapper one goes around the handler that runs the program**, and it must start *before* your first
rejection branch. An execution begins when the host first observes the dispatch, which includes
dispatches it then refuses for a bad key, a failed lint, or being at capacity. Start it after those
guards and every refused run is invisible in a way that looks like no traffic.

**Wrapper two goes around the outermost function the program can reach.** Not the innermost. If your
sandbox is handed a function that then calls another function that then dispatches, wrap the one the
sandbox holds. Anything above your wrapper that can answer the program produces no span, which is
also what makes [the declaration](./declaring.md) false if you are not careful.

Both wrappers must be host code, outside the sandbox. A wrapper the program can reach, replace or
observe is a channel the program writes through, and a host in that position should attest nothing.

## Reading the bridge's answer

Many bridges never throw. They answer with an envelope, `{ ok: false, error }`, and return it
normally. The default here reads a return as success, so on such a bridge every failed call would be
recorded as having worked.

```ts
const callTool = execution.instrument(bridge.callTool, {
  end: (answer) =>
    !answer.threw && !(answer.value as { ok: boolean }).ok
      ? { outcome: "error", errorType: "capability_error", dispatched: true }
      : undefined,
});
```

The same applies to wrapper one, via its own `end` option, for a handler that returns a failure
envelope rather than throwing.

## Saying whether the call left

`dispatched` tells a reader whether the call actually went to a target. Set it `false` on a refusal
your host answered itself, or a cache hit. Without it, an operator reading an error has no way to
tell a target that failed from a call that never reached one, and will go looking in the wrong
system.
