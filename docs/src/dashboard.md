# Dashboard

`dashboards/code-mode.json` is **an example**, not the product. It happens to be Grafana because that
is what it was built against. Use whatever you already run.

## Why example

Everything here is ordinary OpenTelemetry. The two histograms come out named, united and described,
so they show up correctly in any metric browser without anyone teaching it anything. The spans are
spans. The log records are log records. Datadog, Honeycomb, Grafana, Elastic and the rest all handle
them the same way they handle everything else you send.

So there is nothing to build before you can look at this. There is only a choice about what you want
on one screen, and that is yours rather than ours.

## Views

If you are building your own, these are the views that show something the raw trace does not.

**Can you believe there were no calls?** Group runs by `code_mode.observes_crossings` and
`code_mode.unmediated_egress`. Watching everything with no unmediated egress is the only combination
where a run showing no calls really made none.

**Runs by disposition.** `code_mode.execution.duration` grouped by
`code_mode.execution.disposition`. Span status has three values where this has four, so a run you
gave up on looks identical to a clean one everywhere else.

**Calls by outcome.** Same idea on `code_mode.crossing.duration` and
`code_mode.crossing.outcome`. `abandoned` and `output` are both "unset" to a trace viewer.

**Abandoned calls.** Count of crossings with that outcome. If your targets spend money or change
state, that is how many things may or may not have happened.

**Calls the program claimed.** Search traces for spans carrying
`code_mode.provenance.gen_ai.tool.name`. By design these reach no metric, so a trace view is the only
place they appear.

**Runs in flight.** Log records with `event.name = code_mode.execution.started` that have no matching
`ended`. Nothing else in the model can show work still running.

## Ours

Import `dashboards/code-mode.json`, repoint its two datasource uids, and you get the six views above
in Grafana. The PromQL is tested. The four trace panels are not, so give them a look.

It needs the metrics, which come from your app directly, and a Tempo-compatible trace store for the
trace panels.
