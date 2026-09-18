/**
 * The canonical view of a stream, as spec/conformance/README.md section 3
 * defines it: the supersede rule (core.md 4) applied once per key,
 * order-independently, with conflicts resolved by the tie-break check.py
 * uses. Executions and crossings are keyed by host and id, because
 * core.md 6 scopes ids to `(host, kind)`; a single-host stream is the
 * special case where every key shares one host.
 *
 * A consumer-side entry, published at `@mocon/core/fold` with the other
 * consumer tools: `canonical`, `CLOSED`, `unixNanos`, `sameMajor`,
 * `sha256` and `stringifyDeep`, which `@mocon/otel` and `@mocon/cli`
 * share from here rather than each keeping a copy. The emitter's main
 * entry does not carry them.
 */

import { canonical } from "./canonical.js";
import { CLOSED } from "./closed.js";
import type { CrossingLine, ExecutionLine, HostLine } from "./types.js";

export { canonical } from "./canonical.js";
export { CLOSED } from "./closed.js";
export { sha256 } from "./hash.js";
export { stringifyDeep } from "./stringify.js";
export { unixNanos } from "./time.js";
export { sameMajor } from "./version.js";

export interface ViewRef {
  kind: "host" | "execution" | "crossing";
  host: string;
  /** `null` for a host conflict, which has no id. */
  id: string | null;
}

/** The three maps have a null prototype: any key is an own entry, and a missing key reads as `undefined`. */
export interface View {
  hosts: Record<string, HostLine>;
  /** Keyed by `host + "\0" + id`. */
  executions: Record<string, ExecutionLine>;
  /** Keyed by `host + "\0" + id`. */
  crossings: Record<string, CrossingLine>;
  /** Keys with a notice and no complete record, sorted by (kind, host, id). */
  unresolved: ViewRef[];
  /** Keys with two or more distinct complete records, sorted the same way. */
  conflicts: ViewRef[];
  /** Lines that were not JSON objects, carried a kind this version does not know, or had no string `host`, or no string `id` on a kind that needs one. */
  skipped: number;
  /**
   * Lines that carried a value outside a closed set (core.md 8). The
   * containing object is read as absent: an execution or crossing whose
   * `end` is malformed counts as a notice, and a declaration loses the
   * offending key.
   */
  flagged: number;
}

type Rec = Record<string, unknown>;

/** A record as the view reads it, and the canonical JSON it is compared by. */
interface Entry {
  rec: Rec;
  canon: string;
}

const END: ReadonlySet<string> = new Set(["end"]);

/** Folds a stream given as one text or as an iterable of lines. */
export function fold(input: string | Iterable<string>): View {
  const lines = typeof input === "string" ? input.split("\n") : input;
  const hosts = new Map<string, Entry[]>();
  const executions = new Map<string, Entry[]>();
  const crossings = new Map<string, Entry[]>();
  let skipped = 0;
  let flagged = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      skipped++;
      continue;
    }
    const rec = o as Rec;
    const { kind, host, id } = rec;
    if (typeof host !== "string" || (kind !== "host" && typeof id !== "string")) {
      skipped++;
      continue;
    }
    switch (kind) {
      case "host": {
        const drop = new Set<string>();
        if (outside(rec, "observes_crossings", CLOSED.observes_crossings)) drop.add("observes_crossings");
        if (outside(rec, "crossing_edge", CLOSED.crossing_edge)) drop.add("crossing_edge");
        if (drop.size > 0) flagged++;
        push(hosts, host, drop.size > 0 ? { rec: without(rec, drop), canon: canonical(line, drop) } : { rec, canon: canonical(line) });
        break;
      }
      case "execution":
      case "crossing": {
        const bad = badEnd(rec, kind === "execution" ? "disposition" : "outcome", kind === "execution" ? CLOSED.disposition : CLOSED.outcome);
        if (bad) flagged++;
        push(kind === "execution" ? executions : crossings, host + "\0" + id, bad ? { rec: without(rec, END), canon: canonical(line, END) } : { rec, canon: canonical(line) });
        break;
      }
      default:
        skipped++;
    }
  }

  const conflicts: ViewRef[] = [];
  const unresolved: ViewRef[] = [];

  const hostView: Array<[string, HostLine]> = [];
  for (const [host, entries] of hosts) {
    const distinct = dedupe(entries);
    if (distinct.length > 1) conflicts.push({ kind: "host", host, id: null });
    hostView.push([host, pick(distinct) as unknown as HostLine]);
  }

  const resolve = <T>(map: Map<string, Entry[]>, kind: "execution" | "crossing"): Record<string, T> => {
    const out: Array<[string, T]> = [];
    for (const [key, entries] of map) {
      const first = (entries[0] as Entry).rec;
      const ref: ViewRef = { kind, host: first["host"] as string, id: first["id"] as string };
      const completes = dedupe(entries.filter((e) => Object.hasOwn(e.rec, "end")));
      if (completes.length > 0) {
        if (completes.length > 1) conflicts.push(ref);
        out.push([key, pick(completes) as unknown as T]);
      } else {
        unresolved.push(ref);
        out.push([key, pick(dedupe(entries)) as unknown as T]);
      }
    }
    return table(out);
  };

  const executionView = resolve<ExecutionLine>(executions, "execution");
  const crossingView = resolve<CrossingLine>(crossings, "crossing");
  unresolved.sort(byRef);
  conflicts.sort(byRef);
  return { hosts: table(hostView), executions: executionView, crossings: crossingView, unresolved, conflicts, skipped, flagged };
}

/** A map with no prototype, so a key such as `__proto__` or `constructor` is an own entry like any other. */
function table<T>(entries: Array<[string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/** Whether `end` is present but not an object, or carries a closed-set value the consumer does not know. */
function badEnd(rec: Rec, field: string, allowed: ReadonlySet<unknown>): boolean {
  if (!Object.hasOwn(rec, "end")) return false;
  const end = rec["end"];
  if (end === null || typeof end !== "object" || Array.isArray(end)) return true;
  return !(Object.hasOwn(end, field) && allowed.has((end as Rec)[field]));
}

/** Whether the record carries `key` with a value outside `allowed`. */
function outside(rec: Rec, key: string, allowed: ReadonlySet<unknown>): boolean {
  return Object.hasOwn(rec, key) && !allowed.has(rec[key]);
}

/** A copy without `keys`. Every key is copied as an own data property, `__proto__` included. */
function without(rec: Rec, keys: ReadonlySet<string>): Rec {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => !keys.has(k)));
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [entry]);
  else list.push(entry);
}

function byRef(a: ViewRef, b: ViewRef): number {
  return cmp(a.kind, b.kind) || cmp(a.host, b.host) || cmp(a.id ?? "", b.id ?? "");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Distinct by canonical JSON, keeping the first occurrence of each. */
function dedupe(entries: readonly Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const e of entries) {
    if (seen.has(e.canon)) continue;
    seen.add(e.canon);
    out.push(e);
  }
  return out;
}

/** The content-only tie-break the conformance suite recommends: the record whose canonical JSON sorts first. Canonical JSON is ASCII, so `<` is Python's order. */
function pick(entries: readonly Entry[]): Rec {
  let best = entries[0] as Entry;
  for (const e of entries) if (e.canon < best.canon) best = e;
  return best.rec;
}
