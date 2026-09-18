/**
 * The consumer side of core.md 5.1.1 and extensions/links.md: what `view`
 * shows for a declared `ext` key, what it still shows for an undeclared
 * one, what the causal links look like in the tree, and what `mocon lint`
 * says about a declaration that drifted from the code that emits it.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { declarationsOf, declarationWarnings, extEntries, rollup } from "../src/dimensions.js";
import { buildModel } from "../src/model.js";
import { renderView } from "../src/view.js";
import { assertBuilt, jsonl, mocon as run, stream, streams, tempDir, UNSAFE } from "./helpers.js";

before(assertBuilt);

const render = (name: string): string => renderView(buildModel(stream(name).text));
const T = "2026-09-16T10:00:00.000Z";
const T1 = "2026-09-16T10:00:01.000Z";

/** A host that declares one key of each shape a consumer must treat differently. */
const host = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "host",
  host: "h",
  spec_version: "1.1",
  observes_crossings: "all",
  attested: ["ext.declared"],
  dimensions: {
    "h.spend": { agg: "sum", unit: "{credit}", name: "Spend", observed: true },
    "h.left": { agg: "last", unit: "{credit}", name: "Left", observed: true },
    "h.guard": { agg: "none", card: "low", name: "Guard", observed: true },
    "h.box": { agg: "none", observed: true },
  },
  ...over,
});
const execution = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "execution",
  host: "h",
  id: "e1",
  program: { value: "p" },
  start: T,
  end: { time: T1, disposition: "completed" },
  ...over,
});

test("a declared key renders by what its declaration says it means, and an undeclared one still renders", () => {
  const text = render("declared-dimensions");
  assert.match(text, /^host example\/metered .*  dimensions 5$/m);
  assert.match(text, /^    │    ext  Credits spent  12 \{credit\}$/m, "an amount shows its unit and, being host-observed, carries no marker");
  assert.match(text, /^    │    ext  Guard  "allow"  label$/m, "a low-cardinality key is a facet a consumer may group by");
  assert.match(text, /^    ext  Credits left  9964 \{credit\}$/m, "a level shows its unit like an amount and is never totalled");
  assert.match(text, /^    ext  Model  "planner-2" P  label$/m, "a declared key that is not observed stays program-determined");
  assert.match(text, /^    ext  metered\.sandbox_id  "sbx-0f3a91c4e7"  id$/m, "a high-cardinality key shows the key, since the host named none, and is never faceted");
  assert.match(text, /^    totals  Credits spent 36 \{credit\}$/m, "12 and 24 across two crossings total on their execution");
  assert.match(text, /^    facets  Guard "allow"×1, "review"×1  Model "planner-2"×1$/m);
  assert.doesNotMatch(text, /totals.*Credits left/, "core.md 5.1.1: a level is never totalled");
  assert.doesNotMatch(text, /facets.*sandbox_id/, "a high-cardinality key is never offered as a facet");
});

test("an undeclared key is marked, a reserved note is neither declared nor program-determined, and a counter totals as a count", () => {
  const text = render("undeclared-ext-key");
  assert.match(text, /^         ext  upstream\.region  "eu-west" P  undeclared$/m);
  assert.match(text, /^         ext  upstream\.queue_depth  7 P  undeclared$/m, "an undeclared number is displayed, never added up");
  assert.match(text, /^         ext  mocon\.target  \{"truncated":true\}  reserved$/m, "provenance.md 3: a reserved envelope note is host-observed, so no marker");
  assert.match(text, /^    totals  Hops 4$/m, "a sum with no unit reads as a count: 2 on the crossing and 2 on the execution");
  assert.doesNotMatch(text, /Hops.*\{1\}|Hops 4 1/, 'unit "1" shows as a bare count');
});

test("a time unit formats as a duration, a null is no value, and a quantity that did not arrive as a number reads as undeclared", () => {
  const text = render("dimension-mismatch");
  assert.match(text, /^    ext  Wall time  4\.009s$/m, "ms formats as a duration rather than as a bare number");
  assert.match(text, /^    ext  Peak memory  9840 KiBy$/m, "a unit with no time meaning is printed beside the value");
  assert.match(text, /^    ext  Peak memory  no value$/m, "core.md 5.1.1: a null is no value, never zero and never a mismatch");
  assert.match(text, /^    ext  Wall time  "3\.812"  mismatch$/m, "a string under sum is displayed verbatim and never parsed");
  const second = text.slice(text.indexOf("9be15a2d"));
  assert.doesNotMatch(second, /^    totals/m, "the only value of that key on that execution was a mismatch, so there is nothing to total");
});

test("a host that declared nothing renders exactly as it did in 1.0", () => {
  assert.match(render("sync-bridge"), /^    ext  \{"example\.credits_remaining":9982,"example\.credits_used":18\} P$/m);
  assert.doesNotMatch(render("sync-bridge"), /dimensions \d|totals |facets /);
});

test("core.md 8: an entry whose agg this version does not know leaves its key undeclared", () => {
  const text = renderView(
    buildModel(
      jsonl([
        { kind: "host", host: "h", attested: ["ext.declared"], dimensions: { "h.p95": { agg: "p95", observed: true }, "h.spend": { agg: "sum", observed: true } } },
        execution({ ext: { "h.p95": 12, "h.spend": 3 } }),
      ]),
    ),
  );
  assert.match(text, /^    ext  h\.p95  12 P  undeclared$/m);
  assert.match(text, /^    ext  h\.spend  3$/m);
  assert.match(text, /^    totals  h\.spend 3$/m, "the key with no name displays the key");
});

test("links put a retry, a fork, a replay and a continuation in the tree", () => {
  const text = render("links-retry-fanout");
  assert.match(text, /^         links  retry_of crossing b100000000000001 additive$/m);
  assert.equal(text.split("\n").filter((l) => l.includes("forked_from execution a70c3f1b5d92e48607b1c3d5f7a9e2b4 additive")).length, 3, "every shard of the fan-out points back at the one record it came from");
  assert.match(text, /^    links  replay_of execution a70c3f1b5d92e48607b1c3d5f7a9e2b4 duplicate$/m);
  assert.match(text, /^    links  continues execution 1627384950a6b7c8d9e0f11223344556 on example\/branching-worker additive$/m, "a cross-host continuation names the host it points at");
});

test("extensions/links.md 4: a duplicate-linked record is left out of a total and the line says so", () => {
  const lines = [
    host(),
    { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "t", input: { value: 1 }, seq: 1, ext: { "h.spend": 10 }, end: { outcome: "output" } },
    {
      kind: "crossing",
      host: "h",
      id: "c2",
      execution_id: "e1",
      target: "t",
      input: { value: 1 },
      seq: 2,
      ext: { "h.spend": 10 },
      links: [{ rel: "replay_of", kind: "crossing", id: "c1", counts: "duplicate" }],
      end: { outcome: "output" },
    },
    execution(),
  ];
  const text = renderView(buildModel(jsonl(lines)));
  assert.match(text, /^    totals  Spend 10 \{credit\}  \(1 duplicate record excluded\)$/m);

  const additive = jsonl(lines.map((l) => (l["id"] === "c2" ? { ...l, links: [{ rel: "retry_of", kind: "crossing", id: "c1", counts: "additive" }] } : l)));
  assert.match(renderView(buildModel(additive)), /^    totals  Spend 20 \{credit\}$/m, "a retry really did spend again");
});

test("the rollup and the entry order are the same for any line order, and aggregatable keys come first", () => {
  const lines = jsonl([host(), execution({ ext: { "h.box": "b", "h.guard": "g", "h.spend": 2, "h.left": 7, "z.undeclared": 1 } })]);
  const forward = renderView(buildModel(lines));
  assert.equal(renderView(buildModel(lines.split("\n").reverse().join("\n"))), forward);
  const keys = forward.split("\n").filter((l) => l.includes("  ext  ")).map((l) => l.trim().split("  ")[1]);
  assert.deepEqual(keys, ["Left", "Spend", "h.box", "Guard", "z.undeclared"], "core.md 5.1.1's suggested order: sum and last first, then by key, which is the key and never the display name");
});

test("a declaration bounds nothing the stream chose: a huge key, name and value each render within the width", () => {
  const big = "k".repeat(2_000_000);
  const text = renderView(
    buildModel(
      jsonl([
        { kind: "host", host: "h", attested: ["ext.declared"], dimensions: { [`h.${big}`]: { agg: "none", card: "low", name: big, observed: true } } },
        execution({ ext: { [`h.${big}`]: big } }),
      ]),
    ),
  );
  for (const line of text.split("\n")) {
    assert.ok(line.length < 400, `a line of ${line.length} characters`);
    assert.doesNotMatch(line, UNSAFE);
  }
});

test("declarationWarnings is check.py's lint: the golden streams carry exactly the one deliberate mismatch", () => {
  const warned = streams.filter((s) => declarationWarnings(s.text).length > 0).map((s) => s.name);
  assert.deepEqual(warned, ["dimension-mismatch"]);
  assert.deepEqual(declarationWarnings(stream("dimension-mismatch").text), [
    'host example/fronted-runner dimension "runner.wall_time_ms" is aggregatable but carried a non-number (1x)',
  ]);
  for (const s of streams) {
    assert.deepEqual(declarationWarnings(s.text.split("\n").reverse().join("\n")), declarationWarnings(s.text), `${s.name}: the lint does not depend on line order`);
  }
});

test("the drift a host runs this for: a key it forgot to declare, in a namespace it declares", () => {
  const warnings = declarationWarnings(
    jsonl([
      host(),
      execution({ ext: { "h.spend": 1, "h.forgotten": 2, "other.relayed": 3, "mocon.encoding": "base64", nodot: 4 } }),
    ]),
  );
  assert.deepEqual(warnings, ['host h emits undeclared ext key "h.forgotten" in a namespace it declares (1x)']);
});

test("the rest of provenance.md 7's declaration and link rules", () => {
  const unattested = declarationWarnings(jsonl([host({ attested: [] })]));
  assert.deepEqual(unattested, ["host h declares 4 observed dimension(s) without attesting ext.declared; consumers read those keys as P"]);

  const nothingObserved = declarationWarnings(jsonl([{ kind: "host", host: "h", attested: ["ext.declared"], dimensions: { "h.a": { agg: "sum" } } }]));
  assert.deepEqual(nothingObserved, ["host h attests ext.declared but no dimension carries observed: true"]);

  const unknown = declarationWarnings(jsonl([{ kind: "host", host: "h", dimensions: { "h.a": { agg: "p95" }, "h.b": { agg: "none", card: "medium" } } }]));
  assert.deepEqual(unknown, ['host h dimension "h.a" agg outside the known list: "p95"', 'host h dimension "h.b" card outside the known list: "medium"']);

  const links = declarationWarnings(
    jsonl([
      execution({
        links: [
          { rel: "caused_by", kind: "execution", id: "x", counts: "additive" },
          { rel: "retry_of", kind: "execution", id: "e1", counts: "once" },
          { rel: "retry_of", kind: "execution", id: "e1", counts: "additive" },
        ],
      }),
    ]),
  );
  assert.deepEqual(links, [
    'execution e1 link rel outside the known list: "caused_by"',
    'execution e1 link counts outside the known list: "once"',
    "execution e1 link names the record carrying it",
    "execution e1 link names the record carrying it",
  ]);
});

test("mocon lint exits 1 on drift and 0 on a stream whose declaration holds", async () => {
  const dir = tempDir();
  const clean = join(dir, "clean.jsonl");
  writeFileSync(clean, jsonl([host(), execution({ ext: { "h.spend": 1 } })]));
  const ok = await run(["lint", clean]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /: 0 declaration warnings -> OK\n$/);

  const drifted = join(dir, "drift.jsonl");
  writeFileSync(drifted, jsonl([host(), execution({ ext: { "h.spend": 1, "h.forgotten": 2 } })]));
  const bad = await run(["lint", drifted]);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /: 1 declaration warning -> DRIFT\n {4}host h emits undeclared ext key "h\.forgotten" in a namespace it declares \(1x\)\n$/);

  const streamRun = await run(["lint", stream("dimension-mismatch").path]);
  assert.equal(streamRun.status, 1, "a legal stream can still drift: lint is a gate a host opts into, which is why validate never fails on one");
  assert.equal((await run(["validate", stream("dimension-mismatch").path])).status, 0);
});

test("the pieces read a declaration the way core.md 5.1.1 says, without a viewer around", () => {
  const [decl] = [...declarationsOf(buildModel(jsonl([host()])).hosts).values()];
  assert.ok(decl !== undefined);
  assert.deepEqual(decl.dimensions["h.box"], { agg: "none", unit: "1", card: "high", observed: true }, "the absent-reads-as column is applied");
  assert.equal(decl.attestsDeclared, true);

  const entries = extEntries({ "h.spend": 5 }, decl);
  assert.deepEqual(entries.map((e) => [e.key, e.label, e.observed, e.mismatch]), [["h.spend", "Spend", true, false]]);
  assert.deepEqual(extEntries({ "h.spend": 5 }, undefined), [], "no declaration is no work: an undeclared host costs what it did in 1.0");

  const { totals, facets } = rollup([{ ext: { "h.spend": 5, "h.guard": "allow" } }, { ext: { "h.spend": 5, "h.guard": "allow" } }], decl);
  assert.deepEqual(totals, [{ key: "h.spend", label: "Spend", unit: "{credit}", value: 10, records: 2, excluded: 0 }]);
  assert.deepEqual(facets, [{ key: "h.guard", label: "Guard", values: [['"allow"', 2]] }]);
});
