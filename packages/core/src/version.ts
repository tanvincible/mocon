/**
 * The version of spec/core.md this package implements, and the one rule a
 * consumer applies to a declared version (core.md 11).
 */

/** Every host line declares it. */
export const SPEC_VERSION = "1.0";

const MAJOR = SPEC_VERSION.slice(0, SPEC_VERSION.indexOf("."));

/**
 * Whether a declaration's `spec_version` is read under this version: absent,
 * which reads as this major, or a string whose major is this one. A
 * consumer that sees another major warns and may refuse.
 */
export function sameMajor(version: unknown): boolean {
  if (version === undefined) return true;
  if (typeof version !== "string") return false;
  const dot = version.indexOf(".");
  return (dot === -1 ? version : version.slice(0, dot)) === MAJOR;
}
