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
const AGG: ReadonlySet<unknown> = new Set<Aggregation>(["sum", "last", "none"]);
const CARD: ReadonlySet<unknown> = new Set<Cardinality>(["low", "high"]);
const ATTESTED: ReadonlySet<unknown> = new Set<Attestation>([
  "crossing.target",
  "crossing.input",
  "crossing.output",
  "crossing.error",
  "execution.error.class",
  "host_attributes",
]);

/** How a value combines across records. `none` means it must not be added up at all. */
export type Aggregation = "sum" | "last" | "none";
/** Whether grouping by a value is safe. `high` is per-user, per-run or otherwise unbounded. */
export type Cardinality = "low" | "high";

/**
 * What one of the host's own attributes means, in the only terms a stranger needs: whether it can
 * be summed, what it counts, and whether grouping by it is safe.
 */
export interface Dimension {
  agg: Aggregation;
  /** UCUM where one exists, `ms`, `By`, `s`; a curly-brace annotation otherwise, `{credit}`. */
  unit?: string;
  card?: Cardinality;
  /** A display name, for a key that reads badly in a legend. */
  name?: string;
}

export interface Capabilities {
  /**
   * `all`, `some` or `none`.
   *
   * **`all` means nothing can answer the program before the instrumented function.** Not "my wrapper
   * sees every call that reaches it". Check for a call cap, a deadline guard, a rate limiter, a
   * cache, or a permission check that refuses before dispatch: if any of those can return to the
   * program without passing through the wrapped function, some calls produce no span and this is
   * `some`.
   *
   * The check is mechanical. Instrument, run a program that hits every refusal path, and count the
   * spans against the calls. If they do not match, it is `some`.
   *
   * Everything else on the span is conditional on this being honest, and it is the one claim this
   * library cannot check. Over-claiming here is the most damaging mistake available.
   */
  observes_crossings: Observes;
  /**
   * True when the program has a path out the host does not see: raw network, a subprocess, an
   * escapable isolate. It blocks the inference "N spans, therefore N external calls".
   *
   * If you are not certain your sandbox is airtight, `true` is the honest answer.
   */
  unmediated_egress: boolean;
  /**
   * Which edge a crossing span describes. `invocation` is what the program asked for, `dispatch` is
   * what the host actually sent after retries and rewrites. Wrapping the bridge the program calls is
   * `invocation`, which is almost always the case.
   */
  crossing_edge?: CrossingEdge;
  /**
   * What the host observed rather than took from the program. Omitting it attests nothing, which is
   * safe: every field then reads as a program claim.
   *
   * Attest something only if it is true for **every** span emitted; there is no per-call opt-out.
   * Do not attest a field derived from anything the program wrote. If an error class is computed
   * partly by matching a thrown value's name or message, the program can choose it, and a host with
   * both an observed path and a parsed path for one field does not attest that field.
   */
  attested?: readonly Attestation[];
  /** Requires `host_attributes`: the keys in the host's own namespace that the host itself observed. */
  attested_attributes?: readonly string[];
  /**
   * Requires `host_attributes`: the keys the host passed through unchanged from a target, such as a
   * credit count an API reported. Target-relayed, not host-observed: the host did not measure it and
   * does not vouch for it, but the program did not shape it either.
   */
  relayed_attributes?: readonly string[];
  /**
   * What the host's own attributes MEAN, so a consumer that has never heard of this host can add
   * them up and group by them correctly. Keyed by attribute name. Needs no attestation: it is a
   * claim about meaning rather than about fidelity, and provenance still decides whether the value
   * can be believed at all.
   */
  declared?: Readonly<Record<string, Dimension>>;
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
    relayed_attributes: relayedKeys,
    declared,
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
    const observed = names(attestedKeys, "attested_attributes");
    const relayed = names(relayedKeys, "relayed_attributes");
    if (observed.length === 0 && relayed.length === 0) {
      throw new RangeError('@mocon/trace: "host_attributes" is attested but no attribute is named, so it claims nothing');
    }
    // A key cannot be both measured by the host and passed through from a target, and a host that
    // says both has not decided which claim it is making.
    for (const key of relayed) if (observed.includes(key)) throw new RangeError(`@mocon/trace: ${JSON.stringify(key)} is in both attested_attributes and relayed_attributes`);
    if (observed.length > 0) out["code_mode.attested_attributes"] = observed;
    if (relayed.length > 0) out["code_mode.relayed_attributes"] = relayed;
  } else if (attestedKeys !== undefined || relayedKeys !== undefined) {
    throw new RangeError('@mocon/trace: naming host attributes needs "host_attributes" in attested, which is the gate a consumer reads');
  }

  const dimensions = checkDeclared(declared);
  if (dimensions !== undefined) out["code_mode.declared"] = dimensions;

  return Object.freeze(out);
}

/**
 * Read once and rebuilt from what was read, as everything else here is, then serialized at
 * construction so the per-span cost is one string and no `toJSON` of the caller's can run on a
 * request path.
 */
function checkDeclared(given: Capabilities["declared"]): string | undefined {
  if (given === undefined) return undefined;
  if (given === null || typeof given !== "object") throw new TypeError("@mocon/trace: declared must be an object");
  const out: Record<string, Dimension> = {};
  for (const key of Object.keys(given)) {
    const d = given[key];
    if (d === null || typeof d !== "object") throw new TypeError(`@mocon/trace: declared[${JSON.stringify(key)}] must be an object`);
    const { agg, unit, card, name } = d;
    if (!AGG.has(agg)) throw new RangeError(`@mocon/trace: declared[${JSON.stringify(key)}].agg must be "sum", "last" or "none"`);
    const entry: Dimension = { agg };
    if (unit !== undefined) {
      if (typeof unit !== "string" || unit === "") throw new TypeError(`@mocon/trace: declared[${JSON.stringify(key)}].unit must be a non-empty string`);
      entry.unit = unit;
    }
    if (card !== undefined) {
      if (!CARD.has(card)) throw new RangeError(`@mocon/trace: declared[${JSON.stringify(key)}].card must be "low" or "high"`);
      entry.card = card;
    }
    if (name !== undefined) {
      if (typeof name !== "string" || name === "") throw new TypeError(`@mocon/trace: declared[${JSON.stringify(key)}].name must be a non-empty string`);
      entry.name = name;
    }
    out[key] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : JSON.stringify(out);
}

function names(given: readonly string[] | undefined, field: string): string[] {
  if (given === undefined) return [];
  if (!Array.isArray(given)) throw new TypeError(`@mocon/trace: ${field} must be an array`);
  const keys = [...given];
  for (const key of keys) if (typeof key !== "string" || key === "") throw new TypeError(`@mocon/trace: ${field} entries must be non-empty strings`);
  return keys;
}
