/**
 * Timestamps (core.md 7): RFC 3339, UTC, a `Z` suffix and up to nine
 * fractional digits. A clock belongs to one instance, reads with millisecond
 * precision, and never returns a reading earlier than the one before, so a
 * wall clock stepped backwards cannot put one of its own readings before
 * another.
 */
export type Clock = () => string;

export function createClock(): Clock {
  let last = 0;
  let second = -1;
  let prefix = "";
  let reading = "";
  return () => {
    const now = Date.now();
    if (now <= last && reading !== "") return reading;
    const ms = (last = now);
    const s = Math.floor(ms / 1000);
    if (s !== second) {
      second = s;
      prefix = new Date(s * 1000).toISOString().slice(0, 20);
    }
    const frac = ms - s * 1000;
    return (reading = prefix + (frac < 10 ? "00" + frac : frac < 100 ? "0" + frac : String(frac)) + "Z");
  };
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Unix nanoseconds as a decimal string, for an RFC 3339 UTC timestamp with a
 * `Z` suffix; `undefined` for anything else, a date that does not exist such
 * as February 30 included. A leap second, `:60`, reads as the first second of
 * the next minute. The one timestamp validator every package here applies.
 */
export function unixNanos(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = RFC3339.exec(value);
  if (m === null) return undefined;
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (hour > 23 || minute > 59 || second > 60) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(Number(m[1]), month, day);
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  const seconds = date.getTime() / 1000 + hour * 3600 + minute * 60 + second;
  const fraction = m[7] === undefined ? "000000000" : m[7].padEnd(9, "0");
  if (seconds > 0) return String(seconds) + fraction;
  if (seconds === 0) return String(Number(fraction));
  return (BigInt(seconds) * 1000000000n + BigInt(fraction)).toString();
}

/** Both must already have validated; compared as text, fractions padded. */
export function earlier(a: string, b: string): boolean {
  return sortable(a) < sortable(b);
}

/**
 * `reading`, or `floor` when earlier. A host-given `start` may be ahead of
 * this clock, so a default `end.time` never falls before it (core.md 7).
 */
export function notBefore(reading: string, floor: string): string {
  return earlier(reading, floor) ? floor : reading;
}

function sortable(t: string): string {
  return t.charCodeAt(19) === 46 ? t.slice(0, -1).padEnd(29, "0") : t.slice(0, 19) + ".000000000";
}
