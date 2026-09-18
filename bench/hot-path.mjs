/**
 * Hot path of @mocon/core: nanoseconds per crossing start plus end, and
 * per execution start plus end, into a sink that discards every line.
 * One row writes to a temporary file through `fileSink`, to show what a
 * synchronous append adds.
 *
 * Run `npm run bench` at the repository root (it builds first). The
 * script prints a Markdown table and exits non-zero when a gated row, a
 * crossing with 1 KiB out, with 1 KiB in and out, or with 1 KiB out made
 * of small records, costs more than the 10 microsecond target.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileSink, mocon } from "../packages/core/dist/index.js";

const TARGET_NS = 10_000;
const KiB = 1024;
const MiB = 1024 * KiB;

const capabilities = {
  observes_crossings: "all",
  unmediated_egress: false,
  crossing_edge: "invocation",
  attested: ["crossing.target", "crossing.input"],
};

const nullSink = { write() {} };
const m = mocon({ host: "bench/host", capabilities, sinks: [nullSink] });

/** An object whose JSON text is about `bytes` long: a fixed envelope around a string. */
function sizedObject(bytes) {
  const envelope = JSON.stringify({ id: 8842, name: "Acme Robotics", text: "" }).length;
  return { id: 8842, name: "Acme Robotics", text: "x".repeat(Math.max(0, bytes - envelope)) };
}

/** About `bytes` of JSON made of small records, the shape of the `person_search` rows in core.md Appendix A. */
function records(bytes) {
  const rows = [];
  while (JSON.stringify(rows).length < bytes) rows.push({ id: rows.length, name: "Jordan Ellis", title: "CEO" });
  return rows;
}

/** The 24-byte input from core.md Appendix A. */
const smallInput = { query: "acme.example" };

function crossingCase(instance, input, output) {
  const ex = instance.execution.start({ program: "bench", notice: false });
  const callTool = ex.instrument((_name, _args) => output);
  return () => callTool("company_identify", input);
}

const program =
  "const [co, people] = await Promise.all([callTool('company_identify',{query:'acme.example'}), callTool('person_search',{domain:'acme.example',limit:200})]); return {company: co.name, count: people.length};";

function executionCase() {
  const result = { company: "Acme Robotics", count: 200 };
  return () => {
    const ex = m.execution.start({ program, language: "javascript", context: { session: "mcp-9a1f0c" } });
    ex.complete({ result });
  };
}

/** Median over rounds of the per-operation time in nanoseconds. */
function measure(fn, iterations, rounds = 15) {
  for (let i = 0; i < iterations; i++) fn();
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn();
    samples.push(Number(process.hrtime.bigint() - t0) / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const dir = mkdtempSync(join(tmpdir(), "mocon-bench-"));
const file = fileSink(join(dir, "mocon.jsonl"));
const onFile = mocon({ host: "bench/host", capabilities, sinks: [file] });

const cases = [
  ["crossing start + end, 24 B input, 100 B output", crossingCase(m, smallInput, sizedObject(100)), 20_000, false],
  ["crossing start + end, 24 B input, 1 KiB output", crossingCase(m, smallInput, sizedObject(KiB)), 20_000, true],
  ["crossing start + end, 1 KiB input, 1 KiB output", crossingCase(m, sizedObject(KiB), sizedObject(KiB)), 20_000, true],
  ["crossing start + end, 24 B input, 1 KiB output of 23 records", crossingCase(m, smallInput, records(KiB)), 20_000, true],
  ["crossing start + end, 24 B input, 5 MB string output", crossingCase(m, smallInput, "x".repeat(5 * MiB)), 200, false],
  ["crossing start + end, 24 B input, 5 MB object output", crossingCase(m, smallInput, sizedObject(5 * MiB)), 200, false],
  ["execution start + end, 204 B program, notice on", executionCase(), 20_000, false],
  ["crossing start + end, 24 B input, 1 KiB output, fileSink", crossingCase(onFile, smallInput, sizedObject(KiB)), 5_000, false],
];

const rows = cases.map(([name, fn, n, gated]) => [name, measure(fn, n), gated]);
await onFile.close();
rmSync(dir, { recursive: true, force: true });

const cpu = cpus()[0]?.model ?? "unknown CPU";
console.log(`Node ${process.version}, ${process.platform} ${process.arch}, ${cpu}. Null sink unless noted. Median of 15 rounds.\n`);
console.log("| case | ns per operation |");
console.log("|---|---|");
for (const [name, ns] of rows) console.log(`| ${name} | ${Math.round(ns).toLocaleString("en-US")} |`);

const over = rows.filter(([, ns, gated]) => gated && ns > TARGET_NS);
if (over.length > 0) {
  for (const [name, ns] of over) console.error(`\nover target: ${Math.round(ns)} ns for ${name}, target ${TARGET_NS} ns`);
  process.exit(1);
}
