/**
 * Structural validation of a stream: the rules spec/conformance/check.py
 * applies without a schema library (required keys per kind, the closed
 * enums, end completeness, the Payload rule, the timestamp `Z` suffix, the
 * hash pattern; core.md 3, 5, 7, 8) together with the type rules
 * spec/schema adds, a `date-time` included: a timestamp must name an
 * instant that exists, which check.py's pattern alone does not ask. The
 * lint rules in provenance.md 7 and core.md 7's `end.time >= start` are
 * reported as warnings. A line is untrusted, so the report quotes a bounded
 * amount of it however large or deep the line is.
 */

import { SPEC_VERSION } from "@mocon/core";
import { fold, CLOSED, sameMajor, unixNanos } from "@mocon/core/fold";
import { isRecord as isRec, quoted, safe, text } from "./text.js";

const MAJOR = SPEC_VERSION.slice(0, SPEC_VERSION.indexOf("."));
const HASH = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+$/;
const KINDS: ReadonlySet<unknown> = new Set(["host", "execution", "crossing"]);

type Rec = Record<string, unknown>;
type Rule = [test: (v: unknown) => boolean, says: string];

/** Characters of a line's id a report quotes, and of one error. */
const ID_WIDTH = 64;
const ERROR_WIDTH = 256;
/** Errors a report lists for one line before it counts the rest. */
const ERRORS_PER_LINE = 20;

const has = (o: Rec, key: string): boolean => Object.hasOwn(o, key);

const STRING: Rule = [(v) => typeof v === "string", "must be a string"];
const BOOLEAN: Rule = [(v) => typeof v === "boolean", "must be a boolean"];
const OBJECT: Rule = [isRec, "must be an object"];
const COUNT: Rule = [(v) => typeof v === "number" && Number.isInteger(v) && v >= 0, "must be a non-negative integer"];
const STRINGS: Rule = [(v) => Array.isArray(v) && v.every((e) => typeof e === "string"), "must be an array of strings"];
const MAJOR_MINOR: Rule = [(v) => typeof v === "string" && VERSION.test(v), "must be MAJOR.MINOR"];

const HOST_TYPES: Record<string, Rule> = { spec_version: MAJOR_MINOR, unmediated_egress: BOOLEAN, attested: STRINGS, ext: OBJECT };
const EXECUTION_TYPES: Record<string, Rule> = { id: STRING, language: STRING, ext: OBJECT };
const EXECUTION_CONTEXT: Record<string, Rule> = { session: STRING, traceparent: STRING };
const CROSSING_TYPES: Record<string, Rule> = { id: STRING, execution_id: STRING, target: STRING, seq: COUNT, ext: OBJECT };
const CROSSING_CONTEXT: Record<string, Rule> = { traceparent: STRING };
const PAYLOAD_TYPES: Record<string, Rule> = { truncated: BOOLEAN, redacted: BOOLEAN, bytes: COUNT };
const ERROR_TYPES: Record<string, Rule> = { class: STRING, message: STRING };
const DIMENSION_TYPES: Record<string, Rule> = { agg: STRING, unit: STRING, card: STRING, name: STRING, observed: BOOLEAN };
const LINK_TYPES: Record<string, Rule> = { rel: STRING, id: STRING, counts: STRING, host: STRING, execution_id: STRING };
/** A link entry names a core record kind, which unlike `rel` and `counts` does not grow by minor version. */
const KINDS_LINKED: ReadonlySet<unknown> = new Set(["execution", "crossing"]);

/** One error per present key whose value breaks its rule. */
function typed(o: Rec, where: string, rules: Record<string, Rule>, errs: string[]): void {
  for (const [key, [test, says]] of Object.entries(rules)) if (has(o, key) && !test(o[key])) errs.push(`${where}.${key}: ${says}`);
}

function required(o: Rec, keys: string[], label: string, errs: string[]): void {
  for (const key of keys) if (!has(o, key)) errs.push(`${label}: missing required field: ${key}`);
}

function timestamp(o: Rec, key: string, where: string, errs: string[]): void {
  if (has(o, key) && unixNanos(o[key]) === undefined) errs.push(`${where}.${key}: not RFC 3339 UTC with Z suffix`);
}

function payload(p: unknown, where: string, errs: string[]): void {
  if (!isRec(p)) {
    errs.push(`${where}: Payload must be an object`);
    return;
  }
  if (!has(p, "value") && p["truncated"] !== true && p["redacted"] !== true) {
    errs.push(`${where}: Payload has no value and neither truncated nor redacted is true`);
  }
  typed(p, where, PAYLOAD_TYPES, errs);
  if (has(p, "hash") && !(typeof p["hash"] === "string" && HASH.test(p["hash"]))) errs.push(`${where}.hash: does not match sha256:<64 lowercase hex>`);
}

function error(x: unknown, where: string, errs: string[]): void {
  if (!isRec(x)) {
    errs.push(`${where}: Error must be an object`);
    return;
  }
  required(x, ["class"], where, errs);
  typed(x, where, ERROR_TYPES, errs);
  if (has(x, "value")) payload(x["value"], where + ".value", errs);
}

function context(o: Rec, where: string, fields: Record<string, Rule>, errs: string[]): void {
  if (!has(o, "context")) return;
  const c = o["context"];
  if (!isRec(c)) errs.push(`${where}.context: must be an object`);
  else typed(c, where + ".context", fields, errs);
}

/** core.md 5.1.1. Structure only: membership in `agg`/`card` grows by minor version, so an unknown value there is a lint warning, not a failure. */
function dimensions(o: Rec, errs: string[]): void {
  if (!has(o, "dimensions")) return;
  const d = o["dimensions"];
  if (!isRec(d)) {
    errs.push("host.dimensions: must be an object");
    return;
  }
  for (const [key, entry] of Object.entries(d)) {
    const where = `host.dimensions.${key}`;
    if (!isRec(entry)) {
      errs.push(`${where}: must be an object`);
      continue;
    }
    if (!has(entry, "agg")) errs.push(`${where}: missing required field: agg`);
    typed(entry, where, DIMENSION_TYPES, errs);
  }
}

/** extensions/links.md 2. Structure only, for the same reason; `kind` is a core closed set and is checked. */
function links(o: Rec, label: string, errs: string[]): void {
  if (!has(o, "links")) return;
  const v = o["links"];
  if (!Array.isArray(v)) {
    errs.push(`${label}.links: must be an array`);
    return;
  }
  v.forEach((entry, i) => {
    const where = `${label}.links[${i}]`;
    if (!isRec(entry)) {
      errs.push(`${where}: must be an object`);
      return;
    }
    required(entry, ["rel", "kind", "id", "counts"], where, errs);
    typed(entry, where, LINK_TYPES, errs);
    if (has(entry, "kind") && !KINDS_LINKED.has(entry["kind"])) errs.push(`${where}.kind not in closed set`);
  });
}

function execution(o: Rec, errs: string[]): void {
  required(o, ["id", "start"], "execution", errs);
  typed(o, "execution", EXECUTION_TYPES, errs);
  if (has(o, "program")) payload(o["program"], "execution.program", errs);
  timestamp(o, "start", "execution", errs);
  context(o, "execution", EXECUTION_CONTEXT, errs);
  links(o, "execution", errs);
  if (!has(o, "end")) return;
  const end = o["end"];
  if (!isRec(end)) {
    errs.push("execution.end: must be an object");
    return;
  }
  required(end, ["time", "disposition"], "execution.end", errs);
  required(o, ["program"], "execution", errs);
  timestamp(end, "time", "execution.end", errs);
  if (has(end, "disposition") && !CLOSED.disposition.has(end["disposition"])) errs.push("execution.end.disposition not in closed set");
  if (has(end, "result")) payload(end["result"], "execution.end.result", errs);
  if (has(end, "error")) error(end["error"], "execution.end.error", errs);
  if (has(end, "outputs")) {
    const outputs = end["outputs"];
    if (!isRec(outputs)) errs.push("execution.end.outputs: must be an object");
    else for (const channel of Object.keys(outputs)) payload(outputs[channel], `execution.end.outputs.${channel}`, errs);
  }
}

function crossing(o: Rec, errs: string[]): void {
  required(o, ["id", "execution_id", "target", "input"], "crossing", errs);
  typed(o, "crossing", CROSSING_TYPES, errs);
  if (has(o, "input")) payload(o["input"], "crossing.input", errs);
  timestamp(o, "start", "crossing", errs);
  context(o, "crossing", CROSSING_CONTEXT, errs);
  links(o, "crossing", errs);
  if (!has(o, "end")) return;
  const end = o["end"];
  if (!isRec(end)) {
    errs.push("crossing.end: must be an object");
    return;
  }
  timestamp(end, "time", "crossing.end", errs);
  const outcome = end["outcome"];
  if (!has(end, "outcome")) errs.push("crossing.end: missing required field: outcome");
  else if (!CLOSED.outcome.has(outcome)) errs.push("crossing.end.outcome not in closed set");
  if (outcome === "output" && has(end, "error")) errs.push("crossing.end.outcome output must not carry end.error");
  if (outcome === "error" && has(end, "output")) errs.push("crossing.end.outcome error must not carry end.output");
  if (outcome === "abandoned" && (has(end, "output") || has(end, "error"))) errs.push("crossing.end.outcome abandoned must not carry output or error");
  if (has(end, "output")) payload(end["output"], "crossing.end.output", errs);
  if (has(end, "error")) error(end["error"], "crossing.end.error", errs);
}

/** Every structural problem with one parsed line. Empty when the line is valid. */
export function structuralErrors(o: unknown): string[] {
  if (!isRec(o)) return ["line is not a JSON object"];
  const errs: string[] = [];
  const kind = o["kind"];
  if (typeof o["host"] !== "string") errs.push("missing required field: host");
  if (kind === "host") {
    if (has(o, "observes_crossings") && !CLOSED.observes_crossings.has(o["observes_crossings"])) errs.push("observes_crossings not in closed set");
    if (has(o, "crossing_edge") && !CLOSED.crossing_edge.has(o["crossing_edge"])) errs.push("crossing_edge not in closed set");
    typed(o, "host", HOST_TYPES, errs);
    dimensions(o, errs);
  } else if (kind === "execution") {
    execution(o, errs);
  } else if (kind === "crossing") {
    crossing(o, errs);
  } else {
    errs.push(`unknown kind: ${clip(text(kind), ID_WIDTH)}`);
  }
  return errs;
}

export interface Failure {
  /** 1-based line number in the file. */
  line: number;
  kind: string;
  /** The line's id as text, cut to 64 characters. */
  id: string;
  errors: string[];
}

export interface Report {
  /** Non-blank lines. */
  lines: number;
  /** Malformed lines and lines with an unknown kind: counted, not failed (core.md 3). */
  skipped: number;
  failures: Failure[];
  warnings: string[];
}

/** Validates every line of a stream and applies the lint rules across it. */
export function validateStream(stream: string): Report {
  const report: Report = { lines: 0, skipped: 0, failures: [], warnings: [] };
  const records: Rec[] = [];
  const declarations: string[] = [];
  let number = 0;
  for (const raw of stream.split("\n")) {
    number++;
    const line = raw.trim();
    if (line === "") continue;
    report.lines++;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      report.skipped++;
      continue;
    }
    if (!isRec(o) || !KINDS.has(o["kind"])) {
      report.skipped++;
      continue;
    }
    const errors = structuralErrors(o);
    if (errors.length > 0) report.failures.push({ line: number, kind: o["kind"] as string, id: has(o, "id") ? clip(text(o["id"]), ID_WIDTH) : "", errors });
    records.push(o);
    if (o["kind"] === "host") declarations.push(line);
  }
  report.warnings = lint(records, declarations);
  return report;
}

/** 0 when no line failed, 1 otherwise. */
export function exitCode(report: Report): 0 | 1 {
  return report.failures.length === 0 ? 0 : 1;
}

/**
 * provenance.md 7, plus core.md 7's `end.time >= start` and core.md 11's
 * major version check. A host redeclared with different values is linted
 * on the declaration `fold` keeps, the one a viewer shows, so the warnings
 * do not depend on line order.
 */
function lint(records: Rec[], declarationLines: string[]): string[] {
  const warnings: string[] = [];
  const hostsWithCrossings = new Set<string>();
  for (const o of records) {
    if (o["kind"] === "crossing") hostsWithCrossings.add(text(o["host"]));
    const end = o["end"];
    const start = unixNanos(o["start"]);
    const time = isRec(end) ? unixNanos(end["time"]) : undefined;
    if (start !== undefined && time !== undefined && BigInt(time) < BigInt(start)) {
      warnings.push(`${o["kind"] as string} ${clip(text(o["id"]), ID_WIDTH)}: end.time < start`);
    }
  }
  for (const [host, declaration] of Object.entries(fold(declarationLines).hosts)) {
    const decl = declaration as unknown as Rec;
    const attested: unknown[] = Array.isArray(decl["attested"]) ? decl["attested"] : [];
    if (has(decl, "crossing_edge") && !attested.includes("crossing.target")) {
      warnings.push(`host ${host} declares crossing_edge without attesting crossing.target`);
    }
    if (decl["observes_crossings"] === "none" && hostsWithCrossings.has(host)) {
      warnings.push(`host ${host} declares observes_crossings none but the stream has crossings for it`);
    }
    for (const a of attested) if (!CLOSED.attested.has(a)) warnings.push(`host ${host} attested entry outside the known list: ${clip(quoted(a), ID_WIDTH)}`);
    const version = decl["spec_version"];
    if (typeof version === "string" && !sameMajor(version)) warnings.push(`host ${host} declares spec_version ${version}; this consumer reads ${MAJOR}.x`);
  }
  return warnings;
}

/**
 * One line per file, then one indented line per error and per warning,
 * with every stream-derived character made safe for a terminal. A failing
 * line lists at most 20 errors, each cut to 256 characters, and counts the
 * rest, so the report grows with the number of failing lines and not with
 * how large a line is.
 */
export function renderReport(name: string, report: Report): string {
  const verdict = exitCode(report) === 0 ? "OK" : "FAIL";
  const out = [`${name}: ${report.lines} lines, ${report.skipped} skipped, ${report.failures.length} failed, ${report.warnings.length} warnings -> ${verdict}`];
  for (const f of report.failures) {
    const where = `    line ${f.line} ${f.kind} ${f.id}: `;
    for (const e of f.errors.slice(0, ERRORS_PER_LINE)) out.push(where + clip(e, ERROR_WIDTH));
    if (f.errors.length > ERRORS_PER_LINE) out.push(where + `and ${f.errors.length - ERRORS_PER_LINE} more errors`);
  }
  for (const w of report.warnings) out.push(`    WARN ${clip(w, ERROR_WIDTH)}`);
  return out.map(safe).join("\n") + "\n";
}

/** `s`, or its first `width` characters and an ellipsis. */
function clip(s: string, width: number): string {
  return s.length <= width ? s : s.slice(0, width) + "…";
}
