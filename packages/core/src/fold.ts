/**
 * The canonical view of a stream, as spec/conformance/README.md 3 defines it:
 * the supersede rule (core.md 4) applied once per key, order-independently,
 * with the tie-break check.py uses. Executions and crossings are keyed by
 * host and id, because core.md 6 scopes ids to `(host, kind)`.
 *
 * The consumer entry, published at `@mocon/core/fold`; `@mocon/otel` and
 * `@mocon/cli` share its re-exports rather than each keeping a copy.
 */

import { byCodePoint, canonical } from "./canonical.js";
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

/**
 * The three maps have a null prototype: any key is an own entry.
 *
 * `host + "\0" + id` is not injective — host `a` with id `b\0c` and host
 * `a\0b` with id `c` share a key, and both are legal on the wire — so two
 * such records fold as one, which check.py, keying by the pair itself, does
 * not do. Which one the view holds is decided by the tie-break below and
 * never by arrival order, so every permutation still gives one view
 * (core.md 4 rule 4).
 */
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
  /** Not a JSON object, an unknown kind, or a missing string `host` or `id`. */
  skipped: number;
  /**
   * A value outside a closed set (core.md 8). The containing object reads as
   * absent: a malformed `end` counts as a notice, and a declaration loses the
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
      const completes = dedupe(entries.filter((e) => Object.hasOwn(e.rec, "end")));
      // The ref names the record the view holds, not the first line to arrive.
      const chosen = pick(completes.length > 0 ? completes : dedupe(entries));
      const ref: ViewRef = { kind, host: chosen["host"] as string, id: chosen["id"] as string };
      if (completes.length > 1) conflicts.push(ref);
      else if (completes.length === 0) unresolved.push(ref);
      out.push([key, chosen as unknown as T]);
    }
    return table(out);
  };

  const executionView = resolve<ExecutionLine>(executions, "execution");
  const crossingView = resolve<CrossingLine>(crossings, "crossing");
  unresolved.sort(byRef);
  conflicts.sort(byRef);
  return { hosts: table(hostView), executions: executionView, crossings: crossingView, unresolved, conflicts, skipped, flagged };
}

/** No prototype, so `__proto__` or `constructor` is an own entry. */
function table<T>(entries: Array<[string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/** `end` present but not an object, or with an unknown closed-set value. */
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

/** A copy without `keys`, every key an own data property, `__proto__` too. */
function without(rec: Rec, keys: ReadonlySet<string>): Rec {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => !keys.has(k)));
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [entry]);
  else list.push(entry);
}

/** By code point, as check.py sorts; `<` compares UTF-16 units instead. */
function byRef(a: ViewRef, b: ViewRef): number {
  return byCodePoint(a.kind, b.kind) || byCodePoint(a.host, b.host) || byCodePoint(a.id ?? "", b.id ?? "");
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

/**
 * The content-only tie-break the conformance suite recommends: the record
 * whose canonical JSON sorts first. That JSON is ASCII, so `<` is Python's.
 */
function pick(entries: readonly Entry[]): Rec {
  let best = entries[0] as Entry;
  for (const e of entries) if (e.canon < best.canon) best = e;
  return best.rec;
}
