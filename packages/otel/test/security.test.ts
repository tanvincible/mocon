/**
 * Security regressions for the sink and the mapping.
 *
 * - A collector credential placed in the URL or a header never reaches an
 *   error message, whatever fails: construction, a status, a refused
 *   connection, a redirect.
 * - A redirect is never followed, so a vendor key header is never re-sent
 *   to another host.
 * - A record value cannot run program code inside the sink, and what the
 *   collector receives is what the line says, not what the program's object
 *   said later.
 * - A line nested past the native stack, or holding `__proto__`, maps like
 *   any other line.
 * - A collector's answer costs the host what the sink chose to read: the
 *   excerpt, a bounded number of reads, and the request's own deadline,
 *   whatever the size, the shape or the pace of the body it sends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { mocon, type Sink } from "@mocon/core";
import { otlpSink, type ExportTraceServiceRequest } from "../src/index.js";
import { attrs, bodyOf, collector, crossing, fakeFetch, mapped, readStreamLines, spanOf, spansOf, type Rec } from "./helpers.js";

const SECRET = "S3CRET-7f1c";
const line = readStreamLines("sync-bridge")[2] as string;

/** Everything an error can carry into a log: its message, its stack, its cause chain, and its own properties. */
const printed = (e: unknown): string => inspect(e, { depth: 8, showHidden: true });

test("a credential in the URL's query string, fragment or both never reaches the error of a failed POST", async () => {
  const placements = [
    `https://collector.example/v1/traces?api-key=${SECRET}`,
    `https://collector.example/v1/traces?a=1&token=${SECRET}&b=2`,
    `https://collector.example/v1/traces#${SECRET}`,
    `https://collector.example/v1/traces?k=${encodeURIComponent(SECRET + "/+=")}#${SECRET}`,
    `https://collector.example:4318/v1/traces/?dd-api-key=${SECRET}`,
  ];
  for (const url of placements) {
    const status = otlpSink({ url, fetch: fakeFetch(async () => ({ ok: false, status: 403, body: bodyOf("forbidden") })).fetch });
    await assert.rejects(status.write([line]) as Promise<void>, (e: unknown) => !printed(e).includes(SECRET) && /collector\.example(:4318)?\/v1\/traces\/? failed with 403/.test((e as Error).message), url);
    const thrown = otlpSink({
      url,
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND collector.example") });
      },
    });
    await assert.rejects(thrown.write([line]) as Promise<void>, (e: unknown) => !(e as Error).message.includes(SECRET), url);
  }
});

test("a URL carrying userinfo is refused at construction, and the refusal does not repeat it", () => {
  for (const url of [`https://user:${SECRET}@collector.example/v1/traces`, `https://${SECRET}@collector.example/v1/traces`, `https://${SECRET}:@collector.example/v1/traces`]) {
    assert.throws(() => otlpSink({ url }), (e: unknown) => e instanceof TypeError && !printed(e).includes(SECRET), url);
  }
  assert.throws(() => otlpSink({ url: `collector.example/v1/traces?key=${SECRET}` }), (e: unknown) => e instanceof TypeError && !printed(e).includes(SECRET));
});

test("a header value fetch would refuse is refused at construction, without repeating the value", () => {
  const refused: Array<Record<string, string>> = [{ authorization: `Bearer ${SECRET}\nX-Injected: 1` }, { "x-api-key": `${SECRET}\u0000` }, { [`bad ${SECRET}`]: "v" }, { "x-api-key": `${SECRET}\u0100` }];
  for (const headers of refused) {
    assert.throws(() => otlpSink({ url: "https://collector.example/v1/traces", headers }), (e: unknown) => e instanceof TypeError && !printed(e).includes(SECRET));
  }
});

test("with the real fetch, a refused connection and a redirect reject without the URL's secret anywhere in the error or its causes", async () => {
  const c = await collector((_req, res) => void res.writeHead(302, { location: `http://127.0.0.1:1/v1/traces?api-key=${SECRET}` }).end());
  try {
    const redirected = otlpSink({ url: `${c.url}/v1/traces?api-key=${SECRET}` });
    await assert.rejects(redirected.write([line]) as Promise<void>, (e: unknown) => !printed(e).includes(SECRET) && /failed with 302$/.test((e as Error).message));
  } finally {
    await c.close();
  }
  const refused = otlpSink({ url: `${c.url}/v1/traces?api-key=${SECRET}#${SECRET}`, headers: { "x-api-key": SECRET } });
  await assert.rejects(refused.write([line]) as Promise<void>, (e: unknown) => !printed(e).includes(SECRET) && /failed: fetch failed/.test((e as Error).message));
});

test("vendor credential headers are not re-sent to a host the collector redirects to, for any redirect status", async () => {
  const headers = { authorization: "Bearer T", "x-api-key": SECRET, "x-honeycomb-team": SECRET, "api-key": SECRET, "dd-api-key": SECRET };
  for (const status of [301, 302, 303, 307, 308]) {
    const elsewhere = await collector();
    const c = await collector((_req, res) => void res.writeHead(status, { location: `${elsewhere.url}/v1/traces` }).end());
    try {
      const sink = otlpSink({ url: `${c.url}/v1/traces`, headers });
      await assert.rejects(sink.write([line]) as Promise<void>, new RegExp(`failed with ${status}$`));
      assert.equal(c.received.length, 1);
      assert.deepEqual(elsewhere.received, [], `the other host received a request after a ${status}`);
    } finally {
      await c.close();
      await elsewhere.close();
    }
  }
});

/* ------------------------------------------------------------------ */
/* Program code and the sink                                           */
/* ------------------------------------------------------------------ */

function withCore(): { posts: ExportTraceServiceRequest[]; errors: unknown[]; lines: string[]; sink: ReturnType<typeof otlpSink>; m: ReturnType<typeof mocon> } {
  const posts: ExportTraceServiceRequest[] = [];
  const errors: unknown[] = [];
  const lines: string[] = [];
  const sink = otlpSink({ url: "http://collector/v1/traces", fetch: fakeFetch(async (call) => (posts.push(call.body), { ok: true, status: 200, body: null })).fetch });
  const memory: Sink = { write: (l) => void lines.push(...l) };
  const m = mocon({
    host: "example/mcp",
    capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] },
    sinks: [sink, memory],
    onError: (e) => void errors.push(e),
  });
  return { posts, errors, lines, sink, m };
}

test("the attested crossing.input a span carries is what the line and its hash describe, not what the program wrote into the object afterwards", async () => {
  const { posts, lines, sink, m } = withCore();
  const ex = m.execution.start({ program: "p", notice: false });
  const bridge = ex.instrument(async (_name: string, v: unknown) => {
    await new Promise((r) => setTimeout(r, 1));
    return v;
  });
  const args: Rec = { q: 1 };
  const pending = bridge("lookup", args);
  args["q"] = "forged";
  await pending;
  await sink.flush();
  const recorded = JSON.parse(lines.find((l) => l.includes('"kind":"crossing"')) as string) as Rec;
  assert.equal(attrs(spanOf(posts[0] as ExportTraceServiceRequest))["mocon.crossing.input.value"], JSON.stringify((recorded["input"] as Rec)["value"]));
  assert.equal(attrs(spanOf(posts[0] as ExportTraceServiceRequest))["mocon.crossing.input.value"], '{"q":1}');
});

test("a program's toJSON and getters run during capture only, never inside the sink, and cannot cost the batch", async () => {
  const { posts, errors, sink, m } = withCore();
  const ex = m.execution.start({ program: "p", notice: false });
  let calls = 0;
  const input = {
    toJSON() {
      if (++calls >= 2) throw new Error("second call");
      return { n: calls };
    },
    get trap() {
      throw new Error("getter ran");
    },
  };
  ex.crossing.start({ target: "t", input }).output(1);
  ex.complete();
  await sink.flush();
  assert.equal(calls, 1, "one call, in core's capture");
  assert.deepEqual(errors, []);
  assert.equal(spansOf({ resourceSpans: posts.flatMap((p) => p.resourceSpans) }).length, 2, "the crossing span and the execution span both reach the collector");
});

test("an object handed to write in place of a line is counted malformed, and none of its code runs", () => {
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch });
  let ran = false;
  const hostile = {
    toJSON() {
      ran = true;
      return JSON.parse(line) as unknown;
    },
    toString() {
      ran = true;
      return line;
    },
  };
  assert.equal(sink.write([hostile as unknown as string]), undefined);
  assert.equal(ran, false);
  assert.equal(sink.skipped.malformed, 1);
  assert.equal(f.calls.length, 0);
});

test("a line holding __proto__, constructor or toJSON keys is data: no prototype changes, and the keys are exported as written", () => {
  const raw = JSON.stringify(crossing({ ext: { "v.x": 1 } })).replace('"v.x":1', '"v.x":{"1":0,"__proto__":{"polluted":true},"toJSON":"x","constructor":{"prototype":{"polluted":true}}}');
  const a = attrs(spanOf(mapped(raw).request));
  assert.equal(a["mocon.ext.v.x"], '{"1":0,"__proto__":{"polluted":true},"toJSON":"x","constructor":{"prototype":{"polluted":true}}}');
  assert.equal(({} as Rec)["polluted"], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
});

/* ------------------------------------------------------------------ */
/* Nesting                                                             */
/* ------------------------------------------------------------------ */

test("a line nested 200,000 levels deep maps in full, through the mapping and through the sink, without a throw", async () => {
  const depth = 200_000;
  const nested = "[".repeat(depth) + "]".repeat(depth);
  const deep = JSON.stringify(crossing({}, { output: { value: 0 } })).replace('"output":{"value":0}', `"output":{"value":${nested}}`);
  assert.equal(attrs(spanOf(mapped(deep).request))["mocon.crossing.output.value"], nested);
  const f = fakeFetch();
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: f.fetch, cap: 64 });
  await sink.write([deep, line]);
  const [span] = spansOf(f.calls[0]?.body as ExportTraceServiceRequest);
  assert.equal(attrs(span!)["mocon.crossing.output.value"], "[".repeat(64));
  assert.equal(attrs(span!)["mocon.crossing.output.truncated"], true);
  assert.equal(spansOf(f.calls[0]?.body as ExportTraceServiceRequest).length, 2, "the other line in the batch is unaffected");
});

for (const status of [200, 500]) {
  test(`a ${status} answer with an endless body settles the write promptly: an accepted answer's body is not read, and a failed one's only as far as the excerpt`, { timeout: 10_000 }, async () => {
    let sent = 0;
    const endless = await collector((_req, res) => {
      res.writeHead(status, { "content-type": "text/plain" });
      const chunk = Buffer.alloc(1 << 16, 0x61);
      const pump = (): void => {
        for (let more = true; more && !res.destroyed; ) {
          more = res.write(chunk);
          sent += chunk.length;
        }
        if (!res.destroyed) res.once("drain", pump);
      };
      pump();
    });
    try {
      const sink = otlpSink({ url: endless.url + "/v1/traces" });
      const settled = Promise.resolve(sink.write([readStreamLines("sync-bridge")[2] as string])).then(
        () => "settled",
        (e: Error) => e.message,
      );
      // A write that never settles is the failure this guards against, and the test's own timeout is what reports it; the assertions are on the outcome, never on how long it took to get here.
      const outcome = await settled;
      if (status === 200) assert.equal(outcome, "settled", `${Math.round(sent / (1 << 20))} MiB of response body reached the host`);
      else assert.match(outcome, /failed with 500: a{200}$/);
    } finally {
      await endless.close();
    }
  });
}

/** A response body of the chunks `chunk` returns, one per read, counting the reads. A round that returns `undefined` never answers. */
function countedBody(chunk: (read: number) => Uint8Array | undefined): { body: ReadableStream<Uint8Array>; reads: () => number } {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunk(reads++);
      if (next === undefined) return new Promise<void>(() => {});
      controller.enqueue(next);
      return undefined;
    },
  });
  return { body, reads: () => reads };
}

/** Reads the sink makes for one excerpt, and the chunk a `ReadableStream` pulls ahead of them. */
const READS = 32 + 1;

/** A sink whose collector answers 500 with `body`. */
const failing = (body: ReadableStream<Uint8Array>, timeoutMs?: number): ReturnType<typeof otlpSink> =>
  otlpSink({ url: "https://collector.example/v1/traces", fetch: fakeFetch(async () => ({ ok: false, status: 500, body })).fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

test("a failed answer whose body arrives in one enormous chunk costs the excerpt, not the chunk", async () => {
  const huge = new Uint8Array(8 << 20).fill(0x62);
  const { body, reads } = countedBody((read) => (read === 0 ? huge : new Uint8Array(1)));
  await assert.rejects(failing(body).write([line]) as Promise<void>, /failed with 500: b{200}$/);
  assert.ok(reads() <= 2, `the excerpt was full after one read and the sink read ${reads()} times`);
});

for (const [name, size] of [
  ["one byte at a time", 1],
  ["in empty chunks", 0],
] as const) {
  test(`a failed answer that dribbles out an endless body ${name} costs a bounded number of reads`, async () => {
    const { body, reads } = countedBody(() => new Uint8Array(size).fill(0x63));
    await assert.rejects(failing(body).write([line]) as Promise<void>, new RegExp(`failed with 500${size === 0 ? "" : ": c{32}"}$`));
    assert.ok(reads() <= READS, `an endless body cost ${reads()} reads`);
  });
}

test("a failed answer whose body never arrives costs the request's deadline, not the write", async () => {
  const { body, reads } = countedBody(() => undefined);
  await assert.rejects(failing(body, 50).write([line]) as Promise<void>, /failed with 500$/);
  assert.equal(reads(), 1, "the sink waited on one read and gave up with the request's deadline");
});

test("a 400 with a short body is quoted whole, so the bounds cost a reader nothing a collector meant to say", async () => {
  const sink = otlpSink({ url: "https://collector.example/v1/traces", fetch: fakeFetch(async () => ({ ok: false, status: 400, body: bodyOf('{"code":3,"message":"invalid span id"}') })).fetch });
  await assert.rejects(sink.write([line]) as Promise<void>, /failed with 400: \{"code":3,"message":"invalid span id"\}$/);
});
