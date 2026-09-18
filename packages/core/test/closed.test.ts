/**
 * `CLOSED` against spec/schema: each closed set equals the schema's enum,
 * and `attested` equals the list the host schema names for the current minor version.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CLOSED } from "../src/fold.js";

type Rec = Record<string, unknown>;
const schema = (name: string): Rec => JSON.parse(readFileSync(new URL(`../../../spec/schema/${name}.json`, import.meta.url), "utf8")) as Rec;
const at = (node: unknown, ...path: string[]): Rec => path.reduce((n, key) => (n as Rec)[key], node) as Rec;

test("every closed set is the schema's enum, in any order", () => {
  const host = schema("host");
  const endOf = (name: string): Rec => at(schema(name), "$defs", "end", "properties");
  assert.deepEqual([...CLOSED.disposition].sort(), [...((endOf("execution")["disposition"] as Rec)["enum"] as string[])].sort());
  assert.deepEqual([...CLOSED.outcome].sort(), [...((endOf("crossing")["outcome"] as Rec)["enum"] as string[])].sort());
  assert.deepEqual([...CLOSED.observes_crossings].sort(), [...(at(host, "properties", "observes_crossings")["enum"] as string[])].sort());
  assert.deepEqual([...CLOSED.crossing_edge].sort(), [...(at(host, "properties", "crossing_edge")["enum"] as string[])].sort());
  assert.deepEqual([...CLOSED.linked].sort(), [...(at(schema("links"), "items", "properties", "kind")["enum"] as string[])].sort());
  const listed = /The 1\.\d+ list is: (.+)\.$/.exec(at(host, "properties", "attested")["description"] as string);
  assert.ok(listed !== null);
  assert.deepEqual([...CLOSED.attested].sort(), (listed[1] as string).split(", ").sort());
});

test("CLOSED is frozen", () => {
  assert.ok(Object.isFrozen(CLOSED));
});
