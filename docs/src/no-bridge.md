# No bridge

`instrument` wraps a function, which only helps if your host has one to wrap. Plenty don't.

Maybe your sandbox runs in another process and calls back over HTTP. Maybe it drops requests on a
queue and something else picks them up. Maybe you only find out what it did by reading a log after it
finishes. In all of those there's no function sitting on the boundary, so you record the calls
yourself.

You get the same spans either way. `instrument` is a convenience built on top of what's below.

## Recording

Three calls. Start one when you learn a call began, end it when you learn how it went.

```ts
const crossing = execution.crossing.start({ target: "orders.list", input: params });

crossing.output(result);  // it came back
crossing.error(failure);  // it didn't
```

`target` is the only thing required. Everything else is optional and gets filled in with what you
know.

## Late

Calls don't have to end in the order they started, and they don't have to end at all.

```ts
const a = execution.crossing.start({ target: "orders.list" });
const b = execution.crossing.start({ target: "inventory.check" });

b.error(new Error("upstream 503"));   // second one settles first
a.output({ rows: 2 });

execution.crossing.start({ target: "slow_thing" });  // never settles
execution.complete();
```

```
execute_tool inventory.check   error
execute_tool orders.list       output
execute_tool slow_thing        abandoned
execute_code                   completed
```

Anything still open when the execution ends gets closed for you and marked `abandoned`. A sandbox
that goes quiet leaves a record saying so rather than a hole you have to notice.

## Order

Timestamps often won't order these for you. Calls under a millisecond tie, and a sandbox on another
machine has a clock you don't control. If you know the order the program asked in, say it:

```ts
execution.crossing.start({ target: "orders.list", seq: 2 });
```

Only pass `seq` if it's real. A wrong order is worse than no order, so anything that isn't a positive
integer is refused and the count mocon kept itself is used instead.

## Declaring

Watching from a distance usually means seeing less, and the declaration is where you say so. Three
settings matter here.

**`crossing_edge`.** Use `"dispatch"` if what you see is the request you sent toward the tool, rather
than the call the program asked for. Anything observing at the network layer is `dispatch`. A retry
you did on the program's behalf is one call to the program and several dispatches, and this is what
tells a reader which one they're looking at.

**`observes_crossings`.** Use `"some"` unless you're certain you see every call. If calls reach you
through a queue you might drop from, or a log you might read late, you see some.

**`unmediated_egress`.** Set it `true` if the program has any path out that doesn't come through you.
This is the one that stops a reader concluding "no calls recorded, so it called nothing", which is
the wrong conclusion to let someone reach.

```ts
codeMode({
  capabilities: {
    observes_crossings: "some",
    unmediated_egress: true,
    crossing_edge: "dispatch",
    attested: [],
  },
});
```

[Declaring](./declaring.md) goes through all of it, including how to sharpen these once you've
checked what you actually see.

## Reconnecting

If your host learns about an execution in one place and its calls in another, you don't need to hold
the handle between them. Give the execution an id you already have:

```ts
const execution = observed.execution.start({ program: source, id: runId });
```

Every crossing carries that id, so a query finds them by it without needing the parent span. That's
what lets a worker process record a call for a run that a different process started.
