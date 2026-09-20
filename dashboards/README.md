# Dashboards

`code-mode.json` is a Grafana dashboard for code-mode execution. Import it, pick your datasources,
and it works against any OTLP trace store plus the metrics from `collector/codemode.yaml`.

## Example

This is Grafana because that is what it was built against. Everything mocon emits is ordinary
OpenTelemetry, so use whatever you already run: Datadog, Honeycomb, Elastic, anything. The metrics
arrive named, united and described, and show up correctly in any metric browser with nobody teaching
it anything.

What this file is good for is telling you which views are worth having. The queries are in it, and
the same attribute names work in any query language.

## Why

OpenTelemetry will render your code-mode spans without any of this. You get a waterfall, correct
parentage and real durations, for free, the moment you emit.

What you do not get is any of the meaning. Grafana has never heard of `code_mode.` and will not tell
you that a run was abandoned rather than completed, that a crossing the host never observed is
sitting in your trace looking exactly like one it did, or that an absence of calls means nothing on
this particular host. Every panel here shows one of those.

This is also the part a team cannot hand-roll and keep. A hand-rolled dashboard is built once for
one server and transfers to nothing. This one works on any host that follows the specification, which
is the only real return on standardising anything.

## Panels

- **Can an absence of calls be believed?** The declaration, aggregated. `all` with no unmediated
  egress is the only combination where an execution showing no crossings really made no calls.
- **Executions by disposition** and **Crossings by outcome.** Span status has three values and these
  vocabularies have four and three. A run the host gave up on renders identically to a clean one in
  every default dashboard, Grafana's included. These two panels are the correction.
- **Abandoned crossings.** Calls in flight when their execution ended. If your targets spend money or
  change state, this is the count of things that may or may not have happened.
- **Calls the program claimed, not calls the host saw.** These reach no metric by design, so this is
  the only place they appear. Nothing else in your stack will tell you they are different.

## Validation

The PromQL was run against a live Prometheus-compatible datasource, including a deliberately broken
control to confirm that a syntax error actually surfaces rather than returning empty.

The TraceQL was **not** validated. The search endpoint available here returns 200 with no results for
a deliberately malformed query, so a passing response proves nothing about it. The four trace panels
should be checked by hand on first import.

## Requirements

- A Prometheus-compatible datasource holding `traces_span_metrics_*`, produced by the spanmetrics
  connector in `collector/codemode.yaml`.
- A Tempo-compatible trace store.

Both datasource uids are set in the JSON and will need changing to match your instance.
