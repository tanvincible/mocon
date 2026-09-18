/**
 * The per-record provenance map provenance.md 5 asks a viewer to show:
 * every present field whose class is not host-observed after the host
 * declaration's `attested` list is applied (provenance.md 3 and 4).
 * Payload envelope fields are always H, so a marker names the `.value`.
 * Keys are wire paths, and a notice gets a map too, because a viewer shows
 * running records; `@mocon/otel` applies the same table to complete
 * records under attribute names, and a test holds the two in agreement.
 */

import type { CrossingLine, Dimension, ExecutionLine, HostLine } from "@mocon/core";
import { isRecord as isRec } from "./text.js";

export type Marker = "P" | "T";
export type ProvenanceMap = Record<string, Marker>;

/** The reserved envelope notes provenance.md 3 lists as H. Every other `mocon.` key is undefined and reads P, as any unknown field does. */
const RESERVED: ReadonlySet<string> = new Set(["mocon.target", "mocon.encoding", "mocon.message", "mocon.ext"]);

const hasValue = (p: unknown): boolean => isRec(p) && p["value"] !== undefined;

/**
 * Whether any `ext` key on this record is program-determined, which is
 * what the record's one `ext` marker says (provenance.md 3, 4). A key is
 * host-observed only as a reserved envelope note, or when its declaration
 * carries `observed: true` and the host attests `ext.declared` — which is
 * why `dimensions` reaches here only under that attestation. An `ext` that
 * is not an object is one value of unknown shape, which reads as P.
 */
export function programExt(ext: unknown, dimensions: Record<string, Dimension> | undefined): boolean {
  if (!isRec(ext)) return true;
  return Object.keys(ext).some((key) => !RESERVED.has(key) && dimensions?.[key]?.observed !== true);
}

/** The declaration's `attested` entries that are strings, in order; `[]` when there is no declaration (core.md 5.1). */
export function attestedOf(declaration: HostLine | undefined): string[] {
  const list = declaration?.attested;
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
}

export function executionProvenance(r: ExecutionLine, attested: Set<string>, dimensions?: Record<string, Dimension>): ProvenanceMap {
  const m: ProvenanceMap = {};
  if (hasValue(r.program)) m["program.value"] = "P";
  if (r.language !== undefined) m["language"] = "P";
  const end: unknown = r.end;
  if (isRec(end)) {
    if (hasValue(end["result"])) m["end.result.value"] = "P";
    const outputs = end["outputs"];
    if (isRec(outputs)) for (const channel of Object.keys(outputs)) if (hasValue(outputs[channel])) m[`end.outputs.${channel}.value`] = "P";
    const error = end["error"];
    if (isRec(error)) {
      if (!attested.has("execution.error.class")) m["end.error.class"] = "P";
      if (error["message"] !== undefined) m["end.error.message"] = "P";
      if (hasValue(error["value"])) m["end.error.value"] = "P";
    }
  }
  if (r.ext !== undefined && programExt(r.ext, dimensions)) m["ext"] = "P";
  return m;
}

export function crossingProvenance(r: CrossingLine, attested: Set<string>, dimensions?: Record<string, Dimension>): ProvenanceMap {
  const m: ProvenanceMap = {};
  const end: unknown = r.end;
  if (!attested.has("crossing.target")) {
    m["target"] = "P";
    if (r.seq !== undefined) m["seq"] = "P";
    if (isRec(end)) m["end.outcome"] = "P";
  }
  if (!attested.has("crossing.input") && hasValue(r.input)) m["input.value"] = "P";
  if (isRec(end) && end["outcome"] === "output" && hasValue(end["output"])) m["end.output.value"] = attested.has("crossing.output") ? "T" : "P";
  const error = isRec(end) && end["outcome"] === "error" ? end["error"] : undefined;
  if (isRec(error)) {
    const c: Marker = attested.has("crossing.error") ? "T" : "P";
    m["end.error.class"] = c;
    if (error["message"] !== undefined) m["end.error.message"] = c;
    if (hasValue(error["value"])) m["end.error.value"] = c;
  }
  if (r.ext !== undefined && programExt(r.ext, dimensions)) m["ext"] = "P";
  return m;
}
