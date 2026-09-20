# Collector

**Optional.** The emitter produces its own metrics now, so you do not need this to get them. It is
for one narrower job a host cannot do for itself: stopping telemetry *somebody else* configured from
turning a program's claim into a metric.

`codemode.yaml` is a collector configuration, not a component you compile in. That is deliberate.

A custom collector component has to be built into a distribution with the OpenTelemetry Collector
Builder, which means everyone adopting it has to rebuild and redeploy their collector before seeing
anything at all. Everything here is stock `opentelemetry-collector-contrib`, so it works with the
collector you already run.

## Purpose

It stops a program's claim from becoming a metric that reads as a measured fact.

A code-mode program is agent-written. On a host that does not observe its own call boundary, the
target on a crossing span is whatever the program said it called. The emitter marks that, as
`code_mode.provenance.gen_ai.tool.name = "P"`. A span-metrics connector does not read provenance, so
left alone it produces `calls_total{gen_ai.tool.name="order_ship"}` from a name the program
chose, and a metric has no provenance channel in which to carry the doubt.

The specification forbids this and says in its own limitations that a host cannot enforce it. A
collector can, because it sits after every host and before every backend.

The shape is two passes over the same spans:

- The **trace** pipeline keeps everything, claims included. A claim belongs in a trace, next to the
  label saying what it is, where a human reads it in context.
- A **second traces pipeline** feeds the metrics connector and drops the claims first, so nothing
  unobserved is ever counted.

A span carrying no provenance label is left alone, so telemetry from anything that is not a
code-mode host passes through untouched.

There is also an off-by-default `transform` processor that removes program-authored payload values,
for a deployment that wants the shape of a run in its backend but not the content. The capture note
survives it, so a reader still sees the size and hash of what was removed.

## Use

Merge the `processors`, `connectors` and `service.pipelines` blocks into your own collector config
and point the exporters at your real backend. The `debug` exporter here is a placeholder.

Validate it before deploying:

```sh
docker run --rm -v "$PWD:/cfg" otel/opentelemetry-collector-contrib:latest validate --config=/cfg/codemode.yaml
```

## Proof

`check.mjs` emits two crossings through a real collector: one from a host that observed its own call
boundary, one from a host that did not. Run it and read the collector's log.

| | reached traces | reached metrics |
|---|---|---|
| `inventory_search`, which the host observed | yes | yes |
| `order_ship`, which the program claimed | yes | no |

That is the whole point, and it takes about a minute to check.

## Limits

It cannot recover provenance a host never declared. If a host attests nothing, every crossing is a
claim and every crossing is dropped from the metrics pipeline, which is correct and also means that
host gets no per-target metrics at all. The fix is for the host to observe its own call boundary,
not for the collector to guess.

It does not touch span names. A span-metrics connector keyed on the span name rather than on
`gen_ai.tool.name` still reads a claim as fact for a host that does not attest, because the name
cannot carry a label. That is limitation L3 in the specification and this does not close it.
