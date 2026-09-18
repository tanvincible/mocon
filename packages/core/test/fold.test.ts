/**
 * `fold` must produce, for every golden stream, exactly the view in
 * spec/conformance/expected, and the same view for any permutation. It
 * keys by (host, id), so the single-host expected views compare after
 * the host prefix is stripped, and it counts what core.md 8 tells a
 * consumer to read as absent. A hostile line costs that line and nothing
 * else, and a conflict is resolved the way check.py resolves it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fold, type View } from "../src/fold.js";
import { readExpected, readStream, specDir, streamNames, type Rec } from "./helpers.js";

const names = streamNames();

/** The view in the conformance suite's shape: keys are bare ids, and `flagged` is not a field there. */
function suiteView(view: View): Rec {
  const strip = (map: Record<string, unknown>): Rec => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.slice(k.indexOf("\0") + 1), v]));
  return { hosts: { ...view.hosts }, executions: strip(view.executions), crossings: strip(view.crossings), unresolved: view.unresolved, conflicts: view.conflicts, skipped: view.skipped };
}

test("the suite has 23 golden streams", () => {
  assert.equal(names.length, 23);
});

for (const name of names) {
  test(`fold ${name} equals expected/${name}.json`, () => {
    const view = fold(readStream(name));
    assert.deepEqual(suiteView(view), readExpected(name));
    assert.equal(view.flagged, 0);
  });
}

test("the view is the same for any permutation and doubles skipped on self-concatenation", () => {
  for (const name of names) {
    const raw = readStream(name);
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const base = fold(lines);
    for (let i = 0; i < 5; i++) {
      const shuffled = [...lines];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k] as string, shuffled[j] as string];
      }
      assert.deepEqual(fold(shuffled), base, `${name}: permutation ${i}`);
    }
    const doubled = fold([...lines, ...lines]);
    assert.deepEqual({ ...doubled, skipped: 0 }, { ...base, skipped: 0 }, `${name}: self-concatenation`);
    assert.equal(doubled.skipped, base.skipped * 2);
  }
});

test("malformed and non-object lines are skipped and counted", () => {
  const view = fold(['{"kind":"host","host":"h"}', "not json", "[1,2]", "", "   ", '{"kind":"metric","host":"h"}']);
  assert.equal(view.skipped, 3);
  assert.deepEqual(Object.keys(view.hosts), ["h"]);
});

test("a host redeclared with different values is a conflict with a null id", () => {
  const view = fold(['{"kind":"host","host":"h","observes_crossings":"all"}', '{"kind":"host","host":"h","observes_crossings":"none"}']);
  assert.deepEqual(view.conflicts, [{ kind: "host", host: "h", id: null }]);
  assert.equal(view.hosts["h"]?.observes_crossings, "all", "canonical JSON of the 'all' record sorts first");
});

test("two hosts that share an id stay apart: keys are (host, id), as core.md 6 scopes them", () => {
  const lines = [
    '{"kind":"host","host":"a","observes_crossings":"all"}',
    '{"kind":"host","host":"b","observes_crossings":"all"}',
    '{"kind":"execution","host":"a","id":"e1","program":{"value":"x"},"start":"2026-09-16T10:00:00Z","end":{"time":"2026-09-16T10:00:01Z","disposition":"completed"}}',
    '{"kind":"execution","host":"b","id":"e1","program":{"value":"y"},"start":"2026-09-16T10:00:00Z","end":{"time":"2026-09-16T10:00:01Z","disposition":"failed"}}',
    '{"kind":"crossing","host":"a","id":"c1","execution_id":"e1","target":"t","input":{"value":1},"end":{"outcome":"output"}}',
    '{"kind":"crossing","host":"b","id":"c1","execution_id":"e1","target":"u","input":{"value":2},"end":{"outcome":"error"}}',
  ];
  const view = fold(lines);
  assert.deepEqual(Object.keys(view.executions).sort(), ["a\0e1", "b\0e1"]);
  assert.deepEqual(Object.keys(view.crossings).sort(), ["a\0c1", "b\0c1"]);
  assert.deepEqual(view.conflicts, [], "distinct hosts never conflict (core.md 4 rule 6)");
});

test("a host, execution or crossing keyed __proto__ is an own entry of the view, never its prototype", () => {
  const exec = (host: string, id: string): string =>
    JSON.stringify({ kind: "execution", host, id, program: { value: "p" }, start: "2026-09-16T10:00:00Z", end: { time: "2026-09-16T10:00:01Z", disposition: "completed" } });
  const cross = (host: string, id: string): string =>
    JSON.stringify({ kind: "crossing", host, id, execution_id: "e1", target: "t", input: { value: 1 }, end: { outcome: "output" } });
  const view = fold([JSON.stringify({ kind: "host", host: "__proto__", observes_crossings: "all" }), exec("__proto__", "__proto__"), cross("h", "__proto__")].join("\n"));
  assert.deepEqual(Object.keys(view.hosts), ["__proto__"]);
  assert.deepEqual(Object.keys(view.executions), ["__proto__\0__proto__"]);
  assert.deepEqual(Object.keys(view.crossings), ["h\0__proto__"]);
  assert.equal(Object.getPrototypeOf(view.hosts), null);
  assert.equal(Object.getPrototypeOf(view.executions), null);
  assert.equal(view.hosts["__proto__"]?.observes_crossings, "all");
  assert.equal(view.hosts["constructor"], undefined, "a missing host is missing, not Object");
});

test("an unknown end.disposition or end.outcome reads as no end (core.md 8): the record is unresolved and the line is flagged", () => {
  const view = fold([
    '{"kind":"host","host":"h","spec_version":"1.0","observes_crossings":"all"}',
    '{"kind":"execution","host":"h","id":"e1","program":{"value":"p"},"start":"2026-09-16T10:00:00.000Z","end":{"time":"2026-09-16T10:00:01.000Z","disposition":"finished"}}',
    '{"kind":"crossing","host":"h","id":"c1","execution_id":"e1","target":"t","input":{"value":1},"end":{"outcome":"done"}}',
    '{"kind":"crossing","host":"h","id":"c2","execution_id":"e1","target":"t","input":{"value":1},"end":"soon"}',
  ]);
  assert.deepEqual(
    view.unresolved.map((r) => r.id),
    ["c1", "c2", "e1"],
  );
  assert.equal((view.executions["h\0e1"] as Rec | undefined)?.["end"], undefined);
  assert.equal((view.crossings["h\0c1"] as Rec | undefined)?.["end"], undefined);
  assert.equal(view.flagged, 3);
});

test("an unknown observes_crossings or crossing_edge on the declaration reads as absent and is flagged", () => {
  const view = fold(['{"kind":"host","host":"h","spec_version":"1.0","observes_crossings":"everything","crossing_edge":"middle","unmediated_egress":false}']);
  assert.deepEqual(view.hosts["h"], { kind: "host", host: "h", spec_version: "1.0", unmediated_egress: false });
  assert.equal(view.flagged, 1);
});

test("fold survives one line with a payload nested 200k deep", () => {
  const depth = 200_000;
  const nested = "[".repeat(depth) + "]".repeat(depth);
  const line = `{"kind":"crossing","host":"h","id":"c1","execution_id":"e1","target":"t","input":{"value":${nested}},"end":{"outcome":"output"}}`;
  const view = fold(line);
  assert.equal(Object.keys(view.crossings).length, 1);
  assert.equal(view.skipped, 0);
});

/* ------------------------------------------------------------------ */
/* Hostile lines                                                       */
/* ------------------------------------------------------------------ */

const T0 = "2026-09-16T10:00:00.000Z";
const T1 = "2026-09-16T10:00:01.000Z";

test("a declaration with an unknown observes_crossings and an own __proto__ key does not inherit attested from it", () => {
  const view = fold([
    '{"kind":"host","host":"h","spec_version":"1.0","observes_crossings":"bogus","__proto__":{"attested":["crossing.target","crossing.input","crossing.output","crossing.error","execution.error.class"]}}',
  ]);
  const declaration = view.hosts["h"];
  assert.ok(declaration !== undefined);
  assert.equal(Object.getPrototypeOf(declaration), Object.prototype, "the declaration's prototype came from the line");
  assert.equal(declaration.attested, undefined, "attested reads through a prototype the line supplied");
  assert.equal(view.flagged, 1);
});

test("an execution or crossing whose end is flagged, with an own __proto__ key, stays unresolved with no end", () => {
  const view = fold([
    `{"kind":"execution","host":"h","id":"e1","program":{"value":"p"},"start":"${T0}","end":{"time":"${T1}","disposition":"bogus"},"__proto__":{"end":{"time":"${T1}","disposition":"completed","result":{"value":"forged"}}}}`,
    `{"kind":"crossing","host":"h","id":"c1","execution_id":"e1","target":"t","input":{"value":1},"end":"soon","__proto__":{"end":{"outcome":"output","output":{"value":"forged"}}}}`,
  ]);
  assert.equal(view.flagged, 2);
  assert.deepEqual(
    view.unresolved.map((r) => r.id),
    ["c1", "e1"],
    "core.md 8: a record whose end is outside its closed set reads as having no end",
  );
  assert.equal((view.executions["h\0e1"] as { end?: unknown } | undefined)?.end, undefined, "an end the line never validly carried reads through the prototype");
  assert.equal((view.crossings["h\0c1"] as { end?: unknown } | undefined)?.end, undefined);
});

const GOOD = '{"kind":"execution","host":"h","id":"ok","program":{"value":"p"},"start":"2026-09-16T10:00:00Z","end":{"time":"2026-09-16T10:00:01Z","disposition":"completed"}}';

test("a host or id that is not a string costs that line, counted as skipped, not the fold", () => {
  const depth = 20_000;
  const hostile = [
    '{"kind":"host","host":{"toString":0}}',
    '{"kind":"execution","host":{"toString":null},"id":"e1","program":{"value":"p"},"start":"2026-09-16T10:00:00Z"}',
    '{"kind":"crossing","host":"h","id":[{"toString":null}],"execution_id":"e1","target":"t","input":{"value":1}}',
    '{"kind":"execution","host":"h","id":7,"program":{"value":"p"},"start":"2026-09-16T10:00:00Z"}',
    `{"kind":"host","host":${"[".repeat(depth)}${"]".repeat(depth)}}`,
  ];
  let view: View | undefined;
  assert.doesNotThrow(() => {
    view = fold([...hostile, GOOD]);
  });
  assert.ok(view !== undefined && view.executions["h\0ok"] !== undefined, "the well-formed record is still in the view");
  assert.equal(view.skipped, hostile.length);
});

const python = spawnSync("python3", ["--version"]).status === 0;

function checkPyView(stream: string): Rec {
  const script = ["import sys, json", `sys.path.insert(0, ${JSON.stringify(specDir + "conformance")})`, "import check", "print(json.dumps(check.view_for(sys.stdin.read().split('\\n'))))"].join("\n");
  const run = spawnSync("python3", ["-c", script], { input: stream, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as Rec;
}

const HOST = '{"kind":"host","host":"h","spec_version":"1.0","observes_crossings":"all"}';

test("two conflicting complete records that differ in a non-ASCII character: fold keeps the one check.py keeps", { skip: !python }, () => {
  const complete = (cls: string): string =>
    JSON.stringify({ kind: "execution", host: "h", id: "e", program: { value: "p" }, start: "2026-09-17T09:00:00Z", end: { time: "2026-09-17T09:00:01Z", disposition: "failed", error: { class: cls } } });
  const stream = [HOST, complete("z"), complete("é")].join("\n");
  const expected = ((((checkPyView(stream)["executions"] as Rec)["e"] as Rec)["end"] as Rec)["error"] as Rec)["class"];
  const kept = (((fold(stream).executions["h\0e"] as unknown as Rec)["end"] as Rec)["error"] as Rec)["class"];
  assert.equal(kept, expected);
});

test("two complete records that differ only in 1 versus 1.0: fold reports the conflict check.py reports", { skip: !python }, () => {
  const a = '{"kind":"crossing","host":"h","id":"c","execution_id":"e","target":"t","input":{"value":1},"seq":1,"end":{"outcome":"abandoned"}}';
  const b = '{"kind":"crossing","host":"h","id":"c","execution_id":"e","target":"t","input":{"value":1},"seq":1.0,"end":{"outcome":"abandoned"}}';
  const stream = [HOST, a, b].join("\n");
  assert.deepEqual(fold(stream).conflicts, checkPyView(stream)["conflicts"]);
});
