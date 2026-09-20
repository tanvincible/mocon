# Payloads

Program text, call arguments, results and error bodies are **off by default**. They're AI-written
code and customer data, so you opt in rather than out.

```ts
codeMode({
  capabilities,
  capture: { values: true },
});
```

## Captured

| Attribute | What it is |
|---|---|
| `code_mode.program.text` | the program that was submitted |
| `gen_ai.tool.call.arguments` | what the program passed to a call |
| `gen_ai.tool.call.result` | what came back |
| `code_mode.error.message` | the human-readable reason a thing failed |
| `code_mode.error.body` | the raw error object |
| `code_mode.output.<channel>` | stdout, stderr, whatever else you capture |

The program's **hash** is always written, capture on or off. That's how you tell two runs of the same
program apart, and it's what's left when you withhold the text itself.

## Size caps

Big values get cut:

```ts
capture: {
  values: true,
  cap: 8192,          // bytes written per value
  programCap: 32768,  // bytes written for the program
  measure: 1048576,   // bytes read to work out the real size and hash
}
```

When something gets cut, a note records what happened:

```
code_mode.capture  {"gen_ai.tool.call.result":{"truncated":true,"bytes":62240,"hash":"sha256:…"}}
```

So you still know the real size and can match it against the full value elsewhere. OpenTelemetry has
no way to say "this value was shortened", which is why the note exists.

Set your cap below whatever limits your SDK, collector and backend have. Better to cut it yourself
and say so than to have something downstream cut it silently.

## Unserializable

A value with a cycle in it, a getter that throws, a `toJSON` that blows up: these all get recorded as
redacted rather than crashing anything.

```
code_mode.capture  {"gen_ai.tool.call.result":{"redacted":true}}
```

That matters more here than in most libraries, because the values come from AI-written code. Whatever
the program returns, capturing it can cost you the value and never the call.

Two more things land here. A `NaN` or an infinity anywhere in a value redacts the whole value, since
JSON has no way to write either and putting `null` there would turn a reading into a reading of
nothing. And a single value far past your cap is refused rather than read, because serializing
something enormous is work a program can ask for without limit.

A redacted note carries no `bytes` and no `hash`. Both describe an original the host never managed to
serialize, so there is no honest number to report.

## Redacted

**Absent** means you never captured that thing. It says nothing.

**Redacted** means you had it and removed it on purpose. That's a real signal, so they're different
on the wire.

To keep a program's hash without its text, the shape is: no `code_mode.program.text`, a present
`code_mode.program.hash`, and a capture note saying `redacted`.

## Privacy

Everything here is program-determined, so it all carries a `P` provenance label. If you're sending
traces somewhere you don't fully control, `values: false` gives you the whole structure of a run,
durations, outcomes, ordering, failures, with none of the content.
