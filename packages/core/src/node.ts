/**
 * Sinks that write to a file descriptor with a synchronous call, so nothing is
 * buffered and nothing needs a flush at exit: a line either reached the
 * descriptor before the call returned or the call threw. No process hook is
 * installed.
 *
 * A batch is written in pieces of about `PIECE` characters, so nothing the sink
 * builds grows with the batch: a program that leaves many calls open makes a
 * large abandon batch, and one string holding all of it could pass the engine's
 * string limit.
 *
 * A pipe, socket or terminal can be full. Both sinks write non-blocking. A
 * write that finds it full sleeps in one-millisecond steps for up to
 * `PATIENCE_MS` in all, then gives the rest of its batch up with an error
 * counting the lines lost. The descriptor is then known stalled: a write that
 * finds it still full gives up at once, and the first write to get a byte
 * through gets the patience again, so a stalled reader costs one wait and not
 * one per write.
 */

import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";
import type { Sink } from "./types.js";

/**
 * Opens `path` once, appending. The stream holds program text and payloads,
 * so a regular file is owner-readable only, and an existing one others can
 * read or write is made so before anything is written, or refused. A
 * symbolic link is followed only to a pipe, socket or character device such
 * as `/dev/stderr`; anything else is refused, so a link planted at the path
 * cannot send the stream into another file. The holding directory should be
 * owner-writable. Opened non-blocking, so neither the open nor a write waits
 * on a pipe's reader.
 */
export function fileSink(path: string): Sink {
  const fd = openStream(path);
  let open = true;
  const sink = descriptorSink(fd);
  return {
    write(lines) {
      if (open) sink.write(lines);
    },
    close() {
      if (open) {
        open = false;
        closeSync(fd);
      }
    },
  };
}

/**
 * Writes to fd 2 synchronously, which `process.stderr.write` is not on every
 * platform when stderr is a pipe. Never stdout: in a stdio MCP server that
 * is the JSON-RPC channel. Node opens a piped fd 2 non-blocking, so a
 * stalled reader turns a write into EAGAIN and the patience above applies.
 */
export function stderrSink(): Sink {
  return descriptorSink(2);
}

const OWNER_ONLY = 0o600;

function openStream(path: string): number {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NONBLOCK = 0, O_NOFOLLOW = 0 } = constants;
  const flags = O_WRONLY | O_APPEND | O_NONBLOCK;
  let fd: number;
  let linked = false;
  try {
    fd = openSync(path, flags | O_CREAT | O_NOFOLLOW, OWNER_ONLY);
  } catch (e) {
    // Symlink as the last component: ELOOP on Linux and macOS, EMLINK on
    // FreeBSD. Reopened only where it already leads, never created there.
    const code = (e as { code?: unknown }).code;
    if (code !== "ELOOP" && code !== "EMLINK") throw e;
    fd = openSync(path, flags);
    linked = true;
  }
  try {
    const stat = fstatSync(fd);
    const stream = stat.isFIFO() || stat.isSocket() || stat.isCharacterDevice();
    if (linked && !stream) throw Object.assign(new Error(`mocon: ${path} is a symbolic link to a file; name the file itself`), { code: "ELOOP" });
    if (stat.isFile() && (stat.mode & 0o077) !== 0) fchmodSync(fd, OWNER_ONLY);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** Characters a piece holds before it is written, past one longer line. */
const PIECE = 1 << 20;
/** How long one write waits in all for a full descriptor. */
const PATIENCE_MS = 100;

class StallError extends Error {
  override readonly name = "StallError";
  readonly code = "EAGAIN";
}

function descriptorSink(fd: number): Sink & { write(lines: readonly string[]): void } {
  let stalled = false;
  let torn = false;
  let sleeper: Int32Array | undefined;
  const sleep = (): void => {
    sleeper ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleeper, 0, 0, 1);
  };
  return {
    write(lines) {
      let waited = 0;
      /** Lines written before the piece being written. */
      let first = 0;
      // A batch after a torn one starts fresh: the torn line stays one line.
      let text = torn ? "\n" : "";
      let lead = text.length;
      for (let i = 0; i < lines.length; i++) {
        text += lines[i] + "\n";
        if (text.length < PIECE && i < lines.length - 1) continue;
        const buf = Buffer.from(text, "utf8");
        text = "";
        let offset = 0;
        while (offset < buf.length) {
          try {
            offset += writeSync(fd, buf, offset, buf.length - offset);
            stalled = false;
          } catch (e) {
            if (offset > 0) torn = buf[offset - 1] !== 0x0a;
            if ((e as { code?: unknown }).code !== "EAGAIN") throw e;
            if (stalled || waited >= PATIENCE_MS) {
              stalled = true;
              const lost = lines.length - first - newlines(buf, lead, offset);
              throw new StallError(`mocon: the descriptor stayed full${waited === 0 ? "" : ` for ${waited} ms`}; ${lost} of ${lines.length} lines were not written`);
            }
            sleep();
            waited++;
          }
        }
        torn = false;
        first = i + 1;
        lead = 0;
      }
    },
  };
}

/** The line ends in `buf` from `start` up to `end`. */
function newlines(buf: Buffer, start: number, end: number): number {
  let n = 0;
  for (let i = buf.indexOf(0x0a, start); i !== -1 && i < end; i = buf.indexOf(0x0a, i + 1)) n++;
  return n;
}
