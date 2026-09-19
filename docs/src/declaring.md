# Declaring honestly

This is the part that goes wrong, and it goes wrong in the direction that does the most damage.
Everything else on the span is conditional on the declaration, and it is the one claim this library
cannot check for you.

## `observes_crossings: "all"` is a claim about the whole path

Not "my wrapper sees every call that reaches it". It means **nothing can answer the program before
your wrapper**.

Before you claim it, go looking for code that answers the program itself: a call-count cap, a
deadline guard, a rate limiter, a cache, a permission check that refuses before dispatch. If any of
those can return to the program without passing through the function you wrapped, some calls produce
no span and `"all"` is false.

That mistake is easy to make and invisible afterwards. A real integration of this library declared
`"all"` on a host whose sandbox refuses over-cap calls a layer above the bridge. Four calls, two
spans, and a declaration asserting two was all of them.

**The test is mechanical.** Instrument, then make a program hit every refusal path you have, and
count. If the spans do not match the calls, you are `"some"`.

## Attest nothing you derive from something the program wrote

If your error class is computed partly from a thrown value's name or message, a program can choose
it. A host with both an observed path and a parsed path for the same field does not attest that
field.

The same integration attested its error class, and a program throwing a specially named error
published its own choice as host-observed fact, with no provenance label, which is precisely the
failure [provenance](./provenance.md) exists to prevent.

## Your own attributes

They are program claims until you say otherwise. Two lists say which:

```ts
capabilities: {
  attested: ["crossing.target", "host_attributes"],
  attested_attributes: ["com.acme.sandbox_id"],   // you measured these
  relayed_attributes: ["com.acme.credits_used"],  // a target reported these
}
```

The second list matters more than it looks. A credit count your API returned is not something you
measured, so attesting it is false, and leaving it unlisted makes it a program claim and bars you
from summing it into a cost metric. Naming it as relayed is the honest option and the only one that
yields a billing number you can defend.

## The rule underneath all of this

Declare the weakest values true for every dispatch. Silence reads as `none`, which is safe. The
design is built so that forgetting something under-claims rather than over-claims, and you should
let it.
