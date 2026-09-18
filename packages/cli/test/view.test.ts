import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildModel } from "../src/model.js";
import { viewJson } from "../src/ui.js";
import { fmtDuration, renderView } from "../src/view.js";
import { assertBuilt, expectedView, jsonl, mocon as run, stream, streams, tempDir, UNSAFE } from "./helpers.js";

const render = (name: string): string => renderView(buildModel(stream(name).text));
const ch = (code: number): string => String.fromCharCode(code);
const T = "2026-09-16T10:00:00Z";
const T1 = "2026-09-16T10:00:01Z";

test("every golden stream renders a tree that names each execution and crossing, for any line order", () => {
  for (const s of streams) {
    const model = buildModel(s.text);
    const expected = expectedView(s.name);
    assert.equal(model.executions, Object.keys(expected.executions).length, s.name);
    assert.equal(model.crossings, Object.keys(expected.crossings).length, s.name);
    assert.equal(model.skipped, expected.skipped, s.name);
    assert.deepEqual(model.unresolved, expected.unresolved, s.name);
    assert.deepEqual(model.conflicts, expected.conflicts, s.name);
    const text = renderView(model);
    for (const id of Object.keys(expected.executions)) assert.ok(text.includes(id), `${s.name}: execution ${id}`);
    for (const c of Object.values(expected.crossings)) assert.ok(text.includes(String(c["target"])), `${s.name}: crossing ${String(c["id"])}`);
    const reversed = s.text.split("\n").reverse().join("\n");
    assert.equal(renderView(buildModel(reversed)), text, `${s.name}: reversed lines must render the same tree`);
  }
});

test("sync-bridge: session grouping, seq order, durations and provenance markers", () => {
  const text = render("sync-bridge");
  assert.match(text, /^host example\/mcp  spec_version 1\.0  observes_crossings all  unmediated_egress false  crossing_edge invocation  attested crossing\.target, crossing\.input$/m);
  assert.match(text, /^session mcp-9a1f0c$/m);
  assert.match(text, /^  a218a2b4ccf7ed00ce2e656895419c7d  completed  1\.902s  javascript P  start 2026-09-16T10:00:00\.000Z$/m);
  assert.match(text, /^    program P  const \[co, people\] = await Promise\.all.*  \(204 bytes, sha256:7736542c…\)$/m);
  assert.ok(text.indexOf("#1 company_identify") < text.indexOf("#2 person_search"), "crossings are ordered by seq");
  assert.match(text, /^    ├─ #1 company_identify  output  284ms$/m, "an attested target carries no marker");
  assert.match(text, /^    │    input  \{"query":"acme\.example"\}$/m, "an attested input carries no marker");
  assert.match(text, /^    │    output  \{"id":8842,"name":"Acme Robotics"\} P$/m, "an unattested output is program-determined");
  assert.match(text, /^    └─ #2 person_search  output  1\.755s$/m);
  assert.match(text, /^         output  \[\{"name":"Jordan Ellis".* P  \(truncated, 6224 bytes\)$/m);
  assert.match(text, /^    result  \{"company":"Acme Robotics","count":120\} P$/m);
  assert.match(text, /^    ext  \{"example\.credits_remaining":9982,"example\.credits_used":18\} P$/m);
  assert.match(text, /^1 host, 1 execution, 2 crossings, 0 unresolved, 0 conflicts, 0 skipped, 0 flagged$/m);
});

test("markers follow the declaration: P on an unattested target, T on attested output and error", () => {
  const timeout = render("terminated-timeout");
  assert.match(timeout, /^    └─ web_search P  abandoned$/m, "attested is empty, so target is P and the abandoned crossing has no duration");
  assert.match(timeout, /^    error  timeout P  "ExecutionTimeoutError: step exceeded 90s" P$/m);

  const error = render("crossing-error");
  assert.match(error, /^    └─ #2 crm\.update_contact  error  85ms$/m);
  assert.match(error, /^         error  conflict T  "contact c_482 is locked by another writer" T  value \{"code":"CONFLICT","locked_by":"writer-77"\} T$/m);
  assert.match(error, /^    │    output  \{"id":"c_482","name":"Nora Cheng","tier":"gold"\} T$/m);
  assert.match(error, /^    logs  \["lookup ok: c_482","update rejected: locked by writer-77"\] P$/m);

  const nb = render("multi-block-error-value");
  assert.match(nb, /^    error  runtime  "KeyError: 'renewal_date'.*" P  value \{"ename":"KeyError".* P$/m, "an attested execution.error.class carries no marker; message and value stay P");
});

test("unresolved records show as running, conflicts are marked, unknown kinds are counted", () => {
  const unresolved = render("unresolved");
  assert.match(unresolved, /^  e7317286b59fedf2aa9d2dd6f2c11911  running  starlark P  start 2026-09-16T19:00:00\.000Z$/m);
  assert.match(unresolved, /1 unresolved, 0 conflicts/);

  const conflict = render("conflicting-resend");
  assert.match(conflict, /^  7bfcd3aae9d50b5a5a208867efdfe77d  completed \(conflict\)  500ms/m, "the record whose canonical JSON sorts first is shown");
  assert.match(conflict, /1 conflict, 0 skipped/);

  assert.match(render("unknown-kind"), /0 conflicts, 1 skipped, 0 flagged$/m);
});

test("crossings without times carry no duration and program-withheld records show their flags", () => {
  const text = render("seq-no-times");
  assert.match(text, /^    ├─ #1 manual\.records\.lookup  output$/m);
  assert.match(text, /^    ├─ #2 manual\.records\.lookup  output$/m);
  assert.match(text, /^    └─ #3 manual\.records\.summarize  output$/m);
  assert.match(render("hash-only-program"), /^    program  \(no value\)  \(redacted, 169 bytes, sha256:f71577c5…\)$/m);
  assert.match(render("base64-input-null-value"), /^         output  null T$/m, "a present null is a value");
});

test("executions without a session, crossings without an execution, and multi-host keys", () => {
  const lines = [
    { kind: "host", host: "a", observes_crossings: "all" },
    { kind: "execution", host: "a", id: "e1", program: { value: "x" }, start: T, end: { time: T1, disposition: "completed" } },
    { kind: "execution", host: "b", id: "e1", program: { value: "y" }, start: "2026-09-16T09:00:00Z", context: { session: "s" }, end: { time: "2026-09-16T09:00:02Z", disposition: "failed" } },
    { kind: "crossing", host: "a", id: "c1", execution_id: "ghost", target: "t", input: { value: 1 }, end: { outcome: "abandoned" } },
  ];
  const model = buildModel(jsonl(lines));
  assert.equal(model.executions, 2, "the same id under two hosts is two executions");
  assert.deepEqual(model.sessions.map((s) => [s.session, s.executions.map((e) => `${e.host}/${e.id}`)]), [
    ["s", ["b/e1"]],
    [null, ["a/e1", "a/ghost"]],
  ]);
  const text = renderView(model);
  assert.match(text, /^session \(none\)$/m);
  assert.match(text, /^  ghost  no execution record  host a$/m);
  assert.match(text, /^    └─ t P  abandoned$/m);
});

test("core.md 8: an unknown disposition, outcome or capability value reads as absent and is flagged, never shown as a state", () => {
  const text = renderView(
    buildModel(
      jsonl([
        { kind: "host", host: "h", spec_version: "1.0", observes_crossings: "most", crossing_edge: "sideways", attested: ["crossing.target"] },
        { kind: "execution", host: "h", id: "e1", program: { value: "x" }, start: T, end: { time: T1, disposition: "success", result: { value: 1 } } },
        { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "t", input: { value: 1 }, start: T, end: { time: T1, outcome: "ok", output: { value: 2 } } },
      ]),
    ),
  );
  assert.match(text, /^  e1  running  start 2026-09-16T10:00:00Z$/m);
  assert.match(text, /^    └─ t  running$/m);
  assert.match(text, /observes_crossings absent \(none\)/);
  assert.match(text, /crossing_edge absent/);
  assert.doesNotMatch(text, /success|\bok\b|most|sideways/);
  assert.doesNotMatch(text, /^    result/m, "fields of an end read as absent are not shown");
  assert.match(text, /2 unresolved, 0 conflicts, 0 skipped, 3 flagged$/m);
});

test("a capability value of the wrong type reads as absent", () => {
  const text = renderView(buildModel(jsonl([{ kind: "host", host: "h", spec_version: 1, unmediated_egress: "false", attested: [5] }])));
  assert.match(text, /^host h  spec_version absent  observes_crossings absent \(none\)  unmediated_egress absent \(unknown\)  crossing_edge absent  attested none$/m);
});

test("the tree never writes a control character from the stream: C0, C1, line separators and bidirectional marks are escaped", () => {
  const ESC = ch(0x1b);
  const BEL = ch(0x07);
  const ERASE_ABOVE = ESC + "[1A" + ESC + "[2K";
  const LINK = ESC + "]8;;http://attacker.example" + BEL + "company_lookup" + ESC + "]8;;" + BEL;
  const text = jsonl([
    { kind: "host", host: "h" + ESC + "]0;pwned" + BEL, observes_crossings: "all", crossing_edge: "invocation", attested: ["crossing." + ch(0x9b) + "2J"] },
    {
      kind: "execution",
      host: "h" + ESC + "]0;pwned" + BEL,
      id: "e1" + ch(0x0d),
      program: { value: "p" + ch(0x2028) + "q" },
      language: "js" + ERASE_ABOVE,
      start: T,
      context: { session: "s" + ch(0x9b) + "31m", traceparent: "00-" + ch(0x202e) + "abc" },
      end: { time: T1, disposition: "completed", outputs: { ["std" + ESC + "[2K"]: { value: "x" } }, error: { class: "boom" + ESC + "c", message: "m" + ch(0x85) } },
    },
    { kind: "crossing", host: "h" + ESC + "]0;pwned" + BEL, id: "c1", execution_id: "e1" + ch(0x0d), target: ERASE_ABOVE + LINK, input: { value: "a" + ESC + "b", truncated: true }, end: { outcome: "output" } },
    { kind: "execution", host: "h" + ESC + "]0;pwned" + BEL, id: "e2" + ERASE_ABOVE, program: { value: "p" } },
  ]);
  const out = renderView(buildModel(text));
  const hit = UNSAFE.exec(out.replace(/\n/g, ""));
  assert.equal(hit, null, hit === null ? "" : `U+${hit[0].charCodeAt(0).toString(16).padStart(4, "0")} reached the terminal at offset ${hit.index}`);
  assert.ok(out.includes("\\x1b[1A\\x1b[2K\\x1b]8;;http://attacker.example\\x07company_lookup"), "the target is shown with its escapes visible");
  assert.ok(out.includes("session s\\x9b31m"));
  assert.ok(out.includes("traceparent 00-\\u202eabc"));
  assert.ok(out.includes("p\\u2028q"));
});

test("a malformed record renders without throwing", () => {
  const lines = [
    { kind: "execution", host: "h", id: "7", program: "text", start: 5, language: 3, context: "c", end: { time: T1, disposition: "failed", error: "boom", result: null, outputs: "x" } },
    { kind: "crossing", host: "h", id: "c", execution_id: 7, target: { t: 1 }, input: null, seq: "1", end: { outcome: "error", error: [1] } },
    { kind: "crossing", host: "h", id: "d", execution_id: 7, target: "t", input: 5, end: { outcome: "output", output: "raw" } },
    { kind: "execution", host: "h", id: "e", program: { value: "12345", truncated: true }, start: T, ext: [1] },
  ];
  const out = renderView(buildModel(jsonl(lines)));
  assert.match(out, /error  \(not an Error object\)/);
  assert.match(out, /input  \(not a Payload\)/);
  assert.match(out, /output  \(not a Payload\)/);
  assert.match(out, /program P  \(not a Payload\)|program  \(not a Payload\)/);
  assert.doesNotThrow(() => renderView(buildModel(jsonl([{ ...lines[0], id: 7 }]))), "a record with no string id is skipped, as fold skips it");
});

test("durations format by magnitude", () => {
  assert.equal(fmtDuration(null), "");
  assert.equal(fmtDuration(284), "284ms");
  assert.equal(fmtDuration(1902), "1.902s");
  assert.equal(fmtDuration(300_000), "5m0.0s");
  assert.equal(fmtDuration(-5), "-5ms");
});

/* ------------------------------------------------------------------ */
/* Hostile streams                                                     */
/* ------------------------------------------------------------------ */

const DEPTH = 20_000;

/** A stream whose one execution returned DEPTH nested arrays, as a host that does not cut deep values writes it. */
function deepStream(): string {
  const nested = "[".repeat(DEPTH) + "]".repeat(DEPTH);
  const start = '{"kind":"execution","host":"h","id":"deep","program":{"value":"return a"},"start":"2026-09-16T10:00:00Z"';
  return [
    '{"kind":"host","host":"h","spec_version":"1.0","observes_crossings":"all"}',
    `${start},"end":{"time":"2026-09-16T10:00:01Z","disposition":"completed","result":{"value":${nested}},"outputs":{"stdout":{"value":${nested}}}},"ext":{"v.deep":${nested}}}`,
    `{"kind":"crossing","host":"h","id":"c","execution_id":"deep","target":"t","input":{"value":${nested}},"end":{"outcome":"error","error":{"class":"x","message":${nested}}}}`,
  ].join("\n");
}

test("mocon view and mocon ui render a stream whose values are nested past the native stack", () => {
  const stream = deepStream();
  let out = "";
  assert.doesNotThrow(() => {
    out = renderView(buildModel(stream));
  });
  assert.match(out, /result {2}\[array\]/, "a value too deep to serialize shows its type");
  const file = join(tempDir(), "deep.jsonl");
  writeFileSync(file, stream);
  let view = "";
  assert.doesNotThrow(() => {
    view = viewJson(file);
  });
  assert.ok(view.includes("[".repeat(DEPTH)), "view.json carries the value whole");
});

test("the built mocon view exits 0 on a stream nested past the native stack", async () => {
  assertBuilt();
  const file = join(tempDir(), "deep.jsonl");
  writeFileSync(file, deepStream());
  const r = await run(["view", file]);
  assert.equal(r.status, 0, r.stderr);
});

/** A run of `bytes` characters. */
const chars = (c: string, bytes: number): string => c.repeat(bytes);
/** An array of about `bytes` characters, every element alike, so its first hundred do not depend on its length. */
const rows = (bytes: number): string[] => new Array(Math.ceil(bytes / 4)).fill("a") as string[];
/** An object of about `bytes` characters, holding an array and a run. */
const record = (bytes: number): Record<string, unknown> => ({ "v.rows": rows(bytes / 2), "v.note": chars("n", bytes / 2) });

/** A stream of about `bytes` characters in each slot the tree shows, in every shape a value takes: a run, an array and an object. */
function runsOf(bytes: number): string {
  return jsonl([
    { kind: "host", host: "h", spec_version: "1.0", observes_crossings: "all" },
    {
      kind: "execution",
      host: "h",
      id: "e",
      program: { value: chars("p", bytes) },
      start: T,
      ext: record(bytes),
      end: { time: T1, disposition: "completed", result: { value: rows(bytes) }, outputs: { stdout: { value: record(bytes) } } },
    },
    {
      kind: "crossing",
      host: "h",
      id: "c",
      execution_id: "e",
      target: "t",
      input: { value: record(bytes) },
      seq: 1,
      start: T,
      ext: record(bytes),
      end: { outcome: "error", time: T1, error: { class: "E", message: chars("m", bytes), value: { value: rows(bytes) } } },
    },
  ]);
}

test("showing a value costs what the width it shows costs, whatever its shape: a 5 MB payload renders within a small multiple of a 5 KB one", () => {
  const small = buildModel(runsOf(5_000));
  const large = buildModel(runsOf(5_000_000));
  const tree = renderView(large);
  assert.equal(tree, renderView(small), "the tree shows the same 100 characters of each value whatever its size");
  assert.ok(tree.length < 2_000, "the tree is bounded by the width, not by the stream");
  // The fastest of many rounds after a warmup, and a shape no machine changes: a thousand times the bytes for the same 100 characters.
  // A healthy run measures about 1; reading each value whole to show 100 characters of it measured about 500.
  const best = (model: ReturnType<typeof buildModel>): number => {
    let min = Infinity;
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      renderView(model);
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };
  best(small);
  best(large);
  const ratio = best(large) / best(small);
  assert.ok(ratio < 5, `a thousand times the payload took ${ratio.toFixed(1)}x as long to show the same tree`);
});

test("a flagged declaration cannot lift provenance labels through an own __proto__ key, and a flagged end with one neither stops the model nor shows as completed", () => {
  const T0 = "2026-09-16T10:00:00.000Z";
  const T1 = "2026-09-16T10:00:01.000Z";
  const stream = [
    '{"kind":"host","host":"h","spec_version":"1.0","observes_crossings":"bogus","__proto__":{"attested":["crossing.target","crossing.input","crossing.output","crossing.error","execution.error.class"]}}',
    `{"kind":"execution","host":"h","id":"e1","program":{"value":"p"},"start":"${T0}","end":{"time":"${T1}","disposition":"completed"}}`,
    `{"kind":"crossing","host":"h","id":"c1","execution_id":"e1","target":"transfer_funds","input":{"value":{"to":"attacker"}},"end":{"outcome":"output","output":{"value":"ok"}}}`,
    `{"kind":"execution","host":"h","id":"e2","program":{"value":"p"},"start":"${T0}","end":1,"__proto__":{"end":{"time":"${T1}","disposition":"completed","result":{"value":"forged"}}}}`,
  ].join("\n");
  let model: ReturnType<typeof buildModel> | undefined;
  assert.doesNotThrow(() => {
    model = buildModel(stream);
  });
  assert.ok(model !== undefined);
  const executions = model.sessions.flatMap((s) => s.executions);
  const crossing = executions.find((e) => e.id === "e1")?.crossings[0];
  assert.equal(crossing?.provenance["target"], "P", "the program-determined target shows as host-observed");
  assert.equal(crossing?.provenance["input.value"], "P", "the program-determined input shows as host-observed");
  assert.match(renderView(model), /transfer_funds P/);
  assert.equal(executions.find((e) => e.id === "e2")?.running, true, "core.md 8: an end outside its closed set reads as no end");
});
