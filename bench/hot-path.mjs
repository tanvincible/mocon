/**
 * Hot path of @mocon/core: nanoseconds per crossing start plus end, and
 * per execution start plus end, into a sink that discards every line.
 * One row writes to a temporary file through `fileSink`, to show what a
 * synchronous append adds.
 *
 * Run `npm run bench` at the repository root (it builds first). The script
 * prints a Markdown table and exits non-zero when any row is slower than
 * the baseline this file records for it.
 *
 * Every row is gated, and the gate is a ratio rather than one absolute
 * figure shared by rows whose costs differ by 8x. A shared absolute target
 * lets a row that is three times slower than it should be still pass
 * because it was cheap to begin with, and it leaves the most expensive row
 * with whatever headroom is left over — 1.7% of the target, in the figures
 * this file replaces, which made the run fail on a busy machine and pass
 * on a quiet one without anything changing.
 *
 * A ratio to a figure measured on one machine is not portable either, so
 * the baselines are scaled by `calibrate`: a fixed parse-and-write
 * workload, timed in the same run, whose own baseline is recorded next to
 * theirs. A machine half the speed of the recording machine measures
 * calibration twice as slow and every row's bar moves with it, so the gate
 * asks whether this code got slower and not whether this machine is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileSink, mocon } from "../packages/core/dist/index.js";

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Measured on Node v24.16.0, darwin arm64, Apple M5, otherwise idle.
 * `calibration` is the reading `calibrate` produced in that run and is
 * what makes the rest portable: every row is compared against its figure
 * here times this run's calibration over that one.
 */
const BASELINE = {
  machine: "Node v24.16.0, darwin arm64, Apple M5",
  calibration: 2_647,
  // The lowest median of three runs on that machine, which is the reading the scheduler interfered with least.
  // Re-recorded on 2026-09-19 with the capture preview (core README, Capture and redaction): a value over the
  // preview is no longer written to the line, which is why the three large-string rows fell by about fifty
  // times and the two 1 KiB rows rose by about a quarter for the cut the preview adds.
  rows: {
    "crossing start + end, 24 B input, 100 B output": 3_961,
    "crossing start + end, 24 B input, 1 KiB output": 7_191,
    "crossing start + end, 1 KiB input, 1 KiB output": 10_078,
    "crossing start + end, 24 B input, 1 KiB output of 23 records": 11_066,
    "crossing start + end, 24 B input, 128 KiB string output": 3_698,
    "crossing start + end, 24 B input, 1 MiB string output": 3_616,
    "crossing start + end, 24 B input, 3 MiB string output": 3_692,
    "crossing start + end, 24 B input, 5 MB string output": 1_946,
    "crossing start + end, 24 B input, 5 MB object output": 2_754,
    "crossing start + end, 24 B input, 10,000-key object output": 1_425_480,
    "execution start + end, 204 B program, notice on": 3_931,
    "crossing start + end, 24 B input, 1 KiB output, fileSink": 14_341,
  },
};

/** A row may cost this much of its scaled baseline before the run fails. */
const TOLERANCE = 2;

const capabilities = {
  observes_crossings: "all",
  unmediated_egress: false,
  crossing_edge: "invocation",
  attested: ["crossing.target", "crossing.input"],
};

const nullSink = { write() {} };
const m = mocon({ host: "bench/host", capabilities, sinks: [nullSink] });

/** An object whose JSON text is about `bytes` long: three keys, one of them a run of that length. It takes the encoder's string path, not its object walker. */
function sizedObject(bytes) {
  const envelope = JSON.stringify({ id: 8842, name: "Acme Robotics", text: "" }).length;
  return { id: 8842, name: "Acme Robotics", text: "x".repeat(Math.max(0, bytes - envelope)) };
}

/** An object with `keys` own keys, which is what makes the object walker, rather than the string path, the thing being measured. */
function wideObject(keys) {
  const out = {};
  for (let i = 0; i < keys; i++) out["field_" + i] = i;
  return out;
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

/**
 * This machine's speed at the kind of work the emitter does, in
 * nanoseconds per operation, with no mocon in it: a fixed object written
 * and read back. It scales every baseline below, so the gate compares this
 * code against itself rather than this machine against the one the
 * baselines were recorded on.
 */
function calibrate() {
  const fixture = sizedObject(KiB);
  return measure(() => JSON.parse(JSON.stringify(fixture)), 20_000).median;
}

/**
 * Per-operation time in nanoseconds over `rounds` rounds: the median round
 * and the slowest. The median is the figure to quote and the one gated;
 * the slowest is the part a median hides, and a row whose slowest round
 * runs away from its median is a row with a tail whatever its median says.
 *
 * The slowest round is printed and not gated, because on a machine running
 * anything else it is the scheduler's reading rather than this code's: the
 * same row measured 6,508 ns and 23,000 ns as its slowest round in two
 * runs minutes apart with an unchanged median, so a gate on it fails a
 * third of the runs and says nothing when it does.
 */
function measure(fn, iterations, rounds = 15) {
  for (let i = 0; i < iterations; i++) fn();
  const samples = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn();
    samples.push(Number(process.hrtime.bigint() - t0) / iterations);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], slowest: samples[samples.length - 1] };
}

const dir = mkdtempSync(join(tmpdir(), "mocon-bench-"));
const file = fileSink(join(dir, "mocon.jsonl"));
const onFile = mocon({ host: "bench/host", capabilities, sinks: [file] });

const cases = [
  ["crossing start + end, 24 B input, 100 B output", crossingCase(m, smallInput, sizedObject(100)), 20_000],
  ["crossing start + end, 24 B input, 1 KiB output", crossingCase(m, smallInput, sizedObject(KiB)), 20_000],
  ["crossing start + end, 1 KiB input, 1 KiB output", crossingCase(m, sizedObject(KiB), sizedObject(KiB)), 20_000],
  ["crossing start + end, 24 B input, 1 KiB output of 23 records", crossingCase(m, smallInput, records(KiB)), 20_000],
  // The band between the cap and the point where a string is too far past it to read: the 5 MB rows below sit
  // beyond it and are cheap for that reason, so without these three the table shows the two ends and no middle.
  ["crossing start + end, 24 B input, 128 KiB string output", crossingCase(m, smallInput, "x".repeat(128 * KiB)), 2_000],
  ["crossing start + end, 24 B input, 1 MiB string output", crossingCase(m, smallInput, "x".repeat(MiB)), 500],
  ["crossing start + end, 24 B input, 3 MiB string output", crossingCase(m, smallInput, "x".repeat(3 * MiB)), 200],
  ["crossing start + end, 24 B input, 5 MB string output", crossingCase(m, smallInput, "x".repeat(5 * MiB)), 200],
  // Three keys around a 5 MB run, so it takes the string path like the row above it.
  ["crossing start + end, 24 B input, 5 MB object output", crossingCase(m, smallInput, sizedObject(5 * MiB)), 200],
  // A genuinely wide object: the walker reads members until the cap is spent, so this is where a program
  // that spends the budget on structure rather than on text shows up.
  ["crossing start + end, 24 B input, 10,000-key object output", crossingCase(m, smallInput, wideObject(10_000)), 500],
  ["execution start + end, 204 B program, notice on", executionCase(), 20_000],
  ["crossing start + end, 24 B input, 1 KiB output, fileSink", crossingCase(onFile, smallInput, sizedObject(KiB)), 5_000],
];

const calibration = calibrate();
const rows = cases.map(([name, fn, n]) => [name, measure(fn, n)]);
await onFile.close();
rmSync(dir, { recursive: true, force: true });

const scale = BASELINE.calibration > 0 ? calibration / BASELINE.calibration : undefined;
const ns = (v) => Math.round(v).toLocaleString("en-US");
const cpu = cpus()[0]?.model ?? "unknown CPU";
console.log(`Node ${process.version}, ${process.platform} ${process.arch}, ${cpu}. Null sink unless noted. Median of 15 rounds.\n`);
console.log("| case | ns per operation | slowest round | baseline |");
console.log("|---|---|---|---|");
for (const [name, r] of rows) {
  const base = BASELINE.rows[name];
  const against = base === undefined || scale === undefined ? "not recorded" : `${(r.median / (base * scale)).toFixed(2)}x`;
  console.log(`| ${name} | ${ns(r.median)} | ${ns(r.slowest)} | ${against} |`);
}
console.log(
  `\nCalibration (JSON round trip of a 1 KiB object, no mocon): ${ns(calibration)} ns, ` +
    (scale === undefined ? "no baseline recorded, so nothing is gated." : `${scale.toFixed(2)}x the baseline machine (${BASELINE.machine}).`),
);
console.log("A row is gated at " + TOLERANCE + "x its scaled baseline. The slowest round is shown, not gated: on a shared machine it reads the scheduler.");

if (scale === undefined) {
  console.error("\nno baseline recorded: fill in BASELINE in bench/hot-path.mjs from a run on an idle machine");
  process.exit(1);
}
const over = [];
for (const [name, r] of rows) {
  const base = BASELINE.rows[name];
  if (base === undefined) {
    over.push(`no baseline for ${name}; add one to bench/hot-path.mjs`);
    continue;
  }
  const bar = base * scale;
  if (r.median > bar * TOLERANCE) over.push(`${ns(r.median)} ns for ${name}, ${(r.median / bar).toFixed(2)}x its scaled baseline of ${ns(bar)} ns`);
}
if (over.length > 0) {
  for (const line of over) console.error(`\nover baseline: ${line}`);
  process.exit(1);
}
