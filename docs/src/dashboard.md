# The dashboard

`dashboards/code-mode.json` is a Grafana dashboard for code-mode execution.

OpenTelemetry renders your spans without any of this: a waterfall, correct parentage, real
durations, free on the first emit. What it does not render is the meaning. Grafana has never heard
of `code_mode.` and will not tell you that a run was abandoned rather than completed, that a call the
host never observed is sitting in your trace looking exactly like one it did, or that an absence of
calls means nothing on this particular host.

## The panels that earn their place

**Can an absence of calls be believed?** The [declaration](./declaration.md), aggregated. Mediating
everything with no unmediated egress is the only combination in which an execution showing no calls
really made none.

**Executions by disposition** and **crossings by outcome.** Span status has three values where these
[vocabularies](./vocabularies.md) have four and three. A run the host gave up on renders identically
to a clean one in every default dashboard. These two are the correction.

**Abandoned crossings.** Calls in flight when their execution ended. If your targets spend money or
change state, that number is the count of things that may or may not have happened.

**Calls the program claimed, not calls the host saw.** These reach no metric by design, so the trace
panel is the only place they appear at all.

## Why a dashboard is the deliverable

This is the part a team cannot hand-roll and keep. A hand-rolled dashboard is built once for one
server and transfers to nothing. This one works on any host that follows the conventions, which is
the only real return on standardising anything.

## What is validated

The PromQL was run against a live Prometheus-compatible datasource, including a deliberately broken
control to confirm that a syntax error surfaces rather than returning empty.

The TraceQL was **not** validated. The search endpoint available returned 200 with no results for a
deliberately malformed query, so a passing response proved nothing. The four trace panels want a
manual check on first import.

## Requirements

A Prometheus-compatible datasource holding `traces_span_metrics_*` from [the collector](./collector.md),
and a Tempo-compatible trace store. Both datasource uids are in the JSON and will need repointing.
