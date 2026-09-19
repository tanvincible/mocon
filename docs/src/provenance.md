# Provenance

**A code-mode program is written by an agent, and it can lie.**

This is not an adversarial assumption. It is the ordinary consequence of building telemetry out of a
channel the subject controls. Many hosts construct their crossing records from what the program
printed, or classify errors by pattern-matching what it threw. Such a program can print a line that
becomes a record of a call it never made, or throw an error whose name decides the classification
your dashboard shows.

Consumers of these traces are increasingly language models. A model reading "the program deleted
contact 42" needs to know whether the host saw that happen or the program said so.

**OpenTelemetry has no notion of this distinction, and no per-attribute provenance channel anywhere
in its data model.** A `KeyValue` is a key and a value. That narrow gap is what this fills.

## Three classes

**H, host-observed.** Determined where the program cannot write: the host's own clock, its own id
generation, an exit status, a call boundary the host mediates. Relative to the declaring host and
conditional on its isolation holding. It means faithfully observed by this host. It does not mean
true and it does not mean safe.

**P, program-determined.** Authored by the program, or computed by the host from a channel the
program can write: the program text, standard output, thrown errors, return values, and anything
derived from those.

**T, target-relayed.** Passed through unchanged from the target of a call, or produced by the host's
own handling of it, such as a refusal. The program did not shape it.

**T does not mean the target saw the call.** A refusal the host answered itself is T, because the
program did not shape it, and an operator reading a `T` error will go to the target's logs for a
request that never left the process. `code_mode.crossing.dispatched` is what separates them. That
was found by someone working a real trace at a console, not by reading the table.

## How it reaches the span

Every value whose class is not host-observed carries a label beside it:

```
gen_ai.tool.name                            = "company_search"
code_mode.provenance.gen_ai.tool.name       = "P"
```

Absence of a label means host-observed. That direction matters: an emitter that has not heard of a
field simply does not label it, which **under-claims rather than over-claims**.

A host upgrades specific fields by declaring what it observed, in a closed list:

| Entry | Upgrades |
|---|---|
| `crossing.target` | the tool name, its order and its outcome, to H |
| `crossing.input` | the call arguments, to H |
| `crossing.output` | the result, to T |
| `crossing.error` | the error class and body, to T |
| `execution.error.class` | the execution's error class, to H |
| `host_attributes` | the host's own attributes it names, to H or T |

## What attestation is and is not

It makes a claim visible and attributable. It does not make it true.

Nothing in a trace distinguishes a host reading its own call boundary from a host copying a value
out of the program's return and attesting it anyway. No format detects that. Attestation puts a name
on the claim, which is all a format can do.

## Two things it cannot label

A span's **name** and its **status description**. Neither has an attribute key, so nothing can carry
a class beside them. The name is what span-metrics connectors, service maps and span-name-keyed
alerting all read, and on a host that does not attest its targets they read a program's claim as
fact.

The status description is handled by refusing to put anything unlabellable there: it carries a
closed-vocabulary value and never the program's words. The span name has no such fix.
