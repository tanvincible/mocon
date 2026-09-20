# Overview

**OpenTelemetry for code-mode MCP servers.**

It shows you what one of these servers actually did, in the observability stack you already run. If
that already makes sense, jump to [Install](./install.md). If not, here's the whole problem in a
page.

## The problem

The Model Context Protocol lets an AI agent call tools on your server. Normally it calls one tool at
a time. Search for companies. Then enrich this person. One request each.

**Code mode is different.** Instead of calling one tool, the agent writes a small program and sends
you that. You run it in a sandbox, and while it runs, the program calls your tools itself:

```js
const companies = await callTool("inventory_search", { q: "blue widget" });
for (const c of companies.rows) {
  await callTool("item_fetch", { id: c.id });
}
```

It's much faster and much cheaper than sending every call back through the model. It's also much
harder to see into.

From outside your server, the whole run is **one tool call**. One request in, one result out. Which
tools the program called, in what order, what it passed, what came back, how long each took, which
one broke: all of that happened inside, and none of it got recorded.

```
agent ──"run this program"──▶ your server ──▶ sandbox ─┐
                                   ▲                   │ callTool("inventory_search", …)
                                   └───────────────────┘ callTool("item_fetch",  …)
                                                         callTool("item_fetch",  …)
      ◀────"here is a result"────
```

So when a customer says "it gave me the wrong answer", you've got the program and the answer and
nothing in between.

## The fix

You add two wrappers to your server. From those you get all three OpenTelemetry signals:

- **Traces.** One span for the program, one per call it made, nested underneath, with durations and
  outcomes. Any trace viewer draws it as a waterfall you can read.
- **Metrics.** Duration histograms for runs and for calls, so you can ask questions across many runs
  rather than one.
- **Logs.** A record when a run starts, which is the only thing that shows work in flight, because a
  span doesn't appear until it finishes.

Each one goes wherever that signal already goes in your setup, and each costs nothing if you don't
run it. No OpenTelemetry at all? You can [send everything to your logger](./logs.md) instead.

## Versus logging

Plenty of teams do, and it works. Three things are hard to get right that way.

**Knowing what you can trust.** The program is written by an AI, and it can say whatever it likes. If
any part of your telemetry comes from what the program printed or threw, then the program is picking
what your dashboard shows. mocon tags every value as something your server *saw* or something the
program *said*, so you can tell them apart. Nothing in OpenTelemetry does this.

**Knowing what missing data means.** A run with no calls recorded means one of two opposite things.
Either the program made no calls, or your server can't see the calls it made. You declare which,
once, and every span carries the answer.

**A fixed vocabulary.** A run ends one of four ways and a call ends one of three, with the same names
on every server that follows this. So a dashboard or an alert or a script you write against those
names works on any of them.

## Next

- [Install](./install.md), then [your first trace](./quickstart.md). About ten minutes.
- [Output](./output.md) if you want to see the output before you commit to anything.
- [Specification](./spec.md) if you'd rather just read the spec.

## Status

Version 0.1.0. Everything here can still change. The attributes mocon defines are its own, and the
`gen_ai.*` and `mcp.*` ones it reuses are still in development upstream.
