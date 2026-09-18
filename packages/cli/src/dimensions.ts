/**
 * core.md 5.1.1 as a consumer applies it: what a host declared its own
 * `ext` keys to mean, how one key reads on one record, the per-execution
 * rollup a viewer shows, and the declaration drift provenance.md 7 lints.
 *
 * A declaration decides display, aggregation and grouping of `ext`, and
 * nothing else: nothing here reads a core field, and an undeclared key is
 * still displayed verbatim, never totalled and never grouped by. The
 * closed sets come from `@mocon/core`, so a value this version does not
 * know reads as absent (core.md 8) rather than as a new kind.
 */

import type { Dimension, HostLine } from "@mocon/core";
import { CLOSED, dimensionsOf, fold } from "@mocon/core/fold";
import { attestedOf } from "./provenance.js";
import { head, isRecord, quoted, text } from "./text.js";

type Rec = Record<string, unknown>;

/** The reserved namespace core.md 3 keeps for envelope notes: no host authors those keys. */
const RESERVED = "mocon.";
/**
 * Code units of a facet value the rollup groups by. A `card: "low"` key is the host's claim, not a
 * guarantee, so the group key is the text a display can show: two values agreeing for this many
 * characters group together, which a key that is really low-cardinality never meets.
 */
const FACET_WIDTH = 128;

export interface HostDeclaration {
  /**
   * The declaration's own `host` string. A consumer that holds it uses it
   * in place of the one each record carries, so a later lookup compares
   * two references and not two strings the stream chose the length of.
   */
  host: string;
  /** The `attested` entries, as a set (provenance.md 4). */
  attested: Set<string>;
  /** Every entry whose `agg` this version knows, with the "absent reads as" column applied. */
  dimensions: Record<string, Dimension>;
  /** `ext.declared` in `attested`, the second gate a key needs to read host-observed (provenance.md 4). */
  attestsDeclared: boolean;
}

/** One declaration per host string, keyed by it. Hosts come from the model, so they are already folded. */
export function declarationsOf(hosts: readonly HostLine[]): Map<string, HostDeclaration> {
  return new Map(
    hosts.map((h) => {
      const attested = new Set(attestedOf(h));
      return [h.host, { host: h.host, attested, dimensions: dimensionsOf(h), attestsDeclared: attested.has("ext.declared") }];
    }),
  );
}

/** One `ext` key on one record, read through the declaration that governs it. */
export interface ExtEntry {
  key: string;
  /** The declaration's `name`, else the key (core.md 5.1.1). */
  label: string;
  value: unknown;
  /** The entry governing this value, or `null` when the key reads as undeclared on this record. */
  dim: Dimension | null;
  /** Declared `sum` or `last` but the value is not a finite number, so it reads as undeclared here. */
  mismatch: boolean;
  /** Host-observed: `observed: true` and the host attests `ext.declared`, or a reserved note (provenance.md 3, 4). */
  observed: boolean;
  /** One of core.md 3's reserved `mocon.` envelope notes: no host authors it and none can declare it. */
  reserved: boolean;
}

/**
 * Every key of one record's `ext`, aggregatable keys first and then by key
 * name — the deterministic order core.md 5.1.1 names for a viewer that
 * does not ask the host for one.
 */
export function extEntries(ext: unknown, decl: HostDeclaration | undefined): ExtEntry[] {
  const dims = decl?.dimensions;
  // A host that declared nothing reads exactly as it did in 1.0, and costs what it did: no key is looked at.
  if (!isRecord(ext) || dims === undefined || isEmpty(dims)) return [];
  const out = Object.entries(ext).map(([key, value]) => {
    const dim = dims[key];
    // A null is "no value", not a wrong value (core.md 5.1.1): it renders as "no value", never as zero.
    const mismatch = dim !== undefined && dim.agg !== "none" && value !== null && !aggregatable(value);
    const reserved = key.startsWith(RESERVED);
    return {
      key,
      label: dim?.name ?? key,
      value,
      dim: dim === undefined || mismatch ? null : dim,
      mismatch,
      observed: reserved || (dim?.observed === true && decl?.attestsDeclared === true),
      reserved,
    };
  });
  return out.sort((a, b) => rank(a) - rank(b) || compare(a.key, b.key));
}

/** A `sum` over one execution: its own `ext` and its crossings' (core.md 5.1.1). */
export interface Total {
  key: string;
  label: string;
  /** Absent on the wire reads as `"1"`, which displays as a bare count. */
  unit: string;
  value: number;
  /** Records that carried the key and were counted. */
  records: number;
  /** Records left out because they carry a `duplicate` link (extensions/links.md 4). */
  excluded: number;
}

/** A `none` key with `card: "low"`: safe to group by, so the rollup shows its distribution. */
export interface Facet {
  key: string;
  label: string;
  /** Each distinct value as text, with the number of records carrying it; most first, then by value. */
  values: Array<[value: string, count: number]>;
}

/**
 * The rollup for one execution over `records`, which are its crossings in
 * display order followed by its own record. A record carrying a
 * `duplicate` link repeats work already counted, so it is left out of
 * every total and said so (extensions/links.md 4); it still counts toward
 * a facet, which totals nothing. `high`-cardinality keys are never
 * faceted: that default is the whole point of `card`.
 *
 * `last` is deliberately not rolled up. Core forbids totalling a level,
 * and the only other reading — the latest one — is the value on the
 * record that carries it, which the display already shows beside its
 * unit. A rollup line repeating it would say nothing the tree does not.
 */
export function rollup(records: readonly unknown[], decl: HostDeclaration | undefined): { totals: Total[]; facets: Facet[] } {
  const totals = new Map<string, Total>();
  const facets = new Map<string, Map<string, number>>();
  const labels = new Map<string, string>();
  for (const record of records) {
    const duplicate = isRecord(record) && hasDuplicateLink(record["links"]);
    for (const e of extEntries(isRecord(record) ? record["ext"] : undefined, decl)) {
      if (e.dim === null) continue;
      labels.set(e.key, e.label);
      if (e.dim.agg === "sum" && typeof e.value === "number") {
        const t = totals.get(e.key) ?? { key: e.key, label: e.label, unit: e.dim.unit ?? "1", value: 0, records: 0, excluded: 0 };
        if (duplicate) t.excluded++;
        else {
          t.value += e.value;
          t.records++;
        }
        totals.set(e.key, t);
      } else if (e.dim.agg === "none" && e.dim.card === "low" && e.value !== null) {
        const counts = facets.get(e.key) ?? new Map<string, number>();
        const key = facetKey(e.value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        facets.set(e.key, counts);
      }
    }
  }
  return {
    totals: [...totals.values()].filter((t) => t.records > 0).sort((a, b) => compare(a.key, b.key)),
    facets: [...facets].map(([key, counts]) => ({
      key,
      label: labels.get(key) ?? key,
      values: [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])),
    })).sort((a, b) => compare(a.key, b.key)),
  };
}

/**
 * provenance.md 7's declaration and link rules, as one pass over the
 * folded view, so the answer does not depend on line order. These are
 * warnings about streams core.md calls legal: a host runs them in its own
 * tests to catch a declaration that drifted from its code.
 */
export function declarationWarnings(stream: string): string[] {
  const view = fold(stream);
  const hosts = Object.entries(view.hosts as unknown as Record<string, Rec>);
  const warnings: string[] = [];
  const claimed = new Map<string, Set<string>>();
  const known = new Map<string, Rec>();

  for (const [host, decl] of hosts.sort((a, b) => compare(a[0], b[0]))) {
    const dims = isRecord(decl["dimensions"]) ? decl["dimensions"] : {};
    known.set(host, dims);
    const attested: unknown[] = Array.isArray(decl["attested"]) ? decl["attested"] : [];
    const entries = Object.entries(dims).filter((e): e is [string, Rec] => isRecord(e[1]));
    const observed = entries.filter(([, e]) => e["observed"] === true);
    if (observed.length > 0 && !attested.includes("ext.declared")) {
      warnings.push(`host ${host} declares ${observed.length} observed dimension(s) without attesting ext.declared; consumers read those keys as P`);
    }
    if (attested.includes("ext.declared") && observed.length === 0) {
      warnings.push(`host ${host} attests ext.declared but no dimension carries observed: true`);
    }
    for (const [key, e] of entries.sort((a, b) => compare(a[0], b[0]))) {
      if (typeof e["agg"] === "string" && !CLOSED.agg.has(e["agg"])) warnings.push(`host ${host} dimension ${quoted(key)} agg outside the known list: ${quoted(e["agg"])}`);
      if (typeof e["card"] === "string" && !CLOSED.card.has(e["card"])) warnings.push(`host ${host} dimension ${quoted(key)} card outside the known list: ${quoted(e["card"])}`);
    }
    claimed.set(host, new Set(Object.keys(dims).filter((k) => k.includes(".")).map((k) => k.slice(0, k.indexOf(".")))));
  }

  const records = [...hosts.map(([, d]) => d), ...Object.values(view.executions), ...Object.values(view.crossings)] as Rec[];
  const undeclared = new Map<string, number>();
  const mismatched = new Map<string, number>();
  for (const record of records) {
    const host = text(record["host"]);
    const dims = known.get(host) ?? {};
    if (!isRecord(record["ext"])) continue;
    for (const [key, value] of Object.entries(record["ext"])) {
      const entry = dims[key];
      const agg = isRecord(entry) ? entry["agg"] : undefined;
      if (typeof agg !== "string" || !CLOSED.agg.has(agg)) {
        // Scoped to namespaces the host already declares a key in, which is what makes the rule runnable
        // by a relay forwarding another vendor's keys and by a host that has not adopted declarations.
        if (key.startsWith(RESERVED) || !key.includes(".")) continue;
        if (claimed.get(host)?.has(key.slice(0, key.indexOf(".")))) count(undeclared, host + "\0" + key);
        continue;
      }
      // A null is "no value", not a wrong value (core.md 5.1.1), so a nullable key does not warn.
      if (agg !== "none" && value !== null && !aggregatable(value)) count(mismatched, host + "\0" + key);
    }
  }
  for (const [pair, n] of [...undeclared].sort((a, b) => compare(a[0], b[0]))) {
    warnings.push(`host ${split(pair)[0]} emits undeclared ext key ${quoted(split(pair)[1])} in a namespace it declares (${n}x)`);
  }
  for (const [pair, n] of [...mismatched].sort((a, b) => compare(a[0], b[0]))) {
    warnings.push(`host ${split(pair)[0]} dimension ${quoted(split(pair)[1])} is aggregatable but carried a non-number (${n}x)`);
  }

  for (const record of records) {
    const links: unknown = record["links"];
    if (!Array.isArray(links)) continue;
    const where = `${text(record["kind"])} ${text(record["id"])}`;
    for (const e of links) {
      if (!isRecord(e)) continue;
      if (typeof e["rel"] === "string" && !CLOSED.rel.has(e["rel"])) warnings.push(`${where} link rel outside the known list: ${quoted(e["rel"])}`);
      if (typeof e["counts"] === "string" && !CLOSED.counts.has(e["counts"])) warnings.push(`${where} link counts outside the known list: ${quoted(e["counts"])}`);
      const sameHost = (e["host"] ?? record["host"]) === record["host"];
      if (sameHost && e["kind"] === record["kind"] && e["id"] === record["id"]) warnings.push(`${where} link names the record carrying it`);
    }
  }
  return warnings;
}

/** Whether the record's `links` carry an entry that repeats work already counted (extensions/links.md 4). */
export function hasDuplicateLink(links: unknown): boolean {
  return Array.isArray(links) && links.some((e) => isRecord(e) && e["counts"] === "duplicate");
}

/** A facet value as text, reading no more of it than the group key holds. */
function facetKey(v: unknown): string {
  return typeof v === "string" ? quoted(v.length > FACET_WIDTH ? v.slice(0, FACET_WIDTH) : v) : head(v, FACET_WIDTH);
}

/** Whether the map holds no entry; it has a null prototype, so `Object.keys` is the only reading. */
function isEmpty(map: Record<string, unknown>): boolean {
  for (const _ in map) return false;
  return true;
}

/** core.md 5.1.1: `sum` and `last` apply to a finite JSON number only. A boolean is not one. */
function aggregatable(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Aggregatable keys sort before the rest (core.md 5.1.1). */
function rank(e: ExtEntry): number {
  return e.dim !== null && e.dim.agg !== "none" ? 0 : 1;
}

function count(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function split(pair: string): [string, string] {
  const at = pair.indexOf("\0");
  return [pair.slice(0, at), pair.slice(at + 1)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
