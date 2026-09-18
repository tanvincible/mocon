/** The version of spec/core.md this package implements (core.md 11). */

/** Every host line declares it. */
export const SPEC_VERSION = "1.0";

const MAJOR = SPEC_VERSION.slice(0, SPEC_VERSION.indexOf("."));

/**
 * Absent reads as this major; otherwise the string's major must match. A
 * consumer that sees another major warns and may refuse.
 */
export function sameMajor(version: unknown): boolean {
  if (version === undefined) return true;
  if (typeof version !== "string") return false;
  const dot = version.indexOf(".");
  return (dot === -1 ? version : version.slice(0, dot)) === MAJOR;
}
