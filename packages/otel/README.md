# @mocon/otel

Turns mocon lines into OpenTelemetry spans and posts them as OTLP/JSON. No OpenTelemetry dependency; the package speaks the `ExportTraceServiceRequest` JSON shape directly and depends only on `@mocon/core`, from whose `fold` entry it takes the closed sets, the timestamp validator, the canonical form, the SHA-256 its ids derive from and the deep JSON writer, so it keeps no copy of any of them. It implements `spec/otel-mapping.md`, which is normative for sinks.

## The sink

`otlpSink({ url, headers?, fetch?, cap?, timeoutMs? })` returns a `Sink` for `@mocon/core`, and is the whole surface. Each `write` becomes one POST of `application/json` to `url` carrying every span the batch produced, and no POST when it produced none. Nothing is batched across writes and nothing waits for a matching line. The sink parses each line it is handed; anything handed over that is not a string is counted as malformed and never touched. At most 64 POSTs are in flight: a `write` that arrives past that bound is dropped, and the promise it returns rejects with an error that says so. A failed POST rejects the same promise, with the status and the first 200 bytes of the response body. The body of a successful POST is never read, and a failed one's no further than those 200 bytes, taken in at most 32 reads and under the same deadline the request ran on. A collector, or anything on the path to an `http://` endpoint, therefore cannot make the host buffer its answer, keep it reading or keep the write pending, whatever the size, the number or the pace of the chunks it sends. A `Mocon` instance passes every rejection to its `onError`; nothing is thrown into the host. `flush()` resolves when the POSTs in flight have settled, whether they succeeded or not. `fetch` defaults to the global `fetch`; a stand-in resolves to `{ ok, status, body? }`, `body` a `ReadableStream` of bytes.

Each request carries an `AbortSignal` that expires after `timeoutMs`, ten seconds by default, and the sink enforces the same deadline itself, so a stand-in that ignores the signal cannot hold a write open either. A collector that accepts the connection and never answers therefore costs one request and one error, not a `flush` that never resolves and a sink whose 64 slots fill and stay full. The signal belongs to the request: the sink starts no timer of its own and holds none between writes.

`cap` is the string attribute cap of otel-mapping.md section 9, in UTF-8 bytes; there is none by default.

A line that produces no span is counted by reason, as otel-mapping.md section 3 asks, because a `bad_enum` line is a host bug and an ordinary notice is not: `"notice"` for a line without `end`, `"malformed"` for text that is not a JSON object or a complete line missing a field core.md marks required, an `end.error` without the `class` core.md 5.5 requires included, `"unknown_kind"`, `"bad_enum"` for a present closed-set value outside its set, and `"bad_timestamp"` for a time that does not parse, whether required or one the crossing chose to carry. The sink exposes the counts as `skipped`, the number of differing host re-declarations it has seen as `conflicts`, the number of declarations of another major version as `versionMismatches`, and the number it could not hold because its bound on host strings was reached as `declarationsDropped`.

## The mapping

Ids follow core.md section 6 exactly: the execution id is the trace id when it is 32 lowercase hex digits and not all zeros, the execution span id is always hashed, a crossing id is the span id when it is 16 lowercase hex digits and not all zeros, and a well-formed `context.traceparent` moves a span into the caller's trace. Well formed is what otel-mapping.md 4.1 says: lowercase hex for the trace id and the parent id, and hex digits in either case for the version and the flags. Every id comes from the span's own line, so two sinks reading the same stream land in the same trace.

Values follow otel-mapping.md section 8.2. A string, a boolean, an integer within int64 and any other number keep their type. An integer keeps the digits the line carried: one past 2^53 but within int64, such as a snowflake id, is read exactly rather than rounded to a double, in an attribute of its own and inside a JSON text. A number literal past the double range is a double of `"Infinity"` or `"-Infinity"`, as proto3 JSON writes it. An object, an array or `null` is written as compact JSON with non-ASCII characters unescaped and every object's keys in the order the line carried them, at any depth. A line nested deeper than `JSON.stringify` can recurse is written in full by `stringifyDeep` from `@mocon/core/fold`, a loop that keeps its stack on the heap and takes the key order from here.

Provenance labels are written as attributes: `mocon.provenance.<field>` is `"P"` or `"T"` for each present field whose class is not host-observed after the declaration's `attested` list is applied. `ext` keys are listed once, in line order, in `mocon.provenance.ext.p`. `mocon.host.attested` carries only the entries this version knows; an unknown entry is ignored there as it is for the labels (provenance.md 4).

A declaration whose `spec_version` names another major version is not applied: core.md section 11 lets a consumer refuse it, and an `attested` list whose meaning this package does not know must not lift a provenance label. Spans for that host string read as they would before any declaration.

## State

The sink holds one host declaration per host string, the only state otel-mapping.md section 2 allows, for at most 256 host strings; a declaration for a further host string is not stored and is counted in `declarationsDropped`, so that host's spans carry no `mocon.host.*` attributes and baseline provenance labels, and a reader can see that it happened. It sees the declaration first because `@mocon/core` writes the host line first; a declaration that arrives after spans were exported cannot change them. When two declarations for one host string differ, the sink keeps the one whose canonical JSON sorts first, the tie-break core.md section 4 recommends, with canonical JSON as `canonical` from `@mocon/core/fold` builds it, the form check.py compares, and counts the conflict. It also holds the set of POSTs in flight, so `flush` can await them and the bound can hold. Nothing else outlives a `write`.

## Invariants

Each holds by the construction of the one place that builds a span or changes the sink's state, and has a test named after it in `test/invariants.test.ts` that asserts it over the spans the mapping and the sink produce for every golden stream.

- Span ids are lowercase hex of OTLP width.
- A span carries its own line's end: never a disposition or outcome for a record that has not ended.
- One span per complete line: a request carries exactly the spans it was built from.
- The sink holds declarations for at most 256 host strings.
- The sink holds at most 64 POSTs in flight.

## Credentials

Credentials belong in `headers`. A URL that carries userinfo is refused when the sink is built, because `fetch` refuses it too and repeats the whole URL, password included, in its error. The sink's errors print the collector as origin and path only, so a key in the query string or fragment stays out of `onError` and the logs behind it. A header that `fetch` would refuse is refused when the sink is built, with a message that does not repeat its value. Redirects are not followed: `fetch` strips only `authorization` on a cross-origin hop, so a vendor key header such as `x-api-key` would reach whatever host the collector named. A 3xx answer rejects the write like any other failed status.

## Performance

`write` runs on the host's request path, where the emitter calls it without awaiting it. Its synchronous part, parsing and mapping the batch, serializing the request and starting the POST, costs about 25 microseconds for a crossing line with a 1 KiB value and hashed ids, about half of it the mapping, measured on Node 24 on an Apple M5. The cost is proportional to the size of the lines, dominated by `JSON.parse` and `JSON.stringify`. A line holding an array-index key, or an integer token of sixteen digits or more, is parsed a second time to recover its key order and keep its integers exact, which costs about three times what `JSON.parse` costs; `@mocon/core`'s default caps keep any object value in a line under 64 KiB. `npm test` holds no microsecond figure, which would be one machine's number asserted on every machine that runs the suite. It holds the shapes instead: a write costs a small multiple of the mapping it does, a 1 KiB value a small multiple of a one-byte value, a 5 MB value the same per byte as a 50 KB one, and a 200,000-deep value the same per level as a 2,000-deep one. Each bound is a ratio between two measurements from the same run, each the fastest of several rounds after a warmup, and each is at least five times what a healthy run measures, so a busy machine moves both readings and fails nothing while work gone quadratic moves one of them by a hundred. The absolute figures are the ones above, each named with the machine that produced it, and `bench/hot-path.mjs` gates the emitter's.

## Usage

```ts
import { mocon } from "@mocon/core";
import { otlpSink } from "@mocon/otel";

const m = mocon({
  host: "example/mcp",
  capabilities: { observes_crossings: "all", unmediated_egress: false },
  sinks: [
    otlpSink({
      url: "https://otlp.example.internal/v1/traces",
      headers: { authorization: `Bearer ${process.env.OTLP_TOKEN}` },
    }),
  ],
  onError: (error) => console.error("mocon export failed", error),
});
```

To see what a stream maps to without a collector, hand the sink a `fetch` of your own. One `write` of the whole stream is the batch a sink receives, so the declarations in it are held exactly as they would be in production:

```ts
import { otlpSink } from "@mocon/otel";

const sink = otlpSink({
  url: "memory:",
  fetch: async (_url, init) => {
    console.log(init.body);
    return { ok: true, status: 200, body: null };
  },
});
await sink.write(stream);
```

`mocon otlp <file>` in `@mocon/cli` does the same from the command line, and checks a stream against `spec/conformance/otlp/`.
