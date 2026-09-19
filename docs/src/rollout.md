# Rollout

The code change is the small part. If you're replacing existing observability, the order you do
things in decides whether the day you merge is better or worse than the day before.

## Order

**1. Decide if you want a trace pipeline.** Already running OpenTelemetry? Most of the cost is
already paid. If your telemetry goes to logs, adopting this means running a collector and a trace
store, and that's a decision to make on its own merits. If the answer is no, use
[your logger](./logs.md) and you're done. You lose the waterfall and keep everything else.

**2. Stand up the destination first.** Merge [the collector](./collector.md) into your
collector, point it at your backend, and check data arrives with nothing instrumented yet.

**3. Import the dashboard.** [`dashboards/code-mode.json`](./dashboard.md), repointed at your
datasources. Make sure it renders empty rather than broken.

**4. Then the code.** Two wrappers, a provider in your real entrypoint, a cautious declaration.

**5. Turn it on in staging.** Run a program that makes several calls, including one that fails and
one your server refuses. Check the spans arrive and the dashboard fills.

**6. Retire the old thing last.** Deleting a working log line in the same change that ships its
replacement switched off leaves you worse off than before you started. Wait until the new data is
confirmed flowing.

## Sampling

Every run emits one span plus one per call, so a program making a hundred calls emits a hundred and
one. Configure a sampler before this becomes a bill.

Use a **parent-based** sampler so a run and its calls are kept or dropped together. With a head
sampler that decides per span you get runs with half their calls missing, and a missing call is
indistinguishable from a call that never happened.

## Cost

mocon adds roughly five microseconds per span on top of what the OpenTelemetry SDK costs, and about
eight with payload capture on. A run executes a whole program and a call is usually a network
request, so this sits far below the work it's describing. It holds nothing between runs.

Run `npm run bench` in the repo if you want your own numbers.

## Reverting

Take the wrappers out, or leave them and don't register a provider. Everything becomes a no-op with
no other changes. If you used [the logger](./logs.md), swap the tracer back.
