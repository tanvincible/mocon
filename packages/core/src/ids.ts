/**
 * Ids in the shapes core.md 6 recommends: 32 lowercase hex digits from 128
 * random bits for an execution, 16 from 64 bits for a crossing or event.
 * Bytes come from a CSPRNG pool sliced as ids are minted; a pool belongs to
 * one instance, so no chunk is handed out twice.
 */

import { randomFillSync } from "node:crypto";

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const POOL_BYTES = 1024;

export interface IdPool {
  execution(): string;
  crossing(): string;
}

export function createIdPool(): IdPool {
  const pool = new Uint8Array(POOL_BYTES);
  let offset = POOL_BYTES;
  const take = (n: number): string => {
    if (offset + n > POOL_BYTES) {
      randomFillSync(pool);
      offset = 0;
    }
    let s = "";
    const end = offset + n;
    for (let i = offset; i < end; i++) s += HEX[pool[i] as number];
    offset = end;
    return s;
  };
  return {
    execution: () => take(16),
    crossing: () => take(8),
  };
}
