/**
 * The id pool: the two shapes core.md 6 recommends, the refill boundary,
 * and that no chunk of the pool is handed out twice.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { createIdPool } from "../src/ids.js";

test("execution ids are 32 lowercase hex digits and crossing ids 16", () => {
  const pool = createIdPool();
  for (let i = 0; i < 1000; i++) {
    assert.match(pool.execution(), /^[0-9a-f]{32}$/);
    assert.match(pool.crossing(), /^[0-9a-f]{16}$/);
  }
});

test("the pool is refilled from the CSPRNG only when it runs out, and never hands out a chunk twice", () => {
  const real = crypto.randomFillSync;
  const fills: string[] = [];
  crypto.randomFillSync = ((buf: Uint8Array, ...rest: unknown[]) => {
    const out = (real as (...a: unknown[]) => Uint8Array)(buf, ...rest);
    fills.push(Buffer.from(buf).toString("hex"));
    return out;
  }) as typeof crypto.randomFillSync;
  syncBuiltinESMExports();
  try {
    const pool = createIdPool();
    const ids: string[] = [];
    // 1024 bytes of pool: 60 executions (960 bytes) leave 64, which 8 crossings use exactly; the next id refills.
    for (let i = 0; i < 60; i++) ids.push(pool.execution());
    for (let i = 0; i < 8; i++) ids.push(pool.crossing());
    assert.equal(fills.length, 1);
    ids.push(pool.crossing());
    assert.equal(fills.length, 2, "the pool refills only when the next id does not fit");
    for (let i = 0; i < 100; i++) ids.push(pool.execution());
    assert.equal(fills.length, 3);
    assert.equal(new Set(ids).size, ids.length, "no chunk is reused");
    const [first, second] = fills as [string, string];
    assert.equal(ids[0], first.slice(0, 32), "ids are the pool bytes in order");
    assert.equal(ids[59], first.slice(59 * 32, 60 * 32));
    assert.equal(ids[67], first.slice(2048 - 16), "the last crossing of the first pool uses its last eight bytes");
    assert.equal(ids[68], second.slice(0, 16), "the first id after a refill starts at the fresh pool's first byte");
  } finally {
    crypto.randomFillSync = real;
    syncBuiltinESMExports();
  }
});
