# Output

One run, two calls, second one refused. Here's everything mocon produces for it.

## Shape

```
execute_code execute                    303 ms   completed
├── execute_tool company_search         127 ms   output
└── execute_tool refund_customer         17 ms   error      refused
```

One span for the program. One span per call it made, nested underneath, in the order they started.

## Run span

```
name                              execute_code execute
kind                              server
duration                          303 ms

code_mode.execution.disposition   completed
code_mode.execution.id            exec_7f3a
code_mode.program.hash            sha256:6719bd29…
code_mode.program.language        javascript

code_mode.observes_crossings      all
code_mode.unmediated_egress       false
code_mode.crossing_edge           invocation
code_mode.attested                ["crossing.target","crossing.input"]
```

**`disposition`** is how the run ended. Read this, not the span's status. It's one of `completed`,
`failed`, `terminated` (you stopped waiting) or `abandoned` (you closed the record without finding
out). Span status only has three values so it can't hold all four, which means a run you gave up on
looks the same as a clean one in most default dashboards.

**`execution.id`** is your own id for the run, the one in your logs. Every span of the run carries it,
so one query takes you from a log line to the whole trace.

**The last four** are [the declaration](./declaring.md), which is what makes "no calls recorded" mean
anything.

## A success

```
name                              execute_tool company_search
kind                              client
duration                          127 ms

gen_ai.tool.name                  company_search
code_mode.crossing.outcome        output
code_mode.crossing.seq            1
code_mode.crossing.dispatched     true
code_mode.execution.id            exec_7f3a
```

**`outcome`** is `output`, `error` or `abandoned`. Same deal as disposition, read this and not the
status, because `abandoned` and `output` both look like "unset" to a trace viewer.

**`dispatched`** says the call really went out. If your own server refused it, set this `false`, or
whoever's debugging will go looking in the wrong system.

## A failure

```
name                              execute_tool refund_customer
duration                          17 ms
status                            error

code_mode.crossing.outcome        error
error.type                        refused
code_mode.crossing.dispatched     false
code_mode.error.message           "over the call cap for this run"
```

## Provenance

If your server didn't see a value itself, mocon says so, right next to it:

```
gen_ai.tool.name                            refund_customer
code_mode.provenance.gen_ai.tool.name       P
```

`P` means the program said this. No label means your server saw it. There's also `T`, which means a
target reported it.

This matters because the program is written by an AI. If you build call records out of what the
program printed, a program can put a call in your trace that never happened. You can't tell from the
span, so mocon tags it. [Provenance](./provenance.md) has the full story.

## Payloads

Program text, call arguments and results are **off by default**, because they're AI-written code and
customer data. Turn them on when you want them:

```ts
codeMode({ capabilities, capture: { values: true } });
```

Then you also get the arguments and results, cut at a size cap, with a note recording the original
size and hash of anything that got shortened. See [Payloads](./capture.md).
