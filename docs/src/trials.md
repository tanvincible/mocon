# What four trials found

Four times, a blind agent stripped a real server's hand-rolled observability and replaced it with
this library, while another agent kept hand-rolled and improved it. Independent judges then read
both diffs, ran both suites, and scored them.

**Hand-rolled won all four.**

| Trial | Server | Result |
|---|---|---|
| 1 | A production MCP server | 6–4 hand-rolled |
| 2 | An agent framework | 6–5 on substance for the library, hand-rolled recommended |
| 3 | The same production server | 4–8, 4–9, 2–9 |
| 4 | The same production server | 4–9, 5–8, 3–8 |

It is written down here because what the trials found is more useful than a pitch, and because
anyone deciding whether to adopt this should know what happened when four people tried.

## It never lost on the model

Judges repeatedly called it the better observability model. The second trial's verdict was explicit:
*"A is the better observability model, and it lost on delivery, not on substance."*

## Three causes, and only one is structural

**The destination tax.** Hand-rolled writes to a logger that already exists, is already shipped, and
is already on a dashboard someone already opens. This writes to a pipeline that has to exist first.
On one server that is pure added cost, and every trial measured exactly one server. A shared
vocabulary pays off on the second host and the tenth; no trial has ever had a second host.

[The logger destination](./logs.md) exists because of this finding, and it did not exist for any of
the four trials.

**Sequencing.** The fourth trial's arm deleted a log line that was live and shipped the replacement
switched off. The day-one delta was negative. [Integrating for real](./integrating.md) is the order
that avoids it.

**Execution.** By one judge's count the library arm failed the "it builds" condition in some form in
all four trials, for a different reason each time: missing dependencies, an untouched lockfile, and
finally a package that could not be installed as a file dependency at all because it had the wrong
npm lifecycle hook. Four different causes is a pattern about how the integration gets checked.

## The defects the trials found, which are now fixed

Because they were found by running things rather than reasoning about them:

- A provenance label pointing operators at the wrong system: host refusals that never left the
  process were labelled target-relayed. `code_mode.crossing.dispatched` came from this.
- A sequence number written with no validation at all, where a consumer sorts by it.
- A cost meter whose only working configuration was the dishonest one. `relayed_attributes` came
  from this.
- A README that handed a competent engineer the single most damaging mistake available, by shipping
  `observes_crossings: "all"` in its copy-paste block.
- A package that could not be installed outside npm.

## The honest caveat

The destination-tax argument is a real structural explanation, and it is also exactly what every
standard that never got adopted says about itself. "You would see the value on the second server"
cannot be falsified by anyone who never reaches a second server. After four trials, that defence is
doing more work than the evidence supports.

What would move it is not a fifth trial with better polish. It is an organisation that already runs
tracing, where the destination is sunk cost, or a second host emitting the same vocabulary so the
thing being paid for is finally in play.
