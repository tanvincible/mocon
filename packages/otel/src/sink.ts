/**
 * The OTLP/JSON sink. One `write` from the emitter is one host action, so
 * it becomes one POST carrying every span that batch produced, and no POST
 * at all when it produced none. Nothing is buffered across writes and
 * nothing waits for a matching line.
 *
 * Each request carries an `AbortSignal` that expires after `timeoutMs`,
 * so a collector that accepts a connection and never answers costs one
 * request and one error, not a `flush` that never resolves. The signal
 * belongs to the request: the sink starts no timer of its own and holds
 * none between writes.
 */

import type { HostLine, Sink } from "@mocon/core";
import { canonical, sameMajor } from "@mocon/core/fold";
import { buildRequest, mapLine, type Mapped, type SkipReason } from "./map.js";

/** The part of `fetch` the sink uses, so a test can hand in a stand-in. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; body?: ReadableStream<Uint8Array> | null }>;

export interface OtlpSinkOptions {
  /** The collector's traces endpoint, usually ending in `/v1/traces`. Credentials go in `headers`, never in the URL. */
  url: string;
  /** Sent on every request, after `content-type: application/json`. */
  headers?: Record<string, string>;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Cap in UTF-8 bytes on every string attribute written from a record value (otel-mapping.md 9). Default: none. */
  cap?: number;
  /** How long one POST may take before it is aborted. Default: `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface OtlpSink extends Sink {
  /** Lines that produced no span since the sink was created, by reason (otel-mapping.md 3). */
  readonly skipped: Readonly<Record<SkipReason, number>>;
  /** Host re-declarations seen with values that differed from the one held. */
  readonly conflicts: number;
  /** Host declarations of another major version than this package reads, counted and not held (core.md 11). */
  readonly versionMismatches: number;
  /**
   * Host declarations the sink did not hold, because the host string was
   * past `MAX_HOSTS` or the line was longer than `MAX_DECLARATION_BYTES`.
   * Their spans carry no `mocon.host.*` and read as attesting nothing.
   */
  readonly declarationsDropped: number;
  /** Resolves when every POST in flight has settled, whether it succeeded or not. */
  flush(): Promise<void>;
  /** The same wait as `flush`: the sink owns no socket, timer or dispatcher of its own to release, only the POSTs. */
  close(): Promise<void>;
}

/** Host strings whose declaration the sink holds. A declaration for a further host string is not stored. */
const MAX_HOSTS = 256;
/**
 * Bytes of a host line the sink will hold. A declaration carries the five
 * capability fields and an `ext`, and nothing bounds that `ext`: a stream
 * can declare a megabyte of it per host string, and the sink would hold it
 * until the process ends. The count alone is not a bound on memory, so
 * this is the other half of it. A longer line is not held and is counted,
 * so its spans read as they would before any declaration — the same
 * outcome as a host string past `MAX_HOSTS`, and visible in the same
 * counter.
 */
const MAX_DECLARATION_BYTES = 64 * 1024;
/** Concurrent POSTs. A write that arrives past the bound is dropped and its promise rejects. */
const MAX_IN_FLIGHT = 64;
/** Bytes of a failed response's body the error quotes. Nothing more of any body is read. */
const EXCERPT_BYTES = 200;
/** Reads the excerpt makes. A body sent a few bytes at a time is quoted as far as these reach, which is the collector's choice, not the host's cost. */
const EXCERPT_READS = 32;
/** How long one POST may take before its signal aborts it. */
const DEFAULT_TIMEOUT_MS = 10_000;

export function otlpSink(options: OtlpSinkOptions): OtlpSink {
  const { url, cap, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const endpoint = printable(url);
  if (cap !== undefined && !(Number.isSafeInteger(cap) && cap >= 0)) throw new RangeError("mocon otel: cap must be a non-negative integer");
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new RangeError("mocon otel: timeoutMs must be a positive number of milliseconds");
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof doFetch !== "function") throw new TypeError("mocon otel: no fetch available; pass one in options");
  const headers = { "content-type": "application/json", ...options.headers };
  try {
    new Headers(headers);
  } catch {
    // Not the platform's message: it repeats the offending value, which is usually a credential.
    throw new TypeError("mocon otel: headers must be valid HTTP header names and values");
  }

  const hosts = new Map<string, { declaration: HostLine; canon: string }>();
  const skipped: Record<SkipReason, number> = { notice: 0, malformed: 0, unknown_kind: 0, bad_enum: 0, bad_timestamp: 0 };
  const inFlight = new Set<Promise<void>>();
  let conflicts = 0;
  let versionMismatches = 0;
  let declarationsDropped = 0;

  const lookup = (host: string): HostLine | undefined => hosts.get(host)?.declaration;

  // otel-mapping.md 2: one declaration per host string, the one that sorts first by canonical JSON when they differ.
  // A declaration of another major is not held: core.md 11 lets a consumer refuse it, and an `attested` list whose
  // meaning this package does not know must not lift a provenance label.
  const remember = (declaration: HostLine, line: string): void => {
    if (!sameMajor(declaration.spec_version)) {
      versionMismatches++;
      return;
    }
    // Before the line is canonicalized, so an oversized declaration costs no more than the text it arrived as.
    if (line.length > MAX_DECLARATION_BYTES) {
      declarationsDropped++;
      return;
    }
    const canon = canonical(line);
    const held = hosts.get(declaration.host);
    if (held === undefined) {
      if (hosts.size < MAX_HOSTS) hosts.set(declaration.host, { declaration, canon });
      else declarationsDropped++;
      return;
    }
    if (held.canon === canon) return;
    conflicts++;
    if (canon < held.canon) hosts.set(declaration.host, { declaration, canon });
  };

  /** Resolves when every POST in flight has settled: both `flush` and `close` are this wait and nothing else. */
  const settle = async (): Promise<void> => {
    await Promise.allSettled([...inFlight]);
  };

  const post = async (body: string): Promise<void> => {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      // A redirect is not followed: fetch strips only `authorization` on a cross-origin hop, and a vendor key header would go along.
      response = await deadline(doFetch(url, { method: "POST", headers, body, redirect: "manual", signal }), signal);
    } catch (e) {
      throw new Error(`mocon otel: POST ${endpoint} failed: ${reason(e)}`, { cause: e });
    }
    // A collector, or anything on the path to an http endpoint, chooses the size, the number and the pace of its body's chunks: an accepted request's body is never read, and a failed one's only as far as the excerpt.
    if (response.ok) {
      await response.body?.cancel().catch(ignore);
      return;
    }
    const text = await excerpt(response.body, signal);
    throw new Error(`mocon otel: POST ${endpoint} failed with ${response.status}${text === "" ? "" : ": " + text}`);
  };

  return {
    skipped,
    get conflicts() {
      return conflicts;
    },
    get versionMismatches() {
      return versionMismatches;
    },
    get declarationsDropped() {
      return declarationsDropped;
    },
    write(lines: readonly string[]) {
      const spans: Array<Extract<Mapped, { kind: "span" }>> = [];
      for (const line of lines) {
        // Only text: an object handed over in its place is never serialized here, so none of its code runs inside the sink.
        if (typeof line !== "string") {
          skipped.malformed++;
          continue;
        }
        const m = mapLine(line, lookup, cap);
        if (m.kind === "span") spans.push(m);
        else if (m.kind === "skip") skipped[m.reason]++;
        else remember(m.declaration, line);
      }
      if (spans.length === 0) return undefined;
      if (inFlight.size >= MAX_IN_FLIGHT) {
        return Promise.reject(new Error(`mocon otel: ${MAX_IN_FLIGHT} POSTs in flight to ${endpoint}; a write of ${spans.length} spans was dropped`));
      }
      const tracked: Promise<void> = post(JSON.stringify(buildRequest(spans))).finally(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
      return tracked;
    },
    flush: settle,
    close: settle,
  };
}

/**
 * The collector URL as the sink's errors print it: origin and path. A
 * query string or fragment, where some collectors take a key, is left out.
 * A URL that carries userinfo is refused, because `fetch` refuses it too
 * and prints the whole URL, password included, in its error.
 */
function printable(url: unknown): string {
  if (typeof url !== "string" || url === "") throw new TypeError("mocon otel: url must be a non-empty string");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("mocon otel: url must be an absolute URL");
  }
  if (parsed.username !== "" || parsed.password !== "") throw new TypeError("mocon otel: url must not carry credentials; send them in headers");
  return (parsed.origin === "null" ? parsed.protocol : parsed.origin) + parsed.pathname;
}

function ignore(): void {}

/**
 * `request`, or a rejection with the signal's reason once it aborts,
 * whichever settles first. `fetch` gives up on the signal by itself; a
 * stand-in need not, so the deadline is kept here too. A listener on an
 * already-aborted signal never fires, which is what the first line is for.
 * `AbortSignal.timeout` does not hold the event loop open.
 */
function deadline<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return Promise.race([request, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true }))]);
}

/**
 * The first `EXCERPT_BYTES` of a body as text, the stream cancelled after;
 * empty when there is no body, it fails to read, or the deadline passes.
 *
 * The collector chooses how large each chunk is, how many it sends and
 * when, so all three are bounded here: each chunk is copied only as far as
 * the excerpt still has room for, the reads are counted, and every read
 * runs under the same signal as the request. A body of any size therefore
 * costs the host 200 bytes and the deadline the POST already had.
 */
async function excerpt(body: ReadableStream<Uint8Array> | null | undefined, signal: AbortSignal): Promise<string> {
  if (body === null || body === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = body.getReader();
    for (let read = 0; size < EXCERPT_BYTES && read < EXCERPT_READS; read++) {
      const { done, value } = await deadline(reader.read(), signal);
      if (done || value === undefined) break;
      // A copy, not a view: the chunk it was taken from, however large, is released as the loop goes round.
      const kept = value.slice(0, EXCERPT_BYTES - size);
      chunks.push(kept);
      size += kept.byteLength;
    }
  } catch {
    // A body that fails to read costs the excerpt, not the error that reports the status.
  } finally {
    await reader?.cancel().catch(ignore);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A fetch failure in one line: its message, and its cause's, which is where undici says what went wrong. */
function reason(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message;
}
