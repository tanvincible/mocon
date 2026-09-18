/**
 * Test support: the conformance suite's golden streams, expected views,
 * invalid lines and OTLP documents; the spec schema from packages/testkit; scratch
 * directories; a runner for the built `mocon` binary; and a local HTTP
 * server that records what it receives.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { lineSchema, specDir } from "../../testkit/schema.js";

export { specDir };
export const packageDir = fileURLToPath(new URL("../", import.meta.url));
export const conformanceDir = specDir + "conformance/";

export interface Fixture {
  name: string;
  path: string;
  text: string;
}

function list(dir: string): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => ({ name: f.slice(0, -6), path: dir + f, text: readFileSync(dir + f, "utf8") }));
}

export const streams = list(conformanceDir + "streams/");
export const invalid = list(conformanceDir + "invalid/");

export function stream(name: string): Fixture {
  const found = streams.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no golden stream named ${name}`);
  return found;
}

export function expectedView(name: string): {
  executions: Record<string, Record<string, unknown>>;
  crossings: Record<string, Record<string, unknown>>;
  unresolved: unknown[];
  conflicts: unknown[];
  skipped: number;
} {
  return JSON.parse(readFileSync(`${conformanceDir}expected/${name}.json`, "utf8"));
}

export function expectedOtlp(name: string): unknown {
  return JSON.parse(readFileSync(`${conformanceDir}otlp/${name}.json`, "utf8"));
}

/** Any character `safe` must never let through to a terminal. */
export const UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]");

/** Lines as JSONL text. */
export const jsonl = (lines: readonly unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Whether spec/schema/line.json accepts the parsed line. */
export function schemaAccepts(line: unknown): boolean {
  return lineSchema(line) === true;
}

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory, removed when the file's tests finish. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mocon-cli-"));
  scratch.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* The built binary                                                    */
/* ------------------------------------------------------------------ */

export const binPath = packageDir + "dist/bin.js";

/** Fails loudly when `dist` is missing or older than `src`, so a stale build never passes as tested. */
export function assertBuilt(): void {
  assert.ok(existsSync(binPath), `${binPath} is missing: run npm run build`);
  for (const f of readdirSync(packageDir + "src")) {
    if (!f.endsWith(".ts")) continue;
    const built = packageDir + "dist/" + f.slice(0, -3) + ".js";
    assert.ok(existsSync(built) && statSync(built).mtimeMs >= statSync(packageDir + "src/" + f).mtimeMs, `dist/${f.slice(0, -3)}.js is older than src/${f}: run npm run build`);
  }
}

export interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs `node dist/bin.js ...args` to completion without blocking the event loop, so a server in this process can answer it. */
export function mocon(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd: packageDir, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

export interface UiChild {
  url: string;
  child: ChildProcess;
  /** Resolves with the exit once the child has gone. */
  exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts `mocon ui <file> --port 0` and resolves with the URL it prints. */
export function startUi(file: string): Promise<UiChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, "ui", file, "--port", "0"], { cwd: packageDir, stdio: ["ignore", "ignore", "pipe"] });
    const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((done) => child.on("exit", (status, signal) => done({ status, signal })));
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      const m = / at (http:\/\/\S+) \(ctrl-c to stop\)/.exec(stderr);
      if (m?.[1] !== undefined) resolve({ url: m[1], child, exited });
    });
    child.on("error", reject);
    void exited.then(({ status }) => reject(new Error(`mocon ui exited ${status} before serving:\n${stderr}`)));
  });
}

/* ------------------------------------------------------------------ */
/* A recording HTTP server                                             */
/* ------------------------------------------------------------------ */

export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Recorder {
  url: string;
  received: Received[];
  close(): Promise<void>;
}

/** Listens on 127.0.0.1, records each request and answers `status`. */
export function recorder(status = 200): Promise<Recorder> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (body += d));
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status < 300 ? "" : "collector says no");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1/traces`,
        received,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A GET with an explicit `Host` header, which `fetch` does not let a caller set. */
export function get(url: string, host?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: host === undefined ? {} : { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
