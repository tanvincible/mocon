/**
 * The sink that needs nothing from the platform. `fileSink` and
 * `stderrSink` are in `node.ts` because they need `node:fs`. Several sinks
 * go in `sinks: [...]`; the instance delivers to each, isolates a failure
 * and names the failing sink to `onError`.
 */

import type { Sink } from "./types.js";

export interface MemorySink extends Sink {
  /** Every line handed over so far, in order. */
  readonly lines: string[];
}

/** Keeps lines in memory. For tests and for a host that ships a batch itself. */
export function memorySink(): MemorySink {
  const lines: string[] = [];
  return {
    lines,
    write(batch) {
      for (const line of batch) lines.push(line);
    },
  };
}
