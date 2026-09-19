# Self-describing attributes

A host has values of its own: credits spent, a sandbox id, an attempt count, a cache result. They go
in the host's own namespace, `com.acme.credits_used`, and nothing outside your server knows what
they mean.

So say what they mean:

```ts
capabilities: {
  declared: {
    "com.acme.credits_used": { agg: "sum", unit: "{credit}", card: "low", name: "Credits" },
    "com.acme.tenant_id":    { agg: "none", card: "high" },
  },
}
```

Whether the value can be summed, what it counts, whether grouping by it is safe, and what to call it
in a legend. That is everything a stranger needs to do something correct with a field it has never
seen.

## Two separate claims

**Summable by declaration, believable by provenance.** A reader needs both, and they answer different
questions. The declaration says a number adds up. The [provenance label](./provenance.md) says whose
number it is. A value declared summable that carries a program-claim label is still barred from
becoming a metric, because a metric point has nowhere to carry the doubt.

## Where it rides

The execution span only.

The difference from [the capability declaration](./declaration.md) is the point. That one is repeated
on every span because it changes how a *single* span is read. This one is about combining values
*across* spans, which is already a multi-span operation, so one carrier per trace is enough and a
crossing does not pay the bytes.

## Who actually reads it

Worth being clear-eyed, because self-describing data is easy to oversell.

**No general-purpose backend reads this, and none will.** Grafana will not learn what your credit
meter is because a span told it. Declarations of this kind sit in the inert family, like an Avro or
Protobuf schema, not the family where a consumer derives behaviour automatically.

It is worth something to exactly three consumers:

- **A language model reading the trace**, which increasingly is the consumer, and which can act on a
  declaration with no vendor support whatsoever. This is the only adoption path that does not
  require anyone else to build anything first.
- **A dashboard written against these conventions**, which can then render a host's own fields
  without being rebuilt per host. Hand-rolled telemetry structurally cannot do that.
- **A collector deriving metrics**, which can enforce the provenance rule mechanically rather than
  by trusting each host.

It does not make the ecosystem understand you. It makes it possible for something to, without
waiting on a standards process.
