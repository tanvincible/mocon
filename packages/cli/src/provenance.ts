/**
 * The per-record provenance map provenance.md 5 asks a viewer to show:
 * every present field whose class is not host-observed after the host
 * declaration's `attested` list is applied (provenance.md 3 and 4).
 * Payload envelope fields are always H, so a marker names the `.value`.
 * Keys are wire paths, and a notice gets a map too, because a viewer shows
 * running records; `@mocon/otel` applies the same table to complete
 * records under attribute names, and a test holds the two in agreement.
 */

import type { CrossingLine, ExecutionLine, HostLine } from "@mocon/core";
import { isRecord as isRec } from "./text.js";

export type Marker = "P" | "T";
export type ProvenanceMap = Record<string, Marker>;

const hasValue = (p: unknown): boolean => isRec(p) && p["value"] !== undefined;

/** The declaration's `attested` entries; `[]` when there is no declaration (core.md 5.1). */
export function attestedOf(declaration: HostLine | undefined): Set<string> {
  const list = declaration?.attested;
  return new Set(Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : []);
}

export function executionProvenance(r: ExecutionLine, attested: Set<string>): ProvenanceMap {
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
  if (r.ext !== undefined) m["ext"] = "P";
  return m;
}

export function crossingProvenance(r: CrossingLine, attested: Set<string>): ProvenanceMap {
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
  if (r.ext !== undefined) m["ext"] = "P";
  return m;
}
