/**
 * The display model every command renders from: the folded view
 * (`@mocon/core/fold`, the supersede rule applied once per key) arranged
 * as sessions, executions and crossings, with durations and provenance
 * maps computed once. Order comes only from `seq` and host-clock times
 * (core.md 7), never from line order. A record whose `end` carries a value
 * outside its closed set reaches here without that `end` and shows as
 * running (core.md 8); `flagged` counts those lines.
 */

import { invariant, type CrossingLine, type ExecutionLine, type HostLine } from "@mocon/core";
import { fold, type ViewRef } from "@mocon/core/fold";
import { attestedOf, crossingProvenance, executionProvenance, type ProvenanceMap } from "./provenance.js";
import { isRecord, text } from "./text.js";

export interface CrossingNode {
  record: CrossingLine;
  /** Notice only, never completed (core.md 4 rule 5). */
  running: boolean;
  conflict: boolean;
  durationMs: number | null;
  provenance: ProvenanceMap;
}

export interface ExecutionNode {
  host: string;
  id: string;
  /** `null` when only crossings name this execution and no execution line was seen. */
  record: ExecutionLine | null;
  running: boolean;
  conflict: boolean;
  durationMs: number | null;
  provenance: ProvenanceMap;
  crossings: CrossingNode[];
}

export interface SessionNode {
  /** `context.session`, or `null` for executions that carry none. */
  session: string | null;
  executions: ExecutionNode[];
}

export interface Model {
  /** One declaration per host string, with every key whose value is outside its type or closed set removed, so it reads as absent. */
  hosts: HostLine[];
  sessions: SessionNode[];
  executions: number;
  crossings: number;
  unresolved: ViewRef[];
  conflicts: ViewRef[];
  skipped: number;
  /** Lines with a value outside a closed set (core.md 8). */
  flagged: number;
}

type Rec = Record<string, unknown>;

/** Characters past which a string cannot be a timestamp: RFC 3339 with nanoseconds takes 30, and the longest form `Date.parse` accepts takes 62. */
const MAX_TIMESTAMP = 64;

export function buildModel(stream: string): Model {
  const view = fold(stream);
  // The keys fold's maps use, so membership matches the entry fold resolved even when two (host, id) pairs share a key.
  const keysOf = (refs: ViewRef[], kind: ViewRef["kind"]): Set<string> => new Set(refs.filter((r) => r.kind === kind).map((r) => r.host + "\0" + r.id));
  const unresolvedExecutions = keysOf(view.unresolved, "execution");
  const unresolvedCrossings = keysOf(view.unresolved, "crossing");
  const conflictExecutions = keysOf(view.conflicts, "execution");
  const conflictCrossings = keysOf(view.conflicts, "crossing");
  const nodes: ExecutionNode[] = [];
  // By the text of host and id, so a crossing finds its execution whatever JSON type the id has. Where two
  // executions share that text, the one whose fold key sorts first holds it, so line order cannot decide.
  const parents = new Map<string, [foldKey: string, node: ExecutionNode]>();
  const attestedSets = new Map<string, Set<string>>();
  const attested = (host: string): Set<string> => {
    let set = attestedSets.get(host);
    if (set === undefined) attestedSets.set(host, (set = attestedOf(view.hosts[host])));
    return set;
  };
  let running = 0;

  for (const [key, record] of Object.entries(view.executions)) {
    const node: ExecutionNode = {
      host: record.host,
      id: record.id,
      record,
      running: unresolvedExecutions.has(key),
      conflict: conflictExecutions.has(key),
      durationMs: duration(record.start, record.end?.time),
      provenance: executionProvenance(record, attested(record.host)),
      crossings: [],
    };
    invariant(node.running !== Object.hasOwn(record, "end"), "an execution is running exactly when its record has no end");
    if (node.running) running++;
    nodes.push(node);
    const parentKey = text(record.host) + "\0" + text(record.id);
    const held = parents.get(parentKey);
    if (held === undefined || key < held[0]) parents.set(parentKey, [key, node]);
  }

  let placed = 0;
  for (const [key, record] of Object.entries(view.crossings)) {
    const parentKey = text(record.host) + "\0" + text(record.execution_id);
    let node = parents.get(parentKey)?.[1];
    if (node === undefined) {
      node = { host: record.host, id: record.execution_id, record: null, running: false, conflict: false, durationMs: null, provenance: {}, crossings: [] };
      nodes.push(node);
      parents.set(parentKey, ["", node]);
    }
    const crossing: CrossingNode = {
      record,
      running: unresolvedCrossings.has(key),
      conflict: conflictCrossings.has(key),
      durationMs: duration(record.start, record.end?.time),
      provenance: crossingProvenance(record, attested(record.host)),
    };
    invariant(crossing.running !== Object.hasOwn(record, "end"), "a crossing is running exactly when its record has no end");
    if (crossing.running) running++;
    node.crossings.push(crossing);
    placed++;
  }
  invariant(running === view.unresolved.length, "every unresolved record, and only those, shows as running");

  const sessions = new Map<string | null, ExecutionNode[]>();
  for (const node of nodes) {
    node.crossings.sort(byCrossing);
    const session = node.record?.context?.session;
    const key = typeof session === "string" ? session : null;
    const list = sessions.get(key);
    if (list === undefined) sessions.set(key, [node]);
    else list.push(node);
  }
  const list: SessionNode[] = [];
  for (const [session, executions] of sessions) list.push({ session, executions: executions.sort(byExecution) });
  list.sort((a, b) => compare(firstStart(a), firstStart(b)) || compare(Number(a.session !== null), Number(b.session !== null)) || compare(a.session ?? "", b.session ?? ""));
  invariant(placed === list.reduce((n, s) => n + s.executions.reduce((m, e) => m + e.crossings.length, 0), 0), "every crossing sits under exactly one execution");

  return {
    hosts: Object.values(view.hosts)
      .map(declared)
      .sort((a, b) => compare(text(a.host), text(b.host))),
    sessions: list,
    executions: Object.keys(view.executions).length,
    crossings: placed,
    unresolved: view.unresolved,
    conflicts: view.conflicts,
    skipped: view.skipped,
    flagged: view.flagged,
  };
}

/** The declaration with each capability key that does not hold a value of its type read as absent. Fold has already removed unknown closed-set values. */
function declared(h: HostLine): HostLine {
  const out: Rec = { ...h };
  if (typeof h.spec_version !== "string") delete out["spec_version"];
  if (typeof h.unmediated_egress !== "boolean") delete out["unmediated_egress"];
  if (Array.isArray(h.attested)) out["attested"] = h.attested.filter((a) => typeof a === "string");
  else delete out["attested"];
  return out as unknown as HostLine;
}

/**
 * Milliseconds since the epoch for an RFC 3339 UTC string, or `null`. A
 * string longer than any timestamp is rejected without asking `Date.parse`,
 * whose cost grows with the length of the text it refuses, and which the
 * sort comparators below ask once per comparison.
 */
export function parseTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function duration(start: unknown, end: unknown): number | null {
  const a = parseTime(start);
  const b = parseTime(end);
  return a === null || b === null ? null : b - a;
}

function firstStart(s: SessionNode): number {
  const first = s.executions[0];
  return parseTime(first?.record?.start) ?? Number.POSITIVE_INFINITY;
}

/** Host-clock start, then host, then id. An execution with no record or no parseable start sorts last. */
function byExecution(a: ExecutionNode, b: ExecutionNode): number {
  const ta = parseTime(a.record?.start) ?? Number.POSITIVE_INFINITY;
  const tb = parseTime(b.record?.start) ?? Number.POSITIVE_INFINITY;
  return compare(ta, tb) || compare(text(a.host), text(b.host)) || compare(text(a.id), text(b.id));
}

/** `seq` first when present, then host-clock start, then id (core.md 5.3, 7). */
function byCrossing(a: CrossingNode, b: CrossingNode): number {
  const sa = typeof a.record.seq === "number" ? a.record.seq : Number.POSITIVE_INFINITY;
  const sb = typeof b.record.seq === "number" ? b.record.seq : Number.POSITIVE_INFINITY;
  const ta = parseTime(a.record.start) ?? Number.POSITIVE_INFINITY;
  const tb = parseTime(b.record.start) ?? Number.POSITIVE_INFINITY;
  return compare(sa, sb) || compare(ta, tb) || compare(text(a.record.id), text(b.record.id));
}

function compare(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A Payload's out-of-band state as words: `truncated`, `redacted`, and the original's size when it was cut or withheld. */
export function payloadFlags(p: unknown): string[] {
  const flags: string[] = [];
  if (!isRecord(p)) return flags;
  if (p["truncated"] === true) flags.push("truncated");
  if (p["redacted"] === true) flags.push("redacted");
  if (flags.length > 0 && typeof p["bytes"] === "number") flags.push(`${p["bytes"]} bytes`);
  return flags;
}
