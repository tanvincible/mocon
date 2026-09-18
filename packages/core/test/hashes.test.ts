/**
 * Pins the serialization to the conformance fixtures: driving the public
 * API with the values the sync-bridge stream carries must reproduce its
 * exact `bytes` and `hash` for every payload whose original is known.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, readStream, type Rec } from "./helpers.js";

const fixture = readStream("sync-bridge")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Rec);
const execution = fixture.find((r) => r["kind"] === "execution" && "end" in r) as Rec;
const crossings = fixture.filter((r) => r["kind"] === "crossing") as Rec[];
const byTarget = (target: string): Rec => crossings.find((c) => c["target"] === target) as Rec;
const pin = (p: unknown): { bytes: unknown; hash: unknown } => ({ bytes: (p as Rec)["bytes"], hash: (p as Rec)["hash"] });

test("the library reproduces the sync-bridge fixture's bytes and hashes from the original values", () => {
  const h = harness({ host: "example/mcp" });
  const program = (execution["program"] as Rec)["value"] as string;
  const ex = h.m.execution.start({ program, language: "javascript", context: { session: "mcp-9a1f0c" } });
  // The fixture file stores every object with its keys sorted, because it
  // was dumped that way. The producer built this output as {name, id}, as
  // core.md Appendix A and the package README show, and hashed it in that
  // order. The other objects in the stream are already in sorted order.
  ex.crossing.start({ target: "company_identify", input: { query: "acme.example" } }).output({ name: "Acme Robotics", id: 8842 });
  ex.crossing.start({ target: "person_search", input: { domain: "acme.example", limit: 200 } }).output([]);
  ex.complete({ result: { company: "Acme Robotics", count: 120 } });

  const [notice, complete] = h.ofKind("execution") as [Rec, Rec];
  assert.deepEqual(pin(notice["program"]), pin(execution["program"]));
  assert.deepEqual(pin(complete["program"]), pin(execution["program"]));
  assert.deepEqual(pin((complete["end"] as Rec)["result"]), pin((execution["end"] as Rec)["result"]));

  const [c1, c2] = h.ofKind("crossing") as [Rec, Rec];
  assert.deepEqual(pin(c1["input"]), pin(byTarget("company_identify")["input"]));
  assert.deepEqual(pin((c1["end"] as Rec)["output"]), pin((byTarget("company_identify")["end"] as Rec)["output"]));
  assert.deepEqual(pin(c2["input"]), pin(byTarget("person_search")["input"]));
});

/**
 * The one payload in the stream whose stored key order is not the order
 * the producer hashed: the file was dumped with keys sorted, and this
 * output was built as {name, id} (core.md Appendix A, the package
 * README). Every other object in the stream is already in sorted order.
 */
const PRODUCER_ORDER: Record<string, unknown> = {
  "9f8290a2fef1db70:output": { name: "Acme Robotics", id: 8842 },
};

test("every fixture payload with a full value reproduces from its value through the public API", () => {
  let checked = 0;
  for (const rec of fixture) {
    const slots: Array<[unknown, "program" | "result" | "input" | "output"]> = [];
    if (rec["kind"] === "execution") {
      slots.push([rec["program"], "program"]);
      const result = (rec["end"] as Rec | undefined)?.["result"];
      if (result !== undefined) slots.push([result, "result"]);
    } else if (rec["kind"] === "crossing") {
      slots.push([rec["input"], "input"]);
      const output = (rec["end"] as Rec | undefined)?.["output"];
      if (output !== undefined) slots.push([output, "output"]);
    }
    for (const [payload, slot] of slots) {
      const p = payload as Rec;
      if (!("value" in p) || p["truncated"] === true) continue;
      const value = PRODUCER_ORDER[`${String(rec["id"])}:${slot}`] ?? p["value"];
      const h = harness({ host: String(rec["host"]) });
      let produced: Rec;
      if (slot === "program") {
        const ex = h.m.execution.start({ program: value as string, notice: false });
        ex.complete();
        produced = (h.ofKind("execution")[0] as Rec)["program"] as Rec;
      } else if (slot === "result") {
        const ex = h.m.execution.start({ program: "", notice: false });
        ex.complete({ result: value });
        produced = ((h.ofKind("execution")[0] as Rec)["end"] as Rec)["result"] as Rec;
      } else {
        const ex = h.m.execution.start({ program: "", notice: false });
        const c = ex.crossing.start({ target: "t", input: slot === "input" ? value : null });
        c.output(slot === "output" ? value : null);
        const line = h.ofKind("crossing")[0] as Rec;
        produced = slot === "input" ? (line["input"] as Rec) : ((line["end"] as Rec)["output"] as Rec);
      }
      assert.deepEqual(pin(produced), pin(p), `${String(rec["kind"])} ${String(rec["id"])} ${slot}`);
      checked++;
    }
  }
  assert.equal(checked, 6, "program (twice), two inputs, one full output, one result");
});

test("the README's own example lines carry the hashes the library computes", () => {
  const h = harness({ host: "example/mcp" });
  const program = "const co = await callTool('company_identify', {query: 'acme.example'});\nreturn co.name;";
  const ex = h.m.execution.start({ program, language: "javascript" });
  ex.crossing.start({ target: "company_identify", input: { query: "acme.example" } }).output({ name: "Acme Robotics", id: 8842 });
  ex.complete({ result: "Acme Robotics" });
  const [notice, complete] = h.ofKind("execution") as [Rec, Rec];
  assert.deepEqual(notice["program"], { value: program, bytes: 87, hash: "sha256:d64884aeee0ed3ce11e7018bb3280c3f3786b87bb310df90de4ed789bd40924a" });
  assert.deepEqual((complete["end"] as Rec)["result"], {
    value: "Acme Robotics",
    bytes: 15,
    hash: "sha256:ff0443ee31fdc930f559d01124b4b9c0be9fa24d383a5a795544c52abf8c4d70",
  });
  const c = h.ofKind("crossing")[0] as Rec;
  assert.equal((c["input"] as Rec)["hash"], "sha256:f3a8ad21e8d2901da6044c6caf0b28c49c08763b0a958771f49fc0668f5847d9");
  assert.equal(((c["end"] as Rec)["output"] as Rec)["hash"], "sha256:36df3dd3ebc93235d004bd5fcc0ac5e37056638abfead126d1a482e1b83dd412");
});
