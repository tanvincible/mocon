/**
 * Shared test support: the spec's JSON schema through ajv, a port of the
 * structural checks in spec/conformance/check.py, fixture loading, and a
 * harness that drives an instance into a memory sink.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import { mocon, memorySink, type Capabilities, type CapturePolicy, type Mocon, type MemorySink, type MoconOptions } from "../src/index.js";

export const specDir = fileURLToPath(new URL("../../../spec/", import.meta.url));
const schemaDir = specDir + "schema/";
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

/** Schema errors plus structural errors for one parsed line. Empty when the line is valid. */
export function lineErrors(line: unknown): string[] {
  const errors = structuralErrors(line);
  if (!schema(line)) for (const e of schema.errors ?? []) errors.push("schema: " + (e.instancePath || "/") + " " + (e.message ?? ""));
  return errors;
}

/** Throws with every problem when any core line of the stream is invalid. Event lines are checked against extensions/events.md 2. */
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
    const errors = isRec(parsed) && parsed["kind"] === "event" ? eventErrors(parsed) : lineErrors(parsed);
    for (const e of errors) problems.push(`line ${i}: ${e}`);
  });
  if (problems.length > 0) throw new Error("invalid stream:\n" + problems.join("\n"));
}

export type Rec = Record<string, unknown>;

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const DISPOSITIONS = new Set(["completed", "failed", "terminated", "abandoned"]);
const OUTCOMES = new Set(["output", "error", "abandoned"]);

export const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

function payloadErrors(p: unknown, where: string): string[] {
  if (!isRec(p)) return [`${where}: Payload must be an object`];
  const e: string[] = [];
  if (!("value" in p || p["truncated"] === true || p["redacted"] === true)) e.push(`${where}: Payload has no value and neither flag`);
  if ("hash" in p && !HASH.test(String(p["hash"]))) e.push(`${where}.hash: bad shape`);
  return e;
}

function errorErrors(x: unknown, where: string): string[] {
  if (!isRec(x)) return [`${where}: Error must be an object`];
  const e = "class" in x ? [] : [`${where}: missing class`];
  if ("value" in x) e.push(...payloadErrors(x["value"], where + ".value"));
  return e;
}

function tsErrors(o: Rec, key: string, where: string): string[] {
  return key in o && !TS.test(String(o[key])) ? [`${where}.${key}: not RFC 3339 UTC with Z`] : [];
}

/** The rules check.py applies without jsonschema: required keys, closed sets, end completeness, the Payload rule, timestamps, hash shape. */
export function structuralErrors(o: unknown): string[] {
  if (!isRec(o)) return ["line is not an object"];
  const errs: string[] = [];
  if (typeof o["host"] !== "string") errs.push("missing host");
  const kind = o["kind"];
  if (kind === "host") {
    if ("observes_crossings" in o && !["all", "some", "none"].includes(String(o["observes_crossings"]))) errs.push("observes_crossings");
    if ("crossing_edge" in o && !["invocation", "dispatch"].includes(String(o["crossing_edge"]))) errs.push("crossing_edge");
  } else if (kind === "execution") {
    for (const k of ["id", "start"]) if (!(k in o)) errs.push(`execution: missing ${k}`);
    if ("program" in o) errs.push(...payloadErrors(o["program"], "execution.program"));
    errs.push(...tsErrors(o, "start", "execution"));
    if ("end" in o) {
      const end = o["end"];
      if (!isRec(end)) errs.push("execution.end: not an object");
      else {
        for (const k of ["time", "disposition"]) if (!(k in end)) errs.push(`execution.end: missing ${k}`);
        if (!("program" in o)) errs.push("execution: missing program");
        errs.push(...tsErrors(end, "time", "execution.end"));
        if ("disposition" in end && !DISPOSITIONS.has(String(end["disposition"]))) errs.push("disposition");
        if ("result" in end) errs.push(...payloadErrors(end["result"], "execution.end.result"));
        if ("error" in end) errs.push(...errorErrors(end["error"], "execution.end.error"));
        const outputs = end["outputs"];
        if (isRec(outputs)) for (const [ch, p] of Object.entries(outputs)) errs.push(...payloadErrors(p, `outputs.${ch}`));
      }
    }
  } else if (kind === "crossing") {
    for (const k of ["id", "execution_id", "target", "input"]) if (!(k in o)) errs.push(`crossing: missing ${k}`);
    if ("input" in o) errs.push(...payloadErrors(o["input"], "crossing.input"));
    errs.push(...tsErrors(o, "start", "crossing"));
    if ("end" in o) {
      const end = o["end"];
      if (!isRec(end)) errs.push("crossing.end: not an object");
      else {
        errs.push(...tsErrors(end, "time", "crossing.end"));
        const oc = end["outcome"];
        if (!("outcome" in end)) errs.push("crossing.end: missing outcome");
        else if (!OUTCOMES.has(String(oc))) errs.push("outcome");
        if (oc === "output" && "error" in end) errs.push("output with error");
        if (oc === "error" && "output" in end) errs.push("error with output");
        if (oc === "abandoned" && ("output" in end || "error" in end)) errs.push("abandoned with payload");
        if ("output" in end) errs.push(...payloadErrors(end["output"], "crossing.end.output"));
        if ("error" in end) errs.push(...errorErrors(end["error"], "crossing.end.error"));
      }
    }
  } else errs.push(`unknown kind ${String(kind)}`);
  return errs;
}

/** extensions/events.md 2: the required fields of an event line, and the shape of a late settlement's data. */
export function eventErrors(o: Rec): string[] {
  const errs: string[] = [];
  for (const k of ["host", "id", "execution_id", "name"]) if (typeof o[k] !== "string") errs.push(`event: missing ${k}`);
  errs.push(...tsErrors(o, "time", "event"));
  if (o["name"] === "late_settlement") {
    const data = o["data"];
    if (typeof o["crossing_id"] !== "string") errs.push("late_settlement: missing crossing_id");
    if (!isRec(data) || !["output", "error"].includes(String(data["outcome"]))) errs.push("late_settlement: data.outcome");
    else if ("payload" in data) errs.push(...(data["outcome"] === "output" ? payloadErrors(data["payload"], "event.data.payload") : errorErrors(data["payload"], "event.data.payload")));
  }
  return errs;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export function streamNames(): string[] {
  return readdirSync(specDir + "conformance/streams")
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

export function readStream(name: string): string {
  return readFileSync(`${specDir}conformance/streams/${name}.jsonl`, "utf8");
}

export function readExpected(name: string): unknown {
  return JSON.parse(readFileSync(`${specDir}conformance/expected/${name}.json`, "utf8"));
}

/** The invalid fixtures: one line each, with the rule it breaks. */
export function readInvalid(): Array<{ name: string; line: string; reason: string }> {
  const dir = specDir + "conformance/invalid/";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -".jsonl".length);
      const line = readFileSync(dir + f, "utf8").split("\n").find((l) => l.trim() !== "") ?? "";
      return { name, line, reason: readFileSync(`${dir}${name}.reason.txt`, "utf8").trim() };
    });
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

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
  /** The last parsed record of one kind. */
  last(kind: string): Rec;
}

export function harness(options?: {
  host?: string;
  capabilities?: Capabilities;
  capture?: CapturePolicy;
  onError?: MoconOptions["onError"];
}): Harness {
  const sink = memorySink();
  const init: MoconOptions = { host: options?.host ?? "example/mcp", capabilities: options?.capabilities ?? SYNC_BRIDGE, sinks: [sink] };
  if (options?.capture !== undefined) init.capture = options.capture;
  if (options?.onError !== undefined) init.onError = options.onError;
  const m = mocon(init);
  const records = (): Rec[] => sink.lines.map((l) => JSON.parse(l) as Rec);
  const ofKind = (kind: string): Rec[] => records().filter((r) => r["kind"] === kind);
  return {
    m,
    sink,
    records,
    ofKind,
    last: (kind) => {
      const rec = ofKind(kind).at(-1);
      if (rec === undefined) throw new Error(`no ${kind} line was written`);
      return rec;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Every timing assertion in this package goes through one of these two,
 * so the rule holds in one place. Each takes the shortest of several
 * rounds after a warmup, because the shortest round is the one the
 * scheduler left alone, while a median or a mean carries whatever else
 * the machine was doing. A test then compares two of these figures as a
 * ratio, never against a number of microseconds: absolute figures belong
 * in `bench/hot-path.mjs`, which gates them on a known machine.
 */

/** The shortest microseconds per call of `a` and of `b`, measured alternately so load lands on both, after a warmup of each. */
export function interleaved(a: () => void, b: () => void, rounds = 15, perRound = 3): [number, number] {
  for (let i = 0; i < perRound * 2; i++) {
    a();
    b();
  }
  const time = (fn: () => void): number => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < perRound; i++) fn();
    return Number(process.hrtime.bigint() - t0) / perRound / 1000;
  };
  let first = Infinity;
  let second = Infinity;
  for (let r = 0; r < rounds; r++) {
    first = Math.min(first, time(a));
    second = Math.min(second, time(b));
  }
  return [first, second];
}

/** The shortest of several rounds of `run`, which times itself, after two warmup rounds. */
export function least(run: () => number, rounds = 7): number {
  run();
  run();
  let shortest = Infinity;
  for (let i = 0; i < rounds; i++) shortest = Math.min(shortest, run());
  return shortest;
}
