# Collector

**Optional.** The two histograms now come from your app directly, so you do not need a collector to
get metrics at all. This is for one narrower job your server genuinely cannot do for itself. **It stops a program's claim
from turning into a metric that looks like a measured fact.**

If you don't attest `crossing.target`, the tool name on a call span is whatever the program said.
A span-metrics connector doesn't read provenance, so left alone it happily produces
`calls_total{gen_ai.tool.name="order_ship"}` from a name the program picked, and a metric has
nowhere to carry the doubt.

Your server can't prevent that, because the connector runs downstream. A collector can, because it
sits after every server and before every backend.

## Config

On purpose. A custom collector component has to be compiled into a distribution, so everyone adopting
it has to rebuild and redeploy their collector first. Everything here is stock
`opentelemetry-collector-contrib`, so it works with the collector you already run.

## Pipelines

Two passes over the same spans.

The **trace** pipeline keeps everything, claims included. A claim belongs in a trace, next to the
label saying what it is, where a person reads it in context.

A **second traces pipeline** feeds the metrics connector and drops the claims first, so nothing
unobserved ever gets counted.

Spans with no provenance label are left alone, so telemetry from the rest of your system passes
through untouched.

There's also an off-by-default `transform` processor that strips program-written payload values, for
when you want the shape of a run in your backend but not the content. The capture note survives it,
so you still see the size and hash of whatever got removed.

## Checking

`collector/check.mjs` sends two calls through a real collector. One from a server that watched its own
boundary, one from a server that didn't.

| | in traces | in metrics |
|---|---|---|
| `inventory_search`, observed | yes | yes |
| `order_ship`, claimed | yes | no |

Takes about a minute.

## Gotcha

Since v0.104 the collector binds OTLP to localhost by default, so a collector in a container with the
stock config receives nothing at all and says nothing about it. The config here sets explicit
endpoints.
