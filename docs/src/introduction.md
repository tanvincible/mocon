# mocon

**Makes code-mode MCP servers debuggable, in the observability stack you already run.**

In code mode, an agent does not call one tool. It submits a **program**. The server runs that
program in a sandbox, and from inside it, the server's tools are reached through a bridge.

From outside the server, the entire run is a single opaque tool call. Which tools the program
called, in what order, what it passed, what came back, how long each took, whether any of it
failed, and whether the server could even see any of it: all invisible.

```
agent ──"here is a program"──▶ server ──▶ sandbox ─┐
                                   ▲               │ callTool("company_search", …)
                                   └───────────────┘ callTool("person_enrich",  …)
                                                     callTool("refund_customer", …)
        ◀──"here is one result"──
```

One tool call went in. One result came out. Three calls happened in between and nothing recorded
them.

## What this is

A set of [OpenTelemetry semantic conventions](./spec.md) for that shape, and a small emitter that
implements them. OpenTelemetry is the wire format rather than an export target, so there is no
format here for anyone to learn and no destination of ours to wire.

You add two wrappers. You get one span per program dispatch and one span per call the program made,
correctly parented, in whatever backend you already run. If you run no trace backend at all, you can
[point it at your logger instead](./logs.md) and get the same information as flat records.

## What it contributes

OpenTelemetry already models spans, parentage and duration. Three things it has no answer for, and
they are the whole reason this exists.

**[Provenance](./provenance.md).** A code-mode program is written by an agent, and it can lie. Many
hosts build their telemetry out of what that program printed. So every value carries its class:
something the host observed, something the program claimed, or something a target reported. Nothing
in OpenTelemetry's data model does this, anywhere.

**[The capability declaration](./declaration.md).** Without it, a trace showing no calls means either
the program made none or the host is blind to the ones it made. Those are opposite conclusions and
no trace can tell them apart.

**[Closed vocabularies](./vocabularies.md).** Four ways an execution can end and three ways a call
can settle, so a consumer can be written once and work everywhere. Span status collapses them to
two, which is why the attributes are normative and the status is a display hint.

## Status

Development, version 0.1.0, one implementation, and a namespace nobody else has agreed to. The
`gen_ai.*` and `mcp.*` attributes it reuses are themselves Development upstream with no
compatibility guarantee.

This project previously specified a JSON Lines record format with its own schema, conformance suite
and viewer. [It was retired](./history.md), and [four parity trials](./trials.md) against hand-rolled
observability all went the other way. Both of those stories are written down here, because what they
found is more useful than a pitch.
