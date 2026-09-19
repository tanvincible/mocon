# Integrating for real

Four parity trials put this library on real servers against hand-rolled observability. It lost all
four, never on the model and always on delivery, and the most expensive single mistake was merging
the code before the destination existed.

So do it in this order, which is the reverse of the tempting one.

## 1. Decide whether you want a trace pipeline

If you already run OpenTelemetry, most of the cost is sunk and the rest is easy.

If your telemetry goes to logs today, adopting this means running a collector and a trace store.
That is a real decision and it should be made on its own merits rather than as a side effect of
picking an observability library. A trial that skipped this step lost on exactly it: a cost judge
scored the library arm 3 out of 10 because adopting it meant standing up three backends the
organisation did not run.

If the answer is no, [use your logger](./logs.md) and stop reading here. You lose the waterfall and
keep everything else.

## 2. Deploy the destination first

Merge [`collector/codemode.yaml`](./collector.md) into your collector, point it at your real backend,
and confirm data arrives with nothing instrumented yet.

## 3. Import the dashboard

[`dashboards/code-mode.json`](./dashboard.md), repointed at your datasource uids. Check it renders
empty rather than broken.

## 4. Then the code

Two wrappers, a tracer provider in your real entrypoint rather than a test, and the conservative
declaration. Everything in [Traps](./traps.md) applies here.

## 5. Turn it on in staging

Run a program that makes several calls, including one that fails and one your host refuses. Confirm
the spans arrive and the dashboard fills.

## 6. Only then retire what you are replacing

Deleting a live log line in the same change that ships its replacement switched off makes the day-one
delta negative rather than zero. That is what happened in the fourth trial, and it is why that arm
lost despite meeting every build and test condition.
