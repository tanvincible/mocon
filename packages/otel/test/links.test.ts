/**
 * `links` to span links, otel-mapping.md 13 and extensions/links.md 9.
 * Every id comes from the entry itself, so no state and no lookup: the
 * point of these tests is that a link resolves to the ids the named
 * record's own span would have had, and that an entry this version cannot
 * read is dropped from the span links while staying in `mocon.links`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { crossingSpanIdOf, executionSpanIdOf, traceIdOf } from "../src/ids.js";
import { attrs, convertStream, crossing, execution, HOST, mapped, readStreamLines, spanOf, spansOf } from "./helpers.js";

const retry = { rel: "retry_of", kind: "crossing", id: "c100000000000001", counts: "additive" };

test("the fan-out stream: a retried crossing and three shards link back to the record they came from", () => {
  const { request } = convertStream(readStreamLines("links-retry-fanout"));
  const host = "example/branching";
  const root = "a70c3f1b5d92e48607b1c3d5f7a9e2b4";
  const spans = spansOf(request);

  const retried = spans.find((s) => s.spanId === "b100000000000002");
  assert.deepEqual(retried?.links, [
    {
      traceId: root,
      spanId: "b100000000000001",
      attributes: [
        { key: "mocon.rel", value: { stringValue: "retry_of" } },
        { key: "mocon.counts", value: { stringValue: "additive" } },
      ],
    },
  ]);
  assert.equal(attrs(retried as never)["mocon.links"], '[{"counts":"additive","id":"b100000000000001","kind":"crossing","rel":"retry_of"}]', "the array's JSON text, keys as the line carried them");

  const shard = spans.find((s) => s.spanId === executionSpanIdOf(host, "c1d2e3f405162738495a6b7c8d9e0f10"));
  assert.deepEqual(shard?.links?.[0]?.traceId, root, "an execution link lands in the named execution's trace");
  assert.deepEqual(shard?.links?.[0]?.spanId, executionSpanIdOf(host, root), "and on its span");

  const resumed = spans.find((s) => s.spanId === executionSpanIdOf(host, "05162738495a6b7c8d9e0f1122334454"));
  const named = "1627384950a6b7c8d9e0f11223344556";
  assert.deepEqual(resumed?.links?.[0], {
    traceId: named,
    spanId: executionSpanIdOf("example/branching-worker", named),
    attributes: [
      { key: "mocon.rel", value: { stringValue: "continues" } },
      { key: "mocon.counts", value: { stringValue: "additive" } },
    ],
  });
});

test("a crossing entry with no execution_id takes the carrying crossing's, and has none to take on an execution line", () => {
  const onCrossing = spanOf(mapped(crossing({ links: [retry] })).request);
  assert.deepEqual(onCrossing.links?.[0]?.traceId, traceIdOf(HOST, crossing()["execution_id"] as string));
  assert.deepEqual(onCrossing.links?.[0]?.spanId, crossingSpanIdOf(HOST, retry.id));

  const onExecution = spanOf(mapped(execution({ links: [retry] })).request);
  assert.equal(onExecution.links, undefined, "no trace id to derive, so no span link");
  assert.equal(attrs(onExecution)["mocon.links"], JSON.stringify([retry]), "and the entry is still on the span");
});

test("an entry this version cannot read is dropped from the span links and stays in mocon.links", () => {
  const entries = [
    { ...retry, rel: "caused_by" },
    { ...retry, counts: "maybe" },
    { ...retry, kind: "segment" },
    { rel: "retry_of", kind: "crossing", counts: "additive" },
    // links.md 7: an entry naming the record that carries it.
    { rel: "retry_of", kind: "crossing", id: "1a2b3c4d5e6f7081", counts: "additive" },
    "not an object",
  ];
  const span = spanOf(mapped(crossing({ links: entries })).request);
  assert.equal(span.links, undefined);
  assert.equal(attrs(span)["mocon.links"], JSON.stringify(entries));

  // The same id under another host is another record, and does link.
  const other = spanOf(mapped(crossing({ links: [{ rel: "retry_of", kind: "crossing", id: "1a2b3c4d5e6f7081", counts: "additive", host: "example/other" }] })).request);
  assert.equal(other.links?.length, 1);
});

test("links carry no provenance label, and an execution moved into a caller's trace keeps core.md 6's unattributed link first", () => {
  const span = spanOf(
    mapped(
      execution({
        links: [{ rel: "replay_of", kind: "execution", id: "run-1", counts: "duplicate" }],
        context: { traceparent: "00-" + "b".repeat(32) + "-" + "c".repeat(16) + "-01" },
      }),
    ).request,
  );
  assert.equal(span.links?.length, 2);
  assert.equal(span.links?.[0]?.attributes, undefined, "the traceparent degraded-path link, which carries none");
  assert.deepEqual(span.links?.[1]?.attributes?.map((kv) => kv.key), ["mocon.rel", "mocon.counts"]);
  const a = attrs(span);
  assert.ok("mocon.links" in a && !("mocon.provenance.links" in a), "links is host-observed unconditionally");
});
