# Why this replaced a record format

This project began as a record format: its own JSON Lines wire, a schema, a conformance suite with
twenty-six golden streams and sixty-one negative fixtures, a viewer, an OTLP converter, and adaptors.
Eight packages, 8,855 lines of source.

It was retired in a day. What survives is one package and a document.

## The reason was not that it was wrong

Every judge who compared it to hand-rolled observability said the model was the better one, including
judges who scored the implementation 2 and 3 out of 10. The record format's own provenance work was
called the best thinking in a trial it lost.

The reason was arithmetic. **Every consumer of a private format is a consumer you wrote.** That does
not improve with effort; it is the definition. At its absolute ceiling, with emitters in five
languages and sinks for every backend, the project would still be maintaining every one of those
sinks forever, and a team adopting it would still be installing something they had never heard of.

The command-line viewer was 2,034 lines, two and a half times the emitter, and it existed only to
look at a format Grafana would have rendered for free.

## What the move cost

Honestly, and these are not small:

- **Live visibility.** A record is emitted whole the moment it finishes, and a start notice can go
  out immediately. A span must be held open until it ends and then waits in a batch queue. A hung run
  is invisible.
- **Status expressiveness.** Four dispositions into two observable states.
- **A wire you control.** Everything borrowed moves when upstream moves it.

## What survived unchanged

The model, the closed vocabularies, the capability declaration, and provenance. All of it is
carrier-independent, which is what made the move possible: the specification's own text says
provenance costs zero bytes and is a table consumers apply.

## The decision

Three independent judges, given the two architectures and told to argue for deletion, split three
ways: one for each, and one for keeping only the ideas. But all three scored *keeping both* lowest,
and the reason was concrete: the two closed attestation lists had already forked one day after the
pivot, at zero users. A closed list whose entire value is being identical everywhere had already
stopped being one.
