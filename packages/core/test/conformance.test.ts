/**
 * Emitter conformance: six scenarios shaped after the golden streams,
 * every emitted line validated against spec/schema/line.json and the
 * structural rules, then folded into the canonical view; the nine
 * invalid fixtures rejected by the same checks; and the reference
 * checker, spec/conformance/check.py, run on an emitted stream.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fold } from "../src/fold.js";
import { memorySink, mocon, type Payload } from "../src/index.js";
import { assertValidStream, harness, lineErrors, readInvalid, readStream, specDir, SYNC_BRIDGE, sleep, type Rec } from "./helpers.js";

const sha = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");

test("sync bridge: notice, two overlapping crossings, one truncated output, complete with result", async () => {
  const h = harness({ capture: { caps: { "crossing.output": 80 } } });
  const people = Array.from({ length: 200 }, (_, i) => ({ name: `Person ${i}`, title: i === 0 ? "CEO" : "Engineer" }));
  const rawCallTool = async (name: string, _args: unknown): Promise<unknown> => {
    await sleep(2);
    return name === "company_identify" ? { name: "Acme Robotics", id: 8842 } : people;
  };
  const program =
    "const [co, people] = await Promise.all([callTool('company_identify',{query:'acme.example'}), callTool('person_search',{domain:'acme.example',limit:200})]); return {company: co.name, count: people.length};";

  const result = await h.m.execution.run(
    { program, language: "javascript", context: { session: "mcp-9a1f0c" } },
    async (ex) => {
      const callTool = ex.instrument(rawCallTool);
      const [co, ps] = (await Promise.all([
        callTool("company_identify", { query: "acme.example" }),
        callTool("person_search", { domain: "acme.example", limit: 200 }),
      ])) as [{ name: string }, unknown[]];
      ex.complete({ result: { company: co.name, count: ps.length }, ext: { "example.credits_used": 18 } });
      return { company: co.name, count: ps.length };
    },
  );
  assert.deepEqual(result, { company: "Acme Robotics", count: 200 });

  assertValidStream(h.sink.lines);
  const recs = h.records();
  assert.deepEqual(
    recs.map((r) => [r["kind"], "end" in r]),
    [
      ["host", false],
      ["execution", false],
      ["crossing", true],
      ["crossing", true],
      ["execution", true],
    ],
  );

  const view = fold(h.sink.lines);
  assert.deepEqual(view.unresolved, []);
  assert.deepEqual(view.conflicts, []);
  assert.equal(view.skipped, 0);
  assert.equal(Object.keys(view.executions).length, 1);
  assert.equal(Object.keys(view.crossings).length, 2);

  const ex = Object.values(view.executions)[0] as unknown as Rec;
  assert.equal((ex["end"] as Rec)["disposition"], "completed");
  assert.deepEqual(((ex["end"] as Rec)["result"] as Rec)["value"], { company: "Acme Robotics", count: 200 });
  assert.deepEqual(ex["ext"], { "example.credits_used": 18 });
  assert.deepEqual(ex["context"], { session: "mcp-9a1f0c" });
  assert.deepEqual(ex["program"], { value: program, bytes: 204, hash: sha(program) });

  const crossings = Object.values(view.crossings)
    .map((c) => c as unknown as Rec)
    .sort((a, b) => (a["seq"] as number) - (b["seq"] as number));
  const [c1, c2] = crossings as [Rec, Rec];
  assert.equal(c1["target"], "company_identify");
  assert.equal(c1["execution_id"], ex["id"]);
  assert.equal(c2["target"], "person_search");
  assert.equal(c1["seq"], 1);
  assert.equal(c2["seq"], 2);
  assert.equal(c1["execution_id"], ex["id"]);
  assert.ok((c2["start"] as string) <= ((c1["end"] as Rec)["time"] as string), "the second crossing started before the first ended");
  const out1 = (c1["end"] as Rec)["output"] as Rec;
  assert.deepEqual(out1, { value: { name: "Acme Robotics", id: 8842 }, bytes: 34, hash: sha('{"name":"Acme Robotics","id":8842}') });
  const out2 = (c2["end"] as Rec)["output"] as Rec;
  assert.equal(out2["truncated"], true);
  assert.equal(typeof out2["value"], "string");
  assert.ok(JSON.stringify(people).startsWith(out2["value"] as string), "the truncated value is a prefix of the serialization");
  assert.ok(Buffer.byteLength(out2["value"] as string) <= 80);
  assert.equal("bytes" in out2, false, "the encoder stopped reading, so it does not claim bytes");
  assert.equal("hash" in out2, false);
});

test("batch at end: one complete failed execution with stdout and stderr, no crossings", () => {
  const h = harness({ host: "jx-codes/codemode-mcp", capabilities: { observes_crossings: "none", unmediated_egress: true, attested: [] } });
  const ex = h.m.execution.start({ program: "console.log(JSON.stringify(data));", language: "javascript", notice: false });
  ex.end({
    disposition: "failed",
    error: { class: "runtime", message: "export failed: 500" },
    outputs: { stdout: "", stderr: "Error: export failed: 500\n    at file:///tmp/deno-run-8f2c.ts:4:9" },
    ext: { "jxcodes.exit_code": 1 },
  });

  assertValidStream(h.sink.lines);
  assert.equal(h.sink.lines.length, 2);
  const view = fold(h.sink.lines);
  assert.deepEqual(view.hosts["jx-codes/codemode-mcp"], {
    kind: "host",
    host: "jx-codes/codemode-mcp",
    spec_version: "1.0",
    observes_crossings: "none",
    unmediated_egress: true,
    attested: [],
  });
  assert.deepEqual(Object.keys(view.crossings), []);
  assert.deepEqual(view.unresolved, []);
  const rec = Object.values(view.executions)[0] as unknown as Rec;
  const end = rec["end"] as Rec;
  assert.equal(end["disposition"], "failed");
  assert.deepEqual(end["error"], { class: "runtime", message: "export failed: 500" });
  const outputs = end["outputs"] as Rec;
  assert.deepEqual(outputs["stdout"], { value: "", bytes: 2, hash: "sha256:12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126" });
  assert.equal((outputs["stderr"] as Rec)["bytes"], 68);
  assert.deepEqual(rec["ext"], { "jxcodes.exit_code": 1 });
});

test("unmediated: notice and complete, zero crossings, completed with stdout", async () => {
  const h = harness({ host: "open-ptc-agent/daytona", capabilities: { observes_crossings: "none", unmediated_egress: true } });
  const program = "from tools.crm import export_all\nresult = export_all()\nprint(result)";
  await h.m.execution.run({ program, language: "python" }, async (ex) => {
    await sleep(1);
    ex.complete({ outputs: { stdout: "{'exported': 1204, 'file': '/tmp/export-1204.csv'}\n" } });
  });

  assertValidStream(h.sink.lines);
  assert.deepEqual(
    h.records().map((r) => [r["kind"], "end" in r]),
    [
      ["host", false],
      ["execution", false],
      ["execution", true],
    ],
  );
  const view = fold(h.sink.lines);
  const rec = Object.values(view.executions)[0] as unknown as Rec;
  const end = rec["end"] as Rec;
  assert.equal(end["disposition"], "completed");
  assert.equal("result" in end, false, "the body's own complete() won, and it carried no result");
  assert.equal(((end["outputs"] as Rec)["stdout"] as Rec)["bytes"], 54);
  assert.deepEqual(Object.keys(view.crossings), []);
  assert.deepEqual(view.unresolved, []);
});

test("abandoned at end: an open crossing is written abandoned before the terminated execution", async () => {
  const h = harness({
    host: "cloudflare/codemode",
    capabilities: { ...SYNC_BRIDGE, attested: ["crossing.target", "crossing.input", "crossing.output"] },
  });
  const ex = h.m.execution.start({ program: "await connectors.crm.deleteRecord({id: 'rec_50'});", language: "javascript" });
  const c1 = ex.crossing.start({ target: "connectors.crm.deleteRecord", input: { id: "rec_50" } });
  c1.output({ deleted: true });
  const c2 = ex.crossing.start({ target: "connectors.finance.wireTransfer", input: { to: "acct_9", amountCents: 500000 } });
  ex.end({ disposition: "terminated", error: { class: "timeout", message: "execution TTL (300s) elapsed while wireTransfer awaited approval" } });
  const before = h.sink.lines.length;
  c2.output({ approved: true });
  assert.equal(h.sink.lines.length, before + 1, "a settlement after abandon is recorded as a late_settlement event");

  assertValidStream(h.sink.lines);
  const recs = h.records();
  assert.deepEqual(
    recs.map((r) => [r["kind"], r["id"] === c2.id ? "c2" : r["id"] === c1.id ? "c1" : "", (r["end"] as Rec | undefined)?.["outcome"] ?? (r["end"] as Rec | undefined)?.["disposition"] ?? ""]),
    [
      ["host", "", ""],
      ["execution", "", ""],
      ["crossing", "c1", "output"],
      ["crossing", "c2", "abandoned"],
      ["execution", "", "terminated"],
      ["event", "", ""],
    ],
  );
  const abandoned = recs[3] as Rec;
  assert.deepEqual(abandoned["end"], { outcome: "abandoned" });
  assert.equal(abandoned["seq"], 2);
  assert.equal(typeof abandoned["start"], "string");
  assert.deepEqual((abandoned["input"] as Rec)["value"], { to: "acct_9", amountCents: 500000 });

  const view = fold(h.sink.lines);
  assert.deepEqual(view.unresolved, []);
  assert.deepEqual(view.conflicts, []);
  const exec = Object.values(view.executions)[0] as unknown as Rec;
  assert.deepEqual((exec["end"] as Rec)["error"], { class: "timeout", message: "execution TTL (300s) elapsed while wireTransfer awaited approval" });
  assert.equal(((view.crossings["cloudflare/codemode\0" + c2.id] as unknown as Rec)["end"] as Rec)["outcome"], "abandoned");
});

test("pre-run rejection: failed with class validation, the same error rethrown by run", () => {
  const h = harness();
  const program = "const x = await callTool('unknown_tool_name', {});\nreturn x;";
  const rejection = new Error("unknown tool name: unknown_tool_name");
  assert.throws(
    () =>
      h.m.execution.run({ program, language: "javascript" }, (ex) => {
        ex.fail(rejection, { class: "validation" });
        throw rejection;
      }),
    (e: unknown) => e === rejection,
  );

  assertValidStream(h.sink.lines);
  assert.equal(h.sink.lines.length, 3, "host, notice, complete; run's own fail() after the body's was ignored");
  const view = fold(h.sink.lines);
  const rec = Object.values(view.executions)[0] as unknown as Rec;
  const end = rec["end"] as Rec;
  assert.equal(end["disposition"], "failed");
  assert.equal((end["error"] as Rec)["class"], "validation");
  assert.equal((end["error"] as Rec)["message"], "unknown tool name: unknown_tool_name");
  assert.ok((end["time"] as string) >= (rec["start"] as string));
  assert.deepEqual(Object.keys(view.crossings), []);
});

test("hash-only program: redacted with bytes and hash on the notice and the complete record", async () => {
  const h = harness({ host: "codeforge-mcp/sandbox", capture: { rules: { program: "hash-only" } } });
  const program = "x".repeat(100) + "é".repeat(30);
  await h.m.execution.run({ program, language: "typescript" }, async () => ({ charged: true }));

  assertValidStream(h.sink.lines);
  const expected = { redacted: true, bytes: Buffer.byteLength(program), hash: sha(program) };
  const [notice, complete] = h.ofKind("execution") as [Rec, Rec];
  assert.deepEqual(notice["program"], expected);
  assert.deepEqual(complete["program"], expected);
  const view = fold(h.sink.lines);
  const rec = Object.values(view.executions)[0] as unknown as Rec;
  assert.deepEqual((rec["end"] as Rec)["result"], {
    value: { charged: true },
    bytes: 16,
    hash: "sha256:26166c0858b431c1d29b16e7f2030bddf21745f57678bbd6f814fa985bafb899",
  });
  assert.deepEqual(view.unresolved, []);
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

test("every invalid fixture fails the checks emitted streams are held to, and every golden line passes them", () => {
  const invalid = readInvalid();
  assert.equal(invalid.length, 9);
  for (const { name, line, reason } of invalid) {
    assert.ok(lineErrors(JSON.parse(line)).length > 0, `${name} must fail: ${reason}`);
  }
  for (const name of ["sync-bridge", "crossing-error", "base64-input-null-value", "unknown-field"]) {
    const lines = readStream(name).split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) assert.deepEqual(lineErrors(JSON.parse(line)), [], `${name}: ${line.slice(0, 60)}`);
  }
});

test("the emitter writes no invalid fixture: each rule the API can express is enforced before anything is written", () => {
  const fixtures = Object.fromEntries(readInvalid().map(({ name, line }) => [name, JSON.parse(line) as Rec]));
  const h = harness();
  const ex = h.m.execution.start({ program: "p", notice: false });
  const refused: Record<string, () => unknown> = {
    "missing-host": () => mocon({ host: fixtures["missing-host"]?.["host"] as string, capabilities: SYNC_BRIDGE, sinks: [memorySink()] }),
    "observes-crossings-unknown-value": () => mocon({ host: "h", capabilities: { observes_crossings: fixtures["observes-crossings-unknown-value"]?.["observes_crossings"] as "all" }, sinks: [memorySink()] }),
    "disposition-outside-closed-set": () => ex.end({ disposition: ((fixtures["disposition-outside-closed-set"]?.["end"] as Rec)["disposition"]) as "completed" }),
    "end-without-disposition": () => ex.end((fixtures["end-without-disposition"]?.["end"]) as never),
    "timestamp-without-z": () => h.m.execution.start({ program: "p", start: fixtures["timestamp-without-z"]?.["start"] as string }),
  };
  for (const [name, attempt] of Object.entries(refused)) {
    assert.ok(name in fixtures, name);
    assert.throws(attempt, (e: unknown) => e instanceof TypeError || e instanceof RangeError, name);
  }
  // The only Payload the host writes by hand is the one a capture rule returns, and a rule that breaks the Payload rule writes `{"redacted":true}` rather than the fixture's shape.
  const replaced = ["payload-no-value-no-flag", "hash-wrong-length"];
  for (const name of replaced) {
    assert.ok(name in fixtures, name);
    const ruled = harness({ capture: { rules: { "crossing.input": () => (fixtures[name]?.["input"] as Payload) } } });
    const run = ruled.m.execution.start({ program: "p", notice: false });
    run.crossing.start({ target: "t", input: 1, notice: true });
    run.complete();
    assert.deepEqual(ruled.last("crossing")["input"], { redacted: true }, name);
    assertValidStream(ruled.sink.lines);
  }
  // The other two cannot be expressed: a crossing is opened from its execution's handle, and an outcome carries only its own payload.
  assert.deepEqual(Object.keys(fixtures).filter((n) => !(n in refused) && !replaced.includes(n)).sort(), ["crossing-without-execution-id", "outcome-output-with-error-field"]);
  ex.complete();
  assert.equal(h.sink.lines.length, 2, "the host line and the one valid complete record");
  assertValidStream(h.sink.lines);
  const view = fold(Object.values(fixtures).map((r) => JSON.stringify(r)));
  assert.equal(view.flagged, 3, "fold reads an unknown or missing disposition, and an unknown observes_crossings, as absent (core.md 8)");
  assert.deepEqual(view.unresolved.map((r) => r.id).sort(), [fixtures["disposition-outside-closed-set"]?.["id"], fixtures["end-without-disposition"]?.["id"], fixtures["timestamp-without-z"]?.["id"]].sort());
});

test("the reference checker validates an emitted stream and builds the same view fold builds", { skip: spawnSync("python3", ["--version"]).status !== 0 && "python3 is not installed" }, () => {
  const h = harness({ capture: { caps: { "crossing.output": 80 } } });
  const ex = h.m.execution.start({ program: "return await callTool('t', {q: 1});", language: "javascript", context: { session: "s" } });
  const call = ex.instrument((_name: string, args: unknown) => ({ echoed: args, list: Array.from({ length: 50 }, (_, i) => i) }));
  call("t", { q: 1 });
  ex.crossing.start({ target: "u", input: new Uint8Array([1, 2, 3]), notice: true });
  ex.crossing.start({ target: "v", input: 1 }).error(new Error("boom"));
  ex.complete({ result: "done", outputs: { stdout: "x\n" }, ext: { "example.k": null } });
  assertValidStream(h.sink.lines);
  const dir = mkdtempSync(join(tmpdir(), "mocon-conformance-"));
  const stream = join(dir, "emitted.jsonl");
  writeFileSync(stream, h.sink.lines.join("\n") + "\n");
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(specDir + "conformance")})
import check
lines = open(${JSON.stringify(stream)}).read().split("\\n")
schemas, registry = check.load_schemas() if check.HAVE_JSONSCHEMA else (None, None)
errors = []
for line in lines:
    if not line.strip():
        continue
    errors += check.all_errors(json.loads(line), schemas, registry)
print(json.dumps({"errors": errors, "view": check.view_for(lines), "jsonschema": check.HAVE_JSONSCHEMA}))
`;
  try {
    const r = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const { errors, view } = JSON.parse(r.stdout) as { errors: string[]; view: Rec; jsonschema: boolean };
    assert.deepEqual(errors, []);
    const ours = fold(h.sink.lines);
    const strip = (map: Record<string, unknown>): Rec => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.slice(k.indexOf("\0") + 1), v]));
    assert.deepEqual({ hosts: { ...ours.hosts }, executions: strip(ours.executions), crossings: strip(ours.crossings), unresolved: ours.unresolved, conflicts: ours.conflicts, skipped: ours.skipped }, view);
    assert.deepEqual(view["unresolved"], []);
    assert.deepEqual(view["conflicts"], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
