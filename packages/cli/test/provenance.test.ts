import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrossingLine, ExecutionLine, HostLine } from "@mocon/core";
import { exportStream } from "../src/otlp.js";
import { attestedOf, crossingProvenance, executionProvenance } from "../src/provenance.js";
import { streams } from "./helpers.js";

const ALL = new Set(["crossing.target", "crossing.input", "crossing.output", "crossing.error", "execution.error.class"]);
const NONE = new Set<string>();
const T = "2026-09-16T10:00:00Z";

const execution = (over: Record<string, unknown>): ExecutionLine => ({ kind: "execution", host: "h", id: "e1", program: { value: "p" }, start: T, ...over }) as ExecutionLine;
const crossing = (over: Record<string, unknown>): CrossingLine => ({ kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "t", input: { value: 1 }, ...over }) as CrossingLine;

test("attestedOf reads a missing declaration or list as [] and keeps only string entries", () => {
  assert.deepEqual([...attestedOf(undefined)], []);
  assert.deepEqual([...attestedOf({ kind: "host", host: "h" })], []);
  assert.deepEqual([...attestedOf({ kind: "host", host: "h", attested: "crossing.target" } as unknown as HostLine)], []);
  assert.deepEqual([...attestedOf({ kind: "host", host: "h", attested: ["crossing.target", 3, "made.up"] } as unknown as HostLine)], ["crossing.target", "made.up"]);
});

test("provenance.md 3, execution: program, language, result, outputs, error and ext are P at baseline", () => {
  const r = execution({
    language: "python",
    ext: { "x.y": 1 },
    end: { time: T, disposition: "failed", result: { value: 1 }, outputs: { stdout: { value: "o" }, files: { redacted: true } }, error: { class: "runtime", message: "m", value: { value: {} } } },
  });
  assert.deepEqual(executionProvenance(r, NONE), {
    "program.value": "P",
    language: "P",
    "end.result.value": "P",
    "end.outputs.stdout.value": "P",
    "end.error.class": "P",
    "end.error.message": "P",
    "end.error.value": "P",
    ext: "P",
  });
});

test("provenance.md 4, execution: only execution.error.class upgrades anything, and it upgrades the class to H", () => {
  const r = execution({ end: { time: T, disposition: "failed", error: { class: "runtime", message: "m" } } });
  assert.deepEqual(executionProvenance(r, ALL), { "program.value": "P", "end.error.message": "P" });
});

test("a withheld value carries no marker: the envelope is host-observed and there is nothing else to label", () => {
  const r = execution({ program: { redacted: true, bytes: 4, hash: "sha256:" + "0".repeat(64) }, end: { time: T, disposition: "completed", result: { truncated: true } } });
  assert.deepEqual(executionProvenance(r, NONE), {});
  assert.deepEqual(crossingProvenance(crossing({ input: { redacted: true } }), NONE), { target: "P" });
  assert.deepEqual(executionProvenance(execution({ program: { value: null } }), NONE), { "program.value": "P" }, "a present null is a value");
});

test("provenance.md 3 and 4, crossing: seq and outcome follow the target; input upgrades to H, output and error to T", () => {
  const out = crossing({ seq: 1, ext: { a: 1 }, end: { outcome: "output", output: { value: 2 } } });
  assert.deepEqual(crossingProvenance(out, NONE), { target: "P", seq: "P", "end.outcome": "P", "input.value": "P", "end.output.value": "P", ext: "P" });
  assert.deepEqual(crossingProvenance(out, ALL), { "end.output.value": "T", ext: "P" });

  const err = crossing({ end: { outcome: "error", error: { class: "denied", message: "no", value: { value: {} } } } });
  assert.deepEqual(crossingProvenance(err, new Set(["crossing.target", "crossing.input"])), { "end.error.class": "P", "end.error.message": "P", "end.error.value": "P" });
  assert.deepEqual(crossingProvenance(err, ALL), { "end.error.class": "T", "end.error.message": "T", "end.error.value": "T" });

  const notice = crossing({ seq: 3 });
  assert.deepEqual(crossingProvenance(notice, NONE), { target: "P", seq: "P", "input.value": "P" }, "a notice has no outcome to label");
  assert.deepEqual(crossingProvenance(crossing({ end: { outcome: "abandoned" } }), NONE), { target: "P", "end.outcome": "P", "input.value": "P" });
});

test("fields that do not belong to the outcome are not labeled, and shapes a malformed line can carry do not throw", () => {
  const mismatched = crossing({ end: { outcome: "abandoned", output: { value: 1 }, error: { class: "x" } } });
  assert.deepEqual(crossingProvenance(mismatched, ALL), {});
  const odd = execution({ program: "text", end: { time: T, disposition: "completed", result: null, outputs: "stdout", error: ["x"] } });
  assert.deepEqual(executionProvenance(odd, NONE), {});
  assert.deepEqual(crossingProvenance(crossing({ input: null, end: { outcome: "error", error: "boom" } }), NONE), { target: "P", "end.outcome": "P" });
});

/** The CLI's wire path for one `mocon.provenance.*` attribute name (otel-mapping.md 10). */
function wirePath(kind: "execution" | "crossing", label: string): string {
  if (label === "ext.p") return "ext";
  if (label === "program.value") return label;
  const rest = label.slice(kind.length + 1);
  if (kind === "crossing" && rest === "outcome") return "end.outcome";
  if (rest === "target" || rest === "seq" || rest === "input.value" || rest === "language") return rest;
  return "end." + rest.replace(/^error\.value\.value$/, "error.value");
}

test("the CLI and @mocon/otel apply one table: every complete record of every golden stream gets the same labels from both", async () => {
  let compared = 0;
  for (const s of streams) {
    const lines = s.text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const declaration = lines.find((l) => l["kind"] === "host") as HostLine | undefined;
    const attested = new Set(attestedOf(declaration));
    for (const line of lines) {
      if ((line["kind"] !== "execution" && line["kind"] !== "crossing") || line["end"] === undefined) continue;
      const kind = line["kind"];
      const cli = kind === "execution" ? executionProvenance(line as unknown as ExecutionLine, attested) : crossingProvenance(line as unknown as CrossingLine, attested);
      const one = declaration === undefined ? JSON.stringify(line) : JSON.stringify(declaration) + "\n" + JSON.stringify(line);
      const span = (await exportStream(one)).request.resourceSpans[0]?.scopeSpans[0]?.spans[0];
      assert.ok(span !== undefined, `${s.name}: ${kind} ${String(line["id"])} maps to a span`);
      const otel: Record<string, string> = {};
      for (const a of span.attributes) {
        if (!a.key.startsWith("mocon.provenance.")) continue;
        const label = a.key.slice("mocon.provenance.".length);
        otel[wirePath(kind, label)] = label === "ext.p" ? "P" : "stringValue" in a.value ? a.value.stringValue : JSON.stringify(a.value);
      }
      assert.deepEqual(otel, cli, `${s.name}: ${kind} ${String(line["id"])}`);
      compared++;
    }
  }
  assert.ok(compared > 40, `compared ${compared} records`);
});
