# Provenance

The program running in your sandbox was written by an AI. It can print anything, throw anything and
return anything.

That matters because of where telemetry comes from. If you record a call because the program logged
one, then a program that logs a call it never made just put a fiction in your trace. If you classify
errors by matching the message, then a program throwing `new Error("timeout")` picked what your
dashboard says.

This isn't about hostile programs. It's just what happens when you build telemetry out of something
the subject controls.

And more and more, the thing reading these traces is another model. A model reading *"the program
deleted contact 42"* needs to know whether you watched that happen or the program said it did.

**No general observability tool records this.** A span attribute is a key and a value. There's
nowhere to put where the value came from. That's the gap this fills.

## Three classes

**Your server saw it.** Determined somewhere the program can't write: your clock, your id generator,
an exit status, a call boundary you control.

**The program said it.** Written by the program, or worked out by you from something it wrote: the
program text, its output, its thrown errors, its return values.

**A target reported it.** Passed through unchanged from whatever the call reached, or produced by
your own handling of that call, like a refusal. The program didn't shape it.

## Labels

Any value that isn't something your server saw gets a label right next to it:

```
gen_ai.tool.name                            inventory_search
code_mode.provenance.gen_ai.tool.name       P
```

`P` for the program said it, `T` for a target reported it, and **no label** for your server saw it.

The default runs the safe way round. Anything you haven't declared you observed gets `P`. So
forgetting to declare something costs you a bit of detail, and it can't accidentally turn a guess
into a fact.

## A trap

**`T` doesn't mean the target saw the call.** A refusal your own server produced is `T`, because the
program didn't shape it. Someone reading a `T` error will naturally go digging in the target's logs
for a request that never left your process.

`code_mode.crossing.dispatched` is what separates them. Set it, and "their API broke" versus "we
never called them" is one field instead of an afternoon.

## Not proof

Saying you observed something makes the claim visible and makes it yours. It doesn't make it true.
Nothing in a trace can tell a server reading its own call boundary apart from a server copying a
value out of the program's return and attesting it anyway.

No format can catch that. What a format can do is put a name on the claim, so if it's wrong, it's
wrong in public.

## Unlabelled

A span's **name** and its **status description** have no attribute key, so nothing can sit beside
them.

The name matters because span-metrics tools, service maps and name-keyed alerts all read it. On a
server that doesn't attest its targets, they're reading a program's claim as fact. [The
collector](./collector.md) stops the metrics mocon defines from doing that. It can't stop tooling
somebody else set up.

The status description is handled by never putting anything unlabellable in it. It carries a
fixed-vocabulary value, never the program's words. The message goes in an attribute, where it can be
labelled.
