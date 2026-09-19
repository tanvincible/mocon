/**
 * The capability declaration: the attributes that say what the host can and cannot see
 * (otel-code-mode.md 3). Without them an absence of crossing spans reads two ways a consumer cannot
 * tell apart, which is the one inference the declaration exists to make possible.
 *
 * Validated once at construction and frozen, because 3.1 requires every span of one dispatch to
 * carry the same values, and because a host must compute them from its own configuration rather
 * than from anything the program wrote.
 */

import type { Attributes } from "@opentelemetry/api";

export type Observes = "all" | "some" | "none";
export type CrossingEdge = "invocation" | "dispatch";
export type Attestation =
  | "crossing.target"
  | "crossing.input"
  | "crossing.output"
  | "crossing.error"
  | "execution.error.class"
  | "host_attributes";

const OBSERVES: ReadonlySet<unknown> = new Set<Observes>(["all", "some", "none"]);
const EDGES: ReadonlySet<unknown> = new Set<CrossingEdge>(["invocation", "dispatch"]);
const ATTESTED: ReadonlySet<unknown> = new Set<Attestation>([
  "crossing.target",
  "crossing.input",
  "crossing.output",
  "crossing.error",
  "execution.error.class",
  "host_attributes",
]);

export interface Capabilities {
  /** `all` and `some` claim the host mediates; `none` says it does not observe a call boundary. */
  observes_crossings: Observes;
  /** True when the program has a path out the host does not see. It blocks "N spans, N calls". */
  unmediated_egress: boolean;
  /** Which edge a crossing span describes: what the program asked for, or what the host sent. */
  crossing_edge?: CrossingEdge;
  /** What the host observed rather than took from the program. Omitted means it attests nothing. */
  attested?: readonly Attestation[];
  /** Required with `host_attributes`: the keys in the host's own namespace that it observed. */
  attested_attributes?: readonly string[];
}

/**
 * Each field is read once and the attribute written from what was read. Reading twice would let a
 * getter answer the closed-set check with a member and the write with anything, putting a value on
 * a span that never passed a check.
 */
export function declaration(capabilities: Capabilities): Readonly<Attributes> {
  if (capabilities === null || typeof capabilities !== "object") throw new TypeError("@mocon/trace: capabilities are required");
  const {
    observes_crossings: observes,
    unmediated_egress: egress,
    crossing_edge: edge,
    attested,
    attested_attributes: attestedKeys,
  } = capabilities;

  if (!OBSERVES.has(observes)) throw new RangeError('@mocon/trace: observes_crossings must be "all", "some" or "none"');
  if (typeof egress !== "boolean") throw new TypeError("@mocon/trace: unmediated_egress must be a boolean");

  const out: Attributes = { "code_mode.observes_crossings": observes, "code_mode.unmediated_egress": egress };

  if (edge === undefined) {
    // 3: Conditionally Required when the host mediates. A host that claims an edge it cannot name
    // has not said which side its crossing spans describe, and the two do not agree on cardinality.
    if (observes !== "none") throw new RangeError('@mocon/trace: crossing_edge is required unless observes_crossings is "none"');
  } else {
    if (!EDGES.has(edge)) throw new RangeError('@mocon/trace: crossing_edge must be "invocation" or "dispatch"');
    out["code_mode.crossing_edge"] = edge;
  }

  const entries = attested === undefined ? [] : [...attested];
  for (const entry of entries) if (!ATTESTED.has(entry)) throw new RangeError(`@mocon/trace: unknown attested entry ${JSON.stringify(entry)}`);
  // Written even when empty: 3 makes it Required, and an absent list is read as empty anyway, so
  // emitting it is what distinguishes a host that attests nothing from one that never declared.
  out["code_mode.attested"] = entries;

  if (entries.includes("host_attributes")) {
    const keys = attestedKeys === undefined ? [] : [...attestedKeys];
    for (const key of keys) if (typeof key !== "string" || key === "") throw new TypeError("@mocon/trace: attested_attributes entries must be non-empty strings");
    if (keys.length === 0) throw new RangeError('@mocon/trace: attested_attributes is required when "host_attributes" is attested');
    out["code_mode.attested_attributes"] = keys;
  } else if (attestedKeys !== undefined) {
    throw new RangeError('@mocon/trace: attested_attributes needs "host_attributes" in attested, which is the gate a consumer reads');
  }

  return Object.freeze(out);
}
