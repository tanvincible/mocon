# Signals

The same two wrappers produce all three OpenTelemetry signals. Each one is on by default and costs a
function call if your app hasn't configured that signal, so you get whatever you already run.

## Traces

One span per program, one per call it made, nested. The shape of a single run.

Covered in [Output](./output.md).

## Metrics

Two histograms, both in seconds, for questions across many runs.

| Instrument | Keyed on |
|---|---|
| `code_mode.execution.duration` | disposition, and error type when there is one |
| `code_mode.crossing.duration` | tool name, outcome and error type |

**The second one is conditional, and this is the interesting part.** Those dimensions are only added
when you attested `crossing.target`. If you didn't, the tool name is whatever the program said it
called, and a metric has nowhere to record that doubt, so it would turn a claim into a fact that
nothing downstream could question. So the dimensions get dropped and you get an undimensioned
duration distribution instead. Less useful, not a lie.

Calls that ended `abandoned` are not recorded at all. Their duration is zero by construction, so
counting them would put a fiction in the distribution.

You don't need a collector for these. They come straight from your app through whatever metrics
exporter you already have. [The collector](./collector.md) is still worth running if something else
in your pipeline derives metrics from span names, because that you can't control from here.

## Logs

One record when a run starts, one when it ends.

```json
{
  "event.name": "code_mode.execution.started",
  "body": "a program dispatch started",
  "trace_id": "7269fe4c…",
  "span_id": "a1fa92d3…",
  "code_mode.execution.id": "run-1"
}
```

**The starting record is the point.** A span only exports when it ends, so a run that's still going,
or one that hung, isn't in your trace at all. It looks exactly like a run that never happened. The
log record is the only thing in the whole model that says a run is in flight right now.

Both records carry the trace and span id, so they're a view of the trace rather than a second source
of truth. Join on those ids and you're back in the waterfall.

This needs `@opentelemetry/api-logs`, which is an optional peer dependency. If it isn't installed,
log records are silently skipped and everything else works.

## Switching off

```ts
codeMode({
  capabilities,
  signals: { metrics: false, logs: false },
});
```

Traces always emit. The other two are on unless you say otherwise.

## No OpenTelemetry

If you run none of this, [use your logger](./logs.md) instead. You lose metrics and the waterfall,
and keep the vocabulary.
