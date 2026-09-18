/**
 * ids.ts: core.md section 6 and otel-mapping.md section 4. The worked
 * table, the hash inputs, the shape test without normalization, and which
 * `traceparent` values are well formed.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { crossingSpanIdOf, executionSpanIdOf, parseTraceparent, traceIdOf } from "../src/ids.js";
import { EXECUTION_ID, HOST } from "./helpers.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("the worked table in otel-mapping.md section 4", () => {
  assert.equal(traceIdOf(HOST, EXECUTION_ID), EXECUTION_ID);
  assert.equal(executionSpanIdOf(HOST, EXECUTION_ID), "4edd2d736dd0892d");
  assert.equal(crossingSpanIdOf(HOST, "1a2b3c4d5e6f7081"), "1a2b3c4d5e6f7081");
  assert.equal(traceIdOf(HOST, "run-42"), "9517adfb3444518031fe879bc136c334");
  assert.equal(executionSpanIdOf(HOST, "run-42"), "81712fb065e103b6");
  assert.equal(crossingSpanIdOf(HOST, "call-7"), "dcbb7a0fe90e11fd");
});

test("hashed ids are the first hex digits of SHA-256 over the documented inputs, NUL separated, UTF-8", () => {
  assert.equal(traceIdOf(HOST, "run-42"), sha(HOST + "\0run-42").slice(0, 32));
  assert.equal(executionSpanIdOf(HOST, "run-42"), sha("execution\0" + HOST + "\0run-42").slice(0, 16));
  assert.equal(crossingSpanIdOf(HOST, "call-7"), sha("crossing\0" + HOST + "\0call-7").slice(0, 16));
  assert.equal(traceIdOf("hôst/é", "exécution-😀"), sha("hôst/é\0exécution-😀").slice(0, 32));
});

test("the shape test is exact: uppercase, wrong length, padded and all-zero ids are hashed, and only a hashed id includes the host", () => {
  const upper = EXECUTION_ID.toUpperCase();
  assert.equal(traceIdOf(HOST, upper), sha(HOST + "\0" + upper).slice(0, 32));
  assert.equal(traceIdOf(HOST, "0".repeat(32)), sha(HOST + "\0" + "0".repeat(32)).slice(0, 32));
  assert.equal(traceIdOf(HOST, EXECUTION_ID + "0"), sha(HOST + "\0" + EXECUTION_ID + "0").slice(0, 32));
  assert.equal(crossingSpanIdOf(HOST, "0".repeat(16)), sha("crossing\0" + HOST + "\0" + "0".repeat(16)).slice(0, 16));
  assert.equal(crossingSpanIdOf(HOST, " 1a2b3c4d5e6f7081"), sha("crossing\0" + HOST + "\0 1a2b3c4d5e6f7081").slice(0, 16));
  assert.equal(crossingSpanIdOf(HOST, "1A2B3C4D5E6F7081"), sha("crossing\0" + HOST + "\0" + "1A2B3C4D5E6F7081").slice(0, 16));
  assert.notEqual(traceIdOf(HOST, "run-42"), traceIdOf("other/host", "run-42"));
  assert.equal(traceIdOf(HOST, EXECUTION_ID), traceIdOf("other/host", EXECUTION_ID), "two observers sharing a 32-hex id land in one trace");
  assert.notEqual(executionSpanIdOf(HOST, EXECUTION_ID), executionSpanIdOf("other/host", EXECUTION_ID), "their execution span ids differ");
  assert.notEqual(executionSpanIdOf(HOST, EXECUTION_ID), EXECUTION_ID.slice(0, 16), "an execution span id is hashed even for a hex id");
});

test("a well-formed traceparent gives its trace id and parent id", () => {
  assert.deepEqual(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"), {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    parentId: "b7ad6b7169203331",
  });
  assert.deepEqual(parseTraceparent("7f-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00")?.parentId, "b7ad6b7169203331", "any version but ff");
});

test("a malformed traceparent gives nothing", () => {
  for (const bad of [
    "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
    "00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331",
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01\n",
    " 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    "not a traceparent",
    "",
    7,
    null,
    undefined,
  ]) {
    assert.equal(parseTraceparent(bad), undefined, JSON.stringify(bad));
  }
});
