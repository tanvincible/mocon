# The capability declaration

Without this, a trace showing no calls means either the program made none, or the host is blind to
the ones it made. Those are opposite conclusions and no amount of trace data distinguishes them.

Five attributes, on every span:

| Attribute | Values |
|---|---|
| `code_mode.observes_crossings` | `all`, `some`, `none` |
| `code_mode.unmediated_egress` | whether the program has a path out the host cannot see |
| `code_mode.crossing_edge` | `invocation` (what the program asked for) or `dispatch` (what the host sent) |
| `code_mode.attested` | what the host observed rather than took from the program |
| `code_mode.attested_attributes`, `code_mode.relayed_attributes` | which of the host's own attributes, and in which sense |

**Absent reads as the weakest thing.** No declaration means `none`, unmediated egress assumed, and
nothing attested. That is what a host gets for saying nothing, and it is safe.

## Why it is on every span

A crossing span reaches a consumer without its execution span more often than you would think:
sampled separately, exported in a different batch, or emitted for an execution the host never
closed. A record that cannot be read alone is one that has to arrive with its context intact, and
nothing in a telemetry pipeline promises that.

The cost is five attributes per span. It is not free and it is worth it.

## Why not the Resource

Two independent reasons, either sufficient.

**An emitter cannot write one.** A Resource is fixed when the application owner constructs the
provider, and instrumentation depends on the API rather than the SDK. The Resource belongs to the
application owner, and the application owner is the party who does not know about code mode.

**Capabilities are not static per process.** A host may select a sandbox profile per dispatch, and
two profiles do not have the same answer for what can be observed. One provider has exactly one
Resource, so a Resource cannot say that an absence of calls means nothing on this dispatch and
something on that one. That inference is the only thing the declaration exists for.
