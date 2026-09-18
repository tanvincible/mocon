/**
 * Cheap checks at the state boundaries of the handle and capture code. A
 * failed invariant is a bug in this package, never a bad input: bad input
 * is rejected with a TypeError or RangeError before any state changes.
 * The README lists every invariant under "Invariants".
 */

export class InvariantError extends Error {
  override readonly name = "InvariantError";
  readonly code = "ERR_MOCON_INVARIANT";

  constructor(message: string) {
    super("mocon invariant: " + message);
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}
