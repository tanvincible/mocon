/**
 * The fake tools: what each answers, what each rejects, and that an answer
 * is a copy no caller can use to change a later answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool } from "../src/tools.js";

const ACME = { domain: "acme.example", name: "Acme Example Co", industry: "Widgets", headcount: 42 };
type Person = { name: string; title: string; domain: string };

test("company_lookup answers acme.example", async () => {
  assert.deepEqual(await callTool("company_lookup", { domain: "acme.example" }), ACME);
});

test("company_lookup rejects any other domain and names it", async () => {
  await assert.rejects(callTool("company_lookup", { domain: "nowhere.invalid" }), { message: "company_lookup: no company at nowhere.invalid" });
  await assert.rejects(callTool("company_lookup", {}), { message: "company_lookup: no company at undefined" });
});

test("person_search filters by domain and returns every match without a limit", async () => {
  const all = (await callTool("person_search", { domain: "acme.example" })) as Person[];
  assert.equal(all.length, 5);
  assert.ok(all.every((p) => p.domain === "acme.example"));
  assert.deepEqual(await callTool("person_search", { domain: "nowhere.invalid" }), []);
  assert.deepEqual(await callTool("person_search", { domain: "acme.example", limit: null }), all);
});

test("person_search honours a limit in order", async () => {
  const all = (await callTool("person_search", { domain: "acme.example" })) as Person[];
  assert.deepEqual(await callTool("person_search", { domain: "acme.example", limit: 2 }), all.slice(0, 2));
  assert.deepEqual(await callTool("person_search", { domain: "acme.example", limit: 0 }), []);
  assert.deepEqual(await callTool("person_search", { domain: "acme.example", limit: 50 }), all);
});

test("person_search rejects a limit that is not a non-negative integer", async () => {
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", true, {}]) {
    await assert.rejects(callTool("person_search", { domain: "acme.example", limit }), { name: "RangeError", message: "person_search: limit must be a non-negative integer" }, String(limit));
  }
});

test("an answer a caller changes does not reach a later call", async () => {
  const company = (await callTool("company_lookup", { domain: "acme.example" })) as typeof ACME;
  company.name = "Changed";
  const people = (await callTool("person_search", { domain: "acme.example" })) as Person[];
  people[0]!.name = "Changed";
  people.length = 0;
  assert.deepEqual(await callTool("company_lookup", { domain: "acme.example" }), ACME);
  const again = (await callTool("person_search", { domain: "acme.example" })) as Person[];
  assert.equal(again.length, 5);
  assert.equal(again[0]!.name, "Avery Sample");
});

test("arguments that are not an object read as no arguments", async () => {
  for (const args of [undefined, null, "acme.example", 7, ["acme.example"]]) {
    await assert.rejects(callTool("company_lookup", args), /no company at undefined/, String(args));
  }
  assert.deepEqual(await callTool("person_search", null), []);
});

test("an unknown tool is rejected by name", async () => {
  await assert.rejects(callTool("delete_everything", {}), { message: "no tool named delete_everything" });
});
