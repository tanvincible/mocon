/**
 * The closed sets of core.md 8 and the `attested` entries of provenance.md 4, as runtime values. Each set is
 * built from a record keyed by its wire type, so a missing member or one foreign to it fails to compile.
 */

import type { Aggregation, Attestation, Cardinality, CrossingEdge, CrossingEnd, Disposition, Link, LinkCounts, LinkRel, ObservesCrossings } from "./types.js";

const members = <T extends string>(record: Record<T, true>): ReadonlySet<unknown> => new Set(Object.keys(record));

export const CLOSED = Object.freeze({
  disposition: members<Disposition>({ completed: true, failed: true, terminated: true, abandoned: true }),
  outcome: members<CrossingEnd["outcome"]>({ output: true, error: true, abandoned: true }),
  observes_crossings: members<ObservesCrossings>({ all: true, some: true, none: true }),
  crossing_edge: members<CrossingEdge>({ invocation: true, dispatch: true }),
  attested: members<Attestation>({
    "crossing.target": true,
    "crossing.input": true,
    "crossing.output": true,
    "crossing.error": true,
    "execution.error.class": true,
    "ext.declared": true,
  }),
  agg: members<Aggregation>({ sum: true, last: true, none: true }),
  card: members<Cardinality>({ low: true, high: true }),
  rel: members<LinkRel>({ retry_of: true, replay_of: true, forked_from: true, continues: true }),
  counts: members<LinkCounts>({ additive: true, duplicate: true }),
  linked: members<Link["kind"]>({ execution: true, crossing: true }),
});
