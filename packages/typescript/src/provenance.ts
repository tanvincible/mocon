/**
 * Per-field provenance, materialized as attributes (otel-code-mode.md 6.5).
 *
 * `code_mode.attested` alone tells a consumer what the host observed, but only if that consumer
 * finds this document and joins its table against the list. Nothing does. So the effective class of
 * every program-determined or target-relayed attribute is written beside the value, as
 * `code_mode.provenance.<attribute key>`, and a host-observed field carries no label at all.
 *
 * This is the shape 6.3 rejected as "design A" on the grounds that an emitter which adds an
 * attribute and forgets to list it silently promotes a claim to an observation. That objection is
 * about where the classes come from, not about the wire shape: the table below is fixed by the
 * document and cannot drift with whatever an emitter happened to write, so it fails safe the same
 * way the list does. The record format's own OTLP export has done it this way all along.
 */

import type { Attestation } from "./declare.js";

/** The class a consumer reads. A field that ends up host-observed is written with no label. */
export type Provenance = "P" | "T";

/** One row of 6.5: every field starts program-determined, and one `attested` entry may move it. */
interface Row {
  key: string;
  /** The entry that upgrades this field. Absent means nothing ever upgrades it. */
  entry?: Attestation;
  /** What it becomes once that entry is attested. `H` is written as no label at all. */
  after?: "H" | "T";
}

const EXECUTION: readonly Row[] = [
  { key: "code_mode.program.text" },
  { key: "code_mode.program.language" },
  { key: "gen_ai.tool.call.result" },
  { key: "code_mode.error.body" },
  { key: "code_mode.error.message" },
  { key: "error.type", entry: "execution.error.class", after: "H" },
];

const CROSSING: readonly Row[] = [
  { key: "gen_ai.tool.name", entry: "crossing.target", after: "H" },
  { key: "code_mode.crossing.seq", entry: "crossing.target", after: "H" },
  { key: "code_mode.crossing.outcome", entry: "crossing.target", after: "H" },
  { key: "gen_ai.tool.call.arguments", entry: "crossing.input", after: "H" },
  { key: "gen_ai.tool.call.result", entry: "crossing.output", after: "T" },
  { key: "error.type", entry: "crossing.error", after: "T" },
  { key: "code_mode.error.body", entry: "crossing.error", after: "T" },
  { key: "code_mode.error.message", entry: "crossing.error", after: "T" },
];

/** Output channels are an open set, so they are labelled by prefix rather than by name. */
export const OUTPUT_PREFIX = "code_mode.output.";

export interface Labels {
  execution: ReadonlyMap<string, Provenance>;
  crossing: ReadonlyMap<string, Provenance>;
}

/**
 * The label for every field that is not host-observed, resolved once. `attested` cannot vary per
 * span (3.1), so neither can this, and no part of it is recomputed while a request is in flight.
 */
export function labels(attested: readonly Attestation[]): Labels {
  const has = new Set<string>(attested);
  const resolve = (rows: readonly Row[]): ReadonlyMap<string, Provenance> => {
    const out = new Map<string, Provenance>();
    for (const row of rows) {
      const upgraded = row.entry !== undefined && has.has(row.entry);
      if (upgraded && row.after === "H") continue;
      out.set(row.key, upgraded && row.after === "T" ? "T" : "P");
    }
    return out;
  };
  return { execution: resolve(EXECUTION), crossing: resolve(CROSSING) };
}

/**
 * Writes a label for each field present on the span that a consumer must not read as fact. Output
 * channels are always program-determined, so any key under that prefix is labelled whatever it is
 * called. Host-namespace keys are handled by the caller, which alone knows what was attested.
 */
export function label(attrs: Record<string, unknown>, map: ReadonlyMap<string, Provenance>): void {
  for (const key of Object.keys(attrs)) {
    if (key.startsWith("code_mode.provenance.")) continue;
    const cls = map.get(key) ?? (key.startsWith(OUTPUT_PREFIX) ? "P" : undefined);
    if (cls !== undefined) attrs["code_mode.provenance." + key] = cls;
  }
}
