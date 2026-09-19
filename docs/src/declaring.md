# Declaring

Four values, set once, that ride on every span. They tell whoever's reading how much of the picture
they're actually looking at.

```ts
codeMode({
  capabilities: {
    observes_crossings: "all",
    unmediated_egress: false,
    crossing_edge: "invocation",
    attested: ["crossing.target", "crossing.input", "crossing.output"],
  },
});
```

## Why

A run whose trace shows no calls means one of two opposite things. Either the program made no calls,
or your server can't see the ones it made. Nothing else in the trace tells them apart. This does, and
every other claim depends on it being honest.

## `observes_crossings`

`all`, `some`, or `none`.

**`all` means nothing can answer the program before your wrapper does.** Not "my wrapper sees every
call that reaches it". Before you claim it, go look for code that answers the program itself:

- a cap on calls per run
- a deadline or time budget guard
- a rate limiter
- a cache that returns without dispatching
- a permission check that refuses before dispatch

If any of those can return to the program without going through the function you wrapped, then some
calls make no span, and `all` is false. Use `some`.

**How to check, in five minutes.** Instrument it, write a program that deliberately hits every
refusal path you've got, and count the spans against the calls. If they don't match, you're `some`.

## `unmediated_egress`

`true` if the program has any way out that you don't see: raw network, subprocesses, an isolate that
can be escaped. It stops someone concluding "three spans, so three external calls".

Not sure your sandbox is airtight? `true` is the honest answer.

## `crossing_edge`

`invocation` if a span describes what the program asked for. `dispatch` if it describes what you
actually sent after retries and rewrites. Most integrations wrap the bridge the program calls, so
that's `invocation`.

## `attested`

By default **everything is treated as a program claim**, which is the safe reading. This list is how
you upgrade specific things to "my server saw this":

| Entry | What it upgrades |
|---|---|
| `crossing.target` | the tool name, its order and its outcome |
| `crossing.input` | the call arguments |
| `crossing.output` | the result, to "a target reported it" |
| `crossing.error` | the error class and message, to "a target reported it" |
| `execution.error.class` | the run's error type |
| `host_attributes` | your own attributes, listed separately |

Only attest something if it's true for **every** span you emit. There's no per-call opt-out.

**Don't attest anything you work out from what the program wrote.** If your error class comes partly
from matching a thrown value's name or message, the program can pick it. If you've got both an
observed path and a parsed path for the same field, don't attest that field.

## The rule

Declare the weakest thing that's true for every run. Saying nothing reads as `none`, nothing
attested, egress unknown, and that's safe. Forgetting to claim something costs you a bit of detail.
Claiming something that isn't true quietly corrupts every conclusion anyone draws from your traces.
