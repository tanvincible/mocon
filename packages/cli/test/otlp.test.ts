import assert from "node:assert/strict";
import { test } from "node:test";
import { otlpSink, type ExportTraceServiceRequest } from "@mocon/otel";
import { exportStream, requestText } from "../src/otlp.js";
import { expectedOtlp, jsonl, recorder, stream, streams } from "./helpers.js";

type Rec = Record<string, unknown>;

/** The comparison from spec/conformance/otlp/README.md section 3: drop `_note`, sort keys, sort the arrays whose order carries no meaning. */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value === null || typeof value !== "object") return value;
  const out: Rec = {};
  for (const k of Object.keys(value).sort()) if (k !== "_note") out[k] = canon((value as Rec)[k]);
  return out;
}
const attr = (span: Rec, key: string): unknown => ((span["attributes"] as Rec[] | undefined) ?? []).find((a) => a["key"] === key)?.["value"];
const str = (v: unknown): string => JSON.stringify(v ?? "");
function normalize(req: unknown): Rec {
  const r = canon(req) as Rec;
  const resources = (r["resourceSpans"] as Rec[]).sort((a, b) => str(attr(a["resource"] as Rec, "service.name")).localeCompare(str(attr(b["resource"] as Rec, "service.name"))));
  for (const rs of resources) {
    const scopes = (rs["scopeSpans"] as Rec[]).sort((a, b) => str((a["scope"] as Rec)["name"]).localeCompare(str((b["scope"] as Rec)["name"])));
    for (const ss of scopes) {
      const spans = (ss["spans"] as Rec[]).sort((a, b) => String(a["spanId"]).localeCompare(String(b["spanId"])));
      for (const span of spans) (span["attributes"] as Rec[]).sort((a, b) => String(a["key"]).localeCompare(String(b["key"])));
    }
  }
  return r;
}

const T = "2026-09-16T10:00:00Z";
const T1 = "2026-09-16T10:00:01Z";

test("sync-bridge maps to the expected OTLP document, notice dropped and counted", async () => {
  const result = await exportStream(stream("sync-bridge").text);
  assert.equal(result.spans, 3);
  assert.deepEqual({ ...result.skipped }, { notice: 1, malformed: 0, unknown_kind: 0, bad_enum: 0, bad_timestamp: 0 });
  assert.equal(result.conflicts, 0);
  assert.equal("status" in result, false, "nothing was posted");
  assert.equal("error" in result, false);
  assert.deepEqual(normalize(result.request), normalize(expectedOtlp("sync-bridge")));
});

test("unresolved produces no spans", async () => {
  const result = await exportStream(stream("unresolved").text);
  assert.equal(result.spans, 0);
  assert.deepEqual(result.request, { resourceSpans: [] });
  assert.deepEqual(normalize(result.request), normalize(expectedOtlp("unresolved")));
  assert.equal(result.skipped.notice, 1);
});

test("no-timing-blob-ref: synthesized zero-duration crossing spans, everything else exact", async () => {
  const actual = normalize((await exportStream(stream("no-timing-blob-ref").text)).request);
  const expected = normalize(expectedOtlp("no-timing-blob-ref"));
  const spansOf = (r: Rec): Rec[] => ((r["resourceSpans"] as Rec[])[0]!["scopeSpans"] as Rec[])[0]!["spans"] as Rec[];
  let synthesized = 0;
  for (const span of spansOf(actual)) {
    if (str(attr(span, "mocon.crossing.timing")) === str({ stringValue: "none" })) {
      assert.equal(span["startTimeUnixNano"], span["endTimeUnixNano"], "a synthesized time is zero-duration");
      span["startTimeUnixNano"] = span["endTimeUnixNano"] = "receipt";
      synthesized++;
    }
  }
  for (const span of spansOf(expected)) if (str(attr(span, "mocon.crossing.timing")) === str({ stringValue: "none" })) span["startTimeUnixNano"] = span["endTimeUnixNano"] = "receipt";
  assert.equal(synthesized, 2);
  assert.deepEqual(actual, expected);
});

test("every golden stream maps without a malformed or bad line, and blank lines are not counted", async () => {
  for (const s of streams) {
    const result = await exportStream(s.text + "\n\n   \n");
    assert.equal(result.skipped.malformed, 0, s.name);
    assert.equal(result.skipped.bad_enum, 0, s.name);
    assert.equal(result.skipped.bad_timestamp, 0, s.name);
    assert.equal(result.conflicts, 0, s.name);
  }
});

test("malformed lines, unknown kinds, bad enums and bad timestamps are counted by reason", async () => {
  const text =
    stream("unknown-kind").text +
    "not json\n" +
    jsonl([
      { kind: "execution", host: "h", id: "e9", program: { value: "p" }, start: T, end: { time: T1, disposition: "success" } },
      { kind: "execution", host: "h", id: "e8", program: { value: "p" }, start: "yesterday", end: { time: T1, disposition: "completed" } },
    ]);
  const result = await exportStream(text);
  assert.equal(result.skipped.unknown_kind, 1);
  assert.equal(result.skipped.malformed, 1);
  assert.equal(result.skipped.bad_enum, 1);
  assert.equal(result.skipped.bad_timestamp, 1);
  assert.equal(result.spans, 1);
});

test("mocon otlp and one otlpSink write produce the same document, host conflict resolution included", async () => {
  const text = jsonl([
    { kind: "host", host: "h", spec_version: "1.0", observes_crossings: "some" },
    { kind: "host", host: "h", spec_version: "1.0", observes_crossings: "all" },
    { kind: "execution", host: "h", id: "e1", program: { value: "p" }, start: T, end: { time: T1, disposition: "completed" } },
  ]);
  let posted = "";
  const sink = otlpSink({
    url: "memory:",
    fetch: async (_url, init) => {
      posted = init.body;
      return { ok: true, status: 200, body: null };
    },
  });
  await sink.write(text.split("\n").filter((l) => l !== ""));
  const fromSink = JSON.parse(posted) as ExportTraceServiceRequest;
  const fromCli = await exportStream(text);
  const span = fromSink.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.deepEqual(span?.attributes.find((a) => a.key === "mocon.host.observes_crossings")?.value, { stringValue: "all" }, "the declaration that sorts first is held");
  assert.deepEqual(fromCli.request, fromSink);
  assert.equal(fromCli.conflicts, 1);
});

test("with a target the request is posted once, with its headers, and the collector's status is kept", async () => {
  const collector = await recorder(200);
  try {
    const result = await exportStream(stream("sync-bridge").text, { url: collector.url, headers: { authorization: "Bearer t0ken", "x-scope": "a=b" } });
    assert.equal(collector.received.length, 1);
    const [req] = collector.received;
    assert.equal(req!.method, "POST");
    assert.equal(req!.url, "/v1/traces");
    assert.equal(req!.headers["content-type"], "application/json");
    assert.equal(req!.headers["authorization"], "Bearer t0ken");
    assert.equal(req!.headers["x-scope"], "a=b");
    assert.deepEqual(JSON.parse(req!.body), result.request);
    assert.equal(result.status, 200);
    assert.equal("error" in result, false);
    assert.deepEqual(normalize(JSON.parse(req!.body)), normalize(expectedOtlp("sync-bridge")));
  } finally {
    await collector.close();
  }
});

test("a stream with no span posts nothing", async () => {
  const collector = await recorder(200);
  try {
    const result = await exportStream(stream("unresolved").text, { url: collector.url });
    assert.equal(collector.received.length, 0);
    assert.equal("status" in result, false);
    assert.equal("error" in result, false);
  } finally {
    await collector.close();
  }
});

test("a collector that refuses, or is not there, is an error with the status when there was one", async () => {
  const refusing = await recorder(503);
  try {
    const result = await exportStream(stream("sync-bridge").text, { url: refusing.url });
    assert.equal(result.status, 503);
    assert.match(String((result.error as Error).message), /503/);
  } finally {
    await refusing.close();
  }
  const gone = await recorder(200);
  const url = gone.url;
  await gone.close();
  const result = await exportStream(stream("sync-bridge").text, { url });
  assert.equal("status" in result, false);
  assert.ok("error" in result);
  assert.equal(result.spans, 3, "the request that would have been posted is still reported");
});

test("what otlp prints to stdout carries no bidirectional or C1 control character from the stream", async () => {
  const RLO = String.fromCharCode(0x202e);
  const CSI = String.fromCharCode(0x9b);
  const line = JSON.stringify({
    kind: "crossing",
    host: "h",
    id: "c1",
    execution_id: "e1",
    target: "crm." + RLO + "etadpu" + CSI + "2J",
    input: { value: 1 },
    start: "2026-09-16T10:00:00Z",
    end: { time: "2026-09-16T10:00:01Z", outcome: "error", error: { class: "x", message: RLO + "spoofed" } },
  });
  const result = await exportStream(line);
  // Exactly what bin.ts writes to stdout when no --url was given.
  const printed = requestText(result.request);
  assert.ok(!printed.includes(RLO), "a right-to-left override reaches the terminal and reorders what the reader sees");
  assert.ok(!printed.includes(CSI), "a C1 CSI control reaches the terminal");
  assert.ok(printed.includes("\\u202e") && printed.includes("\\u009b"), "the escapes the terminal is safe to show are missing");
  // The escapes are \u escapes, so the text a collector would receive is still the same JSON document.
  assert.deepEqual(JSON.parse(printed), JSON.parse(JSON.stringify(result.request)));
});
