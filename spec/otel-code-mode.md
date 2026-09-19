# Semantic conventions for code-mode execution

**Status:** Development. Version 0.1.0, 2026-09-19.

Everything here is Development and may change. The `gen_ai.*` and `mcp.*` attributes this
document reuses are themselves Development, in `open-telemetry/semantic-conventions-genai`,
read at 2026-09-19. Nothing in either namespace is Stable and neither carries a compatibility
guarantee. `error.type` is the one Stable attribute used below, and it belongs to the core
semantic-conventions registry, not to `gen_ai`. A host pins the registry version it built
against by setting `schema_url` on its instrumentation scope once one is published, and until
then by setting the scope version to the version of this document.

This project previously specified a JSON Lines record format with its own wire, schema and
conformance suite. This document replaces it. The model, the closed vocabularies, the provenance
rules and the capability declaration survive that move unchanged; section 14 lists what did not,
and Appendix A carries the invariants the whole design rests on.

## 1. Scope

A code-mode server is one where the agent submits a program instead of one structured tool
call. The host runs the program in an environment it controls, and from inside the program the
server's capabilities are reached through a mechanism the host provides. From outside the host
that whole run is one opaque tool call: the calls the program made, what it was given, what came
back, and whether the host could see any of it are all invisible.

This document says how a host makes that visible in OpenTelemetry. It defines two spans, a
declaration of what the host can and cannot observe, a rule for telling a value the host
measured from one the program claimed, and a rule for values the host shortened or removed.

It does not define a wire format. OpenTelemetry is the wire format. It does not define a
library. It defines what a host emits.

**Instrumentation depends on the OpenTelemetry API only, never the SDK.** That is
OpenTelemetry's own rule for instrumentation (`specification/library-guidelines.md`:
"Third party libraries and frameworks that add instrumentation to their code will have a
dependency only on the API of OpenTelemetry client"), and it is the reason this works: the host
emits through the API, and the application owner's configured exporters receive it. A host that
cannot carry an SDK writes OTLP/JSON directly; that encoding is Stable and documented.

Everything in this document is written so that an API-only emitter can produce it. Where that
rules a design out, it is ruled out, and section 3 is where it bites hardest.

**Namespace.** New attributes are under `code_mode.`, lowercase and dot-delimited, snake_case
inside each component, per the OpenTelemetry attribute naming rules. `gen_ai.*` and `mcp.*` are
existing OpenTelemetry namespaces: this document reuses attributes from them and mints nothing
inside them, because the naming rules say not to squat an existing convention namespace.
`otel.*` is reserved to the OpenTelemetry specification. The capability attributes are
`code_mode.observes_crossings` and not `code_mode.host.*`, because `host.*` in OpenTelemetry
already means the machine.

**Requirement levels** are OpenTelemetry's: Required, Conditionally Required, Recommended,
Opt-In. Opt-In means off by default and turned on by the application owner. It is used here for
every attribute that carries program text, call arguments or call results.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in
RFC 2119.

## 2. The model

Three terms, and they are the whole model.

**Execution.** One dispatch of one program by a host. Never the session, the conversation or
the container that holds it. A program the host runs again, from a retry, a replay, a resumed
checkpoint, or a speculative branch its own substrate took, is a new execution.

**Crossing.** One invocation, initiated by the program, that crosses from the program to the
host-provided surface: a tool call, a binding method, a proxied fetch, a file read the host
serves.

**Target.** The host-defined identifier of what a crossing invoked.

Two closed vocabularies. An execution ends `completed`, `failed`, `terminated` or `abandoned`.
A crossing settles `output`, `error` or `abandoned`. They are closed because a consumer that
cannot rely on them cannot be written once and work everywhere. A host MUST NOT emit any other
value in these attributes.

Four more sets are closed the same way and for the same reason: `code_mode.observes_crossings`,
`code_mode.crossing_edge`, `code_mode.crossing.timing`, and the entries of `code_mode.attested`.
A host MUST NOT emit a value outside them. A consumer that meets a value it does not know in one
of the first three MUST treat that attribute as absent and apply the "absent reads as" rule in
section 3; an unknown `attested` entry is ignored, which leaves the fields it would have upgraded
at their baseline. Neither is a reason to discard the span.

These come from profiling nineteen code-mode implementations and adversarially testing every
candidate rule against them. The surviving invariants are numbered C1 to C15 and X1 to X5 in
Appendix A, and each new attribute below names the one it carries.

## 3. The capability declaration

Five attributes say what the host can and cannot see. Without them an absence of crossing spans
has two readings a consumer cannot distinguish: the program made no calls, or the host cannot
see the calls it made. That distinction is the difference between a trace you can reason from
and a trace you cannot.

**They are span attributes, on every span this document defines.** Not Resource attributes, not
instrumentation scope attributes. Section 3.2 says why, and the reason is not a preference.

| Attribute | Type | Requirement | Values |
|---|---|---|---|
| `code_mode.observes_crossings` | string | Required | `all`, `some`, `none` |
| `code_mode.unmediated_egress` | boolean | Required | `true`, `false` |
| `code_mode.crossing_edge` | string | Conditionally Required: when `observes_crossings` is not `none` | `invocation`, `dispatch` |
| `code_mode.attested` | string[] | Required | entries from the closed list in section 6.4; empty array when the host attests nothing |
| `code_mode.attested_attributes` | string[] | Conditionally Required: when `code_mode.attested` contains `host_attributes` | fully qualified attribute keys in the host's own namespace, section 8 |

`observes_crossings: all` claims that every invocation routed through the host-provided surface
is recorded. `some` claims the host mediates but records a subset, by policy or by mechanism.
`none` says the host does not mediate calls at a call boundary. The value says nothing about
whether other paths out of the program exist.

`unmediated_egress: true` says the program has a way to reach the outside that the host does not
see: raw network access, subprocess execution, an isolation layer that can be escaped. Consumers
use it to refuse the inference "N crossing spans, therefore N external calls".

`crossing_edge` says which edge a crossing span describes. `invocation` is what the program
asked for at the call boundary, which is the program's view. `dispatch` is what the host sent
toward the target, recorded at the host's own egress point, after any rewrite, retry decision or
policy step. The two edges do not agree on cardinality: a retry or a refusal makes one
invocation into zero or several dispatches, and a host that bundles invocations into one request
makes several into one.

**Absent reads as.** A consumer that finds no declaration on a span reads `observes_crossings`
as `none`, `unmediated_egress` as unknown and treats it as `true`, `crossing_edge` as unknown,
and `attested` as empty. These are the weakest readings, and they are what a host gets for
saying nothing.

### 3.1 The repetition rule

Every execution span and every crossing span carries the declaration. It is repeated per span,
not stored once.

- Every span a host emits for one dispatch MUST carry the same declaration values.
- A host MUST compute those values from its own configuration for the profile it enforced, never
  from anything the program wrote or the caller claimed. A profile selected per dispatch is
  legitimate only when the host itself enforces the resulting capability, for example a network
  flag its own sandbox honours.
- A host that cannot tell which profile served a dispatch MUST declare the weakest values that
  cover every profile it can reach, and MUST attest nothing.
- A host MAY additionally place the same attributes on the Resource, for backends that facet on
  Resource. The span attributes are normative. Where the two disagree, the span wins and a
  consumer SHOULD count the disagreement.

A crossing span carries the declaration because a crossing span can reach a consumer without its
execution span: sampled separately, exported in a different batch, or emitted for an execution the
host never closed. A record that cannot be read alone is a record that has to arrive with its
context intact, and nothing in a telemetry pipeline promises that.

The cost is five attributes on every span. The default `AttributeCountLimit` is 128 and a
crossing span defined here carries at most fifteen attributes, so the repetition fits. It is not
free: an execution with a thousand crossings pays for the declaration a thousand times, and no
attribute interning is guaranteed on the wire.

### 3.2 Why not the Resource

An earlier draft put the declaration on the Resource. Two independent facts killed it, and
either one alone is enough.

**An API-only emitter cannot write a Resource attribute, ever.** `specification/resource/sdk.md`:
"A Resource is an immutable representation of the observed entity for which telemetry is being
produced", "Resources are immutable", and "a resource can be associated with the TracerProvider
when the TracerProvider is created. That association cannot be changed later."
`specification/library-guidelines.md` says instrumentation depends only on the API and cannot
implement resource detection or instantiate providers. The Resource belongs to the application
owner, and the application owner is the party that does not know about code mode. A host library
can ship a resource detector and hope the owner wires it, which is a deployment step that will
sometimes not happen, and silence reads as `none`.

**Capabilities are not static per process.** A profile MAY be selected per dispatch from a parameter
the caller supplies, provided the host itself enforces the resulting capability. The profile survey
has shipped examples. smolagents picks a local
executor or a remote one per agent, in one Python library and one process, and those two
executors do not have the same answer for `observes_crossings`. mcp-use picks a VM executor or a
hosted sandbox per session, in one npm package, and those two do not have the same answer for
`attested` or for `crossing_edge`. One TracerProvider has exactly one Resource, so a Resource
cannot say that an absence of crossings on this execution means none happened while on that
execution it means the host cannot see them. That inference is the only thing the declaration
exists for.

**Instrumentation scope attributes are not a fallback.** The trace API has accepted scope
attributes since specification 1.13.0, but the JavaScript API's `TracerOptions` carries only
`schemaUrl`, and the reference emitter for this model is JavaScript. A carrier that does not
exist in the first language an implementer will reach for is not a carrier.

What the Resource loses, stated plainly: immutability. A Resource could not vary per span, and
that was a structural guarantee the repetition rule now has to state as a rule instead. The two
bullets in section 3.1 are what replaces it, and they are enforced by nothing but the host's own
code.

`service.name` and `service.instance.id` identify the host itself, on the Resource, as usual.
This document mints no attribute for that.

## 4. Execution span

One dispatch of one program is one span.

| | |
|---|---|
| Name | `execute_code {gen_ai.tool.name}`, or `execute_code` when the dispatch did not arrive as a named tool call |
| Kind | `SERVER` when the dispatch arrived over a wire from an agent process; `INTERNAL` when the runtime dispatched it in-process |
| Starts | when the host first observes the dispatch, which for a host that runs the program is acceptance of the submission, including submissions it then rejects |
| Ends | when the host closes the execution |
| Parent | the caller's span, taken from the incoming request context by the usual W3C propagation |

`gen_ai.operation.name` is `execute_code`. That value is not in the well-known list upstream and
this document proposes it. The nearest existing values, `invoke_workflow` and `plan`, both
describe model-driven orchestration rather than the dispatch of one program, and `execute_tool`
is taken by the crossing and by MCP's own rule. The cost of a new value is real: no existing
consumer recognises it until it lands upstream. The cost of reusing `execute_tool` is worse,
because then an execution and the crossings inside it are indistinguishable by operation name,
and any consumer counting tool calls counts each execution twice.

**Exactly one span per dispatch carries `code_mode.execution.disposition`, and that span is the
execution span.** A host that already emits an MCP server span covering exactly this dispatch MAY
put the execution attributes on that span instead of creating a child, following the MCP
convention's own rule against duplicating a span another instrumentation already owns. It then
leaves `gen_ai.operation.name` and the span name as MCP sets them. A consumer finds the execution
by the disposition attribute, not by the name. Section 17 records that two shapes is one too
many.

### 4.1 Status, and what it loses

| `code_mode.execution.disposition` | Span status |
|---|---|
| `completed` | leave `Unset` |
| `failed` | `Error` |
| `terminated` | `Error` |
| `abandoned` | leave `Unset` |

**Instrumentation does not set `Ok`.** `specification/trace/api.md`: "Generally, Instrumentation
Libraries SHOULD NOT set the status code to `Ok`, unless explicitly configured to do so." The
emitter this document describes is an instrumentation library, so `completed` is left `Unset`
unless the application owner turns `Ok` on explicitly. The record format this replaces mapped
`completed` to `OK`, which was legal there because a sink is an application. The emitter is not.

The collapse this produces, stated as a table because nobody should discover it from a dashboard:

| Status | covers |
|---|---|
| `Unset` | `completed`, `abandoned`, and every execution still running |
| `Error` | `failed`, `terminated` |

Four dispositions become two observable states, and three outcomes become two on the crossing
span (section 5.1). In the one field every backend aggregates, alerts on and colours, a completed
execution is indistinguishable from an abandoned one, and a failed execution is indistinguishable
from a terminated one. C4 says that when an end exists the host can tell `completed` from every
other disposition; after this move that claim lives only in the attribute.

**So: `code_mode.execution.disposition` and `code_mode.crossing.outcome` carry the normative
values. A consumer MUST read them. Span status is a display hint.** That is why both attributes
are Required.

`terminated` is `Error` even when the stop was an ordinary user cancellation. An operator who
does not want cancellations in an error rate filters on `code_mode.execution.disposition` and
`error.type` rather than on Status. The alternative considered was `Unset` for a `terminated`
execution whose error class is `cancelled`, which was rejected because it makes a cancelled run
indistinguishable from a clean one in Status, and because one rule with no exception is one fewer
thing to get wrong.

**The status description carries a closed-vocabulary value, not the host's error message.** Set it
to `error.type`, or to the disposition. This diverges from the MCP convention, which sets the
description from the error message, and the divergence is deliberate: the description is the one
field on a span that has no attribute key, so nothing can carry a provenance label beside it. On
most hosts an error message is the program's own words, and putting those in the one unlabellable
field publishes a program claim as prose that every UI renders as the reason a run failed. A
closed-vocabulary host-observed value needs no label, which closes the problem by construction
rather than documenting it. The message itself belongs in `code_mode.error.body`, where it can be
labelled and where section 7 can say what was cut.

### 4.2 Attributes

| Attribute | Type | Requirement | Source |
|---|---|---|---|
| `gen_ai.operation.name` | string | Required | the constant `execute_code` |
| `code_mode.execution.disposition` | string | Required | one of `completed`, `failed`, `terminated`, `abandoned` |
| the five declaration attributes | section 3 | Required | section 3 |
| `code_mode.execution.id` | string | Required | the host's own id for this execution; see below when it has none |
| `code_mode.program.hash` | string | Recommended | `sha256:` and 64 lowercase hex digits over the UTF-8 bytes of the dispatched program text |
| `code_mode.program.language` | string | Recommended | a role hint: `javascript`, `typescript`, `python`, `starlark`. Omit rather than guess |
| `gen_ai.tool.name` | string | Conditionally Required: when the dispatch arrived as a named tool call | the name of the code-mode tool, for example `execute` |
| `gen_ai.tool.call.id` | string | Recommended | the caller's tool-call id for this dispatch |
| `gen_ai.conversation.id` | string | Conditionally Required: when the host's grouping is a conversation or agent session | see below |
| `mcp.session.id` | string | Conditionally Required: when the dispatch arrived over MCP in a session | the MCP session id |
| `error.type` | string | Conditionally Required: when the status is `Error` | section 4.3 |
| `code_mode.program.text` | string | Opt-In | the program text the host dispatched |
| `gen_ai.tool.call.result` | any | Opt-In | the value the host returned on its return channel |
| `code_mode.output.<channel>` | any | Opt-In | one per captured output channel: `stdout`, `stderr`, `logs`, `files` |
| `code_mode.error.message` | string | Opt-In | the human-readable reason, which the status description no longer carries |
| `code_mode.error.body` | any | Opt-In | the raw error object as the host produced it |
| `code_mode.capture` | any | Recommended: when the host shortened or removed any value above, or records sizes | section 7 |

`code_mode.execution.id` earns its place because the span id is minted by the SDK and is not the
id in the host's own logs. An engineer holding a log line that names an execution needs a way back
to the span.

It is Required rather than Recommended, and the difference matters more than it looks. A host that
omits it produces spans that cannot be gathered into a run by any span-scoped query, and such a
query returns no rows rather than an error, so the omission is invisible until someone is debugging
at the wrong moment. **A host that has no id of its own MUST mint one and use it on every span of
that dispatch.** A minted id answers "the crossings of this execution" exactly as well as a real
one; what it cannot do is match a host log line, which is the reason a host that has an id should
pass it rather than let one be made up.

`code_mode.program.hash` carries C1. It is how two dispatches of the same text are matched, and
it is the only thing left when the program itself is withheld for privacy. A host that withholds
the text emits the hash and records the withholding in `code_mode.capture`.

`code_mode.program.text` is Opt-In because it is agent-written code and routinely carries
customer data. The program is not guaranteed to be everything that ran, nor byte-identical to
what the runtime parsed, and a dispatch of several ordered segments may stop before the last one
runs. A consumer MUST NOT infer from the disposition that any particular part of the program
executed.

`code_mode.program.language` carries C2: a host may not know the language it runs, and the label
exists for display and routing only. A consumer MUST NOT use it to predict what will parse. The
core `code.*` registry was checked at 2026-09-19 and has no language attribute: it holds
`code.column.number`, `code.file.path`, `code.function.name`, `code.line.number` and
`code.stacktrace` as Stable, and five deprecated spellings. `telemetry.sdk.language` is the
telemetry SDK's own language, not the program's.

`gen_ai.conversation.id` is the session grouping, and only when the grouping really is a
conversation or agent session. A container id or a worker id is not a conversation: a host with
one of those uses an attribute in its own namespace, per section 8. The upstream rule holds: when
no identifier is available, do not populate it, and never fall back to a new UUID, a trace id or
a hash of the request.

`code_mode.output.<channel>` carries X4. The channel name is the last component. Presence is the
host's declaration that it captures that channel, so a host that captures a channel emits it on
every execution span, empty value and all. Without that rule an absent `stderr` means either "not
captured" or "captured and empty", and a consumer building an inventory from observed channels
gets a different answer per run of the same host. Because the attribute is Opt-In, this rule
binds only when the application owner has turned it on; when it is off, nothing is emitted and
nothing is claimed.

### 4.3 `error.type` on an execution

`error.type` is Stable, low cardinality, with a well-known fallback value of `_OTHER`. Set it
only when the status is `Error`. Recommended values, each a low-cardinality identifier:

`validation` for a rejection before the program ran, including a parse failure; `runtime` for an
ordinary error the program raised after admission; `timeout` for the host's own time limit;
`resource_limit` for a declared non-time limit, such as memory or output size; `cancelled` for a
stop by the caller or another external actor; `approval_rejected` for a gate that declined;
`host_failure` for the host's own process or infrastructure failing, and for a reconciliation
that closed the record `abandoned`; `_OTHER` when the host has a disposition and no reason it can
name.

A host MAY use a more specific low-cardinality identifier, such as an exception class name, and
SHOULD document the values it emits. It MUST NOT put an unbounded value here: this attribute is
one most backends facet on.

Read section 6 before trusting this attribute. On most hosts the class is derived from something
the program wrote.

### 4.4 The states a span cannot hold

A span is exported when it ends. A dispatch the host never closed is not in the trace at all, and
is indistinguishable from one that never happened. The running state and the unresolved state
have no representation here. That is the price of the move.

Closing a past-deadline execution `abandoned` at a later reconciliation is what puts it back in
the trace, and it is the host's job, never the consumer's. A consumer MUST NOT synthesize an
ending for a span it never received, and MUST NOT read the duration of an `abandoned` execution
span as how long the program ran: the span ends when the host gave up.

A host that needs the running state visible MAY emit a log record for it, carrying the same
attributes and the trace id and span id of the execution span so a query joins the two. This
document defines no event name, no body shape and no severity for such a record, and a consumer
MUST NOT depend on one existing. It is an escape hatch, not a second model.

## 5. Crossing span

One recorded invocation from the program across the host-provided boundary is one span.

| | |
|---|---|
| Name | `execute_tool {gen_ai.tool.name}` |
| Kind | `CLIENT` when the host forwards the call toward a remote target; `INTERNAL` when the host serves it in its own code |
| Starts | when the host observes the invocation |
| Ends | when the host determines the outcome, or when it closes the crossing unsettled |
| Parent | the execution span |

The name and kind follow the existing `gen_ai.execute_tool.internal` span, which uses `INTERNAL`,
and `mcp.client`, which uses `CLIENT`. Both precedents are upstream; this document borrows rather
than invents. Span kind carries no information about whether the host mediated the boundary or
merely parsed the program's claim about it, so it is orthogonal to `observes_crossings` and to
provenance.

**Parentage places a crossing; it does not identify its execution.** A crossing span is a child of
its execution span, which is how a viewer nests them. Where the program runs in another process the
host propagates the execution span's context to the code that serves the bridge, so the crossing
span is still a child. Section 6.6 says why that context must never come from inside the sandbox.

Parentage carries the parent's **span id**, which is minted by the SDK and is not the id in the
host's own logs. So `code_mode.execution.id` is Recommended on a crossing span as well, for exactly
the reason section 3.1 repeats the declaration: a crossing span reaches a consumer without its
execution span often enough that it must be readable alone. Three cases, each of which was found by
running the query rather than by reasoning about it:

- **A span-scoped query cannot join.** A backend that filters spans one at a time, which is what
  TraceQL and every span-search box do, cannot express "the crossings of execution X" when only the
  parent carries X. A query written that way matches nothing, and it fails silently.
- **A log line carries the host's execution id, not a span id.** Going from an operator's log line
  to the calls that run made needs the same key on both sides.
- **A process that dies mid-run orphans its crossings.** The execution span was never exported, so
  the parent id resolves to nothing and the crossings are unreachable by any key an operator holds.

An earlier draft of this document argued that parentage made the attribute unnecessary. That was
wrong, and it was wrong in a way that only showed up when someone wrote the query.

**Crossings may overlap and carry no order.** Sibling spans have no ordering in OpenTelemetry,
which is exactly right: C10 says crossings within an execution are unordered unless `seq` or
host-clock timestamps say otherwise. A consumer MUST NOT infer order from the order spans arrive,
and MUST NOT assume crossings are sequential.

**A crossing served by another execution** is that execution's span, as a child of the crossing
span when the context propagated, and as a span link when it did not. This is C13, and
OpenTelemetry satisfies it natively; nothing new is defined for it.

**Open crossings when the execution ends.** When an execution ends, the host ends every crossing
span still open that it can still account for, with outcome `abandoned`, before it ends the
execution span. A crossing whose bookkeeping was lost with the process that opened it produces no
span. A settlement that arrives after the crossing was closed is not attributed to it.

A host that observes one SHOULD record it as a span event named `code_mode.late_settlement`, on the
**execution** span, carrying `gen_ai.tool.call.id` to name the crossing it belongs to. Nothing is
minted for that: it is the attribute the crossing span already carries for the host's own id, and a
host that did not set it there has no name to give the event either. Not on the crossing span: that span has ended by the time a late settlement exists, and the specification makes
every operation on an ended span a no-op, so the event would be silently discarded. Where the
execution span has ended too, which is the usual case because the execution ending is what closed
the crossing, the trace has nowhere to put it and the log record in section 4.4 is the only place
left. Section 16 records that.

### 5.1 Status

| `code_mode.crossing.outcome` | Span status |
|---|---|
| `output` | leave `Unset` |
| `error` | `Error` |
| `abandoned` | leave `Unset` |

Three outcomes, two states. `Unset` covers `output` and `abandoned`, which are the two outcomes a
reader most needs to tell apart. `code_mode.crossing.outcome` is Required for that reason, and
section 4.1's rule applies here too: the attribute is normative, Status is a display hint.

`abandoned` is not a failure and not a success. It says the host stopped observing and closed the
record before it had determined either, usually because the execution ended first. **It is not a
claim that the target never responded.**

Outcomes describe what the host itself determined at its own instrumentation point, not what the
program observed. The outcome is fixed at the instant the host accepts the target's answer or its
own refusal. A fault in a later delivery step does not change it: if the host determined `output`
and the value then failed to reach the program, the outcome stays `output`.

### 5.2 Attributes

| Attribute | Type | Requirement | Source |
|---|---|---|---|
| `gen_ai.operation.name` | string | Required | the constant `execute_tool` |
| `gen_ai.tool.name` | string | Required | the target |
| `code_mode.crossing.outcome` | string | Required | one of `output`, `error`, `abandoned` |
| the five declaration attributes | section 3 | Required | section 3 |
| `code_mode.crossing.timing` | string | Conditionally Required: when the host synthesized either span time | one of `start_only`, `end_only`, `none`; section 5.4 |
| `code_mode.execution.id` | string | Required | the same id as the execution span this crossing belongs to |
| `gen_ai.tool.call.id` | string | Recommended | the host's own id for this crossing |
| `code_mode.crossing.seq` | int | Recommended: when the host declares `observes_crossings: all` and has an initiation order | initiation order within the execution, from 1 |
| `gen_ai.tool.type` | string | Recommended | `function`, `extension` or `datastore`, when the host knows |
| `error.type` | string | Conditionally Required: when the status is `Error` | section 5.3 |
| `mcp.method.name`, `mcp.session.id` | string | Conditionally Required: when the crossing went over MCP and this span is the only span for it | section 5.5 |
| `gen_ai.tool.call.arguments` | any | Opt-In | the input, fixed at initiation |
| `gen_ai.tool.call.result` | any | Opt-In | the output, only under outcome `output` |
| `code_mode.error.message` | string | Opt-In | the human-readable reason for this call's failure |
| `code_mode.error.body` | any | Opt-In | the raw error object as the host or target produced it |
| `code_mode.capture` | any | Recommended: as on the execution span | section 7 |

The target goes in `gen_ai.tool.name`, uncut. Nothing is minted for it, because that attribute
already means the right thing and reusing it is what makes a code-mode crossing legible to a
consumer that has never heard of code mode. The target is whatever the host uses to name what was
invoked: a tool name, a `namespace.method`, a server and tool pair, a URL, a path. This document
does not interpret it. Section 16 states the price of that reuse on a host that does not attest
the target.

**Span names must stay low cardinality.** A host whose targets are unbounded, URLs for instance,
uses a bounded form in the span name and keeps the full target in `gen_ai.tool.name`. This is the
same allowance the MCP convention makes for resource URIs.

Input and output are typed `any`. Record them in structured form where the API supports it, and
as a JSON string otherwise, which is the rule GenAI states for every `any` attribute. Both are
Opt-In, because a crossing's arguments and results are the most sensitive values in the trace.
They are opaque: a consumer MAY display them and MUST NOT parse them, scan them for markers, or
infer from them whether the value is inline text, base64 binary or a reference the host holds
instead of content.

`code_mode.crossing.seq` carries C10 for hosts that have an order. A host that silently retries
emits one span with the final outcome; the attempt count goes in the host's own namespace, per
section 8.

### 5.3 `error.type` on a crossing

Recommended values: `capability_error` when the target returned an error for this call or the host
cannot say more; `validation` when the input was rejected as malformed; `refused` when the host
declined to dispatch by its own policy, before the target saw it; `timeout` for this call's own
time budget; `cancelled` when the target or host reported a cancellation; `approval_rejected` for
a gate on this specific call; `_OTHER` when the host cannot classify.

Where the crossing was an MCP tool call that returned `CallToolResult` with `isError` true,
`error.type` is `tool_error`, which is the MCP convention's own rule.

An `abandoned` crossing carries no `error.type`. Nothing failed; the host stopped watching.

### 5.4 Times, and the crossing that settled without one

A span always has a start and an end, therefore always a duration. **OpenTelemetry has no
representation for "settled, duration unknown."** This is a gap in the data model and no
convention closes it.

Crossing times are optional in the model: their presence is the host's declaration that it has
host-clock timing for the crossing. A span needs both, so the host fills what is missing and says
that it did.

| host has `start` | host has `end` time | span start | span end | `code_mode.crossing.timing` |
|---|---|---|---|---|
| yes | yes | the start | the end | not set |
| yes | no | the start | the start | `start_only` |
| no | yes | the end | the end | `end_only` |
| no | no | the host's own reading at close | the same | `none` |

The attribute is present exactly when a time was synthesized. All three synthesized cases are
zero-duration spans, and **a consumer MUST NOT read their duration as the crossing's duration.**
Under `none` the span's position says only when the host closed it.

An `abandoned` crossing usually lands in `start_only`. A trace viewer renders that as a
zero-width tick inside its parent, with no status colour, which reads to the eye as a call that
did not happen. It is the opposite. The case worth keeping in mind is a five thousand dollar wire
transfer that the host started, stopped watching when the execution's time limit fired, and closed
`abandoned`. The transfer may
or may not have gone out. Section 15 shows what that trace looks like.

The inference this attribute exists to block, stated as a rule: a
consumer MUST NOT treat an unresolved crossing as evidence the call is still in progress, or an
`abandoned` crossing as evidence the target never responded. Both say only that the host stopped
observing.

### 5.5 A crossing that went over MCP

The MCP convention says: "If the MCP instrumentation can reliably detect that outer GenAI
instrumentation is already tracing the tool execution, it SHOULD NOT create a separate span.
Instead, it SHOULD add MCP-specific attributes to the existing tool execution span."

A code-mode crossing dispatched over MCP is exactly that case. The host emits **one** span,
carrying the crossing attributes and the MCP attributes together: `mcp.method.name` (`tools/call`
for a tool call), `mcp.session.id` when there is a session, and `mcp.resource.uri` when the method
takes one.

A sink reading a record after the fact cannot know whether a crossing was an MCP request, because
no field says so. A host knows, and should say.

Where MCP client instrumentation is running in the same process and cannot detect the outer span,
two spans per crossing is the result. That is a real failure and this document cannot prevent it
from here; see section 16.

## 6. Provenance

### 6.1 The problem

A code-mode program is agent-written, and it can lie.

Some hosts build crossing records out of things the program wrote. Such a program can print a
line that becomes a crossing span for a call it never made. It can throw an error whose message
the host parses into an error class, choosing the classification the trace will show. It can
return a value the host copies into an attribute. None of this requires an adversary: it is the
ordinary consequence of building telemetry out of a channel the subject controls.

Consumers of these traces are increasingly language models. A model reading "the program deleted
contact 42" needs to know whether the host saw that happen or the program said so.

**OpenTelemetry has no notion of the host-observed versus program-determined distinction, and no
per-attribute provenance channel anywhere in the data model.** `KeyValue` is a key and a value.
No field in Span, Resource, LogRecord, Link or Event annotates a value with where it came from.
That narrow claim is the contribution. The broader claim, that OpenTelemetry has no trust or
provenance work at all, is false and section 11 lists the open work that overlaps this.

### 6.2 Three classes

**H, host-observed.** Determined at a point the program cannot write through: the host's own
clock, its own id generation, an exit status, a call boundary the host mediates. Relative to the
declaring host and conditional on its isolation not being bypassed. H means faithfully observed
by this host. It does not mean true and it does not mean safe.

**P, program-determined.** Authored by the program, or computed by the host from a channel the
program can write: the program text, standard output and error, thrown errors, files, return
values, and anything derived from those.

**T, target-relayed.** Passed by the host unchanged from the target of a crossing, or produced by
the host's own handling of that crossing, such as a refusal or a policy error. The program did
not shape it.

Whether a program is adversarial is a deployment question. These labels are about fidelity, not
intent.

### 6.3 The design, and the three that lose

**A. A per-span attribute listing which attribute keys on this span are program-determined.**
Rejected. It fails open: an emitter that adds an attribute and forgets to add it to the list
silently promotes a claim to an observation, and the failure is invisible. It also lets the list
drift with whatever the emitter happened to write on that span, which is the wrong thing for the
claim to track.

**B. A naming convention that encodes provenance in the key**, such as
`code_mode.claimed.tool.name` beside `code_mode.observed.tool.name`. Rejected, and this is the
decisive one. The attributes whose provenance is in question are the borrowed ones:
`gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `error.type`.
Encoding provenance in the key means minting parallel names inside `gen_ai.*` and `error.*`,
which the naming rules forbid, or abandoning reuse and shipping a private vocabulary no existing
consumer reads. That is the fragmentation this whole move exists to avoid. It has a second
failure: the key changes when a host improves, so a host that moves from parsing stderr to
mediating the boundary breaks every saved query, dashboard and alert built on its traces. A
design that punishes the honest upgrade is wrong.

**C. A declaration of what the host attests, from a closed list of model fields, plus a fixed
table of baseline classes in this document.** Chosen. It works on borrowed keys, because it names
model fields and this document maps them to attribute keys once. It fails safe: a field nobody
attested is a program claim, so an emitter that forgets something under-claims rather than
over-claims. Its vocabulary is fixed by this document and cannot drift with the emitter's
attribute set, which is what separates it from A. And a consumer that ignores this convention
entirely still gets a valid, useful trace, with correct `gen_ai.*` attributes and correct
parentage; it simply does not learn what was observed and what was claimed.

**A, revisited, and adopted in part.** The objection to A is about where the classes come from,
not about the wire shape. A list the emitter assembles from whatever it happened to write can
drift; a label the emitter computes from **this document's fixed table** cannot, because the table
is not the emitter's to change and a field it has never heard of is simply not labelled, which
under-claims. So C fixes the vocabulary and A's shape carries it: alongside `code_mode.attested`,
an emitter writes `code_mode.provenance.<attribute key>` next to every value whose effective class
is `P` or `T`, and writes nothing beside a host-observed one. This is not a third design; it is C's
table, materialized. The record format's own OpenTelemetry export has done exactly this since it
was written, which is the standing proof that the shape is safe when the source is fixed.

Without it, a consumer learns nothing. `code_mode.attested` on its own is an answer to a question
the consumer does not know to ask, and joining it against section 6.5 requires finding and reading
this document. Almost nothing will. The label is what makes the idea survive contact with a
backend, and it costs one attribute per unobserved field.

**D. A span event or log record per value, carrying that value's provenance.** Rejected:
unbounded volume, and it moves the claim away from the value.

The cost of C, stated plainly. A consumer must read one table in this document to know which
attributes are provenance-bearing, and must read the declaration on the span. It cannot work that
out from an attribute in isolation. And because the declaration is a span attribute rather than a
Resource attribute (section 3.2), nothing structural stops a host varying it per span. Section 3.1
states the rule; only the host's own code enforces it.

### 6.4 `code_mode.attested`

`code_mode.attested` is a string array from this closed list. A consumer MUST ignore an entry it
does not know.

| Entry | Upgrades | To |
|---|---|---|
| `crossing.target` | `gen_ai.tool.name`, `code_mode.crossing.seq` and `code_mode.crossing.outcome` on crossing spans | H |
| `crossing.input` | `gen_ai.tool.call.arguments` on crossing spans | H |
| `crossing.output` | `gen_ai.tool.call.result` on crossing spans | T |
| `crossing.error` | `error.type`, the status description and `code_mode.error.body` on crossing spans | T |
| `execution.error.class` | `error.type` and the status description on execution spans | H |
| `host_attributes` | the attributes named in `code_mode.attested_attributes` (section 8) | H |

The entries are bundled rather than per attribute because they travel together. A host that
observed the call boundary observed the target, the order and the outcome; a host that attested
the outcome but not the target would be claiming something incoherent, and a closed list of six
is shorter to write, shorter to read, and impossible to spell wrong.

Rules, and they are the rules the underlying model already states:

- A host attests only what is true for **every** span it emits. There is no per-span attestation
  and no per-span opt-out. A host with both an observed path and a parsed path for the same field
  does not attest it.
- A host that declares `crossing_edge: dispatch` SHOULD attest `crossing.target`. `dispatch`
  names what the host itself sent, so claiming that edge while not observing the target is
  contradictory. `crossing_edge: invocation` carries no such expectation: an invocation span is
  the program's view by definition, which is what the next rule is for.
- A host that derives crossings from program-written channels MAY still emit them. It simply does
  not attest them, and consumers read them as program claims. This is a feature. A
  stdout-parsing host that emits unattested crossings is more useful than one that emits nothing,
  as long as nobody mistakes the two.
- Attestation makes a claim visible and attributable. It does not make it true. Nothing in a trace
  distinguishes a host reading its own call boundary from a host copying a value out of the
  program's return and attesting it anyway. No format detects that. Attestation puts a name on
  the claim, which is all a format can do.

### 6.5 Baseline classes

Everything not in this table is H: span ids, parentage, start and end times, the five declaration
attributes, `code_mode.execution.id`, `code_mode.execution.disposition`,
`code_mode.crossing.timing`, `code_mode.program.hash`, `gen_ai.tool.call.id`,
`gen_ai.conversation.id`, `mcp.session.id`, `mcp.method.name`, and every entry inside
`code_mode.capture`.

| Attribute | Span | Baseline | Entry that upgrades it | After |
|---|---|---|---|---|
| `code_mode.program.text` | execution | P | none | P |
| `code_mode.program.language` | execution | P | none | P |
| `gen_ai.tool.call.result` | execution | P | none | P |
| `code_mode.output.<channel>` | execution | P | none | P |
| `error.type` | execution | P | `execution.error.class` | H |
| status description | execution | P | `execution.error.class` | H |
| `code_mode.error.message` | execution | P | none | P |
| `code_mode.error.body` | execution | P | none | P |
| `gen_ai.tool.name` | crossing | P | `crossing.target` | H |
| `code_mode.crossing.seq` | crossing | P | `crossing.target` | H |
| `code_mode.crossing.outcome` | crossing | P | `crossing.target` | H |
| `gen_ai.tool.call.arguments` | crossing | P | `crossing.input` | H |
| `gen_ai.tool.call.result` | crossing | P | `crossing.output` | T |
| `error.type` | crossing | P | `crossing.error` | T |
| status description | crossing | P | `crossing.error` | T |
| `code_mode.error.message` | crossing | P | `crossing.error` | T |
| `code_mode.error.body` | crossing | P | `crossing.error` | T |
| host's own namespace | either | P | `host_attributes`, per key | H |

**These classes are written onto the span.** For every attribute above whose effective class is `P`
or `T`, an emitter writes `code_mode.provenance.<that attribute's key>` with the value `P` or `T`. A
field that is host-observed, whether at baseline or after attestation, carries no such attribute,
so absence means observed and a field the emitter has not heard of under-claims rather than over-
claims. A host's own attribute (section 8) is labelled `P` unless `host_attributes` is attested and
the key is named in `code_mode.attested_attributes`.

Three readings worth spelling out, because they are the ones that surprise people.

**A span's own name and its status follow the attributes they came from.** A crossing span is
named from `gen_ai.tool.name`, so under an unattested host the span name itself is a program
claim. The status follows `code_mode.crossing.outcome`, which follows `crossing.target`, so under
an unattested host the red span in the UI is a program claim too. Neither the name nor the status
can carry a label, which is limitation L3 in section 16.

**The status description cannot be labelled.** It has no attribute key, so nothing can name it in
a list and nothing can carry its class beside it. It is in the table above so that a consumer
knows what it is reading. A host SHOULD NOT put anything in the description that is not also in
an attribute, and a host MUST NOT make the description the sole carrier of anything a consumer
needs.

**`code_mode.program.text` is never attestable, and neither is `code_mode.program.hash`'s
subject.** The program is by definition what the agent submitted. The hash is H because the host
computed it, over content that is P. A host-observed hash of program-determined content is
exactly what it sounds like, and it is still the right way to match two executions.

### 6.6 Rules a consumer applies, and one a host must

For any attribute whose effective class is P:

1. **Display it distinguishably.** A viewer shows a program-reported marker or a distinct style.
   It does not show it the way it shows a timestamp.
2. **Exclude it from any aggregate presented as host-observed fact.** Aggregates over program
   claims are legitimate when labelled as such. Section 9 is the hard form of this rule.
3. **When handing records to a language model, supply the classes alongside** and state that P
   values are unverified program output.
4. **Never parse it.** Do not scan a P value for structure or markers.

For T: the content came from the target, or from the host's own handling of the crossing, and the
program did not shape it. It is a claim about what the target returned, not something the host
verified against the world.

For H: observed by the declaring host, subject to that host's isolation. A consumer that does not
trust the host trusts nothing.

And the rule for hosts, which is new here and has no counterpart in the record format, because
trace context did not exist there:

**A host MUST NOT accept trace context or spans minted inside the sandbox.** If the program can
supply a `traceparent` that the host then uses as the parent of its own spans, the program
chooses where its execution appears in the trace, and can attach its records to another tenant's
trace. If the program can emit spans that reach the host's exporter, it can write any attribute
on any span, including the ones this document marks H. Context flows into the sandbox, never out
of it. A host that gives the program its own tracer has made every span it emits
program-determined, and must attest nothing.

## 7. Capture: truncation, redaction and size

OpenTelemetry has no way to say that a value on a record was shortened or removed. The SDK's own
attribute value length limit truncates silently. `dropped_attributes_count` says an attribute was
dropped whole; it says nothing about a value that survived in shortened form. So this is minted,
in one attribute.

`code_mode.capture` is a map from attribute key to a note about what the host did to that value.
It is typed `any`: record it in structured form where the API supports it, and as a JSON string
otherwise. Reading it is reading an envelope, not parsing a payload, so the rule in section 5.2
against parsing values does not apply to it.

| Field | Type | Meaning |
|---|---|---|
| `truncated` | boolean | the value on the span is a prefix of the host's serialization of the original. It need not parse |
| `redacted` | boolean | the host removed or replaced the content by policy. The attribute itself may be absent |
| `bytes` | int | the size in bytes of the host's serialization of the original |
| `hash` | string | `sha256:` and 64 lowercase hex digits over the host's serialization of the original |

Example, as a structured value:
`{"gen_ai.tool.call.result": {"truncated": true, "bytes": 6224, "hash": "sha256:..."}}`.

Rules:

- Every entry is H wherever it appears. Each is the emitter's own record of what it did to its own
  capture, and no attestation entry moves it.
- `truncated` and `redacted` are authoritative. Absence of an entry for a key means the emitter
  neither shortened nor removed that value.
- **Redacted is not the same as not recorded.** An Opt-In attribute the host never records is
  simply absent, and its absence says nothing. `redacted` says the host held the value and removed
  it by policy. This is the only way to tell "we capture stderr and it is withheld here" from "we
  do not capture stderr", now that presence alone cannot say it for an Opt-In attribute.
- A host that drops a value because it could not serialize it, a cycle or a throwing serializer,
  dropped it by its own policy, and that is `redacted`. `truncated` is only ever a prefix of a
  serialization the host did produce.
- `bytes` and `hash` describe the original, never the prefix, and are comparable only within one
  host, because serialization is host-defined.
- A host that also writes an in-band marker into a value, such as a truncation note in the text,
  still sets `truncated`. The out-of-band flag is authoritative; the marker is content.
- A program withheld for privacy is an absent `code_mode.program.text`, a present
  `code_mode.program.hash`, and an entry `{"redacted": true, "bytes": N}`.

**Cut the value yourself.** A host SHOULD shorten a large value in the emitter and record the
truncation, rather than letting the SDK's value length limit cut it silently downstream. Cut on a
UTF-8 code point boundary. Set the cap below every downstream limit the host knows of, in the
SDK, the collector and the backend.

`code_mode.capture` is itself an attribute and is itself subject to those limits, so keep it
small. It has one entry per value slot, so on the spans defined here it never exceeds a handful.

Section 16 records the two limits this does not close.

## 8. The host's own attributes

A host has values of its own: credits spent, a sandbox id, a subprocess exit code, an attempt
count, a cache result, a model name. These go in the host's own namespace, formed from its
reverse domain name or its application name, for example `com.acme.credits_used`. They are never
minted inside `gen_ai.*`, `mcp.*`, `code_mode.*` or `otel.*`.

They are **P at baseline**, like everything else the host did not declare it observed. A host
lists the ones it determines at a point the program cannot write through in
`code_mode.attested_attributes`, and adds `host_attributes` to `code_mode.attested`. Both gates
are needed, for the reason the underlying model gives: the list alone is an upgrade path
invisible in the attested declaration, which is the one place a consumer looks for an observation
claim; and the entry alone would upgrade every host attribute at once, forcing a host to choose
between recording a value the caller supplied and attesting its own meter.

A host's own reading of its own meter is H. A number it copied out of a target's reply, or out of
the program's return value, is not, and one boolean cannot say which, so such a host leaves the
key off the list.

Nothing is minted for units, aggregation or display names. OpenTelemetry already models them on
the metric instrument: the instrument type is the aggregation, the instrument unit is the unit,
the instrument description is the display name. Use UCUM where one exists, `By`, `ms`, `s`, and a
curly-brace annotation otherwise, `{credit}`, `{token}`.

## 9. Metrics

**One rule. A metric point MUST NOT be keyed by, or measured from, any attribute whose effective
class is P.**

A metric point has no per-point provenance channel. A P value exported as a metric silently
presents a program claim as fact, and a label added as a point attribute would become a
cardinality dimension and make the metric unsummable across it. A P value stays on the span,
where section 6.5 says what it is.

Four consequences, and the first is the one that costs something.

**`gen_ai.execute_tool.duration` is conditional here.** That histogram is Recommended upstream and
its dimensions are `gen_ai.tool.name`, `gen_ai.tool.type` and `error.type`. On a code-mode
crossing `gen_ai.tool.name` is the target, which is P unless the host attests `crossing.target`.
So: a host MUST NOT emit `gen_ai.execute_tool.duration` for a code-mode crossing unless it attests
`crossing.target`, and MUST NOT include `error.type` as a dimension unless it also attests
`crossing.error`. A host that attests neither keeps the span and drops the metric.

**MCP operation metrics are conditional for the same reason.**
`mcp.client.operation.duration` and `mcp.server.operation.duration` are keyed on
`mcp.method.name`. On a crossing the host reconstructed from program output, the method name is
the program's claim, and the rule applies unchanged.

**A host-specific value becomes a metric point only when `host_attributes` covers it** (section
8).

**What is always legal.** The execution span's own times, `code_mode.execution.disposition` and
the five declaration attributes are H on every host. A duration histogram over executions, keyed
on disposition, is therefore always sound. This document does not define one; section 17 asks
whether it should.

Keep point attributes to low-cardinality dimensions. Never an execution id, a crossing id, a
session id or anything per user.

Section 16 records the part of this rule that cannot be enforced from inside a host.

## 10. Integration shape

Two wrappers. That is the whole integration, and it is what both blind integrations converged on.

**Wrapper one goes around the handler that runs the program.** It starts the execution span
before the program is dispatched, on the host's own clock, extracting the incoming trace context
from the request so the span has the caller's span as parent. It ends the span when the host
closes the execution, setting the disposition, and, on a non-normal end, the status and
`error.type`. It ends every still-open crossing span first.

**Wrapper two goes around the function the sandbox calls to reach the host.** It starts a crossing
span as a child of the execution span, records the target and the input at initiation, and ends
the span when the host determines the outcome.

Three things determine whether the result is worth anything:

- **Wrapper two must be host code, outside the sandbox.** A wrapper the program can reach, replace
  or observe is a channel the program writes through, and a host in that position attests nothing.
  This is the mechanical link between the integration shape and section 6: where the wrapper sits
  is what `observes_crossings` and `code_mode.attested` are describing.
- **Context flows in, never out.** Wrapper one puts the execution span's context where wrapper two
  can read it, in a context-local slot, in the bridge's own per-execution state, or over the
  bridge's own transport where the sandbox is another process. The program never supplies it. See
  section 6.6.
- **The emitter must not be able to change an outcome.** No emitter fault may raise into the
  caller, and no metering call may relabel an outcome. Record the outcome first, then measure.

Both wrappers write the declaration attributes from section 3 onto every span they start. Neither
wrapper needs an SDK. Both use the API only, so the application owner's configured exporters
receive the spans, which is the entire reason this is worth doing.

## 11. Relationship to open work upstream

State of `open-telemetry/semantic-conventions-genai` at 2026-09-19. Everything below is open, and
everything below is Development.

| Upstream | What it does | Relation to this document |
|---|---|---|
| PR #370 | `gen_ai.attribution.link_type` on span links: `CAUSED_BY_GENERATION`, `RETRY_OF`, `INFORMED_BY`. Titled "tool-call provenance" | The same channel and an overlapping vocabulary for relating a retry or a replay to what it came from. The upstream version carries no count of attempts, which this project's own earlier design argued is mandatory because there is no safe default |
| Issue #406 | Correlating GenAI spans with verified execution-environment attestation. States that "absence of attestation attributes must not be interpreted as a failed verification" | The same fail-safe shape as `code_mode.attested`, for a different subject: it attests the environment, this attests what the host observed of the program |
| PR #445 | `gen_ai.agent.paused`, `.checkpointed`, `.resumed`, with `gen_ai.agent.execution.id`, `pause.reason`, `resumed_from.type`/`.id` | Suspend and resume, which this project modelled as events and links. Its own text names its blocker: "LangGraph exposes no id spanning suspend and resume, so execution.id has no producer yet." `code_mode.execution.id` is exactly that id, defined and Required by a model that has one |
| Issue #509 | Whether MCP tool calls are an `execute_tool` refinement | Decides section 5.5 |
| Issue #511 | Stabilizing inference and core agentic execution conventions | Decides when any of this can stop being Development |
| Issue #373 | Tool risk attributes for `execute_tool` and MCP tool call telemetry | Adjacent. A risk label on a target the host did not observe has the same problem section 9 describes |

What is **not** covered upstream, checked the same day: of the eleven `gen_ai` span types
(`inference.client`, `embeddings.client`, `retrieval.client`, `fetch_response.client`,
`memory.client`, `create_agent.client`, `invoke_agent.client`, `invoke_agent.internal`,
`execute_tool.internal`, `invoke_workflow.internal`, `plan.internal`) none is a code execution or
sandbox span. The MCP conventions model MCP at the JSON-RPC method level only. Nothing upstream
models a submitted program, an execution, mediation, or the host-observed versus
program-determined distinction.

## 12. What a consumer may rely on, and what it must not

A consumer MAY rely on:

- Every execution span carries exactly one `code_mode.execution.disposition` from the closed set,
  and every crossing span exactly one `code_mode.crossing.outcome` from its closed set.
- Every span carries the declaration, and the declaration is the same on every span of one
  dispatch.
- A crossing span's parent is its execution span, or the two are joined by a span link.
- Start and end times are the declaring host's own clock readings, except where
  `code_mode.crossing.timing` says a time was synthesized. Crossing times and execution times are
  in the same clock domain, to whatever precision that host achieves.
- `code_mode.capture` is authoritative about what the emitter did to a value.
- Attributes covered by an entry in `code_mode.attested` are host-observed, or target-relayed,
  relative to the declaring host, and everything else in the section 6.5 table is a program claim.
- Under `observes_crossings: all`, no invocation through the host-provided surface went unrecorded
  by that host, short of sampling and export loss.

A consumer MUST NOT:

- **Read Status as the outcome.** `Unset` covers `completed` and `abandoned`. `Error` covers
  `failed` and `terminated`. The vocabulary attributes carry the answer.
- **Read a zero-duration crossing span as a crossing that took no time.** Read
  `code_mode.crossing.timing`.
- **Treat the absence of crossing spans as evidence no calls happened.** That inference needs
  `observes_crossings: all`, `unmediated_egress: false`, and a trace the sampler kept whole.
  Application owners SHOULD use a parent-based sampler so that an execution and its crossings are
  kept or dropped together; under a head sampler that decides per span, a missing crossing span
  means nothing at all.
- **Treat the absence of an execution span as evidence no execution happened.** An execution the
  host never closed is never exported.
- **Infer order from the order spans arrive, or from ids**, or assume crossings are sequential.
  Only `code_mode.crossing.seq` and host-clock timestamps carry order.
- **Assume the number of execution spans is the number of programs an agent submitted.** A host
  emits one per dispatch, including dispatches it made on its own: a reactive re-run, a retry, a
  speculative branch, a shard of a data-parallel job.
- **Assume one crossing span is one dispatch to the target, or one invocation by the program.**
  `crossing_edge` says which side the span describes, and nothing carries a count for the other
  side.
- **Read an `abandoned` crossing as evidence the target never responded**, or an unfinished
  operation as evidence it is still running. Both say only that the host stopped observing.
- **Read the duration of an `abandoned` execution span as how long the program ran.** The span
  ends when the host gave up, which is usually a later reconciliation.
- **Parse or interpret a payload value beyond displaying it.**
- **Treat an attribute in the host's own namespace as host-observed** unless it is named in
  `code_mode.attested_attributes` and `host_attributes` is attested.
- **Use trace context, `gen_ai.conversation.id`, `mcp.session.id`, or `gen_ai.tool.call.id` on an
  execution span, for authorization or billing attribution.** All of them are relayed from the
  caller, faithfully copied and unverified. `gen_ai.tool.call.id` on a crossing span is different:
  there the host minted it.
- **Assume the declaring host is trustworthy.** Host-observed means observed by that host,
  relative to its own isolation.

## 13. Attribute index

Eighteen keys, one new enum value and one span event. Each names the invariant it carries.
Everything else in this document reuses an attribute that already exists.

| Attribute | Type | Where | Carries |
|---|---|---|---|
| `code_mode.observes_crossings` | string | both spans | C5: mediation is declared, not assumed |
| `code_mode.unmediated_egress` | boolean | both spans | C5 |
| `code_mode.crossing_edge` | string | both spans | X2: two edges |
| `code_mode.attested` | string[] | both spans | X1: provenance |
| `code_mode.attested_attributes` | string[] | both spans | X1, for the host's own attributes |
| `code_mode.execution.id` | string | both spans | C3: identity, and the only key that reads a crossing alone |
| `code_mode.execution.disposition` | string | execution span | C3, C4: the closed disposition set Status cannot carry |
| `code_mode.program.text` | string | execution span | C1: one program per execution |
| `code_mode.program.hash` | string | execution span | C1: matching two dispatches of the same text |
| `code_mode.program.language` | string | execution span | C2: language is a hint |
| `code_mode.output.<channel>` | any | execution span | X4: no universal output channel |
| `code_mode.crossing.outcome` | string | crossing span | C6: the closed outcome set Status cannot carry |
| `code_mode.crossing.seq` | int | crossing span | C10: no implicit order |
| `code_mode.crossing.timing` | string | crossing span | C7: crossing times exist only where the host observed them |
| `code_mode.error.message` | string | either | C4: the reason, moved off the one field nothing can label |
| `code_mode.error.body` | any | either | C4: structured target errors that export would otherwise lose |
| `code_mode.capture` | any | either | C9: opaque payloads, truncation and redaction out of band |
| `code_mode.provenance.<attribute>` | string | either | X1: the class of the attribute it names, written only when that class is not host-observed |

New value: `gen_ai.operation.name = execute_code`, for an execution span. Proposed, not upstream.

One span event: `code_mode.late_settlement`, on the execution span, for an outcome that arrived
after the host closed the crossing (section 5). It names its crossing with `gen_ai.tool.call.id` and
mints no key of its own. It carries C6: a crossing settles once.

Reused without change: `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type`,
`gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`,
`gen_ai.conversation.id`, `mcp.session.id`, `mcp.method.name`, `mcp.resource.uri`, `error.type`,
and the whole trace data model: parentage, span links, span events and Status.

## 14. What the move away from a record format dropped

For a reader who knew the retired JSON Lines format.

- **Id derivation.** Span ids are minted by the SDK and trace context propagates natively. The
  host's own execution id survives as `code_mode.execution.id`.
- **`context.traceparent` as a field.** It is the incoming request context, extracted by the usual
  propagator. C13 is satisfied by parentage and links.
- **Start notices, and the unresolved state.** A span exports when it ends. Section 4.4.
- **The supersede and conflict rules.** They belong to a line-oriented format. Two spans with one
  span id are a backend problem, not this document's.
- **`dimensions`.** Aggregation, unit and display name are native to a metric instrument. What
  survives is section 9, the rule that a program-determined value never becomes a metric point.
- **`spec_version` as a field.** The scope version, and eventually `schema_url`, carry it.
- **Stateless sinks, malformed lines, line order.** All properties of a JSON Lines stream.
- **`OK` for a completed execution.** Section 4.1.

What did not drop: the model, the closed vocabularies, provenance, the capability declaration, and
the two-wrapper integration shape.

## 15. Worked example

One execution, two crossings, the second abandoned. Every value below comes from a fixture this
project has carried since before the move, and the emitter reproduces all of them.

The host is a synchronous bridge. It mediates every call at the call boundary and attests the
target, the input and the output. The program deletes a CRM record and then starts a wire
transfer. The transfer waits for an approval that never comes, the host's own five minute limit
fires, and the host closes the execution `terminated`. Before it does, it closes the wire transfer
crossing `abandoned` with no end time, because it never determined an outcome for it.

```
14:00:00.000  host accepts the dispatch            execution span starts
14:00:00.080  program calls crm.deleteRecord       crossing span starts
14:00:00.240  the delete returns                   crossing ends, outcome output
14:00:00.260  program calls finance.wireTransfer   crossing span starts
14:05:00.000  execution TTL elapsed                crossing closed abandoned, then execution ends
```

The execution span, as attributes:

| Attribute | Value |
|---|---|
| name | `execute_code execute` |
| kind | `SERVER` |
| status | `Error` |
| `gen_ai.operation.name` | `execute_code` |
| `code_mode.execution.disposition` | `terminated` |
| `code_mode.observes_crossings` | `all` |
| `code_mode.unmediated_egress` | `false` |
| `code_mode.crossing_edge` | `invocation` |
| `code_mode.attested` | `["crossing.target","crossing.input","crossing.output"]` |
| `code_mode.execution.id` | `3c95e2578dd5e0169e81c566e43fac92` |
| `code_mode.program.hash` | `sha256:bf15ddc985049f6ab5a1915a5e6235c149f48ef0e974318d2ca954a33ccec341` |
| `code_mode.program.language` | `javascript` |
| `error.type` | `timeout` |

The abandoned crossing span, in OTLP/JSON. Note the equal start and end times, the `timing`
attribute that says so, and the absent status, which is `Unset`. The span id is the SDK's;
the host's own id for the crossing is in `gen_ai.tool.call.id`, which is the only place a
reader holding a host log line can pick it up.

```json
{
  "traceId": "0057b132ad41f0ea8a76f9299ba13793",
  "spanId": "7d1c04e9b8a3f265",
  "parentSpanId": "bb27b8faea63e97b",
  "name": "execute_tool connectors.finance.wireTransfer",
  "kind": 3,
  "startTimeUnixNano": "1789567200260000000",
  "endTimeUnixNano": "1789567200260000000",
  "attributes": [
    {"key": "gen_ai.operation.name",         "value": {"stringValue": "execute_tool"}},
    {"key": "gen_ai.tool.name",              "value": {"stringValue": "connectors.finance.wireTransfer"}},
    {"key": "code_mode.crossing.outcome",    "value": {"stringValue": "abandoned"}},
    {"key": "code_mode.crossing.timing",     "value": {"stringValue": "start_only"}},
    {"key": "code_mode.crossing.seq",        "value": {"intValue": "2"}},
    {"key": "code_mode.observes_crossings",  "value": {"stringValue": "all"}},
    {"key": "code_mode.unmediated_egress",   "value": {"boolValue": false}},
    {"key": "code_mode.crossing_edge",       "value": {"stringValue": "invocation"}},
    {"key": "code_mode.attested",            "value": {"arrayValue": {"values": [
      {"stringValue": "crossing.target"}, {"stringValue": "crossing.input"},
      {"stringValue": "crossing.output"}]}}},
    {"key": "gen_ai.tool.call.id",           "value": {"stringValue": "a1fa92d32b26e374"}},
    {"key": "code_mode.capture",             "value": {"stringValue":
      "{\"gen_ai.tool.call.arguments\":{\"bytes\":36,\"hash\":\"sha256:b8af7ef3554cb1900ad0506f62b274834ac850def21311f494d115e7a1d33843\"}}"}}
  ]
}
```

What a reader gets right from this span: the target and the input are attested, so the call was
observed leaving, and the wire transfer really was initiated. `observes_crossings: all` with
`unmediated_egress: false` means there were exactly two crossings. The outcome is `abandoned`, so
the host never learned whether the transfer went out.

What a reader gets wrong if they read only the picture: a zero-width tick at 14:00:00.260, no
status colour, inside a five minute parent. It looks like nothing happened. Section 16, L4.

## 16. Limitations

Each of these is a fact about what this design cannot do. None is closed by anything in this
document, and none is argued away.

**L1. The emitter cannot write a Resource, so the declaration is repeated on every span.** Five
attributes per span, on every crossing of every execution. There is no interning guarantee on the
wire. The immutability a Resource would have given the declaration is replaced by a rule in
section 3.1 that only the host's own code enforces.

**L2. Span status collapses four dispositions into two states, and three outcomes into two.**
`completed` and `abandoned` are both `Unset`. `failed` and `terminated` are both `Error`. Every
default dashboard, alert and error rate in every backend reads that field and not the attributes.
A consumer that wants the real answer must be told to read `code_mode.execution.disposition` and
`code_mode.crossing.outcome`, and most consumers will not be.

**L3. On a host that does not attest `crossing.target`, the crossing span's NAME is a program claim,
and standard pipelines read it as fact.** The attribute beside it is now labelled, so a consumer
that reads attributes can tell. The span's own name cannot be labelled, and that is what
span-metrics connectors, service maps and span-name-keyed alerting key on. Span-metrics
connectors, service maps, span-name-keyed alerting and trace search all key on those two values
and none of them reads the provenance table. Section 9 blocks the metric the convention itself
recommends, which is the part a host controls. It does not and cannot block a collector-side
connector deriving metrics from span names. This is the price of reusing `gen_ai.tool.name`
instead of minting a private key, and the reuse is still right, because a private key buys a
consumer that reads nothing at all.

**L4. There is no representation for "settled, duration unknown."** A span always has two times.
An abandoned crossing, or any crossing on a host that does not record crossing times, becomes a
zero-duration span that renders as a tick. `code_mode.crossing.timing` says so in an attribute,
and no trace viewer reads it.

**L5. A running or never-closed execution is not in the trace.** It is indistinguishable from a
dispatch that never happened. The only fix is the host closing it `abandoned` at a later
reconciliation, which is work inside the host, or a log record (section 4.4), which this document
does not define.

**L6. The SDK's attribute value length limit truncates after the emitter has written its capture
note.** A value the host recorded whole can arrive shortened with nothing saying so. The default
limit is infinite, so this bites only where an owner has set one, and the owner is the only party
who can raise it. Not fixable from instrumentation.

**L7. Sampling can drop part of a trace.** Instrumentation cannot guarantee a whole trace is kept,
so a missing crossing span can mean sampled rather than not observed. A parent-based sampler keeps
an execution and its crossings together, and that is a recommendation to the application owner,
not something the host can enforce. Not fixable from instrumentation.

**L8. The attribute count limit, commonly 128, drops attributes past it silently.** An execution
span with many output channels and a large capture map can reach it. `dropped_attributes_count`
says how many were lost, never which.

**L9. `any`-typed attributes are not representable in the span attribute APIs of the three major
languages.** The specification's `AnyValue` allows a nested map, but JavaScript's
`SpanAttributeValue`, Python's `types.AttributeValue` and Java's `AttributeType` are primitives
and homogeneous arrays. In practice `code_mode.capture`, `code_mode.error.body`,
`code_mode.output.<channel>`, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` are JSON
strings on a span today. Log records do not have this restriction.

**L10. The status description has no attribute key, so nothing can label its provenance.** Section
4.1 closes this by construction rather than by warning: the description carries `error.type` or the
disposition, both closed vocabularies and both host-observed, so there is nothing there to label.
The cost is a divergence from the MCP convention and the loss of a human-readable reason in the one
place a UI shows it without being asked. The reason moves to `code_mode.error.body`, which is
Opt-In, so a host that does not turn capture on has a less readable failure than it used to.

**L11. Attestation is a claim, not proof.** Nothing in a trace distinguishes a host reading its
own call boundary from a host copying a value out of the program's return and attesting it anyway.
Detecting that needs a second observer in the path, under its own identity. No format detects it.

**L12. `gen_ai.operation.name = execute_code` is not upstream.** No existing consumer recognises
it, and none will until a proposal lands. Until then a consumer filtering on known operation names
does not see code-mode executions at all.

**L13. Two spans per crossing are possible over MCP.** The MCP convention's anti-duplication rule
is conditional on the MCP instrumentation detecting the outer span. Where it cannot, a crossing
produces both a crossing span and an `mcp.client` span. Issue #509 is the place that gets decided.

**L14. Everything this document reuses is Development.** `gen_ai.*` and `mcp.*` carry no
compatibility guarantee, and `code_mode.*` is a namespace this project owns and nobody else has
agreed to.

**L15. A late settlement usually has nowhere in the trace to go.** A span that has ended takes no
further events, by specification, and the thing that closed a crossing early is normally the
execution ending, which closes the execution span too. So the one case the `code_mode.late_settlement`
event was defined for is the case where no span is still open to carry it. What survives is the log
record of section 4.4, which this document does not define. An `abandoned` crossing that did in fact
settle is therefore, in the common case, indistinguishable in the trace from one that never did.

## 17. Open questions

**Does this belong in `open-telemetry/semantic-conventions-genai` rather than here?** That
repository's scope is the GenAI and MCP conventions; it was split out of
`open-telemetry/semantic-conventions`, which now redirects there. Its stability level is
Development throughout: none of `gen_ai.*` or `mcp.*` is Stable, and issue #511 is the open work to
stabilize inference and core agentic execution. Its gaps are real, checked at 2026-09-19: no code
execution or sandbox span among the eleven `gen_ai` span types, MCP modelled only at the JSON-RPC
method level, and nothing anywhere that models a submitted program, mediation, or the
host-observed versus program-determined distinction. Its naming rules leave exactly one route for
an industry-wide attribute, which is a proposal to the specification.

The argument for upstream: every comparable project that kept its own vocabulary was eventually
merged or demoted, and the failure was fragmentation rather than any technical flaw. The argument
for here: this is unproven, `code_mode.*` is ours to change, and a rejected proposal is worse than
no proposal. The way to settle it is not more argument. **It is one pull request proposing the
code-mode execution span, and what happens to it.** Lead with `code_mode.execution.id`, because PR
#445 names its absence as its own blocker and this model has the id it needs. Take the collision
list in section 11 into that conversation rather than making the reviewer derive it.

**Namespace.** `code_mode.*` was chosen over the retired format's `mocon.*`, because an upstream
proposal named after a product would fail the naming rules, while `gen_ai.*` and `mcp.*` are named
for their domain.

**Merging with an existing MCP server span.** Section 4 allows two shapes: a fresh execution span,
or the execution attributes added to an MCP server span that already covers exactly the dispatch.
Discovery is safe either way, because the execution span is defined as whichever span carries
`code_mode.execution.disposition`. One rule would still be better than two, and picking one needs a
test against a real MCP server instrumentation.

**`attested` entry spelling.** Entries name model fields (`crossing.target`) and section 6.4 maps
them to attribute keys. Naming attribute keys directly would remove one lookup for a naive
consumer, but it permits incoherent claims, attesting the outcome but not the target, and it is
longer on the wire. The closed six-entry list was chosen. Reasonable people could pick the other
one.

**Standard code-mode metrics.** Section 9 defines the prohibition and no instruments. An execution
duration histogram keyed on disposition would be sound on every host (section 9), and a crossing
count would not be on most. Whether that is a follow-up document is open.

**The declaration on crossing spans.** Section 3.1 requires all five on both span types, for a
consumer that receives a crossing without its execution. If the repetition proves too expensive in
practice, the smaller rule is `code_mode.attested` on crossings and the rest only on executions,
because `attested` is the only one needed to read a crossing span's own attributes. That would be
two rules instead of one, which is why it is not the rule today.

**The unresolved-execution log record.** Section 4.4 says a host MAY emit one and defines nothing
about it. If more than one host does it, two hosts will do it differently, and then it needs an
event name, a body shape and a severity, which is a second document.

## Appendix A. Invariants

These are the claims this specification is built on, not claims about any one implementation. They hold for a host as section 1 scopes one: a party that holds the program text it dispatched and can attribute the crossings it records to its own executions. Each attribute above cites the one it carries. They were derived by profiling nineteen implementations and adversarially testing every candidate against them, and they outlived the record format they were first written for.

- **C1. One program per execution.** One execution is one dispatch of one program, never the session that contains it. The host holds that program text in full at dispatch. It is not guaranteed to be what an agent submitted for that dispatch — a reactive runtime re-runs a dependent cell, a scheduler resumes a checkpoint, and the text is then the host's own — nor everything that ran, nor what the runtime parsed.
- **C2. Language is a hint.** A host may not know the language it runs. The label exists for display and routing only.
- **C3. Identity and disposition.** Every execution has an id unique within its host and a host-observed start. If it ends, it ends with exactly one of `completed`, `failed`, `terminated`, `abandoned`. It may never end.
- **C4. Completed or not.** When an end exists, the host can tell `completed` from every other disposition. Error detail is optional.
- **C5. Mediation is declared, not assumed.** Whether the host observes crossings, and whether the program has a path out that the host does not see, differ by implementation and are declared.
- **C6. Crossing shape.** Every recorded crossing has a target and an input fixed at initiation, and if it settles it settles as exactly one of `output`, `error`, `abandoned`. How many invocations or dispatches one record stands for follows from the declared edge (X2) and is not itself a core field.
- **C7. Host clock.** Execution start and end are on the declaring host's clock. Crossing times exist only where the host observed the crossing.
- **C8. Delivery varies.** How an outcome reaches the caller, and whether the caller sees crossings, differ by implementation and are outside the contract.
- **C9. Opaque payloads.** Inputs, outputs and results have no standard shape. Truncation and redaction are annotated out of band; consumers never parse values.
- **C10. No implicit order.** Crossings within an execution are unordered unless `seq` or host-clock timestamps are present, and they may overlap.
- **C11. No universal session.** Session, user and conversation identity are optional context the host passes through.
- **C12. Discovery is not universal.** How the agent learns the callable surface is outside the contract.
- **C13. Nesting is a link.** A crossing may be served by another execution. Correlation is by `traceparent`, not by a core field.
- **C14. Positions are not universal.** Source positions for errors and crossings are not guaranteed and are not in core.
- **C15. Limits are not universal.** Host-enforced limits and termination are not guaranteed.
- **X1. Provenance.** Every field is host-observed, program-determined or target-relayed by a rule fixed in this specification. Only the `attested` list upgrades a field.
- **X2. Two edges.** A crossing record describes either the program-facing invocation or the host's dispatch toward the target. The host declares which.
- **X3. Environment is not fixed.** The callable surface can change during an execution. Core does not record it.
- **X4. No universal output channel.** Non-crossing outputs such as standard output are optional, per channel.
- **X5. Meaning is declared, identity is fixed.** A host declares what its own attributes mean, so a consumer that has never heard of it can read them. No declaration reaches identity: not what an execution or a crossing is, not the closed dispositions and outcomes, not the reading of any attribute this document defines. This specification fixes the spine; everything above it is the host's to declare.
