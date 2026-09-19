# API

## `codeMode(options)`

Makes an instance. Do this once, at startup.

```ts
codeMode({
  capabilities,      // required, see below
  tracer,            // optional, defaults to the global OpenTelemetry tracer
  capture,           // optional, payload settings
});
```

Bad capabilities throw here, at startup, rather than later on a request.

### `capabilities`

| Field | Type | |
|---|---|---|
| `observes_crossings` | `"all"` \| `"some"` \| `"none"` | required |
| `unmediated_egress` | boolean | required |
| `crossing_edge` | `"invocation"` \| `"dispatch"` | required unless `observes_crossings` is `"none"` |
| `attested` | string[] | what your server observed, default `[]` |
| `attested_attributes` | string[] | your keys you measured, needs `host_attributes` |
| `relayed_attributes` | string[] | your keys a target reported, needs `host_attributes` |
| `declared` | object | what your keys mean |

### `capture`

| Field | Default | |
|---|---|---|
| `values` | `false` | write program text, arguments and results |
| `cap` | 8192 | bytes written per value |
| `programCap` | 32768 | bytes written for the program |
| `measure` | 1048576 | bytes read to compute the real size and hash |

## `execution.run(options, body)`

Starts a run, calls `body`, closes the run. Returns whatever `body` returns, and follows a promise if
it returns one. A throw is recorded as `failed` and rethrown unchanged.

```ts
observed.execution.run({ program, tool: "execute" }, (execution) => { … });
```

| Option | |
|---|---|
| `program` | the submitted text, required |
| `tool` | the name of your code-mode tool |
| `id` | your own run id; one is generated if you don't pass one |
| `language` | a hint like `"javascript"`, leave it out rather than guess |
| `kind` | `"server"` (default) or `"local"` |
| `parent` | the caller's context from your propagator, never from the sandbox |
| `sessionId`, `conversationId`, `toolCallId` | correlation ids |
| `attributes` | your own attributes |
| `end` | read a failure envelope, see [the wrappers](./wrappers.md) |

## `execution.start(options)`

Same options, but you close it yourself. Use it when your handler shape doesn't suit a callback.

## The execution handle

| | |
|---|---|
| `instrument(fn, options?)` | wrap a bridge function, one call becomes one span |
| `crossing.start(options)` | open a call by hand |
| `complete(options?)` | close the run as `completed` |
| `fail(cause, options?)` | close it as `failed` |
| `end(options)` | close it with any disposition |
| `span` | the underlying OpenTelemetry span |
| `context` | the run's context, for bridges served in another task |

Closing twice is a no-op, so the first close wins.

## `instrument(fn, options?)`

Returns a wrapped function with the same name, arity and behaviour. It forwards `this`, rethrows the
exact error, and follows a returned promise.

| Option | |
|---|---|
| `target` | a string, or a function of the arguments; defaults to the first argument |
| `input` | a function of the arguments; defaults to everything after the target |
| `end` | turn the bridge's answer into an outcome |
| `toolType` | `"function"`, `"extension"` or `"datastore"` |
| `attributes` | your own attributes |

If one of these options throws, you lose that field and not the call. The call still runs and the
span is still recorded.

## The crossing handle

| | |
|---|---|
| `output(value?, options?)` | settled with a result |
| `error(cause, options?)` | settled with an error |
| `end(options)` | settled with any outcome |
| `span` | the underlying span |

Options take `dispatched`, `errorType`, `message`, `endTime` and `attributes`. A call you never
settle is closed as `abandoned` when the run ends.

## `logTracer(write | options)`

A tracer that writes flat records to a function instead of exporting spans. See
[using your logger](./logs.md).

## Errors

Bad configuration throws at startup: `TypeError` for a wrong type, `RangeError` for a value outside a
fixed set.

On the request path, nothing throws. A value that can't be serialized is recorded as redacted, a
broken option costs that field, a logger that throws costs that record. Observability should never
break the thing it's watching.
