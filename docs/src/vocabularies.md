# Closed vocabularies

An execution ends exactly one of four ways, and a call settles exactly one of three:

| `code_mode.execution.disposition` | |
|---|---|
| `completed` | it finished |
| `failed` | it raised |
| `terminated` | the host stopped waiting, or tried to stop it; the computation may still be running |
| `abandoned` | the host closed the record without learning an outcome |

| `code_mode.crossing.outcome` | |
|---|---|
| `output` | a value came back |
| `error` | an error came back |
| `abandoned` | the host stopped watching before it knew |

They are closed so that a consumer can be written once and work everywhere. A host must not emit any
other value.

## Span status cannot carry them

Status has three values, and instrumentation is not supposed to set `Ok`. So:

| Status | covers |
|---|---|
| `Unset` | `completed`, `abandoned`, and every execution still running |
| `Error` | `failed`, `terminated` |

**A run the host gave up on is indistinguishable from a clean one** in the single field every backend
aggregates, alerts on and colours, including Grafana's own defaults. That is why the attributes are
normative and the status is a display hint, and why [the dashboard](./dashboard.md) exists.

`abandoned` deserves particular care. It is not a failure and not a success. It says the host stopped
observing before it knew, usually because the execution ended first. **It is not a claim that the
target never responded.** If your targets spend money or change state, an abandoned call is an
operation that may or may not have happened.

## The price of closing them

A host cannot add a value. It can add a field beside one, but a consumer following the rules reads
the closed value as normative and will not believe the field.

The case that exposes this: a run that pauses at the end of one dispatch and resumes in a later one.
Each dispatch is its own execution, so the paused one reports `completed`, and a consumer reads one
logical run as having completed three times. A host attribute saying `paused` sits right beside it
and nothing is told to look.

Closing the vocabularies is what lets a consumer be written once. It is also what makes the model
rigid at exactly these two points. That trade is real and it is not resolved.
