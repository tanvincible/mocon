# Logging

Standing up a collector and a trace backend is a real decision. If your telemetry today is structured
logs, that's a lot more work than the two wrappers. You don't have to do it.

```ts
import { codeMode, logTracer } from "@mocon/trace";

const observed = codeMode({
  capabilities: { /* same as before */ },
  tracer: logTracer((record) => logger.info(record)),
});
```

That's the only line that changes. No SDK, no exporter, no collector, no backend.

## Records

Every finished span becomes one flat record handed to your logger:

```json
{
  "name": "execute_tool inventory_search",
  "kind": "client",
  "trace_id": "f3d8f44c4f3d6a83bd2518356040dd1a",
  "span_id": "33924c3b939b1dcc",
  "parent_span_id": "eceff414b8114181",
  "start": "2026-09-20T10:14:02.118Z",
  "duration_ms": 17.68,
  "code_mode.execution.id": "exec_7f3a",
  "code_mode.crossing.outcome": "output",
  "gen_ai.tool.name": "inventory_search",
  "gen_ai.tool.call.arguments": { "q": "widget" },
  "code_mode.provenance.gen_ai.tool.call.result": "P"
}
```

The whole attribute set, the provenance labels, the ids, a duration and a status. Payloads come back
as real values rather than JSON strings, because a log record can hold an object where a span
attribute can't. Group by `code_mode.execution.id` and you've got the whole run, in the pipeline you
already query.

## Trade-offs

The things a trace store is actually for. A rendered waterfall, and metrics off spans without
aggregating log lines yourself.

## Reversible

The ability to change your mind. Switching to a real trace pipeline later means passing a different
tracer and touching nothing else.

## Flat

Records are flat, one per span, rather than nesting calls inside their run.

Nesting means holding children until the parent closes, and a call the program makes a tick later
then never gets written at all. Flat records carry `parent_span_id`, so you rebuild the tree by
grouping instead of trusting the writer to buffer correctly.

## Options

```ts
logTracer({
  write: (record) => logger.info(record),
  raw: true,   // leave payloads as JSON strings instead of decoding them
});
```

If your logger throws, the record is dropped and the call carries on. An observability problem should
never break the thing it's watching.
