/**
 * The 1.1 declarations: `dimensions` on the host record (core.md 5.1.1) and `links` on an execution or a
 * crossing (extensions/links.md). Each test is named for the rule it protects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mocon, memorySink, type Capabilities, type Dimension, type Link } from "../src/index.js";
import { dimensionsOf, fold } from "../src/fold.js";
import { assertValidStream, harness, SYNC_BRIDGE, type Rec } from "./helpers.js";

const declaring = (dimensions: Record<string, Dimension>): Capabilities => ({ ...SYNC_BRIDGE, attested: ["crossing.target", "crossing.input", "ext.declared"], dimensions });

const refuses = (dimensions: unknown): void => {
  assert.throws(() => mocon({ host: "example/mcp", capabilities: { observes_crossings: "all", dimensions } as Capabilities, sinks: [memorySink()] }), (e: unknown) => e instanceof TypeError || e instanceof RangeError);
};

test("core.md 5.1.1: a declaration reaches the host line with its fields in the spec's order and nothing added", () => {
  const h = harness({
    capabilities: declaring({
      "example.credits_used": { agg: "sum", unit: "{credit}", name: "Credits spent", observed: true },
      "example.credits_remaining": { agg: "last", unit: "{credit}", name: "Credits left", observed: true },
      "example.guard": { agg: "none", card: "low", name: "Guard" },
      "example.sandbox_id": { agg: "none" },
    }),
  });
  assert.equal(
    h.sink.lines[0],
    '{"kind":"host","host":"example/mcp","spec_version":"1.1","observes_crossings":"all","unmediated_egress":false,"crossing_edge":"invocation",' +
      '"attested":["crossing.target","crossing.input","ext.declared"],' +
      '"dimensions":{"example.credits_used":{"agg":"sum","unit":"{credit}","name":"Credits spent","observed":true},' +
      '"example.credits_remaining":{"agg":"last","unit":"{credit}","name":"Credits left","observed":true},' +
      '"example.guard":{"agg":"none","card":"low","name":"Guard"},' +
      '"example.sandbox_id":{"agg":"none"}}}',
  );
  assertValidStream(h.sink.lines);
});

test("core.md 5.1.1: agg is required and closed, and every other field is checked for its type", () => {
  refuses({ "example.k": { unit: "{credit}" } });
  refuses({ "example.k": { agg: "total" } });
  refuses({ "example.k": { agg: "sum", unit: 1 } });
  refuses({ "example.k": { agg: "none", card: "medium" } });
  refuses({ "example.k": { agg: "none", name: 7 } });
  refuses({ "example.k": { agg: "none", observed: "yes" } });
  refuses({ "example.k": 3 });
  refuses({ "example.k": null });
  refuses([]);
  refuses(7);
});

test("core.md 5.1.1: a declaration that contradicts itself is refused, never written", () => {
  // A unit on a key that is not a quantity, and a cardinality on a key whose value is a measure.
  refuses({ "example.guard": { agg: "none", unit: "{credit}" } });
  refuses({ "example.credits": { agg: "sum", card: "low" } });
  refuses({ "example.credits": { agg: "last", card: "high" } });
});

test("core.md 3: the reserved mocon. namespace is not declarable", () => {
  refuses({ "mocon.encoding": { agg: "none" } });
  refuses({ "mocon.cost": { agg: "sum", unit: "{credit}" } });
});

test("core.md 5.1: a declaration is read once, so a getter cannot answer the check with one value and the line with another", () => {
  let reads = 0;
  const dimensions = {
    "example.k": {
      get agg(): string {
        reads++;
        return reads === 1 ? "sum" : "made-up";
      },
    },
  };
  const h = harness({ capabilities: { ...SYNC_BRIDGE, dimensions } as Capabilities });
  assert.deepEqual((JSON.parse(h.sink.lines[0] as string) as Rec)["dimensions"], { "example.k": { agg: "sum" } });
  assert.equal(reads, 1);
});

test("core.md 3: a declared key named __proto__ is an own entry on the wire, not this object's prototype", () => {
  const h = harness({ capabilities: { ...SYNC_BRIDGE, dimensions: JSON.parse('{"__proto__":{"agg":"none"},"example.k":{"agg":"sum"}}') as Record<string, Dimension> } });
  assert.ok((h.sink.lines[0] as string).includes('"dimensions":{"__proto__":{"agg":"none"},"example.k":{"agg":"sum"}}'));
  assert.deepEqual(Object.keys(dimensionsOf(JSON.parse(h.sink.lines[0] as string))), ["__proto__", "example.k"]);
  assertValidStream(h.sink.lines);
});

test("core.md 5.1: declare re-writes the declaration byte for byte, so a re-send is a no-op and not a conflict", () => {
  const h = harness({ capabilities: declaring({ "example.credits_used": { agg: "sum", unit: "{credit}" } }) });
  h.m.declare();
  assert.equal(h.sink.lines[0], h.sink.lines[1]);
  assert.deepEqual(fold(h.sink.lines).conflicts, []);
});

test("core.md 5.1.1 and 8: dimensionsOf reads a declaration back with the absent-reads-as column applied", () => {
  const host = {
    kind: "host",
    host: "h",
    dimensions: {
      "example.credits_used": { agg: "sum", unit: "{credit}", name: "Credits spent", observed: true },
      "example.guard": { agg: "none", card: "low" },
      "example.bare": { agg: "none" },
      "example.unknown_agg": { agg: "p95" },
      "example.unknown_card": { agg: "none", card: "medium" },
      "example.no_agg": { unit: "{credit}" },
      "example.not_an_object": 3,
    },
  };
  assert.deepEqual({ ...dimensionsOf(host) }, {
    "example.credits_used": { agg: "sum", unit: "{credit}", card: "high", name: "Credits spent", observed: true },
    "example.guard": { agg: "none", unit: "1", card: "low", observed: false },
    "example.bare": { agg: "none", unit: "1", card: "high", observed: false },
    "example.unknown_card": { agg: "none", unit: "1", card: "high", observed: false },
  });
  assert.deepEqual({ ...dimensionsOf({ kind: "host", host: "h" }) }, {});
  assert.deepEqual({ ...dimensionsOf({ kind: "host", host: "h", dimensions: [] }) }, {});
  assert.deepEqual({ ...dimensionsOf(undefined) }, {});
});

test("links.md 2: a link reaches the execution's notice and its complete record, in the table's field order", () => {
  const links: Link[] = [{ rel: "replay_of", kind: "execution", id: "run-1", counts: "duplicate" }];
  const h = harness();
  h.m.execution.start({ program: "p", id: "run-2", links }).complete();
  for (const line of h.ofKind("execution")) assert.deepEqual(line["links"], [{ rel: "replay_of", kind: "execution", id: "run-1", counts: "duplicate" }]);
  assert.ok((h.sink.lines[1] as string).includes('"links":[{"rel":"replay_of","kind":"execution","id":"run-1","counts":"duplicate"}]'));
  assertValidStream(h.sink.lines);
});

test("links.md 2: a crossing carries its own links, with the optional host and execution_id", () => {
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  ex.crossing.start({
    target: "t",
    input: 1,
    id: "c2",
    links: [{ rel: "retry_of", kind: "crossing", id: "c1", counts: "additive", host: "example/other", execution_id: "e0" }],
  }).output(1);
  ex.complete();
  assert.deepEqual(h.last("crossing")["links"], [{ rel: "retry_of", kind: "crossing", id: "c1", counts: "additive", host: "example/other", execution_id: "e0" }]);
  assertValidStream(h.sink.lines);
});

test("links.md 2 and 4: rel, kind and counts are closed, id is a string, and counts is required", () => {
  const h = harness();
  const bad: unknown[] = [
    { kind: "execution", id: "a", counts: "additive" },
    { rel: "parent", kind: "execution", id: "a", counts: "additive" },
    { rel: "retry_of", kind: "event", id: "a", counts: "additive" },
    { rel: "retry_of", kind: "execution", id: "a" },
    { rel: "retry_of", kind: "execution", id: "a", counts: "maybe" },
    { rel: "retry_of", kind: "execution", id: 7, counts: "additive" },
    { rel: "retry_of", kind: "execution", id: "a", counts: "additive", host: 7 },
    "retry_of",
    null,
  ];
  for (const entry of bad) assert.throws(() => h.m.execution.start({ program: "p", links: [entry] as Link[] }), (e: unknown) => e instanceof TypeError || e instanceof RangeError, JSON.stringify(entry));
  assert.throws(() => h.m.execution.start({ program: "p", links: {} as unknown as Link[] }), TypeError);
  assert.equal(h.sink.lines.length, 1, "nothing but the host line was written");
});

test("links.md 7: a link must not name the record carrying it", () => {
  const h = harness();
  assert.throws(() => h.m.execution.start({ program: "p", id: "e1", links: [{ rel: "retry_of", kind: "execution", id: "e1", counts: "additive" }] }), RangeError);
  // Another host's record of the same id is a different record, and a crossing of that id is a different key.
  const ex = h.m.execution.start({ program: "p", id: "e1", links: [{ rel: "continues", kind: "execution", id: "e1", counts: "additive", host: "example/other" }] });
  ex.crossing.start({ target: "t", input: 1, id: "e1", links: [{ rel: "forked_from", kind: "execution", id: "e1", counts: "additive" }] }).output(1);
  assert.throws(() => ex.crossing.start({ target: "t", input: 1, id: "c1", links: [{ rel: "retry_of", kind: "crossing", id: "c1", counts: "additive" }] }), RangeError);
  ex.complete();
  assertValidStream(h.sink.lines);
});

test("links.md 7: an empty links array is absent on the wire, and links is read once at initiation", () => {
  const h = harness();
  const links: Link[] = [{ rel: "forked_from", kind: "execution", id: "root", counts: "additive" }];
  const ex = h.m.execution.start({ program: "p", links: [] });
  assert.equal("links" in h.last("execution"), false);
  const later = h.m.execution.start({ program: "p", links, notice: false });
  links[0] = { rel: "retry_of", kind: "crossing", id: "moved", counts: "duplicate" };
  later.complete();
  assert.deepEqual(h.last("execution")["links"], [{ rel: "forked_from", kind: "execution", id: "root", counts: "additive" }]);
  ex.complete();
  assertValidStream(h.sink.lines);
});
