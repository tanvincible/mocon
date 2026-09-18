/**
 * sink.ts against a stand-in fetch: one POST per write that produced a
 * span, the declaration it holds, the counters, the in-flight bound, the
 * URL checks, failure reporting, and the path through a real
 * `@mocon/core` instance.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mocon } from "@mocon/core";
import { otlpSink, type ExportTraceServiceRequest } from "../src/index.js";
import { attrs, bodyOf, canonicalize, convertStream, execution, fakeFetch, HOST, mergeRequests, ok, readStreamLines, spanOf, spansOf, type Rec, type Response } from "./helpers.js";

const URL_ = "https://collector.example/v1/traces";
const text = (records: object[]): string[] => records.map((r) => JSON.stringify(r));
const hostLine = (host: string, extra: Rec = {}): Rec => ({ kind: "host", host, spec_version: "1.0", observes_crossings: "all", ...extra });

test("one POST per write that produced a span, with content-type, the configured headers, and redirects not followed", async () => {
  const lines = readStreamLines("sync-bridge");
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, headers: { authorization: "Bearer t", "x-api-key": "k" }, fetch: f.fetch });
  const results = lines.map((line) => sink.write([line]));
  assert.equal(results[0], undefined, "the host line returns synchronously with no POST");
  assert.equal(results[1], undefined, "so does the notice");
  assert.ok(results[2] instanceof Promise);
  await sink.flush();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0]?.url, URL_);
  assert.deepEqual(f.calls[0]?.init.headers, { "content-type": "application/json", authorization: "Bearer t", "x-api-key": "k" });
  assert.equal(f.calls[0]?.init.method, "POST");
  assert.equal(f.calls[0]?.init.redirect, "manual");
  assert.deepEqual(sink.skipped, { notice: 1, malformed: 0, unknown_kind: 0, bad_enum: 0, bad_timestamp: 0 });
  assert.equal(sink.conflicts, 0);
  assert.equal(sink.versionMismatches, 0);
});

test("a write batch becomes one request holding every span in it, grouped by host", async () => {
  const [a, b] = readStreamLines("sync-bridge").slice(2, 4) as [string, string];
  const other = JSON.parse(a) as Rec;
  other["host"] = "other/host";
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  await sink.write([a, b, JSON.stringify(other)]);
  assert.equal(f.calls.length, 1);
  const body = f.calls[0]?.body as ExportTraceServiceRequest;
  assert.equal(body.resourceSpans.length, 2);
  assert.equal(body.resourceSpans[0]?.scopeSpans[0]?.spans.length, 2);
  assert.equal(body.resourceSpans[1]?.scopeSpans[0]?.spans.length, 1);
  assert.deepEqual(body.resourceSpans[1]?.resource.attributes, [{ key: "service.name", value: { stringValue: "other/host" } }]);
  assert.equal(body.resourceSpans[1]?.scopeSpans[0]?.scope.name, "mocon/other/host");
});

test("lines that produce no span are counted by reason and never posted", () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const r = sink.write([
    "{oops",
    JSON.stringify({ kind: "metric", host: "h" }),
    JSON.stringify({ kind: "execution", host: "h", id: "x", start: "2026-09-16T10:00:00Z" }),
    JSON.stringify(execution({}, { disposition: "done" })),
    JSON.stringify(execution({ start: "soon" })),
    JSON.stringify(execution({}, { disposition: undefined })),
    JSON.stringify({ kind: "crossing", host: "h", id: "c", execution_id: "x", end: { outcome: "output" } }),
  ]);
  assert.equal(r, undefined);
  assert.deepEqual(sink.skipped, { notice: 1, malformed: 3, unknown_kind: 1, bad_enum: 1, bad_timestamp: 1 });
  assert.equal(f.calls.length, 0);
});

test("the sink holds one declaration per host string and applies it to later lines; a late declaration changes nothing already sent", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const [host, notice, c1, c2, complete] = readStreamLines("sync-bridge") as [string, string, string, string, string];
  await sink.write([c1]);
  sink.write([host, notice]);
  await sink.write([c2, complete]);
  const before = spanOf(f.calls[0]?.body as ExportTraceServiceRequest);
  assert.equal(attrs(before)["mocon.provenance.crossing.target"], "P", "attested read as [] before the declaration");
  const after = f.calls[1]?.body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  assert.equal(after.length, 2);
  assert.ok(!("mocon.provenance.crossing.target" in attrs(after[0]!)));
  assert.equal(attrs(after[1]!)["mocon.host.observes_crossings"], "all");
});

test("a differing re-declaration counts as a conflict and the one that sorts first by canonical JSON is kept; identical re-sends are no-ops", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const [host, , , , complete] = readStreamLines("sync-bridge") as [string, string, string, string, string];
  const some = JSON.stringify({ ...(JSON.parse(host) as Rec), observes_crossings: "some" });
  sink.write([some]);
  sink.write([host]);
  sink.write([some]);
  sink.write([host]);
  assert.equal(sink.conflicts, 2, "the two differing arrivals after the first, not the identical re-send");
  await sink.write([complete]);
  assert.equal(attrs(spanOf(f.calls[0]?.body as ExportTraceServiceRequest))["mocon.host.observes_crossings"], "all", '"all" sorts before "some"');
});

test("a declaration of another major version is counted, not held, and does not block a later one of this major", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const line = JSON.stringify(execution({ host: "h" }));
  sink.write(text([hostLine("h", { spec_version: "2.0", attested: ["crossing.target"] })]));
  assert.equal(sink.versionMismatches, 1);
  await sink.write([line]);
  assert.ok(!Object.keys(attrs(spanOf(f.calls[0]?.body as ExportTraceServiceRequest))).some((k) => k.startsWith("mocon.host.")));
  sink.write(text([hostLine("h")]));
  await sink.write([line]);
  assert.equal(attrs(spanOf(f.calls[1]?.body as ExportTraceServiceRequest))["mocon.host.spec_version"], "1.0");
  assert.equal(sink.conflicts, 0, "the refused declaration is not a conflict");
  sink.write(text([hostLine("h", { spec_version: 2 })]));
  assert.equal(sink.versionMismatches, 2, "a version that is not a string is not this major");
});

test("the declaration map holds at most 256 host strings", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  for (let i = 0; i <= 256; i++) sink.write(text([hostLine("h" + i)]));
  await sink.write(text([execution({ host: "h0" }), execution({ host: "h256" })]));
  const spans = f.calls[0]?.body.resourceSpans.map((rs) => rs.scopeSpans[0]?.spans[0]) ?? [];
  assert.equal(attrs(spans[0]!)["mocon.host.spec_version"], "1.0");
  assert.ok(!("mocon.host.spec_version" in attrs(spans[1]!)), "a host string past the bound is mapped without its declaration");
  // A span that reads as attesting nothing because its declaration was dropped is counted, like a conflict or a version mismatch.
  assert.equal(sink.declarationsDropped, 1, "the declaration past the bound vanished without a count");
  assert.equal(sink.conflicts, 0);
  assert.equal(sink.versionMismatches, 0);
});

test("a collector that accepts the request and never answers costs one request, not a flush that never resolves", async () => {
  const never: typeof globalThis.fetch = (() => new Promise(() => {})) as never;
  const sink = otlpSink({ url: URL_, fetch: never as never, timeoutMs: 50 });
  const write = sink.write(text([execution()])) as Promise<void>;
  const failed = await write.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  assert.ok(failed !== undefined, "the write resolved although the collector never answered");
  assert.match(failed.message, /POST .* failed/);
  assert.ok(!failed.message.includes("undefined"), failed.message);
  await sink.flush();
  // The default applies when none is given, so a sink built the usual way cannot hang either.
  assert.doesNotThrow(() => otlpSink({ url: URL_, fetch: never as never }));
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => otlpSink({ url: URL_, fetch: never as never, timeoutMs: bad }), RangeError, `timeoutMs ${bad}`);
});

test("64 POSTs in flight: a write past the bound is dropped, its promise rejects saying so, and capacity returns as requests settle", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = fakeFetch(async () => {
    await gate;
    return ok();
  });
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const line = JSON.stringify(execution());
  const held = Array.from({ length: 64 }, () => sink.write([line]));
  const dropped = sink.write([line, line]);
  await assert.rejects(dropped as Promise<void>, /64 POSTs in flight to https:\/\/collector\.example\/v1\/traces; a write of 2 spans was dropped/);
  assert.equal(f.calls.length, 64);
  release();
  await Promise.all(held);
  await sink.flush();
  await sink.write([line]);
  assert.equal(f.calls.length, 65);
});

test("a failed POST rejects the write promise with the status and the start of the body; flush resolves either way", async () => {
  const [, , c1] = readStreamLines("sync-bridge") as [string, string, string];
  const failing = otlpSink({ url: URL_, fetch: fakeFetch(async () => ({ ok: false, status: 503, body: bodyOf("try later" + "x".repeat(500)) })).fetch });
  await assert.rejects(failing.write([c1]) as Promise<void>, (e: Error) => /^mocon otel: POST https:\/\/collector\.example\/v1\/traces failed with 503: try laterx+$/.test(e.message) && e.message.length < 300);
  await failing.flush();

  const redirected = otlpSink({ url: URL_, fetch: fakeFetch(async () => ({ ok: false, status: 307, body: null })).fetch });
  await assert.rejects(redirected.write([c1]) as Promise<void>, /failed with 307$/);

  const cause = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:4318") });
  const thrown = otlpSink({
    url: URL_,
    fetch: async () => {
      throw cause;
    },
  });
  await assert.rejects(thrown.write([c1]) as Promise<void>, (e: Error) => e.message === "mocon otel: POST https://collector.example/v1/traces failed: fetch failed: connect ECONNREFUSED 127.0.0.1:4318" && e.cause === cause);
  const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("reset")) });
  const bodyless = otlpSink({ url: URL_, fetch: async () => ({ ok: false, status: 500, body: broken }) as Response });
  await assert.rejects(bodyless.write([c1]) as Promise<void>, /failed with 500$/);
  await thrown.flush();
});

test("the url is checked up front, and a message about it never repeats it", () => {
  assert.throws(() => otlpSink({ url: "" }), TypeError);
  assert.throws(() => otlpSink({ url: 7 as unknown as string }), TypeError);
  assert.throws(() => otlpSink({ url: "/v1/traces?key=SECRET" }), (e: Error) => e instanceof TypeError && /absolute URL/.test(e.message) && !e.message.includes("SECRET"));
  assert.throws(() => otlpSink({ url: "https://user:SECRET@collector.example/v1/traces" }), (e: Error) => e instanceof TypeError && /credentials/.test(e.message) && !e.message.includes("SECRET"));
  assert.throws(() => otlpSink({ url: "https://SECRET@collector.example/v1/traces" }), (e: Error) => /credentials/.test(e.message) && !e.message.includes("SECRET"));
  assert.throws(() => otlpSink({ url: URL_, cap: -1 }), RangeError);
  assert.doesNotThrow(() => otlpSink({ url: "memory:", fetch: fakeFetch().fetch }), "any absolute URL a stand-in fetch accepts");
});

test("through a core instance: lines arrive as text, the sink maps them, and a failure reaches onError without touching the host", async () => {
  const f = fakeFetch();
  const errors: unknown[] = [];
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const m = mocon({
    host: HOST,
    capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] },
    sinks: [sink],
    onError: (e) => errors.push(e),
  });
  const result = await m.execution.run({ program: "return 1", language: "javascript", context: { session: "s" } }, async (ex) => {
    const callTool = ex.instrument(async (_name: string, args: { q: string }) => ({ echo: args.q }));
    return callTool("echo", { q: "hi" });
  });
  assert.deepEqual(result, { echo: "hi" });
  await m.flush();
  assert.equal(f.calls.length, 2, "the crossing, then the end batch");
  const [crossing, execution] = spansOf(mergeRequests(f.calls.map((c) => c.body)));
  assert.ok(crossing !== undefined && execution !== undefined);
  assert.equal(crossing.kind, 3);
  assert.equal(crossing.parentSpanId, execution.spanId);
  assert.equal(crossing.traceId, execution.traceId);
  assert.equal(attrs(crossing)["mocon.crossing.output.value"], '{"echo":"hi"}');
  assert.equal(attrs(crossing)["mocon.provenance.crossing.output.value"], "P");
  assert.ok(!("mocon.provenance.crossing.target" in attrs(crossing)));
  assert.equal(attrs(execution)["mocon.host.crossing_edge"], "invocation");
  assert.equal(attrs(execution)["mocon.execution.result.value"], '{"echo":"hi"}');
  assert.equal(errors.length, 0);

  const failing = otlpSink({ url: URL_, fetch: async () => ({ ok: false, status: 500, body: bodyOf("") }) });
  const m2 = mocon({ host: HOST, capabilities: { observes_crossings: "all" }, sinks: [failing], onError: (e) => errors.push(e) });
  m2.execution.start({ program: "p", notice: false }).complete({ result: 1 });
  await m2.flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /500/);
});

test("what the sink posts for a stream equals what the mapping gives line by line", async () => {
  for (const name of ["sync-bridge", "crossing-error", "anthropic-ptc", "multi-block-error-value"]) {
    const lines = readStreamLines(name);
    const f = fakeFetch();
    const sink = otlpSink({ url: URL_, fetch: f.fetch });
    await sink.write(lines);
    assert.deepEqual(canonicalize(mergeRequests(f.calls.map((c) => c.body))), canonicalize(convertStream(lines).request), name);
  }
});

test("through a core instance, undefined, NaN, Infinity, a Date and a boxed string map to what their lines say, never a double of null", async () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const memory: { lines: string[]; write(l: readonly string[]): void } = { lines: [], write: (l) => void memory.lines.push(...l) };
  const m = mocon({ host: HOST, capabilities: { observes_crossings: "all" }, sinks: [memory, sink] });
  const ex = m.execution.start({ program: "p", notice: false });
  ex.crossing.start({ target: "u", input: undefined }).output(NaN);
  ex.crossing.start({ target: "d", input: new Date(0) }).output(new String("boxed"));
  ex.complete({ result: Infinity, ext: { "v.when": new Date(0) as never } });
  await m.flush();

  assert.deepEqual(canonicalize(mergeRequests(f.calls.map((c) => c.body))), canonicalize(convertStream(memory.lines).request));
  assert.ok(!f.calls.some((c) => JSON.stringify(c.body).includes('"doubleValue":null')));
  const spans = spansOf(mergeRequests(f.calls.map((c) => c.body)));
  const byTarget = (target: string): Rec => attrs(spans.find((s) => attrs(s)["mocon.crossing.target"] === target)!);
  assert.equal(byTarget("u")["mocon.crossing.input.value"], "null", "an undefined input is written as null, and null is a value");
  assert.equal(byTarget("u")["mocon.provenance.crossing.input.value"], "P");
  assert.equal(byTarget("u")["mocon.crossing.output.value"], "null");
  assert.equal(byTarget("d")["mocon.crossing.input.value"], "1970-01-01T00:00:00.000Z");
  assert.equal(byTarget("d")["mocon.crossing.output.value"], "boxed");
  const execution = attrs(spans.find((s) => s.kind === 1)!);
  assert.equal(execution["mocon.execution.result.value"], "null");
  assert.equal(execution["mocon.ext.v.when"], "1970-01-01T00:00:00.000Z");
});

test("a declaration larger than the sink will hold is not held and is counted, so one host string cannot make the sink hold a stream's ext for the process's life", async () => {
  // The count of host strings bounds the entries and not the bytes: nothing bounds a declaration's `ext`,
  // so 256 slots can hold gigabytes. This is the other half of the bound, and its outcome is the same as a
  // host string past the count: no `mocon.host.*`, baseline labels, and a number a reader can see.
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const huge = hostLine("huge/host", { attested: ["crossing.target"], ext: { "example.blob": "x".repeat(200_000) } });
  const line = JSON.stringify(huge);
  assert.ok(line.length > 64 * 1024, "the fixture must be past the bound to test it");
  await sink.write([line, JSON.stringify(execution({ host: "huge/host" }))]);
  assert.equal(sink.declarationsDropped, 1);
  assert.equal(sink.conflicts, 0);
  const span = attrs(spanOf(f.calls[0]?.body as ExportTraceServiceRequest));
  assert.equal(span["mocon.host"], "huge/host");
  assert.ok(
    !Object.keys(span).some((k) => k.startsWith("mocon.host.")),
    "a declaration the sink did not hold must not reach the span",
  );

  // The same host string declaring again within the bound is held as usual: the bound is on the line, not the host.
  const small = hostLine("huge/host", { attested: ["crossing.target"] });
  await sink.write([JSON.stringify(small), JSON.stringify(execution({ host: "huge/host" }))]);
  assert.equal(sink.declarationsDropped, 1, "a declaration inside the bound is held, not counted");
  assert.equal(attrs(spanOf(f.calls[1]?.body as ExportTraceServiceRequest))["mocon.host.observes_crossings"], "all");
});

test("close() waits for the POSTs in flight, so Mocon.close does not return while a request is open", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const sink = otlpSink({
    url: URL_,
    fetch: async () => {
      await gate;
      return ok();
    },
  });
  const write = sink.write(text([execution()]));
  assert.ok(write instanceof Promise);
  void write.then(() => {
    settled = true;
  });
  const closing = sink.close().then(() => {
    assert.equal(settled, true, "close resolved while a POST was still open");
  });
  assert.equal(settled, false);
  release();
  await closing;
});

test("kind:'event', which @mocon/core writes for a late settlement, is counted as unknown_kind and produces no span", async () => {
  // core.md 4 rule 7 reads as one span per complete line, but an extension kind is a kind this sink does
  // not know, so core.md 3 has it skipped and counted. A recorded late settlement therefore reaches no
  // trace backend, and the counter is the only place it shows.
  const f = fakeFetch();
  const sink = otlpSink({ url: URL_, fetch: f.fetch });
  const event = { kind: "event", host: HOST, event: "late_settlement", time: "2026-09-16T10:00:03Z", crossing_id: "c1" };
  await sink.write([JSON.stringify(hostLine(HOST)), JSON.stringify(execution()), JSON.stringify(event)]);
  assert.equal(sink.skipped.unknown_kind, 1);
  assert.equal(spansOf(f.calls[0]?.body as ExportTraceServiceRequest).length, 1, "the event line adds no span to the batch that carried it");
});
