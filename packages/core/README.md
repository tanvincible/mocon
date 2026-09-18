# @mocon/core

The reference emitter for mocon, a record format that makes a code-mode MCP execution visible: that a program ran, and each time control crossed from the program into the host while it ran. A host wraps two things, the handler that runs a program and the bridge the program calls back into, and mocon lines come out. Nothing else changes.

Zero runtime dependencies. ESM only, and the subpaths resolve through the exports map, so a TypeScript consumer needs `moduleResolution` `node16`, `nodenext` or `bundler`: a top-level `types` keeps `@mocon/core` itself resolvable under the classic `node10`, but `@mocon/core/fold` is not. `@mocon/core/package.json` is in the exports map, for tooling that reads a dependency's manifest. The contract is `spec/core.md` and `spec/provenance.md` in this repository. This package implements the producer side of it.

## Integration

One import, two wrappers. `execution.run` brackets the handler. `instrument` wraps the bridge.

```ts
import { fileSink, mocon } from "@mocon/core";

const m = mocon({
  host: "example/mcp",
  capabilities: {
    observes_crossings: "all",
    unmediated_egress: false,
    crossing_edge: "invocation",
    attested: ["crossing.target", "crossing.input"],
  },
  sinks: [fileSink("mocon.jsonl")],
});

export function execute(code: string, rawCallTool: CallTool) {
  return m.execution.run({ program: code, language: "javascript" }, (ex) => {
    const callTool = ex.instrument(rawCallTool);
    return runInSandbox(code, { callTool });
  });
}
```

`run` writes the start notice, calls the body, and settles the execution: `complete({ result })` with what the body returned, `fail(error)` with what it threw. It keeps the body's sync or async shape and rethrows the exact error object. A native promise is followed through the intrinsic `then`, and the promise that call derives is what the caller gets: it settles with the same value or the same error, so a rejection nobody awaits is still reported unhandled, and a read of the promise's `constructor` that throws settles the record the way `await` would. Any other value, a thenable of another kind included, is the outcome as it is: it is returned unchanged and its own `then` is never read or called, so a lazy thenable such as a query builder does its work once, when the program awaits it. `instrument` does the same for the bridge, and the wrapper carries the bridge's `name`, `length` and own properties, so a program that calls it, awaits it or inspects those sees the bridge. Every open crossing is written as `abandoned` before the complete record on both paths, so a host that uses `run` never leaves a crossing open by accident.

## The lines it writes

For the integration above, one call to `execute` writes these lines. Ids and times are the host's own.

Hashes are SHA-256 over the host's serialization of the original, and `bytes` is its length. This library serializes one way per slot. `program` is the UTF-8 bytes of the text itself, as core.md 5.4 recommends, so two executions of the same text match on `hash`. Every other slot is `JSON.stringify(value)`, with one addition described under Capture, so a string value is hashed with its quotes and escapes, and a truncated `value` is a prefix of that JSON text. The test suite recomputes every `bytes` and `hash` printed on this page from that rule.

The host line, written once when `mocon()` is called:

```json
{"kind":"host","host":"example/mcp","spec_version":"1.0","observes_crossings":"all","unmediated_egress":false,"crossing_edge":"invocation","attested":["crossing.target","crossing.input"]}
```

The start notice, written by `run` before it calls the body:

```json
{"kind":"execution","host":"example/mcp","id":"5f1c0b7a9e2d4c6b8a1f3e5d7c9b2a4e","program":{"value":"const co = await callTool('company_identify', {query: 'acme.example'});\nreturn co.name;","bytes":87,"hash":"sha256:d64884aeee0ed3ce11e7018bb3280c3f3786b87bb310df90de4ed789bd40924a"},"language":"javascript","start":"2026-09-17T09:00:00.000Z"}
```

One complete crossing, written by the instrumented bridge when the call returns:

```json
{"kind":"crossing","host":"example/mcp","id":"7c2e9a4b1d6f0e83","execution_id":"5f1c0b7a9e2d4c6b8a1f3e5d7c9b2a4e","target":"company_identify","input":{"value":{"query":"acme.example"},"bytes":24,"hash":"sha256:f3a8ad21e8d2901da6044c6caf0b28c49c08763b0a958771f49fc0668f5847d9"},"seq":1,"start":"2026-09-17T09:00:00.012Z","end":{"time":"2026-09-17T09:00:00.310Z","outcome":"output","output":{"value":{"name":"Acme Robotics","id":8842},"bytes":34,"hash":"sha256:36df3dd3ebc93235d004bd5fcc0ac5e37056638abfead126d1a482e1b83dd412"}}}
```

The complete execution, written by `run` when the body returns. It supersedes the notice. The result is the string `Acme Robotics`; its 15 bytes are the JSON text `"Acme Robotics"`, quotes included:

```json
{"kind":"execution","host":"example/mcp","id":"5f1c0b7a9e2d4c6b8a1f3e5d7c9b2a4e","program":{"value":"const co = await callTool('company_identify', {query: 'acme.example'});\nreturn co.name;","bytes":87,"hash":"sha256:d64884aeee0ed3ce11e7018bb3280c3f3786b87bb310df90de4ed789bd40924a"},"language":"javascript","start":"2026-09-17T09:00:00.000Z","end":{"time":"2026-09-17T09:00:00.318Z","disposition":"completed","result":{"value":"Acme Robotics","bytes":15,"hash":"sha256:ff0443ee31fdc930f559d01124b4b9c0be9fa24d383a5a795544c52abf8c4d70"}}}
```

Every line is whole. A consumer never merges fragments. A crossing that is still open when the execution ends is written as `{"end":{"outcome":"abandoned"}}` before the execution's complete record, as core.md 5.3 requires. When the execution carries `context.traceparent`, every crossing line carries the same value, so a stateless OTLP sink places the crossings in the caller's trace without looking anything up.

A settlement that arrives for a crossing already written as `abandoned` is not attributed to it. The first one is written as a `late_settlement` event (`spec/extensions/events.md`), whose `data.payload` has the shape `end.output` or `end.error` would have had; later ones are ignored. A core-only consumer skips the event as a kind it does not know, and so does every validator: `spec/schema/line.json` holds host, execution and crossing and nothing else, so an event line is the one kind this package writes that no schema in this repository checks. `mocon validate` counts it as skipped and reports OK; check.py does the same. The claim to make about a stream this package writes is that every line of a core kind validates against `spec/schema/line.json`, and that event lines follow `spec/extensions/events.md`, which ships no schema.

A settlement arrives late the same way after the host wrote the crossing as abandoned itself, with `end({ outcome: "abandoned" })`; a second abandon of an abandoned crossing writes nothing and does not use up that one event.

The library writes four keys of its own into a record's `ext`, all under `mocon.`: `mocon.encoding` names each slot whose value holds binary written as base64, the whole value or somewhere inside it; `mocon.target` says the target was cut at its cap; `mocon.message` says an error's `message` was cut at its slot's cap; and `mocon.ext` replaces an `ext` the serialization rejected. A `late_settlement` event carries the notes its payload needs in its own `ext`.

## Handles

`mocon(options)` builds the instance. `m.execution.run(options, body)` is the wrapper. `m.execution.start(options)` is the same start without the bracket, for a host that opens a handle per turn and settles it later. Both write a start notice by default; pass `notice: false` for a host that does not want live views. A `notice: false` handle still owes the stream an execution record: when it writes its first crossing line, the notice goes out with it, so a crossing never reaches the stream while its dispatch has no record there (core.md 10).

- `ex.instrument(fn, options?)` wraps a bridge. By default the first argument is the target: as it is when it is a string, its text when it is another primitive, and its type in brackets, `[object]` or `[function]`, when it is neither, because coercing an object runs code the program wrote and the host cannot bound — a proxy over three elements claiming a length of 1e8 costs the program nothing and the host sixteen seconds inside `Array.prototype.join`. A bridge whose first argument is an object passes a `target` function. The rest is the input; the call always reaches the bridge, which decides what a strange tool name means. A bridge shaped like `callTool({ name, arguments })` passes `target` and `input` functions. Those functions run on each call, inside the wrapper: one that throws, or that yields a target which is not a string or an `ext` which is not an object, costs that field and not the call, so the bridge is still reached and the crossing is still written. Only `instrument()` itself throws, and only for an option of the wrong shape. The wrapper forwards `this`. A native promise is followed and the derived promise returned, as under `run`; any other value, a thenable included, is returned unchanged and never subscribed. An iterator, stream or callback is not followed: the crossing records the value the bridge returned, at the moment it returned. A streaming bridge opens the crossing with `ex.crossing.start` and settles it when the stream ends or fails.
- `ex.crossing.start({ target, input })` opens a crossing by hand and returns a `CrossingHandle` with `output(value)`, `error(cause)` and `end(options)`. Use it when there is no single function to wrap. It takes a string target, so `targetOf(value)` is exported for a host that holds whatever named the call: it is the coercion `instrument` applies, it never runs the value's own `toString` or reads a member of it, and `@mocon/adapter-mcp` names a call the same way through it.
- `ex.complete({ result?, outputs? })` and `ex.fail(cause, { class? })` are shorthands for `ex.end({ disposition, ... })`. `end` takes the exact wire fields for `terminated` and `abandoned`, and `error.cause` in place of `message` and `value` when the host holds what it caught: `ex.end({ disposition: "terminated", error: { class: "timeout", cause } })` records the caught error the way `fail` does.

A handle numbers its crossings from 1 and continues past any `seq` the host gives, so an automatic `seq` never repeats or falls below one given earlier. A `seq` must be an integer below 2^53 - 1, and past that limit an automatic `seq` is left out rather than repeated. A host that continues one dispatch across turns passes the `seq` of each crossing it repeats.

`end`, `complete`, `fail`, `output` and `error` write on the first call and ignore later ones. A watchdog and the normal path can both call `end` without coordination. A body under `run` can call `ex.fail` itself; the `complete` that `run` issues afterwards is ignored. Every call reads each option once and validates it before it touches the handle, and throws a `TypeError` or `RangeError` for a value that would not validate on the wire, so a rejected call leaves the handle as it was and an option that answers differently on a second read cannot reach the line. That reading includes the `outputs` container itself: its channel list and each channel's value are taken there, so a map whose getter, `ownKeys` trap or revoked proxy throws answers with mocon's own `TypeError` rather than throwing the program's error out of `complete()`. Nothing a value does during capture reaches the caller: a value the serialization rejects is written redacted, and a getter that settles the same handle from inside the capture wins, because it finished first.

The cause of `fail(cause)` and `error(cause)`, and `error.cause` given to either handle's `end`, becomes `message` and `value` by one rule, which never throws; a `message` or `value` given beside `cause` wins. A native error from any realm, `node:vm` and workers included, recognised by its internal brand, gives `message` from `error.message` when that is a string and `value` from the plain object `{ name, message, stack, ...own enumerable properties, cause }`, so an MCP error keeps its `code` and `data` and a system error its `errno` and `syscall`; a nested error is converted the same way, and a cause chain is cut after 32 levels. The own properties are read lazily, as the capture writes them, so a getter on a thrown error past the error slot's cap never runs. A string or other primitive gives `message` from `String(cause)` and no `value`. `null` and `undefined` give neither. Any other object, such as an MCP `isError` result or `{ ok: false, status }`, is the `value`, with `message` taken from its `message` field when that is a string. A getter or trap that throws costs the field it guarded. `value` goes through the error slot's capture rule like any other payload, so a policy can drop the stack. `message` is cut at the error slot's cap like a value, and a rule on the slot withholds it with the value.

`ext` is read once, when the host hands it over, so a later change to the host's object does not reach the record. `ext` given on a settle call is merged over the `ext` given at start, key by key. The settle key wins. A crossing opened after the handle ended is not tracked: its record is written when it settles, and if nothing settles it, it stays unresolved, which core.md 4 allows.

Timestamps default to now on the host's clock, which never reads earlier than its previous reading. A default `end.time` is also never earlier than the record's own `start`, compared to nine fractional digits, so a `start` you gave from a clock that runs ahead cannot put `end.time` before `start` (core.md 7): when the clock reads earlier, `start` itself is written. Every start and settle option accepts your own reading (`start`, `time`) for the case where you observed the event earlier than you could record it; it must be RFC 3339 UTC with a `Z`, naming an instant that exists, so February 30 or an hour of 25 is refused, and an `end.time` that names an instant before the record's `start` is refused with a `RangeError` before anything is written. Only your own clock goes there. A time from the sandbox or a backend row belongs in `ext`.

### Across turns

A host that sees a crossing begin in one HTTP turn and settle in the next gives the handle its own `id` and `start`, keeps those fields in the state it already persists, and opens a handle from them again on the next turn. A crossing is repeated the same way, from its `id`, `target`, `input`, `seq` and `start`:

```ts
// turn 1
const dispatch = { id: runId, program, language: "python", start: new Date().toISOString(), context: { traceparent } };
const call = { id: callId, target: "lookup_account", input: args, seq: 1, start: new Date().toISOString() };
m.execution.start(dispatch).crossing.start({ ...call, notice: true });
return { state: { dispatch, open: [call] } };

// turn 2
const ex = m.execution.start({ ...state.dispatch, notice: false });
ex.crossing.start(state.open[0]).output(toolResult);
ex.complete({ result });
```

The host keeps no map of live handles. What crosses the turn is data the client already carries. The second handle's first crossing line brings a start notice built from the same fields, so it is the first turn's notice byte for byte, and a consumer supersedes both with the complete record.

Two handles for one dispatch each hold only the crossings they opened. The turn-2 handle abandons the call it repeated if nothing settles it, and knows nothing of a call it did not repeat, which stays unresolved unless some handle settles it; core.md 4 allows that.

Idempotence belongs to a handle, not to a key. Two handles opened from the same fields, such as a retried turn and the original, each write a complete record for the same execution or crossing, which core.md 4 counts as a conflict. The library cannot see that without keeping state across calls, so a host that can receive the same turn twice makes its own settle path idempotent, keyed on the id the client state already carries.

## Capture and redaction

Every value goes through one encoder that produces a Payload: `value`, `truncated`, `redacted`, `bytes`, `hash`. Caps, redaction and hashing live in one policy so they cannot disagree. The encoder reads a value once: every property it reads is read once, every getter and `toJSON` runs at most once per capture, the text it produced is the text that is measured, hashed and cut, and no program code in the value runs after the capture returns.

Default caps, in bytes, all overridable through `capture.caps`:

| slot | cap |
|---|---|
| `program` | 768 KiB |
| `result` | 64 KiB |
| `outputs` (each channel) | 64 KiB |
| `error` | 16 KiB |
| `crossing.target` | 4 KiB |
| `crossing.input` | 16 KiB |
| `crossing.output` | 64 KiB |
| `crossing.error` | 16 KiB |

A cap bounds what the slot's `value` adds to a line, in UTF-8 bytes as written: a cut value is a JSON string, and its prefix is chosen so that the string, its quotes and escapes included, fits the cap. `crossing.target` caps the target string itself, which the program chooses: a longer target is cut on a code point boundary before any capture rule sees it, and the record's `ext` carries `"mocon.target": { "truncated": true }`. An error's `message` is cut at its slot's cap the same way, noted under `mocon.message`.

The payloads of a complete execution record, its error, result and output channels in that order, share one budget with the line's head: 1 MiB, the size core.md 3 asks lines to stay under, less 4 KiB for the envelope. A slot gets its cap or what the line has left, whichever is less, so every channel is still recorded, cut to what is left. With the default caps no line this package writes passes 1 MiB, whatever a program's text holds and however many channels the host passes, apart from what the host supplies itself: the host string, ids, `language`, `context`, an error's class, channel names and `ext`. Those are outside the budget entirely and no cap bounds them, so a host that derives one of them from what a program handed it gives the program the size of the line: `ex.instrument(fn, { ext: (_n, a) => a })` puts a 3 M character argument into a 3 MB crossing line, and a `context.session` of a million characters writes a million characters onto the notice and again onto the complete record. core.md 3 makes such a line legal, since a consumer MUST accept one past 1 MiB, but the host is the only thing bounding it. Put program data in a payload slot, which has a cap, not in `ext` or `context`.

Under the cap the Payload is `{ value, bytes, hash }`. Over it, `value` is a string prefix of the serialization cut on a code point boundary and `truncated` is `true`. `bytes` and `hash` describe the whole original or are absent: the encoder writes them when it read the whole value, and leaves them out when it stopped at the cap, because it will not claim a length or a hash for bytes it never read. There are two exceptions. `program` is hashed in full even when its value is cut, so two executions of the same text can always be matched. A binary value cut at the cap keeps `bytes`, whose length is known without reading it, and has no `hash`.

A binary value, an `ArrayBuffer`, a `SharedArrayBuffer` or a typed array from any realm, travels as a base64 string, which is the first place the serialization departs from `JSON.stringify`. Binary is recognised by its internal brand and read through the intrinsic `buffer`, `byteOffset` and `byteLength` getters, so an object that names itself `ArrayBuffer` is an ordinary object, and a `Buffer` whose own `byteOffset` or `byteLength` a program redefined yields its own bytes and no others. When the whole slot is binary, `bytes` and `hash` are over the raw bytes, as core.md 5.4 recommends. Binary nested inside a value is written as a base64 string within that value's JSON, bounded by the cap like any other string. Either way the record's `ext` names the slot under `mocon.encoding`, so a consumer can tell the base64 text from an ordinary string. A value the serialization rejects, such as a `BigInt` or a cyclic object, is written as `{ redacted: true }`. `undefined` is written as `null` where a Payload is required, a crossing's `input`, and omitted where it is optional: `result`, `output`, an output channel.

The walker departs from `JSON.stringify` in two more ways, both bounds. A value nested deeper than 256 levels is cut there as truncated, so the record that carries it can be read back by code that recurses, `JSON.stringify` included. And a string more than 64 times longer than the cap is not read at all: a program can build a string of 134 million characters in 26 concatenations, which V8 keeps as a rope until the first character is read, and that first read flattens all of it. Such a string is recorded as truncated with no characters of it: `{ truncated: true }` for a whole slot, and inside a value a prefix that stops where the string would begin.

Rules override the encoder, one rule per slot. A rule is `"drop"`, `"hash-only"`, or a function that receives the raw value and a context, and tells targets and output channels apart through `ctx.target` and `ctx.channel`. A rule that throws, or returns anything that is not a Payload, counts as `"drop"`. A Payload a rule returns is read once and written from the fields read, `value` through the default encoder under the cap, so its own `toJSON` never runs; it carries `value`, or sets `truncated` or `redacted`, its flags are booleans, `bytes` a non-negative integer, `hash` a `sha256:` digest in lowercase hex, a truncated `value` a string, and its `value` must serialize to something. A rule that returns `undefined`, `{}`, `{ value: someFunction }` or a Payload that breaks one of those is written as `{"redacted":true}` and the caller never sees an error. A rule on an error slot decides the whole error but its `class`: under it no `message` is written, so a policy that withholds an error's content withholds all of it. The policy refuses a slot or a policy key it does not know, so a rule cannot be silently ignored.

```ts
import { fileSink, mocon, type CaptureRule } from "@mocon/core";

// The host's own masking function: returns a copy of the arguments with secrets replaced.
const mask = (args: unknown) => ({ ...(args as object), ssn: "***" });

const input: CaptureRule = (v, ctx) => {
  if (ctx.target?.startsWith("auth.")) return "drop";
  if (ctx.target?.startsWith("crm.update_")) return ctx.capture(mask(v), { redacted: true });
  return ctx.capture(v);
};

const m = mocon({
  host: "example/mcp",
  capabilities: { observes_crossings: "all", unmediated_egress: false },
  sinks: [fileSink("mocon.jsonl")],
  capture: {
    caps: { "crossing.output": 8192 },
    rules: {
      program: "hash-only",
      "crossing.input": input,
      "crossing.output": (v, ctx) => (ctx.target?.startsWith("auth.") ? "drop" : ctx.capture(v)),
    },
  },
});
```

- `"drop"` writes `{ redacted: true }`.
- `"hash-only"` writes `{ redacted: true, bytes, hash }`, the withheld shape core.md 5.4 defines. It reads the whole value to hash it, up to 8 MiB of serialization and 256 levels of nesting; past either the slot is `{ redacted: true }`. The ceiling counts the bytes written, not the characters read, so a string of control characters, six bytes of serialization each, stops at the same 8 MiB. A value a program builds for free, such as `new Array(2 ** 32 - 1)` or a `toJSON` that nests itself forever, cannot exhaust the heap.
- A function receives the raw value and a context with the slot, the target or channel, the cap and the default encoder. It returns a Payload or one of the two directives. `ctx.capture(value)` returns the frozen Payload the default encoder writes, and returning it unchanged writes exactly that, its `mocon.encoding` note included. `ctx.capture(replacement, { redacted: true })` encodes a replacement under the cap, sets the flag, and leaves `bytes` and `hash` off because they would describe the replacement, not the original.

The wrappers see the real call boundary, so a host built on `instrument` can declare `attested: ["crossing.target", "crossing.input"]` truthfully when the program cannot reach the host's realm. Whether to attest `crossing.output` or `crossing.error` is the host's call: it is true when the bridge relays the target's answer unchanged. A program that can reach the host's realm, as one in `node:vm` can, can change what the capture records, so such a host attests nothing.

## Sinks

A sink receives lines and does one thing with them.

```ts
interface Sink {
  write(lines: readonly string[]): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

Each line is one JSON object with no trailing newline, in the order the emitter produced them, handed over in a frozen array, so no sink can change what the next one receives. `end` hands over the abandoned crossings and the complete record in one `write` call. A sink that needs fields parses the line; the line is the only representation, so what a sink reads is what every other sink wrote.

- `memorySink()` keeps `lines` in an array, for tests and for a host that ships a batch itself.
- `fileSink(path)` opens the path once, appending, and writes synchronously. Nothing is lost on crash because nothing is buffered. The stream holds program text and payloads, so the file is readable by its owner only, mode `0o600`: one it finds already readable or writable by others is made owner-only before a line is written, or the open fails. A symbolic link at the path is followed only to a pipe, a socket or a character device, such as `/dev/stderr`; a link to anything else is refused, so a link planted at the path cannot send the stream into another file. Keep the directory that holds the path writable by its owner only. The path is opened non-blocking, and a full pipe gets the patience `stderrSink` gives it.
- `stderrSink()` writes to file descriptor 2 with a synchronous call, which `process.stderr.write` is not on every platform when stderr is a pipe. Node makes a piped fd 2 non-blocking once anything touches `process.stderr`, so a reader that stops draining turns a write into `EAGAIN`. The first write that finds the descriptor full waits in one-millisecond steps for up to 100 ms in all, then gives the rest of its batch up and throws, with `code` `"EAGAIN"` and a message naming the lines it could not write, which reaches `onError`. From then on the descriptor is known to be stalled: a write that finds it still full gives its batch up at once, without waiting, and the first write that gets a byte through gets the patience again. A stalled consumer costs lines and one wait of at most 100 ms, not a wait per write, and never the host's request path after that.

  A batch is written in pieces of about 1 MiB, so nothing the sink builds grows with the batch: a program that leaves tens of thousands of calls open when it returns makes a large abandon batch, and one string holding all of it could pass the engine's string limit and cost the whole batch, the execution's complete record included.
- `otlpSink` lives in `@mocon/otel`.

Both file sinks and `memorySink` come from `@mocon/core`. Several sinks go in `sinks: [a, b]`. The instance hands every write to each, and a sink that fails does not stop the others. Neither file sink installs a process hook. A synchronous write either reached the descriptor before the call returned or threw, so there is nothing to flush at exit.

The emitter calls `write` on the request path but never awaits it there. A throw from `write`, `flush` or `close`, or a rejection of the promise one of them returned, goes to the instance's `onError(error, { sink, lines, phase })`: `sink` is the sink that failed, `phase` is `"write"`, `"flush"` or `"close"`, and `lines` is the size of the batch for a write and `0` otherwise. It defaults to a no-op. The emitter attaches that handler synchronously to every promise, and catches a rejection of a promise `onError` itself returns, so a failing sink never produces an unhandled rejection. `m.flush()` awaits every sink's `flush`; on Cloudflare Workers call it inside `waitUntil`. `m.close()` marks the instance closed, then flushes and closes each sink, each sink's close waiting only on its own flush, so a sink whose flush never settles does not keep the others open. A write issued from then on, including one issued while a flush is in flight, is dropped and reported to `onError` for each sink, never left inside a sink after its flush. A second `close()` returns the first call's promise.

The host line is written when `mocon()` is called. A sink whose write of it throws or rejects is handed it again at the start of its next batch, so every stream a sink writes opens with the declaration (core.md 5.1). `m.declare()` writes it again to every sink, byte for byte. Call it after a log file is rotated by an external tool, so the new file begins with the declaration; a consumer treats the repeat as a no-op. `spec_version` is always the version this package implements; `capabilities.ext` is written on the declaration.

Never point a sink at stdout in a stdio MCP server. Stdout is the JSON-RPC channel. Use stderr or a file.

## Statelessness

- No execution is tracked across executions. The instance holds its options, the compiled capture rules, the serialized host line, whether each sink has taken it, the encoder's scratch buffer, an id pool and a clock. There is no registry of executions, no reconciliation sweep, no timer, no background thread, and no module-level state.
- Two of those are written by one execution and read by the next, and both change the bytes the later one writes, so two executions on one instance are not independent in their timestamps or in their batch contents. The clock never reads earlier than its own last reading, so after a clock that stepped back an execution records the earlier execution's reading as its `start`. And a sink that has not taken the declaration gets it at the head of the next batch, so whether an execution's batch carries the declaration depends on whether an earlier execution's write failed. The id pool is the third, and it changes nothing a record says.
- A handle holds only the crossings it opened and has not settled. `end` writes `abandoned` for those, writes the complete record, and forgets them. A second handle opened for the same dispatch abandons only the crossings it opened itself.
- The encoder keeps one scratch buffer, sized from the largest cap when the instance is built. Nothing is kept per cap, per line or per execution: a buffer larger than the scratch is allocated for that call and released with it.
- Sinks hold nothing between writes. The emitter does not batch. Each start, settle and end is one write.
- A crossing remembers only whether it is open, settled or abandoned, which is what it needs to turn a settlement after abandonment into one `late_settlement` event.
- With `sinks: []` the instance is inert: nothing is written, nothing is captured or hashed, and every handle is a no-op that still validates its arguments. Ids are still minted so the host's own code paths do not change.

## Invariants

These hold at every state boundary in the handle and capture code. Where a state changes in one place and is read in another, a check cheap enough for the request path guards it; a failed check throws an `InvariantError` with `code` `"ERR_MOCON_INVARIANT"`. The rest hold by the construction of the one line that changes the state, where a check could only restate that line. A failed invariant is a bug in this package, never a bad input: bad input is rejected with a `TypeError` or `RangeError` before any state changes. Each has a test named after it in `test/invariants.test.ts`. `invariant(condition, message)` and `InvariantError` are exported, so the packages built on this one check their own invariants the same way.

- A crossing ends at most once: it leaves the open state once, settled or abandoned, and a settlement after abandonment is an event, not a second record.
- Abandon precedes execution end: every crossing the handle has opened and not settled is written abandoned, in the same write, before the execution's complete record. A crossing is tracked from the moment it is opened, before its input is captured, so a capture rule, an `instrument` derive or a `toJSON` that ends the execution from inside that capture still finds it, and its record carries the input the capture never returned as `{ redacted: true }`.
- An execution ends at most once.
- No crossing is tracked after its execution ended: every crossing whose `start` is at or before the execution's `end.time` has its complete record written before the execution's complete record. A crossing opened after the end is not tracked, and its own lines follow the complete record, which core.md 4 rule 4 allows because a consumer's view does not depend on their order.
- A complete record carries every required field: `id`, `program` and `start` on an execution, and `id`, `execution_id`, `target` and `input` on a crossing.
- `bytes` equals the byte length of the serialization the hash is taken over.
- `truncated` implies `value` is a string prefix of the serialization, within the cap.
- The host declaration is written before any record: a sink that has not accepted it gets it at the head of every batch, including one whose write is still in flight, until one write carrying it goes through.

## Performance

No absolute time is a target here, and nothing is gated on one. A figure such as "under 10 microseconds" is one machine's reading on one day: it passes a fast machine that has regressed and fails a slow one that has not, and it rots in a README, where nothing re-measures it.

What `npm run bench` enforces from the repository root is that this code has not got slower than itself. `bench/hot-path.mjs` records a baseline for every row it measures, and beside them a `calibration`: what a fixed JSON parse-and-write round trip of a 1 KiB object, with no mocon in it, read on the machine those baselines came from. Each run measures that same calibration again in the same process and scales every baseline by this run's calibration over the recorded one. A machine half the speed of the recording machine measures calibration twice as slow, so every row's bar moves with it and the gate asks whether this code got slower rather than whether this machine is. A row fails above **2x its scaled baseline**, and a row with no baseline recorded fails too; either exits the run non-zero and is named on stderr.

To check it: run `npm run bench`. It builds, then prints one row per case with its median, its slowest round, and a `baseline` column holding that row's ratio to its scaled baseline. Every row is gated, not a chosen few, so anything above `2.00x` in that column is what failed. The gated figure is the median of 15 rounds after a warmup. The slowest round is printed and not gated: on a machine running anything else it reads the scheduler rather than this code, and the same row has measured 6,508 ns and 23,000 ns as its slowest round in two runs minutes apart with an unchanged median.

The baselines in `BASELINE` are the lowest median of three runs on an idle machine, the reading the scheduler interfered with least, and that machine is named beside them. Re-record them when the code's cost legitimately changes, deliberately and in one commit, never to make a failing run pass.

`npm test` asserts no absolute time either. Its timing assertions compare two measurements taken in the same process and assert a shape the machine cannot change: one 1 KiB crossing against the serializing and hashing inside it, a 5 MB payload against a 5 KB one under the same cap, a forged 400 M element binary value against a 40 M element one, a stalled descriptor against a sink that keeps the line. Each side is the shortest of several rounds after a warmup, because the shortest run is the one the scheduler left alone, and each bound is several times the steady-state ratio and far below the ratio the regression it guards would produce. A suite that fails on a busy machine is worse than no suite, and a suite that asserts microseconds is one.

One snapshot follows, so the orders of magnitude are on this page. It is a measurement and not a target; run the bench for the verdict. The last row writes through `fileSink` to a temporary file, to show what a synchronous append adds; that part is the operating system's cost, not the emitter's. The row of 23 small records is the shape of the `person_search` rows in core.md Appendix A, which costs the walker the most per byte.

Measured on Node v24.16.0, darwin arm64, Apple M5, otherwise idle, on 2026-09-18. Null sink unless noted. Lowest median of three runs of 15 rounds.

| case | ns per operation |
|---|---|
| crossing start + end, 24 B input, 100 B output | 3,915 |
| crossing start + end, 24 B input, 1 KiB output | 5,799 |
| crossing start + end, 1 KiB input, 1 KiB output | 7,565 |
| crossing start + end, 24 B input, 1 KiB output of 23 records | 9,490 |
| crossing start + end, 24 B input, 128 KiB string output | 190,900 |
| crossing start + end, 24 B input, 1 MiB string output | 187,814 |
| crossing start + end, 24 B input, 3 MiB string output | 192,172 |
| crossing start + end, 24 B input, 5 MB string output | 1,627 |
| crossing start + end, 24 B input, 5 MB object output | 2,382 |
| crossing start + end, 24 B input, 10,000-key object output | 1,588,406 |
| execution start + end, 204 B program, notice on | 3,690 |
| crossing start + end, 24 B input, 1 KiB output, fileSink | 15,599 |

The 5 MB rows cost less than the 1 KiB ones because a string more than 64 times the 64 KiB output cap is not read at all; a 3 MB string output is read only as far as the cap. No `bytes` or `hash` is computed over an original the encoder did not read in full. About a third of a 1 KiB crossing is native work that any emitter pays: two SHA-256 digests and a UTF-8 decode of each payload. The 10,000-key row is the own-key cost the paragraphs below measure, and it is the one cost no cap reduces.

Where the time goes:

- Each payload is serialized once, as UTF-8 written straight into a scratch buffer. Those bytes give `bytes` and are what `hash` is taken over, and one decode gives the text spliced into the line, so a line is a fixed envelope concatenated around payload text that already exists, not a second `JSON.stringify` of the whole record. The part of a line fixed at start, the host, ids, target, input and start time, is written once per handle; a settlement appends `end` and `ext`.
- A short string that needs no escaping is copied byte by byte; any other is escaped natively. A plain object's members are read in a `for...in` loop, which V8 compiles to direct field loads for objects of one shape.
- SHA-256 is one call to `crypto.hash` (Node 20.12 and later), with `createHash` as the fallback on older 20.x.
- Ids come from a pooled CSPRNG read sliced into 16 and 8 byte chunks, and are written without an escaping pass, as are the clock's readings. The clock formats the date and time to the second once per second, appends the milliseconds itself, and returns its last text when the millisecond has not changed.
- The line budget of a complete execution record counts a payload at its largest possible size and measures it exactly only when that estimate would cut a cap.

The encoder is bounded in the bytes it writes and the members it reads, so a 5 MB result costs O(cap) in both, not O(size), with one exception: the own key list of each object it opens, which the paragraph after this one measures. A string is sliced to the remaining budget first and escaped after, so the characters past the cap are never read, and one far past the cap is not read at all. Any other value goes through a walker that mirrors `JSON.stringify` byte for byte, with the departures described under Capture: key order, `toJSON` on objects and functions, unboxing of wrappers from any realm by internal slot, `JSON.rawJSON`, an array's `length` read once, `undefined` in arrays versus objects, lone surrogates, number formatting. It checks each object for a cycle and each level for the depth bound, and stops when the budget is spent. Every node it visits adds at least one byte of output, except an object member that serializes to nothing, `undefined`, a function, a symbol or a `toJSON` that returns one of those, and those are counted against the budget too, so the number of members read is bounded by the cap and not by the size of the original: a program cannot make the walker run 100,000 getters under a 1 KiB cap. The test suite checks the walker against `JSON.stringify` on a corpus and on generated values for byte equality, which is what makes a truncated `value` a true prefix of the host's serialization.

Two costs stay proportional to size, and the width of an object is the one a program chooses. An object's own key list is read whole before its first member: V8 materializes the keys of a large object, and a Proxy's `ownKeys` result, before the first iteration whether the walker uses `Object.keys` or `for...in`. So the honest bound on a capture is O(cap) in bytes written and members read, plus O(own keys) once per object opened, and no cap reduces that second term. On the machine and date of the snapshot above, a crossing whose input is a plain object cost about 0.005 ms at 10 keys, 0.15 ms at 1,000, 19 ms at 100,000 and 262 ms at 1,000,000, and the same 100,000-key object cost 19 ms under a 16-byte cap and 22 ms under a 256 KiB one — a cap sixteen thousand times smaller bought nothing. Read those for the curve, which is the part that holds: linear in the key count, and flat in the cap. A host that captures values from a program it does not trust should reject one whose own key count passes a bound of its own before it hands the value over, or set a `drop` rule on the slot, which recorded the same object in 0.003 ms. The other cost is `program`, hashed in full in one native SHA-256 pass because core.md 5.2 wants `program.bytes` and `program.hash` on every record; that text is the host's, not the program's.

## Runtimes

Node 20 or later, Bun, Deno, and Cloudflare Workers with `nodejs_compat` and a compatibility date of 2025-09-01 or later, the first with `node:fs`. The package imports `node:crypto` for synchronous SHA-256 and random bytes, `node:util` for the internal-slot checks that recognise binary, boxed values and errors from any realm, `node:fs` for the two file sinks, and uses the `Buffer` global, and nothing else from the platform.

The published tarball carries `dist` and `src`, so the source maps in `dist` resolve and a stack trace under `--enable-source-maps` names a file that exists. `dist` is not in the repository, so packing builds first through `prepack`; a manifest without it would publish a package holding nothing but its own manifest and README, which npm reports as a success.

## Conformance

`spec/conformance/README.md` defines producer conformance. The tests in this package feed emitted streams to the same structural checks `check.py` applies and to the JSON schema in `spec/schema/`, check that each of the nine invalid fixtures is refused at the emitter's boundary wherever its API can express it, and run the reference checker itself on an emitted stream when `python3` is available. `npm run conformance` at the repository root runs the checker over the whole suite.

`@mocon/core/fold` carries the consumer-side tools, which the emitter's main entry does not. `CLOSED` holds the closed sets of core.md 8, `disposition`, `outcome`, `observes_crossings` and `crossing_edge`, and the `attested` entries this version knows, as `ReadonlySet`s; the emitter, `fold`, `@mocon/otel` and `@mocon/cli` test membership against that one copy. `unixNanos(text)` is the one timestamp validator they all apply: unix nanoseconds for an RFC 3339 UTC time that exists, `undefined` otherwise. `canonical(text)` is the canonical JSON check.py compares records by, and `sameMajor(version)` the one rule of core.md 11. `sha256(data)` is the one digest in this repository, the emitter's and the derived span ids of `@mocon/otel` alike. `stringifyDeep(value, keysOf?)` writes a value a consumer parsed out of a line at any depth, where `JSON.stringify` recurses on the native stack and gives up a few thousand levels down; `keysOf` gives an object's keys in the order the line carried them, which the engine does not preserve for an array-index key. It writes a bigint as its digits, which is how an int64 past 2^53 survives a second parse, and rejects a value that holds itself with the `TypeError` `JSON.stringify` raises; both hold whether or not `keysOf` is given, because whatever the native call refuses the loop decides.

`fold(lines)` builds the canonical view that `spec/conformance/README.md` section 3 defines: the supersede rule applied once per key, order-independently, with `unresolved`, `conflicts` and `skipped`. It keys executions and crossings by host and id, `host + "\0" + id`, because core.md 6 scopes ids to a host; the maps have no prototype, so a key such as `__proto__` is an entry like any other. That key is not injective: a host `a` with id `b\0c` and a host `a\0b` with id `c` share one key, and both are legal on the wire, where neither field is patterned or bounded. Two such records fold as one, which check.py, keying by the pair itself, does not do. Which one the view then keeps is decided by the tie-break below, never by the order the lines arrived in, so every permutation of a stream still gives one view. A line whose `host`, or whose `id` on an execution or crossing, is not a string is skipped and counted, so one hostile line costs that line and not the fold. Of two conflicting complete records it keeps the one check.py keeps: the one whose canonical JSON sorts first, where canonical JSON is `json.dumps(sort_keys=True)`, with keys sorted by code point, non-ASCII escaped and `1` distinct from `1.0`. A record whose `end` carries a value outside its closed set reads as having no `end`, and a declaration loses such a key (core.md 8); `flagged` counts those lines, and a record is copied without the key as own data, so an own `__proto__` key in the line never becomes the copy's prototype. `unresolved` and `conflicts` are sorted by kind, host and id compared by Unicode code point, which is the order check.py's lists come out in; JavaScript's `<` compares UTF-16 units and would put U+1F600 before U+FFFD. A record is kept as `JSON.parse` returns it, so an integer outside the double range is not preserved: a `seq` of 12345678901234567890, which no schema in this repository bounds, reads back as 12345678901234567000 here and exactly in check.py. The tie-break is unaffected, because `canonical` reads the digits from the text. The tests fold every golden stream, compare the result with `spec/conformance/expected/` after dropping the host prefix, and check that any permutation gives the same view.
