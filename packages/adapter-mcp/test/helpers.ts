/**
 * Test support: an instance over a memory sink, a hand-built request
 * `extra`, and a timing helper. The schema, the transport pairing and the
 * small async helpers are shared with the other packages in
 * `packages/testkit`.
 */

import { mocon, memorySink, type Capabilities, type CapturePolicy, type MemorySink, type Mocon } from "@mocon/core";
import { completeExecution, type Rec } from "../../testkit/mcp.js";
import { lineSchema } from "../../testkit/schema.js";
import type { McpExtra } from "../src/index.js";

export { completeExecution, pair, text, waitFor, type Paired, type Rec } from "../../testkit/mcp.js";

/** Throws with every problem when any line of the stream fails the schema. An event line belongs to an extension the core schema does not define, so it is only checked to be JSON. */
export function assertValidStream(lines: readonly string[]): void {
  const problems: string[] = [];
  lines.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      problems.push(`line ${i}: not JSON`);
      return;
    }
    if (line.includes("\n")) problems.push(`line ${i}: contains a raw newline`);
    if ((parsed as Rec)["kind"] === "event") return;
    if (!lineSchema(parsed)) for (const e of lineSchema.errors ?? []) problems.push(`line ${i}: ${e.instancePath || "/"} ${e.message ?? ""}`);
  });
  if (problems.length > 0) throw new Error("invalid stream:\n" + problems.join("\n"));
}

export const SYNC_BRIDGE: Capabilities = {
  observes_crossings: "all",
  unmediated_egress: false,
  crossing_edge: "invocation",
  attested: ["crossing.target", "crossing.input"],
};

export interface Harness {
  m: Mocon;
  sink: MemorySink;
  /** Parsed lines. */
  records(): Rec[];
  /** Parsed records of one kind. */
  ofKind(kind: string): Rec[];
  /** The one complete execution record. Fails unless there is exactly one. */
  done(): Rec;
}

export function harness(host = "test/mcp", options?: { capabilities?: Capabilities; capture?: CapturePolicy }): Harness {
  const sink = memorySink();
  const m = mocon({ host, capabilities: options?.capabilities ?? SYNC_BRIDGE, sinks: [sink], capture: options?.capture });
  const records = (): Rec[] => sink.lines.map((l) => JSON.parse(l) as Rec);
  const ofKind = (kind: string): Rec[] => records().filter((r) => r["kind"] === kind);
  return { m, sink, records, ofKind, done: () => completeExecution(records()) };
}

/** The `extra` an SDK request handler receives, built by hand. `abort` aborts its signal first, with that reason. */
export function extraOf(fields?: Partial<McpExtra> & { abort?: { reason: unknown } }): McpExtra {
  const { abort, ...rest } = fields ?? {};
  const controller = new AbortController();
  if (abort !== undefined) controller.abort(abort.reason);
  return { signal: controller.signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) as never, ...rest };
}

/**
 * Every timing assertion in this package goes through this one helper, so
 * the rule holds in one place. It takes the shortest of several rounds
 * after a warmup, because the shortest round is the one the scheduler left
 * alone, while a median or a mean carries whatever else the machine was
 * doing. A test then compares two of these figures as a ratio, never
 * against a number of microseconds: absolute figures belong in
 * `bench/hot-path.mjs`, which gates them on a known machine.
 */

/** The shortest microseconds per call of `a` and of `b`, measured alternately so load lands on both, after a warmup of each. */
export async function interleaved(a: () => Promise<unknown>, b: () => Promise<unknown>, rounds = 9, perRound = 100): Promise<[number, number]> {
  const time = async (fn: () => Promise<unknown>): Promise<number> => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < perRound; i++) await fn();
    return Number(process.hrtime.bigint() - t0) / perRound / 1000;
  };
  for (let i = 0; i < 2; i++) {
    await time(a);
    await time(b);
  }
  let first = Infinity;
  let second = Infinity;
  for (let r = 0; r < rounds; r++) {
    first = Math.min(first, await time(a));
    second = Math.min(second, await time(b));
  }
  return [first, second];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}