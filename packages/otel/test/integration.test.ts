/**
 * The sink over real HTTP: the global `fetch` posting to a node:http
 * collector on 127.0.0.1 that records method, path, headers and body. One
 * POST per write, the headers as configured, the fixture document on the
 * wire, a failing status, a redirect that is not followed, and `flush`
 * waiting for a collector that answers late.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mocon } from "@mocon/core";
import { otlpSink, type ExportTraceServiceRequest } from "../src/index.js";
import { attrs, canonicalize, collector, mergeRequests, readOtlpFixture, readStreamLines, spansOf } from "./helpers.js";

const parse = (body: string): ExportTraceServiceRequest => JSON.parse(body) as ExportTraceServiceRequest;

test("one POST of application/json per write that produced spans, with the configured headers, and the fixture document on the wire", async () => {
  const c = await collector();
  try {
    const sink = otlpSink({ url: `${c.url}/v1/traces?tenant=a`, headers: { authorization: "Bearer T", "x-api-key": "K" } });
    const lines = readStreamLines("sync-bridge");
    for (const line of lines) await sink.write([line]);
    await sink.flush();
    assert.equal(c.received.length, 3, "none for the host line or the notice");
    for (const r of c.received) {
      assert.equal(r.method, "POST");
      assert.equal(r.path, "/v1/traces?tenant=a");
      assert.equal(r.headers["content-type"], "application/json");
      assert.equal(r.headers["authorization"], "Bearer T");
      assert.equal(r.headers["x-api-key"], "K");
      assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.body));
    }
    const document = mergeRequests(c.received.map((r) => parse(r.body)));
    assert.deepEqual(canonicalize(document), canonicalize(readOtlpFixture("sync-bridge")));
  } finally {
    await c.close();
  }
});

test("a batch is one request: the whole stream in one write is one POST", async () => {
  const c = await collector();
  try {
    const sink = otlpSink({ url: `${c.url}/v1/traces` });
    await sink.write(readStreamLines("anthropic-ptc"));
    assert.equal(c.received.length, 1);
    assert.equal(spansOf(parse(c.received[0]?.body as string)).length, 3);
    assert.equal(sink.write(readStreamLines("unresolved")), undefined, "a batch with no span posts nothing");
    assert.equal(c.received.length, 1);
  } finally {
    await c.close();
  }
});

test("a failing status rejects with the status and the start of the body, and the URL's query string stays out of it", async () => {
  const c = await collector((_req, res) => void res.writeHead(401, { "content-type": "text/plain" }).end("bad key"));
  try {
    const sink = otlpSink({ url: `${c.url}/v1/traces?api-key=SECRET` });
    const line = readStreamLines("sync-bridge")[2] as string;
    await assert.rejects(sink.write([line]) as Promise<void>, (e: Error) => e.message === `mocon otel: POST ${c.url}/v1/traces failed with 401: bad key`);
    assert.equal(c.received.length, 1);
  } finally {
    await c.close();
  }
});

test("a redirect is not followed: the write rejects with the 3xx and the other host receives nothing", async () => {
  const elsewhere = await collector();
  const c = await collector((_req, res) => void res.writeHead(308, { location: `${elsewhere.url}/v1/traces` }).end());
  try {
    const sink = otlpSink({ url: `${c.url}/v1/traces`, headers: { "x-api-key": "K", authorization: "Bearer T" } });
    await assert.rejects(sink.write([readStreamLines("sync-bridge")[2] as string]) as Promise<void>, /failed with 308$/);
    assert.equal(c.received.length, 1);
    assert.equal(elsewhere.received.length, 0);
  } finally {
    await c.close();
    await elsewhere.close();
  }
});

test("flush waits for a collector that answers late, and a refused connection is a rejection, never a throw", async () => {
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const c = await collector(async (_req, res) => {
    await answered;
    res.writeHead(200).end("{}");
  });
  try {
    const sink = otlpSink({ url: `${c.url}/v1/traces` });
    let settled = false;
    const pending = sink.write([readStreamLines("sync-bridge")[2] as string]) as Promise<void>;
    void pending.then(() => (settled = true));
    const flushed = sink.flush().then(() => settled);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settled, false);
    answer();
    assert.equal(await flushed, true, "flush resolved only after the POST settled");
  } finally {
    await c.close();
  }
  const closed = otlpSink({ url: c.url + "/v1/traces" });
  await assert.rejects(closed.write([readStreamLines("sync-bridge")[2] as string]) as Promise<void>, /^Error: mocon otel: POST http:\/\/127\.0\.0\.1:\d+\/v1\/traces failed: fetch failed/);
});

test("a core instance posting through the sink: the collector receives the crossing and the execution, tied together", async () => {
  const c = await collector();
  const errors: unknown[] = [];
  try {
    const m = mocon({
      host: "example/mcp",
      capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] },
      sinks: [otlpSink({ url: `${c.url}/v1/traces` })],
      onError: (e) => errors.push(e),
    });
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await m.execution.run({ program: "return await lookup({ q: 1 })", language: "javascript", context: { traceparent } }, async (ex) => {
      const lookup = ex.instrument(async (_target: string, args: unknown) => ({ found: args }));
      return lookup("lookup", { "10": "ten", q: 1 });
    });
    await m.flush();
    assert.deepEqual(errors, []);
    assert.equal(c.received.length, 2);
    const [crossing, execution] = spansOf(mergeRequests(c.received.map((r) => parse(r.body))));
    assert.ok(crossing !== undefined && execution !== undefined);
    assert.equal(crossing.traceId, "0af7651916cd43dd8448eb211c80319c");
    assert.equal(execution.traceId, "0af7651916cd43dd8448eb211c80319c");
    assert.equal(execution.parentSpanId, "b7ad6b7169203331");
    assert.equal(crossing.parentSpanId, execution.spanId);
    assert.equal(attrs(crossing)["mocon.crossing.input.value"], '{"10":"ten","q":1}');
    assert.equal(attrs(execution)["mocon.host.observes_crossings"], "all");
  } finally {
    await c.close();
  }
});
