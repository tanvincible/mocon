/**
 * Id derivation, core.md section 6 and otel-mapping.md section 4. Every
 * function here is a pure function of the strings on one line, which is
 * what lets two sinks reading the same stream land in the same trace. The
 * hash is `@mocon/core`'s, so this package carries no copy of it.
 */

import { sha256 } from "@mocon/core/fold";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const ZERO32 = "0".repeat(32);
const ZERO16 = "0".repeat(16);
// otel-mapping.md 4.1 asks lowercase of the two ids only: the version and the flags are hex digits in either case.
const TRACEPARENT = /^([0-9a-fA-F]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-fA-F]{2}$/;

/** The trace id an execution id derives: itself when it is 32 lowercase hex digits and not all zeros, otherwise hashed with the host. */
export function traceIdOf(host: string, executionId: string): string {
  if (HEX32.test(executionId) && executionId !== ZERO32) return executionId;
  return sha256(host + "\0" + executionId).slice(0, 32);
}

/** Always hashed, so it differs from a trace id that is the execution id verbatim. */
export function executionSpanIdOf(host: string, id: string): string {
  return sha256("execution\0" + host + "\0" + id).slice(0, 16);
}

/** The crossing id itself when it is 16 lowercase hex digits and not all zeros, otherwise hashed with the host. */
export function crossingSpanIdOf(host: string, id: string): string {
  if (HEX16.test(id) && id !== ZERO16) return id;
  return sha256("crossing\0" + host + "\0" + id).slice(0, 16);
}

interface Traceparent {
  traceId: string;
  parentId: string;
}

/**
 * The ids of a well-formed `traceparent` (otel-mapping.md 4.1): a hex
 * version that is not `ff`, a lowercase hex trace id and parent id that
 * are not all zeros, and hex flags. `undefined` for anything else, so the
 * caller falls back to the derived ids.
 */
export function parseTraceparent(value: unknown): Traceparent | undefined {
  if (typeof value !== "string") return undefined;
  const m = TRACEPARENT.exec(value);
  if (m === null) return undefined;
  const traceId = m[2] as string;
  const parentId = m[3] as string;
  if ((m[1] as string).toLowerCase() === "ff" || traceId === ZERO32 || parentId === ZERO16) return undefined;
  return { traceId, parentId };
}
