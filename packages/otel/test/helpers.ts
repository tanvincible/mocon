/**
 * Test support: line builders, fixture loading, the canonical form
 * spec/conformance/otlp/README.md section 3 compares in, a merge of
 * per-line requests into the one document a fixture holds, and a local
 * collector that records what it receives.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { HostLine } from "@mocon/core";
import { sameMajor } from "@mocon/core/fold";
import fc from "fast-check";
import type { ExportTraceServiceRequest, FetchLike } from "../src/index.js";
import { buildRequest, mapLine, type SkipReason, type Span } from "../src/map.js";

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

export const specDir = fileURLToPath(new URL("../../../spec/", import.meta.url));

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

export const HOST = "example/mcp";
export const EXECUTION_ID = "a3f1c2d4e5b6978081726354a1b2c3d4";
export const EMPTY: ExportTraceServiceRequest = { resourceSpans: [] };

export const declared = (attested: string[], extra: Rec = {}): HostLine =>
  ({ kind: "host", host: HOST, spec_version: "1.0", observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested, ...extra }) as HostLine;

/** A complete execution line; `overrides` replace top-level fields and `end` fields, `undefined` removing one once serialized. */
export function execution(overrides: Rec = {}, end: Rec = {}): Rec {
  return {
    kind: "execution",
    host: HOST,
    id: EXECUTION_ID,
    program: { value: "return 1", bytes: 8, hash: "sha256:" + "0".repeat(64) },
    start: "2026-09-16T10:00:00.000Z",
    end: { time: "2026-09-16T10:00:01.000Z", disposition: "completed", ...end },
    ...overrides,
  };
}

/** A complete crossing line with host-clock times and an output. */
export function crossing(overrides: Rec = {}, end: Rec = {}): Rec {
  return {
    kind: "crossing",
    host: HOST,
    id: "1a2b3c4d5e6f7081",
    execution_id: EXECUTION_ID,
    target: "company_identify",
    input: { value: { query: "acme.example" }, bytes: 24, hash: "sha256:" + "1".repeat(64) },
    start: "2026-09-16T10:00:00.118Z",
    end: { time: "2026-09-16T10:00:00.402Z", outcome: "output", output: { value: { id: 8842 }, bytes: 9, hash: "sha256:" + "2".repeat(64) }, ...end },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Generated JSON text                                                 */
/* ------------------------------------------------------------------ */

/** A JSON value whose objects are entry lists and whose numbers are source tokens, so the text it renders is exactly what a line carries. */
export type Tree = null | boolean | string | { number: string } | Tree[] | { entries: Array<[string, Tree]> };

const numberToken = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => JSON.stringify(n)),
  fc.integer().map(String),
  fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n }).map(String),
  fc.constantFrom("-0", "1E2", "1.50", "0.0000001", "1e21", "1e400", "-1e400", "1e-400", "9007199254740993", "9223372036854775807", "-9223372036854775808", "9223372036854775808"),
);
const key = fc.oneof(
  fc.string({ maxLength: 4 }),
  fc.string({ unit: "binary", maxLength: 3 }),
  fc.nat({ max: 20 }).map(String),
  fc.constantFrom("__proto__", "toJSON", "constructor", "", "4294967294", "4294967295", "01", "-1", "1.5"),
);

export const tree: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    numberToken.map((number) => ({ number })),
    fc.string({ unit: "binary" }),
    fc.array(tie("tree"), { maxLength: 5 }),
    fc.uniqueArray(fc.tuple(key, tie("tree")), { maxLength: 5, selector: (e) => e[0] }).map((entries) => ({ entries })),
  ),
})).tree;

/** A tree whose root is an object with at least one key. */
export const objectTree = fc.uniqueArray(fc.tuple(key, tree), { minLength: 1, maxLength: 8, selector: (e) => e[0] }).map((entries) => ({ entries }));

const INT64 = 2n ** 63n;

/** The integer a number token names, when it is written without a fraction or an exponent and lies within int64; `undefined` otherwise. */
export function int64Of(token: string): bigint | undefined {
  if (!/^-?[0-9]+$/.test(token)) return undefined;
  const n = BigInt(token);
  return n >= -INT64 && n < INT64 ? n : undefined;
}

/**
 * `JSON.parse` as the sink reads a line: an integer token past 2^53 but
 * within int64 comes back as a bigint with the token's digits.
 */
export function parseExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number" || Number.isSafeInteger(value) || context?.source === undefined) return value;
    return int64Of(context.source) ?? value;
  });
}

/**
 * The compact text a tree denotes, keys in entry order. `normalized`
 * writes each number the way otel-mapping.md 8.2 asks a sink to: an
 * integer within int64 with its own digits, any other number as
 * `JSON.stringify` writes the double it parses to.
 */
export function render(t: Tree, normalized = false): string {
  if (Array.isArray(t)) return "[" + t.map((v) => render(v, normalized)).join(",") + "]";
  if (t !== null && typeof t === "object") {
    if ("number" in t) return normalized ? (int64Of(t.number)?.toString() ?? JSON.stringify(Number(t.number))) : t.number;
    return "{" + t.entries.map(([k, v]) => JSON.stringify(k) + ":" + render(v, normalized)).join(",") + "}";
  }
  return JSON.stringify(t);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export function streamNames(): string[] {
  return readdirSync(`${specDir}conformance/streams`)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

export function readStreamLines(name: string): string[] {
  return readFileSync(`${specDir}conformance/streams/${name}.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

export function readOtlpFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${specDir}conformance/otlp/${name}.json`, "utf8"));
}

/** Every line under conformance/invalid, by file name without extension. */
export function invalidLines(): Array<[string, string]> {
  const dir = `${specDir}conformance/invalid/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => [f.slice(0, -".jsonl".length), readFileSync(dir + f, "utf8").trim()]);
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

/** The sort key section 3 gives an array element, by its shape; `undefined` leaves the array's order alone. */
function sortKey(el: unknown): string | undefined {
  if (!isRec(el)) return undefined;
  if (isRec(el["resource"])) {
    const attrs = el["resource"]["attributes"];
    if (Array.isArray(attrs)) {
      const name = attrs.find((a) => isRec(a) && a["key"] === "service.name") as Rec | undefined;
      return name === undefined ? "" : JSON.stringify(name["value"]);
    }
    return "";
  }
  if (isRec(el["scope"])) return String(el["scope"]["name"]);
  if (typeof el["spanId"] === "string") return el["spanId"];
  if (typeof el["key"] === "string") return el["key"];
  return undefined;
}

/** Drops `_`-prefixed keys, sorts object keys, and sorts the arrays section 3 names by their key. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    const keys = items.map(sortKey);
    if (items.length > 1 && keys.every((k) => k !== undefined)) {
      const indexed = items.map((item, i) => [keys[i] as string, item] as const);
      indexed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return indexed.map((pair) => pair[1]);
    }
    return items;
  }
  if (isRec(value)) {
    const out: Rec = {};
    for (const key of Object.keys(value).sort()) {
      if (key.startsWith("_")) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** Every span of a request, in order. */
export function spansOf(request: ExportTraceServiceRequest): Span[] {
  return request.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
}

/** One request holding every span of the given requests, grouped by host as one sink write would group them. */
export function mergeRequests(requests: readonly ExportTraceServiceRequest[]): ExportTraceServiceRequest {
  const byHost = new Map<string, Span[]>();
  for (const request of requests) {
    for (const rs of request.resourceSpans) {
      const host = (rs.resource.attributes[0]?.value as { stringValue: string }).stringValue;
      let spans = byHost.get(host);
      if (spans === undefined) byHost.set(host, (spans = []));
      for (const ss of rs.scopeSpans) spans.push(...ss.spans);
    }
  }
  return {
    resourceSpans: [...byHost].map(([host, spans]) => ({
      resource: { attributes: [{ key: "service.name", value: { stringValue: host } }] },
      scopeSpans: [{ scope: { name: "mocon/" + host }, spans }],
    })),
  };
}

/** Runs a whole stream line by line, holding the latest declaration as it goes, the way the sink does over one batch. */
export function convertStream(lines: readonly string[], options?: MapOptionsAt): { request: ExportTraceServiceRequest; skipped: string[] } {
  let declaration: HostLine | undefined;
  const requests: ExportTraceServiceRequest[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as Rec;
    if (parsed["kind"] === "host") declaration = parsed as unknown as HostLine;
    const result = mapOne(line, declaration, options);
    requests.push(result.request);
    if (result.skipped !== undefined) skipped.push(result.skipped);
  }
  return { request: mergeRequests(requests), skipped };
}

/** The attribute values of a span as a plain map, for assertions. */
export function attrs(span: Span): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of span.attributes) {
    const v = kv.value as Rec;
    out[kv.key] =
      "stringValue" in v
        ? v["stringValue"]
        : "boolValue" in v
          ? v["boolValue"]
          : "intValue" in v
            ? v["intValue"]
            : "doubleValue" in v
              ? v["doubleValue"]
              : (v["arrayValue"] as { values: Rec[] }).values.map((x) => x["stringValue"]);
  }
  return out;
}

/** One line's mapping, for a line given as text or as one of the objects the builders above return. */
export interface MappedLine {
  request: ExportTraceServiceRequest;
  skipped?: SkipReason;
}

/** The mapping's `cap`, plus the receipt clock reading a test pins, which the mapping reads from `Date.now`. */
export interface MapOptionsAt {
  /** Cap in UTF-8 bytes on every string attribute written from a record value (otel-mapping.md 9). Default: none. */
  cap?: number;
  now?: () => number;
}

/** Maps one line, with `Date.now` pinned to `options.now` while it runs, so a crossing with no times lands where the test says. */
export function mapped(line: string | object, declaration?: HostLine, options?: MapOptionsAt): MappedLine {
  return mapOne(typeof line === "string" ? line : JSON.stringify(line), declaration, options);
}

function mapOne(line: string, declaration: HostLine | undefined, options: MapOptionsAt = {}): MappedLine {
  const { now, cap } = options;
  if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
  const held = declaration !== undefined && sameMajor(declaration.spec_version) ? declaration : undefined;
  const real = Date.now;
  if (now !== undefined) Date.now = now;
  try {
    const m = mapLine(line, (host) => (held?.host === host ? held : undefined), cap);
    if (m.kind === "span") return { request: buildRequest([m]) };
    return m.kind === "skip" ? { request: { resourceSpans: [] }, skipped: m.reason } : { request: { resourceSpans: [] } };
  } finally {
    Date.now = real;
  }
}

/** The single span of a one-line result. */
export function spanOf(request: ExportTraceServiceRequest): Span {
  const span = request.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  if (span === undefined) throw new Error("no span");
  return span;
}

/* ------------------------------------------------------------------ */
/* Collectors                                                          */
/* ------------------------------------------------------------------ */

export type Response = Awaited<ReturnType<FetchLike>>;
/** A response body stream holding `text`. */
export const bodyOf = (text: string): ReadableStream<Uint8Array> => new Response(text).body as ReadableStream<Uint8Array>;
export const ok = (): Response => ({ ok: true, status: 200, body: bodyOf("{}") });

export interface FakeCall {
  url: string;
  init: Parameters<FetchLike>[1];
  body: ExportTraceServiceRequest;
}

/** A stand-in for `fetch` that records each call and answers with `answer`. */
export function fakeFetch(answer: (call: FakeCall) => Promise<Response> = async () => ok()): { calls: FakeCall[]; fetch: FetchLike } {
  const calls: FakeCall[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const call = { url, init, body: JSON.parse(init.body) as ExportTraceServiceRequest };
      calls.push(call);
      return answer(call);
    },
  };
}

export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Collector {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

/** A node:http server on 127.0.0.1 that records every request and answers with `respond`, 200 by default. */
export async function collector(respond: (req: Received, res: ServerResponse) => void | Promise<void> = (_req, res) => void res.writeHead(200).end("{}")): Promise<Collector> {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      void respond(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
