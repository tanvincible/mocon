/**
 * The projection over the golden streams, the rules that decide what a
 * declared key is promoted as, and the sink around them. The fixture named
 * PANELS is shaped like a production host's declaration: the field names a
 * log dashboard's panels already facet on, which is what this package has to
 * keep working.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mocon, type HostLine, type Sink } from "@mocon/core";
import { flatten, logSink, type FlatRecord } from "../src/index.js";

type Rec = Record<string, unknown>;

const streams = fileURLToPath(new URL("../../../spec/conformance/streams/", import.meta.url));
const lines = (name: string): string[] =>
  readFileSync(streams + name + ".jsonl", "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");

/** Every record a stream flattens to, in order, through the sink that reads its declaration. */
const records = (name: string): FlatRecord[] => {
  const out: FlatRecord[] = [];
  logSink((r) => out.push(r)).write(lines(name));
  return out;
};

const only = (all: FlatRecord[], where: (r: FlatRecord) => boolean): FlatRecord => {
  const found = all.filter(where);
  assert.equal(found.length, 1);
  return found[0] as FlatRecord;
};

const host = (name: string): HostLine => JSON.parse(lines(name)[0] as string) as HostLine;

const declaration = (dimensions: Rec): HostLine =>
  ({ kind: "host", host: "example/panels", spec_version: "1.1", observes_crossings: "all", attested: ["ext.declared"], dimensions }) as unknown as HostLine;

/** The names a real dashboard's panels facet on, declared as one host's own keys. */
const PANELS = declaration({
  "panels.tenant_id": { agg: "none", card: "low", name: "Tenant" },
  "panels.client_platform": { agg: "none", card: "low" },
  "panels.dry_run": { agg: "none", card: "low" },
  "panels.rollout": { agg: "none", card: "low" },
  "panels.guard": { agg: "none", card: "low" },
  "panels.reason": { agg: "none", card: "low" },
  "panels.error_type": { agg: "none", card: "low" },
  "panels.status": { agg: "none", card: "low" },
  "panels.endpoint": { agg: "none", card: "low" },
  "panels.route": { agg: "none", card: "low" },
  "panels.credits_used": { agg: "sum", unit: "{credit}" },
  "panels.sandbox_id": { agg: "none" },
});

const line = (rec: Rec): string => JSON.stringify({ kind: "execution", host: "example/panels", id: "e1", start: "2026-09-18T08:00:00.000Z", ...rec });

test("a panel facets on every declared key, under the name the host chose for it", () => {
  const flat = flatten(
    line({
      end: { time: "2026-09-18T08:00:02.500Z", disposition: "completed" },
      ext: {
        "panels.tenant_id": "t-88",
        "panels.client_platform": "cli",
        "panels.dry_run": false,
        "panels.rollout": "arm-b",
        "panels.guard": "filters",
        "panels.reason": "auth",
        "panels.error_type": "invalid_request",
        "panels.status": 400,
        "panels.endpoint": "/records/search",
        "panels.route": "/mcp",
        "panels.credits_used": 0.06,
        "panels.sandbox_id": "sbx-0f3a",
      },
    }),
    PANELS,
  );
  assert.equal(flat.tenant_id, "t-88");
  assert.equal(flat.client_platform, "cli");
  assert.equal(flat.dry_run, false);
  assert.equal(flat.rollout, "arm-b");
  assert.equal(flat.guard, "filters");
  assert.equal(flat.reason, "auth");
  assert.equal(flat.error_type, "invalid_request");
  assert.equal(flat.status, 400);
  assert.equal(flat.endpoint, "/records/search");
  assert.equal(flat.route, "/mcp");
  assert.equal(flat.credits_used, 0.06);
  // card absent reads as high: an identifier, promoted so it can be looked up, never grouped by.
  assert.equal(flat.sandbox_id, "sbx-0f3a");
  assert.equal(flat.ok, true);
  assert.equal(flat.duration_ms, 2500);
});

test("every value is a scalar and `mocon` is the line itself, over every golden stream", () => {
  for (const name of ["declared-dimensions", "dimension-mismatch", "undeclared-ext-key", "two-hosts", "unknown-kind", "unresolved", "seq-no-times", "crossing-error", "abandoned-at-end", "anthropic-ptc", "links-retry-fanout", "multi-block-error-value", "no-timing-blob-ref", "base64-input-null-value"]) {
    const all = lines(name);
    const out = records(name);
    assert.equal(out.length, all.length, name);
    out.forEach((flat, i) => {
      assert.equal(flat.mocon, all[i], name);
      assert.equal(flat.ev, "mocon", name);
      for (const [key, value] of Object.entries(flat)) {
        assert.ok(["string", "number", "boolean"].includes(typeof value), `${name}: ${key} is ${typeof value}`);
        if (typeof value === "number") assert.ok(Number.isFinite(value), `${name}: ${key}`);
      }
    });
  }
});

test("a declared key is promoted, an undeclared one is not, and neither is a reserved `mocon.` note", () => {
  const crossing = only(records("undeclared-ext-key"), (r) => r.kind === "crossing");
  assert.equal(crossing.hops, 2);
  assert.equal(crossing.queue_depth, undefined);
  assert.equal(crossing.region, undefined);
  // `mocon.target` is never declarable (core.md 5.1.1), so it cannot take the core `target` name.
  assert.equal(crossing.target, JSON.parse(crossing.mocon as string).target);
});

test("a value that does not match its `agg` reads as undeclared for that record, and a null is no value", () => {
  const [, first, second] = records("dimension-mismatch");
  assert.equal(first?.wall_time_ms, 4009);
  assert.equal(first?.memory, 9840);
  assert.equal(second?.wall_time_ms, undefined, 'the string "3.812" is a mismatch under sum: never parsed');
  assert.equal(second?.memory, undefined, "null is no value, and a missing field is how a log line says that");
  assert.equal(second?.queue, "batch");
});

test("core fields come through under fixed names, on both kinds", () => {
  const all = records("declared-dimensions");
  const crossing = only(all, (r) => r.crossing_id === "d1a0b2c3d4e5f607");
  assert.deepEqual(crossing, {
    ev: "mocon",
    mocon: crossing.mocon,
    kind: "crossing",
    mocon_host: "example/metered",
    exec_id: "3fbb1c40a2d74e5b8f0c6913ad25e874",
    crossing_id: "d1a0b2c3d4e5f607",
    target: "records_search",
    seq: 1,
    outcome: "output",
    ok: true,
    duration_ms: 472,
    credits_used: 12,
    guard: "allow",
  });
  const execution = only(all, (r) => r.kind === "execution");
  assert.equal(execution.exec_id, "3fbb1c40a2d74e5b8f0c6913ad25e874");
  assert.equal(execution.session, "s-4471");
  assert.equal(execution.language, "javascript");
  assert.equal(execution.disposition, "completed");
  assert.equal(execution.program_bytes, 167);
  assert.ok(String(execution.program_hash).startsWith("sha256:"));
  assert.equal(execution.crossing_id, undefined);
});

test("`ok` is a confirmed normal end, and a record the host never settled has none", () => {
  const settle = (end: Rec | undefined, kind = "execution"): FlatRecord => flatten(JSON.stringify({ kind, host: "h", id: "i", execution_id: "e", start: "2026-09-18T08:00:00.000Z", end }));
  assert.equal(settle({ time: "2026-09-18T08:00:00.100Z", disposition: "completed" }).ok, true);
  assert.equal(settle({ time: "2026-09-18T08:00:00.100Z", disposition: "failed" }).ok, false);
  assert.equal(settle({ time: "2026-09-18T08:00:00.100Z", disposition: "terminated" }).ok, false);
  const abandoned = settle({ time: "2026-09-18T08:00:00.100Z", disposition: "abandoned" });
  assert.equal(abandoned.ok, undefined);
  assert.equal(abandoned.disposition, "abandoned");
  assert.equal(settle({ time: "2026-09-18T08:00:00.100Z", outcome: "output" }, "crossing").ok, true);
  assert.equal(settle({ time: "2026-09-18T08:00:00.100Z", outcome: "error" }, "crossing").ok, false);
  assert.equal(settle({ time: "2026-09-18T08:00:00.100Z", outcome: "abandoned" }, "crossing").ok, undefined);
});

test("a notice carries no end, and a value outside a closed set leaves the record one (core.md 8)", () => {
  const notice = only(records("unresolved"), (r) => r.kind === "execution");
  assert.equal(notice.disposition, undefined);
  assert.equal(notice.ok, undefined);
  assert.equal(notice.duration_ms, undefined);
  const bad = flatten(JSON.stringify({ kind: "execution", host: "h", id: "i", start: "2026-09-18T08:00:00.000Z", end: { time: "2026-09-18T08:00:01.000Z", disposition: "cancelled" } }));
  assert.equal(bad.disposition, undefined);
  assert.equal(bad.ok, undefined);
  assert.equal(bad.duration_ms, undefined);
  assert.equal(bad.exec_id, "i");
});

test("an error's class and message are promoted; the rest of the record stays in `mocon`", () => {
  const crossing = only(records("crossing-error"), (r) => r.outcome === "error");
  assert.equal(crossing.ok, false);
  assert.equal(typeof crossing.error_class, "string");
  const raw = JSON.parse(crossing.mocon as string) as Rec;
  assert.equal(crossing.error_class, ((raw.end as Rec).error as Rec).class);
  assert.equal(crossing.error_message, ((raw.end as Rec).error as Rec).message);
});

test("a name a pipeline takes for itself, a core name, or a name two keys want, is not promoted", () => {
  const ext: Rec = {};
  const keys = ["a.app", "a.host", "a.level", "a.message", "a.timestamp", "a.pod_name", "a.origin", "a.container_name", "a._time", "a.kind", "a.ok", "a.target", "a.duration_ms", "a.mocon", "a.exec_id", "a.2bad", "a.with-dash", "a."];
  for (const key of keys) ext[key] = "taken";
  const dimensions: Rec = {};
  for (const key of keys) dimensions[key] = { agg: "none", card: "low" };
  dimensions["one.guard"] = { agg: "none", card: "low" };
  dimensions["two.guard"] = { agg: "none", card: "low" };
  ext["one.guard"] = "first";
  ext["two.guard"] = "second";
  const flat = flatten(line({ end: { time: "2026-09-18T08:00:01.000Z", disposition: "completed" }, ext }), declaration(dimensions));
  assert.deepEqual(flat, {
    ev: "mocon",
    mocon: flat.mocon,
    kind: "execution",
    mocon_host: "example/panels",
    exec_id: "e1",
    disposition: "completed",
    ok: true,
    duration_ms: 1000,
  });
  // Nothing was lost: every one of them is in the line the record carries.
  for (const key of [...keys, "one.guard", "two.guard"]) assert.ok((flat.mocon as string).includes(key));
});

test("a nested value is never promoted, whatever it was declared as", () => {
  const dimensions = { "a.rows": { agg: "none" }, "a.steps": { agg: "none" }, "a.count": { agg: "sum" } };
  const flat = flatten(line({ ext: { "a.rows": [{ id: 1 }, { id: 2 }], "a.steps": { first: "search" }, "a.count": 2 } }), declaration(dimensions));
  assert.equal(flat.rows, undefined);
  assert.equal(flat.steps, undefined);
  assert.equal(flat.count, 2);
});

test("an entry whose `agg` this version does not know leaves its key undeclared (core.md 8)", () => {
  const flat = flatten(line({ ext: { "a.mean": 3, "a.sum": 4 } }), declaration({ "a.mean": { agg: "mean" }, "a.sum": { agg: "sum" } }));
  assert.equal(flat.mean, undefined);
  assert.equal(flat.sum, 4);
});

test("without a declaration no ext key is promoted, and core fields still are", () => {
  const flat = flatten(line({ ext: { "panels.tenant_id": "t-88" } }));
  assert.equal(flat.tenant_id, undefined);
  assert.equal(flat.exec_id, "e1");
  assert.equal(flat.kind, "execution");
});

test("a line that is not one JSON object still arrives, carrying its text", () => {
  for (const text of ["not json", "[1,2]", '{"kind":', "null", ""]) {
    const flat = flatten(text);
    assert.deepEqual(flat, { ev: "mocon", mocon: text });
  }
});

test("an unknown kind is relayed, not read: no field core does not fix on every line", () => {
  const metric = only(records("unknown-kind"), (r) => r.kind === "metric");
  assert.deepEqual(metric, { ev: "mocon", mocon: metric.mocon, kind: "metric", mocon_host: "pydantic/mcp-run-python" });
});

test("a host declaration is held per host string, and the sink reads each line with its own", () => {
  const out: FlatRecord[] = [];
  const sink = logSink((r) => out.push(r));
  const one = declaration({ "one.guard": { agg: "none", card: "low" } });
  const two = { ...declaration({ "two.guard": { agg: "none", card: "low" } }), host: "example/two" };
  sink.write([JSON.stringify(one), JSON.stringify(two)]);
  sink.write([
    JSON.stringify({ kind: "execution", host: "example/panels", id: "a", start: "2026-09-18T08:00:00.000Z", ext: { "one.guard": "allow", "two.guard": "x" } }),
    JSON.stringify({ kind: "execution", host: "example/two", id: "b", start: "2026-09-18T08:00:00.000Z", ext: { "one.guard": "x", "two.guard": "review" } }),
  ]);
  assert.equal(out[2]?.guard, "allow");
  assert.equal(out[3]?.guard, "review");
});

test("two declarations for one host string: the one whose canonical JSON sorts first (core.md 4 rule 3)", () => {
  const out: FlatRecord[] = [];
  const first = JSON.stringify(declaration({ "a.zeta": { agg: "none", card: "low" } }));
  const second = JSON.stringify(declaration({ "a.alpha": { agg: "none", card: "low" } }));
  const record = line({ ext: { "a.zeta": "z", "a.alpha": "a" } });
  for (const order of [[first, second], [second, first]]) {
    out.length = 0;
    logSink((r) => out.push(r)).write([...order, record]);
    assert.equal(out[2]?.alpha, "a", "the same view whichever order they arrive in");
    assert.equal(out[2]?.zeta, undefined);
  }
});

test("a declaration of another major is not held, and a record before any declaration promotes no ext key", () => {
  const out: FlatRecord[] = [];
  const sink = logSink((r) => out.push(r));
  const record = line({ ext: { "panels.tenant_id": "t-88" } });
  sink.write([record]);
  assert.equal(out[0]?.tenant_id, undefined, "a stateless sink applies the declaration it has seen so far (core.md 5.1)");
  sink.write([JSON.stringify({ ...declaration({ "panels.tenant_id": { agg: "none", card: "low" } }), spec_version: "2.0" }), record]);
  assert.equal(out[2]?.tenant_id, undefined);
});

test("logSink writes one record per line, in order, and takes a stream as well as a function", () => {
  const chunks: string[] = [];
  const sink: Sink = logSink({ write: (chunk: string) => chunks.push(chunk) });
  const all = lines("sync-bridge");
  sink.write(all);
  assert.equal(chunks.length, all.length);
  assert.ok(chunks.every((c) => c.endsWith("\n")));
  assert.equal((JSON.parse(chunks[1] as string) as FlatRecord).mocon, all[1]);
  assert.throws(() => logSink({} as never), TypeError);
});

test("a non-string handed to the sink is skipped rather than serialized", () => {
  const out: FlatRecord[] = [];
  const hostile = {
    toJSON() {
      throw new Error("never read");
    },
  };
  logSink((r) => out.push(r)).write([hostile as unknown as string, '{"kind":"execution","host":"h","id":"i","start":"2026-09-18T08:00:00.000Z"}']);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.exec_id, "i");
});

test("end to end from the emitter: what a host writes is what a panel reads", () => {
  const out: FlatRecord[] = [];
  const m = mocon({
    host: "example/e2e",
    capabilities: {
      observes_crossings: "all",
      unmediated_egress: false,
      crossing_edge: "invocation",
      attested: ["crossing.target", "crossing.input", "ext.declared"],
      dimensions: { "e2e.tenant_id": { agg: "none", card: "low", observed: true }, "e2e.credits_used": { agg: "sum", unit: "{credit}", observed: true } },
    },
    sinks: [logSink((r) => out.push(r))],
  });
  m.execution.run({ program: "return search('x')", language: "javascript", ext: { "e2e.tenant_id": "t-88" } }, (ex) => {
    const call = ex.instrument((target: string, args: unknown) => ({ target, args }));
    call("records_search", { limit: 2 });
  });
  const declared = only(out, (r) => r.kind === "host");
  assert.equal(declared.mocon_host, "example/e2e");
  const crossing = only(out, (r) => r.kind === "crossing");
  assert.equal(crossing.target, "records_search");
  assert.equal(crossing.ok, true);
  assert.equal(typeof crossing.duration_ms, "number");
  const execution = only(out, (r) => r.kind === "execution" && r.disposition !== undefined);
  assert.equal(execution.tenant_id, "t-88");
  assert.equal(execution.ok, true);
  assert.equal(execution.exec_id, crossing.exec_id);
});
