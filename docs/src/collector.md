# The collector

`collector/codemode.yaml` does one job that a host cannot do for itself: **it stops a program's claim
from becoming a metric that reads as a measured fact.**

On a host that does not observe its own call boundary, the tool name on a crossing span is whatever
the program said it called, and the emitter labels it accordingly. A span-metrics connector does not
read provenance, so left alone it produces `calls_total{gen_ai.tool.name="refund_customer"}` from a
name the program chose, and a metric has no channel in which to carry the doubt.

The specification forbids that and states in its own limitations that a host cannot enforce it. A
collector can, because it sits after every host and before every backend.

## It is configuration, not a component

Deliberately. A custom collector component has to be compiled into a distribution, which means every
adopter rebuilds and redeploys their collector before seeing anything. This library has already lost
[four trials](./trials.md) to things needing to be wired first. Everything here is stock
`opentelemetry-collector-contrib`.

## The shape

Two passes over the same spans.

- The **trace** pipeline keeps everything, claims included. A claim belongs in a trace, beside the
  label saying what it is, where a human reads it in context.
- A **second traces pipeline** feeds the metrics connector and drops the claims first, so nothing
  unobserved is ever counted.

A span carrying no provenance label is untouched, so telemetry from anything that is not a code-mode
host passes through unchanged.

There is also an off-by-default `transform` processor that strips program-authored payload values,
for a deployment that wants the shape of a run but not its content. The capture note survives it, so
a reader still sees the size and hash of what was removed.

## Proof

`collector/check.mjs` emits two calls through a real collector: one from a host that observed its own
boundary, one from a host that did not.

| | reached traces | reached metrics |
|---|---|---|
| `company_search`, which the host observed | yes | yes |
| `refund_customer`, which the program claimed | yes | **no** |

That is the whole point, and it is checkable in about a minute.

## One trap worth knowing

Since v0.104 the collector binds OTLP to localhost by default, so a containerised collector with the
stock configuration receives nothing at all, silently. The shipped config sets explicit endpoints.
