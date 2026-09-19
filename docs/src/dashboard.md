# The dashboard

`dashboards/code-mode.json` is a Grafana dashboard for code-mode runs.

OpenTelemetry already renders your spans without it. You get a waterfall, correct nesting and real
durations for free. What you don't get is any of the meaning. Grafana has never heard of
`code_mode.` and won't tell you a run was abandoned rather than finished, or that a call your server
never saw is sitting in the trace looking just like one it did.

## The panels that matter

**Can you believe there were no calls?** The [declaration](./declaring.md), aggregated. Watching
everything with no unmediated egress is the only combination where a run showing no calls really made
none.

**Runs by disposition** and **calls by outcome.** Span status has three values where these have four
and three. A run you gave up on looks identical to a clean one everywhere else. These two fix that.

**Abandoned calls.** Calls still in flight when their run ended. If your targets spend money or change
state, that number is how many things may or may not have happened.

**Calls the program claimed.** These reach no metric by design, so the trace panel is the only place
they show up at all.

## Why a dashboard ships with this

It's the part you can't hand-roll and keep. A dashboard you build for your server transfers to
nothing. This one works on any server following the conventions, which is the actual payoff of
standardising anything.

## Setup

You need a Prometheus-compatible datasource holding `traces_span_metrics_*` from
[the collector](./collector.md), and a Tempo-compatible trace store. Both datasource uids are in the
JSON and you'll need to repoint them.

The PromQL panels are tested. The four TraceQL panels aren't, so give them a look on first import.
