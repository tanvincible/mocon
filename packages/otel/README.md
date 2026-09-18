# @mocon/otel

Turns mocon lines into OpenTelemetry spans and posts them as OTLP/JSON. No OpenTelemetry dependency; the package speaks the `ExportTraceServiceRequest` JSON shape directly and depends only on `@mocon/core`, from whose `fold` entry it takes the closed sets, the timestamp validator, the canonical form, the SHA-256 its ids derive from and the deep JSON writer, so it keeps no copy of any of them. It implements `spec/otel-mapping.md`, which is normative for sinks.

## The sink

`otlpSink({ url, metricsUrl?, headers?, fetch?, cap?, timeoutMs? })` returns a `Sink` for `@mocon/core`, and is the whole surface. Each `write` becomes one POST of `application/json` to `url` carrying every span the batch produced, and no POST when it produced none. With a `metricsUrl` the same `write` posts a second request, an `ExportMetricsServiceRequest` of the metric points that batch produced, and the write settles when both have; without one the sink is trace-only and the declared values ride their spans as attributes, which is what otel-mapping.md 14 asks. Nothing is batched across writes and nothing waits for a matching line. The sink parses each line it is handed; anything handed over that is not a string is counted as malformed and never touched. At most 64 POSTs are in flight: a `write` that arrives past that bound is dropped, and the promise it returns rejects with an error that says so. A failed POST rejects the same promise, with the status and the first 200 bytes of the response body. The body of a successful POST is never read, and a failed one's no further than those 200 bytes, taken in at most 32 reads and under the same deadline the request ran on. A collector, or anything on the path to an `http://` endpoint, therefore cannot make the host buffer its answer, keep it reading or keep the write pending, whatever the size, the number or the pace of the chunks it sends. A `Mocon` instance passes every rejection to its `onError`; nothing is thrown into the host. `flush()` resolves when the POSTs in flight have settled, whether they succeeded or not. `fetch` defaults to the global `fetch`; a stand-in resolves to `{ ok, status, body? }`, `body` a `ReadableStream` of bytes.

Each request carries an `AbortSignal` that expires after `timeoutMs`, ten seconds by default, and the sink enforces the same deadline itself, so a stand-in that ignores the signal cannot hold a write open either. A collector that accepts the connection and never answers therefore costs one request and one error, not a `flush` that never resolves and a sink whose 64 slots fill and stay full. The signal belongs to the request: the sink starts no timer of its own and holds none between writes.

`cap` is the string attribute cap of otel-mapping.md section 9, in UTF-8 bytes; there is none by default.

`flush()` waits for the POSTs in flight; `close()` waits for the same ones, so a `Mocon` whose `close` runs this sink's does not return while a request is open. The sink owns no socket, timer or dispatcher to release beyond them. With the global `fetch` the platform owns the connections, and Node's keep-alive pool holds them open after the last response: on Node 24 a process that posted to a collector can stay alive about four seconds after `close()` resolves, with the sockets still listed as active handles. That tail is the platform's and not the sink's — the same number of bare `fetch` calls with no mocon in the process linger for the same four seconds — but a reader who expects `close()` to free the process should know it is there. A host that needs the process down sooner passes its own `fetch` over a dispatcher it can destroy.

A line that produces no span is counted by reason, as otel-mapping.md section 3 asks, because a `bad_enum` line is a host bug and an ordinary notice is not: `"notice"` for a line without `end`, `"malformed"` for text that is not a JSON object or a complete line missing a field core.md marks required, an `end.error` without the `class` core.md 5.5 requires included, `"unknown_kind"`, `"bad_enum"` for a present closed-set value outside its set, and `"bad_timestamp"` for a time that does not parse, whether required or one the crossing chose to carry. The sink exposes the counts as `skipped`, the number of differing host re-declarations it has seen as `conflicts`, the number of declarations of another major version as `versionMismatches`, and the number it could not hold, because its bound on host strings or on the size of one declaration was reached, as `declarationsDropped`. `"unknown_kind"` covers every kind this version does not define, the extension kinds included: `kind: "event"`, which `@mocon/core` writes for a late settlement, is counted there and produces no span, so a settlement the emitter recorded reaches no trace backend and shows only in that counter.

## The mapping

Ids follow core.md section 6 exactly: the execution id is the trace id when it is 32 lowercase hex digits and not all zeros, the execution span id is always hashed, a crossing id is the span id when it is 16 lowercase hex digits and not all zeros, and a well-formed `context.traceparent` moves a span into the caller's trace. Well formed is what otel-mapping.md 4.1 says: lowercase hex for the trace id and the parent id, and hex digits in either case for the version and the flags. Every id comes from the span's own line, so two sinks reading the same stream land in the same trace.

Values follow otel-mapping.md section 8.2. A string, a boolean, an integer within int64 and any other number keep their type. An integer keeps the digits the line carried: one past 2^53 but within int64, such as a snowflake id, is read exactly rather than rounded to a double, in an attribute of its own and inside a JSON text. A number literal past the double range is a double of `"Infinity"` or `"-Infinity"`, as proto3 JSON writes it. An object, an array or `null` is written as compact JSON with non-ASCII characters unescaped and every object's keys in the order the line carried them, at any depth. A line nested deeper than `JSON.stringify` can recurse is written in full by `stringifyDeep` from `@mocon/core/fold`, a loop that keeps its stack on the heap and takes the key order from here.

Provenance labels are written as attributes: `mocon.provenance.<field>` is `"P"` or `"T"` for each present field whose class is not host-observed after the declaration's `attested` list is applied. `ext` keys are listed once, in line order, in `mocon.provenance.ext.p`, each as the bare key: for `ext {"example.credits_used": 3}` the array holds `"example.credits_used"`, not `"mocon.ext.example.credits_used"` and not `"ext.example.credits_used"`. otel-mapping.md section 10 states that array three ways in one sentence — the formula, the prose and the naming rule each give a different spelling — so this is the reading, it is the one the spec's own OTLP fixtures carry, and `test/determinism.test.ts` holds it. A key that is host-observed is left out of that array: one of the four reserved `mocon.` envelope notes (core.md 3), or a declared key under both of provenance.md 4's gates — `ext.declared` attested and `observed: true` on its `dimensions` entry — and the array is omitted altogether when every `ext` key on the span is. `mocon.host.attested` carries only the entries this version knows; an unknown entry is ignored there as it is for the labels (provenance.md 4). `dimensions` itself is never exported as an attribute (otel-mapping.md 6.2): the sink reads it, for the labels above and for the metrics below.

A timestamp is read by `unixNanos` from `@mocon/core/fold`, the one validator every package here applies. A leap second, `23:59:60`, is a valid RFC 3339 time and is accepted: it maps to the first instant of the next minute. A date or time that names no instant — February 30, hour 25, minute 60 — does not parse, so the line is skipped and counted as `bad_timestamp`, even though `spec/schema`'s `date-time` pattern and check.py's regex both accept it.

A status of UNSET is written as an explicit `{"code": 0}` rather than as an empty object. The two are the same message in proto3, but `spec/conformance/otlp` compares structurally, so a sink that writes one and a sink that writes the other fail each other's check; this is the form this sink writes.

A declaration whose `spec_version` names another major version is not applied: core.md section 11 lets a consumer refuse it, and an `attested` list whose meaning this package does not know must not lift a provenance label. Spans for that host string read as they would before any declaration.

`links` (`spec/extensions/links.md`) becomes one OTel span link per entry, plus `mocon.links` holding the array's JSON text. Every id comes from the entry itself — the named record's trace and span ids are derived the way that record's own line would derive them — so no state and no lookup is involved, and a link to a record in last month's file resolves the same as one to a record in this batch. An entry this version cannot read is dropped from the span links and stays in `mocon.links`: an unknown `rel`, `counts` or `kind`, an entry naming the record that carries it (links.md 7), and a `crossing` entry on an execution line with no `execution_id`, which has no trace id to derive. The link core.md 6 requires on the traceparent degraded path carries no attributes and stays first; each entry's link carries `mocon.rel` and `mocon.counts`.

## Metrics from declared dimensions

A key the host declared `agg: "sum"` or `"last"` (core.md 5.1.1) becomes an OTLP metric point, the way a crossing becomes a span: `sum` a `Sum` with `aggregationTemporality: DELTA` and `isMonotonic: false`, `last` a `Gauge`, the instrument named `mocon.ext.<key>` and carrying the declared `unit` verbatim, or `1` when absent. Delta is what lets a stateless sink export a metric at all: each point is the value its own record carried, and the backend does the adding.

Three conditions, all of them (otel-mapping.md 14): the key is declared `sum` or `last`, its value on that record is a finite JSON number, and its provenance is **H** — the host attests `ext.declared` *and* the entry carries `observed: true`. The third is not decoration. A metric point has no per-point provenance channel, so a program-determined value exported as a metric would present a claim as fact, which provenance.md 5 forbids; a value that has not been attested stays on its span with its `P` label, exactly as in 1.0, and a host that wants the metric attests the key. A value that is not a finite number — a `null`, a string, an infinity — is a mismatch under core.md 5.1.1: it is displayed on the span and exported nowhere.

Point attributes are the closed list section 14 gives and nothing else: `mocon.host`; `mocon.crossing.target` and `mocon.crossing.outcome` on a point from a crossing, `mocon.execution.disposition` on one from an execution; and every `ext` key on that same record declared `agg: "none"` with `card: "low"` that is itself H. Never an execution id, a crossing id, a session, a traceparent, a `card: "high"` or `card`-absent key, or a key whose provenance is P — that is the whole cardinality rule, and `card` defaults to `high` so a host opts a facet in rather than out. The list being closed is also why `cap` does not apply to a point attribute: a cut string needs a `truncated` flag beside it, and the list has no room for one.

A point's window is its record's own: `startTimeUnixNano` is `start` when present, else `end.time`; `timeUnixNano` is `end.time`, else the sink's receipt time, the same fallbacks section 7.3 gives a crossing span. The instrument is keyed by name, unit and aggregation together, so two declarations that disagree produce two instruments rather than one mislabelled series.

## What a second sink may still write differently

otel-mapping.md section 1 promises that any two sinks produce the same trace ids, span ids, span names and attributes from the same stream. The ids and the names hold unconditionally. The attribute set holds for a given stream order and a given configuration, and the document itself names the axes:

- **Where the declaration sits.** A sink maps a line when it arrives, so a declaration governs the records that follow it and not the ones already exported. core.md 4.4 allows a host line after the records it governs, and a stream split, rotated or tailed from the middle presents one that way. Spans mapped with no declaration in hand carry no `mocon.host.*` and label every program-determined field `P`, which reads the same as a declaration that attests nothing. Feed the whole stream to one `write`, as `mocon otlp` does, and the declaration is in hand for every line of it.
- **`cap`** (section 9), which changes every string attribute it cuts and adds a `<key>.truncated` flag. Two sinks at different caps write different text.
- **Whether a declaration is held** (section 2), which this sink does, for at most 256 host strings and 64 KiB per line.
- **A `false` flag** (section 8.1), which this sink copies rather than omitting.

Two more are worth naming because no configuration fixes them:

- A stream with **no complete execution line** exports none of the declaration's five fields, because section 6.2 puts `mocon.host.*` on execution spans only. A backend reading such an export cannot see `observes_crossings` or `unmediated_egress`, which core.md 12 names as the two facts a consumer needs before concluding anything about external calls. Crossing spans carry `mocon.host`, the host string, and nothing else of the declaration.
- A record that only ever has a **start notice** reaches the export not at all, so its `id`, `start`, `language` and `program` are lost with it. That is section 3's rule, not an omission here.

Under a `cap`, section 9's flag name collides with the `ext` namespace: an `ext` key literally named `v.k.truncated` writes the same attribute name as the cap flag for the key `v.k`, and a reader cannot tell them apart. `ext` keys are an open `vendor.key` namespace, so a stream can do this; every conforming sink does the same thing with it.

## State

The sink holds one host declaration per host string, the only state otel-mapping.md section 2 allows, for at most 256 host strings and at most 64 KiB of line each; a declaration for a further host string, or one whose line is longer than that, is not stored and is counted in `declarationsDropped`, so that host's spans carry no `mocon.host.*` attributes and baseline provenance labels, and a reader can see that it happened. The byte bound is the other half of the entry bound: section 2 calls the host record small, and nothing in the format makes it so — a declaration's `ext` is as unbounded as any other, and 256 slots of it are 256 slots of whatever the stream chose. The `attested` list is reduced to the entries this version knows once per declaration, not once per line, and `dimensions` is read once per declaration the same way, so a list or a map of any length costs one span nothing. It sees the declaration first because `@mocon/core` writes the host line first; a declaration that arrives after spans were exported cannot change them. When two declarations for one host string differ, the sink keeps the one whose canonical JSON sorts first, the tie-break core.md section 4 recommends, with canonical JSON as `canonical` from `@mocon/core/fold` builds it, the form check.py compares, and counts the conflict. It also holds the set of POSTs in flight, so `flush` can await them and the bound can hold. Nothing else outlives a `write`.

## Invariants

Each holds by the construction of the one place that builds a span or changes the sink's state, and has a test named after it in `test/invariants.test.ts` that asserts it over the spans the mapping and the sink produce for every golden stream.

- Span ids are lowercase hex of OTLP width.
- A span carries its own line's end: never a disposition or outcome for a record that has not ended.
- One span per complete line: a request carries exactly the spans it was built from.
- The sink holds declarations for at most 256 host strings, and none whose line is longer than 64 KiB.
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
