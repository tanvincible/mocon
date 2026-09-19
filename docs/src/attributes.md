# Custom attributes

Your server knows things mocon doesn't. Credits spent, a sandbox id, an attempt count, a cache hit, a
tenant. Put them on the spans.

```ts
execution.crossing.start({
  target: "company_search",
  attributes: { "com.acme.credits_used": 5, "com.acme.cache_hit": false },
});
```

Use your own namespace, from your domain or product name. Keys under `code_mode.`, `gen_ai.`, `mcp.`
and `otel.` are reserved and get dropped rather than written.

## Trust

By default everything you add gets labelled unverified, because mocon has no idea where your value
came from. Two lists sort that out:

```ts
capabilities: {
  attested: [...otherEntries, "host_attributes"],
  attested_attributes: ["com.acme.sandbox_id"],    // you measured these
  relayed_attributes: ["com.acme.credits_used"],   // a target reported these
}
```

**`attested_attributes`** is for things you worked out yourself, somewhere the program can't reach.
Your own meter, your own clock, your own sandbox id.

**`relayed_attributes`** is for numbers you copied out of a target's response. A credit count your API
returned isn't something you measured. Attesting it would be a lie, and leaving it off makes it a
program claim, which bars it from becoming a metric. Listing it as relayed is the honest option, and
the one that gets you a billing number you can actually defend.

A key can't be in both lists, and listing keys at all needs `host_attributes` in `attested`.

## Meaning

Nothing outside your server knows what `com.acme.credits_used` is. Tell it:

```ts
capabilities: {
  declared: {
    "com.acme.credits_used": { agg: "sum", unit: "{credit}", card: "low", name: "Credits" },
    "com.acme.tenant_id":    { agg: "none", card: "high" },
  },
}
```

| Field | What it says |
|---|---|
| `agg` | `sum` if the values add up, `last` if only the newest matters, `none` if adding them is meaningless |
| `unit` | UCUM if there is one (`ms`, `By`, `s`), otherwise a braced annotation (`{credit}`) |
| `card` | `low` if it's safe to group by, `high` for per-user or per-run values |
| `name` | what to call it in a legend |

**Summable is a different question from believable**, and a reader needs both answers. The
declaration says the number adds up. The provenance label says whose number it is. A value declared
summable that carries a `P` label still shouldn't become a metric, because a metric has nowhere to
carry the doubt.

## Readers

Worth being straight, because self-describing data is easy to oversell.

**No general-purpose backend reads it.** Grafana isn't going to learn what your credit meter is
because a span told it.

Three readers get something out of it. A **model** reading the trace, which can act on it with no
vendor support at all. A **dashboard written against mocon**, which can then render your fields
without being rebuilt for your server. And a **collector** deriving metrics, which can follow the
provenance rule automatically instead of trusting each server.

So it doesn't make the ecosystem understand you. It makes it possible for something to.
