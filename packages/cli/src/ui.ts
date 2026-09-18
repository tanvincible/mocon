/**
 * `mocon ui`: a local server on 127.0.0.1 that serves the page and the
 * folded view as JSON, or one self-contained HTML file with `--out`.
 * node:http only. The file is folded again on every `view.json` request,
 * so a reload shows lines appended since.
 *
 * The stream holds program text and payloads, which is why emitters write
 * it readable by its owner only. The server keeps it that way: it answers
 * only under a random path token printed at startup, which keeps other
 * local users out, and only to a `Host` header naming the loopback address
 * it listens on, which keeps out a page that rebinds its own name to
 * 127.0.0.1.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { stringifyDeep } from "@mocon/core/fold";
import { buildModel } from "./model.js";
import { page } from "./page.js";
import { safe } from "./text.js";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'";
const TEXT = "text/plain; charset=utf-8";

/** The folded view as the page's JSON. */
export function viewJson(file: string): string {
  return stringifyDeep({ file: basename(file), ...buildModel(readFileSync(file, "utf8")) });
}

export interface UiServer {
  /** `http://127.0.0.1:<port>/<token>/`, the only place the page is served. */
  url: string;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1. Port 0 picks a free port; the resolved `url` carries the bound one and the token. */
export async function serveUi(file: string, port: number): Promise<UiServer> {
  viewJson(file); // an unreadable file rejects here, before anything listens
  const token = randomBytes(16).toString("hex");
  const secret = Buffer.from(token);
  const server = createServer((req, res) => {
    if (!loopbackHost(req)) return send(res, 421, TEXT, "");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, TEXT, "method not allowed\n");
    // Read by hand: `new URL` throws on a request target Node's parser accepts, and nothing here needs more than the path.
    const target = req.url ?? "/";
    const query = target.search(/[?#]/);
    const path = query === -1 ? target : target.slice(0, query);
    const slash = path.indexOf("/", 1);
    const segment = Buffer.from(slash === -1 ? path.slice(1) : path.slice(1, slash));
    if (segment.length !== secret.length || !timingSafeEqual(segment, secret)) return send(res, 403, TEXT, "open the URL mocon ui printed\n");
    const rest = slash === -1 ? "" : path.slice(slash);
    if (rest === "") return send(res, 308, TEXT, "", { location: `/${token}/` });
    if (rest === "/") return send(res, 200, "text/html; charset=utf-8", page());
    if (rest === "/view.json") {
      try {
        return send(res, 200, "application/json; charset=utf-8", viewJson(file));
      } catch (e) {
        // The path came from the command line and the message from the platform, but both reach a terminal
        // through `curl` as readily as a browser, so neither goes out with a control character in it.
        return send(res, 500, TEXT, safe(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`));
      }
    }
    return send(res, 404, TEXT, "not found\n");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${bound}/${token}/`,
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections();
            server.close((e) => (e === undefined ? done() : fail(e)));
          }),
      });
    });
  });
}

/**
 * Writes the page with the view inlined, readable by its owner only.
 * Nothing is served. The page carries the whole stream, program text and
 * payload values included, so the final path component is opened without
 * following a symbolic link, checked to be a regular file, and set to
 * owner-only before it is emptied, whether the open created it or found
 * it: a path this cannot make private keeps what it held.
 *
 * The open is non-blocking, because the check that refuses anything but a
 * regular file can only run once the open returns: a FIFO planted at the
 * path would otherwise hold `open` until a reader arrived, which is
 * indefinitely, and the refusal would never be reached. `O_NONBLOCK` makes
 * that open fail with ENXIO instead, and it has no effect on a regular
 * file, which is the only kind of file this goes on to write.
 */
export function writeUi(file: string, out: string): void {
  const html = page(viewJson(file));
  const { O_WRONLY, O_CREAT, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;
  const fd = openSync(out, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, OWNER_ONLY);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${out} is not a regular file`);
    fchmodSync(fd, OWNER_ONLY);
    ftruncateSync(fd, 0);
    const buffer = Buffer.from(html, "utf8");
    for (let at = 0; at < buffer.length; ) at += writeSync(fd, buffer, at, buffer.length - at);
  } finally {
    closeSync(fd);
  }
}

const OWNER_ONLY = 0o600;

/** Whether the request names the address this connection reached: `127.0.0.1` or `localhost`, with the port unless it is 80. */
function loopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host?.toLowerCase();
  const port = req.socket.localPort;
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
  return port === 80 && (host === "127.0.0.1" || host === "localhost");
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": CSP,
    ...headers,
  });
  res.end(body);
}
