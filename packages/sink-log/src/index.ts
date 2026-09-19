/**
 * @mocon/sink-log: one mocon line as one flat log record.
 *
 * A log backend facets on named fields. A record that arrives as one JSON
 * blob inside one field is data every panel is blind to, which is how a
 * team ends up with richer records and a worse dashboard. `flatten` turns a
 * line into a flat object whose keys are names a query can spell, and
 * `logSink` writes those objects wherever the host's own log lines already
 * go.
 *
 * The projection needs no configuration because the host already declared
 * it. core.md 5.1.1 gives every `ext` key the host means something by an
 * `agg`, a `unit` and a `card`, on the host line of every stream. So: core
 * fields this package knows are promoted under fixed names, every declared
 * `ext` key is promoted under a name derived from its key, and everything
 * else rides in `mocon`, the original line, where it cannot explode the
 * column space. The host's declaration is the allow-list, which is why the
 * column space is bounded by something the host already writes.
 *
 * Every promoted value is a scalar. A nested array of objects spread into
 * columns is what makes a log backend fall over, so nothing nested is ever
 * promoted; `mocon` carries it as text, the way a host that hit this hazard
 * JSON-encodes a field on purpose.
 */

import type { HostLine, Sink } from "@mocon/core";
import { CLOSED, canonical, dimensionsOf, sameMajor } from "@mocon/core/fold";

/** One line, flat: every value is a scalar a log backend can index. */
export type FlatRecord = Record<string, string | number | boolean>;

/**
 * Where `logSink` writes. A function takes the record as it is, which is
 * what a structured logger wants (`(r) => log.info(r)`); anything with a
 * `write` gets one JSON object per line, which is what a stream wants.
 */
export type LogWriter = ((record: FlatRecord) => void) | { write(chunk: string): unknown };

/** On every record, so `ev:mocon` selects these lines and nothing else does. */
const EV = "mocon";

/**
 * The names core fields are promoted under. A declared `ext` key whose
 * derived name lands here is not promoted: `disposition` has to be core.md's
 * disposition on every line that carries one, or a panel grouping by it is
 * counting two different things.
 *
 * `mocon_host` rather than `host`: `host` is one of the names a log pipeline
 * takes for itself (below), and the record's host string is the one field
 * that scopes every id in it, so losing it silently is not an option.
 */
const CORE: ReadonlySet<string> = new Set([
  "ev",
  "kind",
  "mocon",
  "mocon_host",
  "exec_id",
  "crossing_id",
  "target",
  "seq",
  "session",
  "traceparent",
  "language",
  "duration_ms",
  "disposition",
  "outcome",
  "ok",
  "error_class",
  "error_message",
  "program_bytes",
  "program_hash",
]);

/**
 * Names a log pipeline takes for itself. A shipper sets its own stream and
 * metadata fields and deletes the app's before flattening — one deployment's
 * transform drops `app`, `origin`, `pod_name`, `pod_namespace`, `node_name`,
 * `container_name` and `container_image` — and a logger writes its own level,
 * time, host and message alongside whatever it is handed. A promoted key that
 * lands on one of these either never arrives or overwrites the line's own
 * field, and both failures are silent. So it is not promoted, and its value
 * is in `mocon` like any other. The names the backends reserve for themselves
 * (`_time`, `_msg`, `_stream`) are excluded by the name shape below.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "app",
  "container_image",
  "container_name",
  "host",
  "hostname",
  "level",
  "message",
  "msg",
  "name",
  "node_name",
  "origin",
  "pid",
  "pod_name",
  "pod_namespace",
  "source_type",
  "time",
  "timestamp",
]);

/** A name a query can spell unquoted in any of the common log languages, which also rules out a leading `_`. */
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * `ok` is "the host confirmed a normal end": `completed` on an execution,
 * `output` on a crossing. `failed` and `error` are the host confirming a
 * non-normal one, and `terminated` is the host stopping the run on its own
 * limit — none of them produced what was asked for. `abandoned` gets no `ok`
 * at all, because the host never determined an end: core.md 12 refuses the
 * reading that the target never answered, and `false` would assert it. Those
 * records still carry `disposition` or `outcome`, which is the distinction
 * they actually make.
 */
const OK: ReadonlyMap<unknown, boolean> = new Map<unknown, boolean>([
  ["completed", true],
  ["failed", false],
  ["terminated", false],
  ["output", true],
  ["error", false],
]);

const EMPTY: ReadonlyMap<string, Promoted> = new Map();

/** Host strings whose declaration a sink holds. One sink usually reads one. */
const MAX_HOSTS = 64;
/** Bytes of a host line a sink will hold: `dimensions` and `ext` are open, and nothing else bounds them. */
const MAX_DECLARATION_BYTES = 64 * 1024;

interface Promoted {
  name: string;
  /** `sum` and `last` apply only to a JSON number (core.md 5.1.1). */
  numeric: boolean;
}

/**
 * Derived once per declaration object. A `WeakMap` because the map belongs
 * to the declaration and dies with it: this package holds no registry of its
 * own.
 */
const NAMES = new WeakMap<object, ReadonlyMap<string, Promoted>>();

/**
 * The name a declared `ext` key is promoted under: the key with its `vendor.`
 * namespace dropped, any further dot turned into an underscore. The namespace
 * goes because that is what puts the log field name under the host's control
 * with no configuration anywhere — a host whose panels read `dry_run` declares
 * `vendor.dry_run` and the panel keeps working. Two namespaces that both
 * declare `guard` would give one field two meanings, so neither is promoted;
 * likewise a name a pipeline or a core field has already taken, or one a query
 * cannot spell. In every one of those cases the value is still in `mocon`.
 */
function promoted(declaration: HostLine | undefined): ReadonlyMap<string, Promoted> {
  if (declaration === null || typeof declaration !== "object") return EMPTY;
  const cached = NAMES.get(declaration);
  if (cached !== undefined) return cached;
  // dimensionsOf drops an entry whose `agg` is missing or unknown to this version, which leaves its key undeclared (core.md 8).
  const dimensions = dimensionsOf(declaration);
  const claimed = new Map<string, string | null>();
  for (const key of Object.keys(dimensions)) {
    const name = key.slice(key.indexOf(".") + 1).replace(/\./g, "_");
    if (!NAME.test(name) || CORE.has(name) || RESERVED.has(name)) continue;
    claimed.set(name, claimed.has(name) ? null : key);
  }
  const map = new Map<string, Promoted>();
  for (const [name, key] of claimed) {
    if (key === null) continue;
    const agg = dimensions[key]?.agg;
    map.set(key, { name, numeric: agg === "sum" || agg === "last" });
  }
  NAMES.set(declaration, map);
  return map;
}

/**
 * The one gate every value passes through, so nothing nested, null or
 * non-finite can reach a column. An empty string is left out: a log backend
 * reads an empty field and a missing one the same way, and the missing one
 * costs nothing.
 */
function put(out: FlatRecord, name: string, value: unknown): void {
  if (typeof value === "string") {
    if (value !== "") out[name] = value;
  } else if (typeof value === "number") {
    if (Number.isFinite(value)) out[name] = value;
  } else if (typeof value === "boolean") out[name] = value;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Both readings are the declaring host's own, in one clock domain (core.md 7), so their difference is the record's own span. */
function duration(start: unknown, end: unknown): number | undefined {
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * One mocon line as a flat log record. Never throws: a line that is not one
 * JSON object still comes back as a record carrying the text, because a sink
 * that drops what it cannot read is the failure this package exists to undo.
 *
 * `declaration` is the `host` record for this line's host string (core.md
 * 5.1), and without one no `ext` key is promoted — core.md 12 forbids
 * treating an undeclared key as meaningful, and here that rule is also what
 * bounds the columns.
 */
export function flatten(line: string, declaration?: HostLine): FlatRecord {
  return build(line, typeof line === "string" ? parse(line) : undefined, declaration);
}

function build(line: string, rec: Record<string, unknown> | undefined, declaration: HostLine | undefined): FlatRecord {
  const out: FlatRecord = { ev: EV };
  if (typeof line === "string") out.mocon = line;
  if (rec === undefined) return out;

  const kind = rec["kind"];
  put(out, "kind", kind);
  put(out, "mocon_host", rec["host"]);
  if (kind === "execution") {
    put(out, "exec_id", rec["id"]);
    put(out, "language", rec["language"]);
  } else {
    // `execution_id` names the same thing on a crossing and on every extension kind that carries it.
    put(out, "exec_id", rec["execution_id"]);
    if (kind === "crossing") {
      put(out, "crossing_id", rec["id"]);
      put(out, "target", rec["target"]);
      put(out, "seq", rec["seq"]);
    }
  }

  const context = object(rec["context"]);
  if (context !== undefined) {
    put(out, "session", context["session"]);
    put(out, "traceparent", context["traceparent"]);
  }
  const program = object(rec["program"]);
  if (program !== undefined) {
    // The two fields that match one run against another when the text is truncated or withheld (core.md 5.2).
    put(out, "program_bytes", program["bytes"]);
    put(out, "program_hash", program["hash"]);
  }

  if (kind === "execution" || kind === "crossing") {
    const end = object(rec["end"]);
    const field = kind === "execution" ? "disposition" : "outcome";
    const settled = end?.[field];
    // A value outside a closed set makes the whole `end` read as absent, which leaves the record a notice (core.md 8).
    if (end !== undefined && CLOSED[field].has(settled)) {
      out[field] = settled as string;
      const ok = OK.get(settled);
      if (ok !== undefined) out.ok = ok;
      const ms = duration(rec["start"], end["time"]);
      if (ms !== undefined) out.duration_ms = ms;
      const error = object(end["error"]);
      if (error !== undefined) {
        put(out, "error_class", error["class"]);
        put(out, "error_message", error["message"]);
      }
    }
  }

  const ext = object(rec["ext"]);
  if (ext === undefined) return out;
  const names = promoted(declaration);
  if (names.size === 0) return out;
  for (const key of Object.keys(ext)) {
    const entry = names.get(key);
    if (entry === undefined) continue;
    const value = ext[key];
    // A value that does not match its `agg` reads as undeclared for this record (core.md 5.1.1): displayed, never
    // aggregated. `put` drops the rest — an object or an array is not declarable and is not a column either, and a
    // `null` is "no value", which a missing field says and a promoted null would not.
    if (entry.numeric && typeof value !== "number") continue;
    put(out, entry.name, value);
  }
  return out;
}

/**
 * A `Sink` that writes each line as a flat record, so mocon arrives where
 * the host's telemetry already arrives, in a shape its queries read.
 *
 * Stateless but for the host declarations it reads out of the stream, which
 * core.md 5.1 puts once at the head of every stream and permits a consumer
 * to hold per host string. Nothing is buffered, nothing is timed, and one
 * line in is one record out.
 */
export function logSink(to: LogWriter): Sink {
  const write = typeof to === "function" ? to : undefined;
  const stream = write === undefined ? object(to) : undefined;
  if (write === undefined && typeof stream?.["write"] !== "function") {
    throw new TypeError("mocon sink-log: logSink takes a function or something with a write method");
  }
  const emit = write ?? ((record: FlatRecord): void => void (stream as { write(chunk: string): unknown }).write(JSON.stringify(record) + "\n"));
  const hosts = new Map<string, { declaration: HostLine; canon: string }>();

  /** core.md 5.1: one declaration per host string, the one whose canonical JSON sorts first when two differ (core.md 4 rule 3). */
  const remember = (rec: Record<string, unknown>, line: string): HostLine | undefined => {
    const host = rec["host"];
    if (typeof host !== "string") return undefined;
    // Another major may mean something else by `agg`, and a declaration held past a cap is memory a stream can grow.
    if (!sameMajor(rec["spec_version"]) || line.length > MAX_DECLARATION_BYTES) return hosts.get(host)?.declaration;
    const held = hosts.get(host);
    if (held === undefined) {
      if (hosts.size < MAX_HOSTS) hosts.set(host, { declaration: rec as unknown as HostLine, canon: canonical(line) });
      return hosts.get(host)?.declaration;
    }
    const canon = canonical(line);
    if (canon < held.canon) hosts.set(host, { declaration: rec as unknown as HostLine, canon });
    return hosts.get(host)?.declaration;
  };

  return {
    write(lines: readonly string[]): void {
      for (const line of lines) {
        // Only text: an object handed over in its place is never serialized here, so none of its code runs inside the sink.
        if (typeof line !== "string") continue;
        const rec = parse(line);
        const declaration =
          rec === undefined ? undefined : rec["kind"] === "host" ? remember(rec, line) : typeof rec["host"] === "string" ? hosts.get(rec["host"] as string)?.declaration : undefined;
        emit(build(line, rec, declaration));
      }
    },
  };
}
