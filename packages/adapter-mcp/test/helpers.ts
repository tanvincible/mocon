/**
 * Test support: the spec's JSON schema through ajv, an instance over a
 * memory sink, a hand-built request `extra`, and two small async helpers.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { mocon, memorySink, type Capabilities, type CapturePolicy, type MemorySink, type Mocon } from "@mocon/core";
import type { McpExtra } from "../src/index.js";

const schemaDir = fileURLToPath(new URL("../../../spec/schema/", import.meta.url));
const LINE_ID = "https://github.com/tanvincible/mocon/spec/1.0/schema/line.json";

// ajv is CommonJS: the default import is `module.exports`, which is the class and also carries itself as `default`.
const Ajv2020 = Ajv2020Module.default ?? (Ajv2020Module as unknown as typeof Ajv2020Module.default);
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
for (const file of ["line.json", "host.json", "execution.json", "crossing.json", "payload.json", "error.json"]) {
  ajv.addSchema(JSON.parse(readFileSync(schemaDir + file, "utf8")) as object);
}
const loaded = ajv.getSchema(LINE_ID);
if (loaded === undefined) throw new Error("line.json did not load");
const schema = loaded;

/** Throws with every problem when any line of the stream fails the schema. An event line belongs to an extension the core schema does not define, so it is only checked to be JSON. */
export function assertValidStream(lines: readonly string[]): void {
  const problems: string[] = [];
  lines.forEach((text, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`line ${i}: not JSON`);
      return;
    }
    if (text.includes("\n")) problems.push(`line ${i}: contains a raw newline`);
    if ((parsed as Rec)["kind"] === "event") return;
    if (!schema(parsed)) for (const e of schema.errors ?? []) problems.push(`line ${i}: ${e.instancePath || "/"} ${e.message ?? ""}`);
  });
  if (problems.length > 0) throw new Error("invalid stream:\n" + problems.join("\n"));
}

export type Rec = Record<string, any>;

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
  return { m, sink, records, ofKind, done: () => complete(ofKind("execution")) };
}

/** The one record with `end` among `records`. */
export function complete(records: Rec[]): Rec {
  const done = records.filter((r) => r["end"] !== undefined);
  assert.equal(done.length, 1, "exactly one complete execution record");
  return done[0]!;
}

/** The `extra` an SDK request handler receives, built by hand. `abort` aborts its signal first, with that reason. */
export function extraOf(fields?: Partial<McpExtra> & { abort?: { reason: unknown } }): McpExtra {
  const { abort, ...rest } = fields ?? {};
  const controller = new AbortController();
  if (abort !== undefined) controller.abort(abort.reason);
  return { signal: controller.signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) as never, ...rest };
}

/** Polls until `predicate` holds. Throws after `ms`. */
export async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
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
