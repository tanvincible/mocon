# No trace store

Standing up a collector and a trace backend is a real decision. For a team whose telemetry is
structured logs it costs far more than the two wrappers, and it is the reason this library lost
[three of four parity trials](./trials.md). You do not have to make that decision to use this.

```ts
import { codeMode, logTracer } from "@mocon/trace";

const observed = codeMode({
  capabilities: { /* as before */ },
  tracer: logTracer((record) => logger.info(record)),
});
```

That is the only line that differs. No SDK, no exporter, no collector, no backend.

## What you get

Each finished span becomes one flat record handed to your logger:

```json
{
  "name": "execute_tool company_search",
  "kind": "client",
  "trace_id": "f3d8f44c4f3d6a83bd2518356040dd1a",
  "span_id": "33924c3b939b1dcc",
  "parent_span_id": "eceff414b8114181",
  "start": "2026-09-20T10:14:02.118Z",
  "duration_ms": 17.68,
  "code_mode.execution.id": "exec_7f3a",
  "code_mode.crossing.outcome": "output",
  "gen_ai.tool.name": "company_search",
  "gen_ai.tool.call.arguments": { "q": "food" },
  "code_mode.provenance.gen_ai.tool.call.result": "P"
}
```

The full attribute set, the provenance labels, the ids, a duration and a status. Payloads come back
as values rather than JSON strings, because a log record can hold a map where a span attribute
cannot. Group by `code_mode.execution.id` and you have the whole run, in the pipeline you already
query.

## What you give up

What a trace store is actually for: a rendered waterfall, and metrics derived from spans without
aggregating log lines yourself.

## What you keep

The ability to change your mind. The same host code moves to a real trace pipeline by passing a
different tracer, with nothing else touched. Tracing becomes a decision you can defer and reverse
rather than a precondition.

## One design choice

Records are flat, one per span, rather than crossings nested inside their execution.

Nesting means buffering children until the parent closes, and a call the program makes on a later
tick is then never written at all. That is not hypothetical. It was measured on a hand-written
destination during an experiment, and it lost calls with no error of any kind, which is the worst
way to lose them. Flat records carry `parent_span_id`, so a reader reassembles the tree by grouping
rather than by trusting the writer's buffering.
