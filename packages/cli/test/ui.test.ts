import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveUi, viewJson, writeUi } from "../src/ui.js";
import { get, jsonl, stream, tempDir } from "./helpers.js";

interface Crossing {
  record: { seq?: number; target: string };
  provenance: Record<string, string>;
}

/** The connect outcome to `host:port`: the error code, "connected", or "timeout". */
function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve("timeout");
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "error"));
  });
}

/** One raw request line and headers, for request targets `fetch` will not send. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (data += d));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write(text);
  });
}

test("the ui server returns the page and the view JSON under its token on 127.0.0.1", async () => {
  const ui = await serveUi(stream("sync-bridge").path, 0);
  try {
    assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);

    const page = await fetch(ui.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.ok(html.includes("<title>mocon</title>"));
    assert.ok(html.includes('id="app"'));
    assert.ok(html.includes("fetch('view.json'"), "the served page loads the view from the server, relative to its own path");
    assert.ok(!html.includes('id="data"'), "nothing is inlined when serving");
    assert.ok(!/<script[^>]*src=|<link[^>]*href=/.test(html), "no external resources");

    const json = await fetch(ui.url + "view.json");
    assert.equal(json.status, 200);
    assert.match(json.headers.get("content-type") ?? "", /^application\/json/);
    const view = (await json.json()) as {
      file: string;
      executions: number;
      flagged: number;
      sessions: Array<{ session: string | null; executions: Array<{ id: string; durationMs: number | null; crossings: Crossing[] }> }>;
    };
    assert.equal(view.file, "sync-bridge.jsonl");
    assert.equal(view.executions, 1);
    assert.equal(view.flagged, 0);
    assert.equal(view.sessions[0]?.session, "mcp-9a1f0c");
    const ex = view.sessions[0]?.executions[0];
    assert.equal(ex?.id, "a218a2b4ccf7ed00ce2e656895419c7d");
    assert.equal(ex?.durationMs, 1902);
    assert.deepEqual(ex?.crossings.map((c) => c.record.target), ["company_identify", "person_search"]);
    assert.deepEqual(ex?.crossings[0]?.provenance, { "end.output.value": "P" });

    assert.equal((await fetch(ui.url + "nope")).status, 404);
    assert.equal((await fetch(ui.url, { method: "POST" })).status, 405);
    const head = await fetch(ui.url + "view.json", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await ui.close();
  }
});

test("without the token nothing is served: another local user who finds the port gets no stream", async () => {
  const ui = await serveUi(stream("sync-bridge").path, 0);
  try {
    const origin = new URL(ui.url).origin;
    const token = new URL(ui.url).pathname.slice(1, -1);
    for (const path of ["/", "/view.json", "/" + "0".repeat(32) + "/view.json", "/" + token.slice(0, -1) + "/view.json", "/" + token + "x/view.json", "/" + token.toUpperCase() + "/view.json"]) {
      const r = await fetch(origin + path);
      assert.equal(r.status, 403, path);
      assert.ok(!(await r.text()).includes("company_identify"), path);
    }
    const redirect = await fetch(origin + "/" + token, { redirect: "manual" });
    assert.equal(redirect.status, 308, "the token without its trailing slash redirects to the page");
    assert.equal(redirect.headers.get("location"), "/" + token + "/");
    assert.equal((await fetch(origin + "/" + token + "/view.json?cache=no")).status, 200, "a query string does not change the route");
    const other = await serveUi(stream("sync-bridge").path, 0);
    try {
      assert.notEqual(new URL(other.url).pathname, new URL(ui.url).pathname, "each server draws its own token");
    } finally {
      await other.close();
    }
  } finally {
    await ui.close();
  }
});

test("DNS rebinding: a Host header that is not the bound loopback address is refused with no body", async () => {
  const ui = await serveUi(stream("sync-bridge").path, 0);
  try {
    const port = new URL(ui.url).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await get(ui.url + "view.json", host)).status, 200, host);
    }
    for (const host of ["attacker.example", `attacker.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`, `127.0.0.1.attacker.example:${port}`]) {
      for (const path of ["view.json", ""]) {
        const r = await get(ui.url + path, host);
        assert.equal(r.status, 421, `${host} ${path}`);
        assert.equal(r.body, "", `${host} ${path}`);
      }
    }
    const path = new URL(ui.url).pathname + "view.json";
    const empty = await raw(Number(port), `GET ${path} HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n`);
    assert.match(empty, /^HTTP\/1\.1 (400|421) /, "an empty Host");
    const none = await raw(Number(port), `GET ${path} HTTP/1.0\r\n\r\n`);
    assert.match(none, /^HTTP\/1\.1 (400|421) /, "no Host at all");
    assert.ok(!(empty + none).includes("company_identify"));
  } finally {
    await ui.close();
  }
});

test("the server is reachable on 127.0.0.1 only", async () => {
  const ui = await serveUi(stream("sync-bridge").path, 0);
  try {
    const port = Number(new URL(ui.url).port);
    assert.equal(await probe("127.0.0.1", port), "connected");
    assert.equal(await probe("::1", port), "ECONNREFUSED");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && !i.internal && i.family === "IPv4");
    if (external !== undefined) assert.notEqual(await probe(external.address, port), "connected", `reachable on ${external.address}`);
  } finally {
    await ui.close();
  }
});

test("a request target the URL parser rejects gets an answer, and the server keeps serving", async () => {
  const ui = await serveUi(stream("sync-bridge").path, 0);
  try {
    const port = Number(new URL(ui.url).port);
    for (const target of ["http://%zz/", "//", "*", "/" + "a".repeat(4000)]) {
      const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      assert.match(answer, /^HTTP\/1\.1 (400|403) /, target);
    }
    assert.equal((await fetch(ui.url + "view.json")).status, 200);
  } finally {
    await ui.close();
  }
});

test("view.json is folded again on each request: appended lines show on reload, and an unreadable file is a 500", async () => {
  const file = join(tempDir(), "live.jsonl");
  copyFileSync(stream("unresolved").path, file);
  const ui = await serveUi(file, 0);
  try {
    const view = async (): Promise<{ executions: number; unresolved: unknown[] }> => (await (await fetch(ui.url + "view.json")).json()) as { executions: number; unresolved: unknown[] };
    const before = await view();
    assert.equal(before.unresolved.length, 1);
    appendFileSync(file, jsonl([{ kind: "execution", host: "h", id: "later", program: { value: "p" }, start: "2026-09-16T10:00:00Z", end: { time: "2026-09-16T10:00:01Z", disposition: "completed" } }]));
    assert.equal((await view()).executions, before.executions + 1);
    unlinkSync(file);
    const gone = await fetch(ui.url + "view.json");
    assert.equal(gone.status, 500);
    assert.match(await gone.text(), /^cannot read .*live\.jsonl: ENOENT/);
  } finally {
    await ui.close();
  }
});

test("serveUi fails before listening on an unreadable file, and on a port in use", async () => {
  await assert.rejects(serveUi(join(tempDir(), "missing.jsonl"), 0), /ENOENT/);
  const ui = await serveUi(stream("sync-bridge").path, 0);
  try {
    await assert.rejects(serveUi(stream("sync-bridge").path, Number(new URL(ui.url).port)), /EADDRINUSE/);
  } finally {
    await ui.close();
  }
});

test("--out writes one self-contained page, owner-readable, with the view inlined and script-closing text escaped", () => {
  const dir = tempDir();
  const file = join(dir, "hostile.jsonl");
  const program = "</script><script>alert(1)</script><!-- x";
  writeFileSync(
    file,
    jsonl([
      { kind: "host", host: "h", observes_crossings: "none" },
      { kind: "execution", host: "h", id: "e1", program: { value: program }, start: "2026-09-16T10:00:00Z", end: { time: "2026-09-16T10:00:01Z", disposition: "completed" } },
    ]),
  );
  const out = join(dir, "page.html");
  writeUi(file, out);
  const html = readFileSync(out, "utf8");
  assert.ok(!html.includes("</script><script>alert"), "the program text cannot close the data block");
  const block = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(block !== null && block[1] !== undefined);
  const inlined = JSON.parse(block[1]) as { sessions: Array<{ executions: Array<{ record: { program: { value: string } } }> }> };
  assert.equal(inlined.sessions[0]?.executions[0]?.record.program.value, program, "the escaped block round-trips");
  assert.equal(JSON.parse(viewJson(file)).executions, 1);
  if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600, "the page holds the stream, so it is as private as the stream");
});

test("--out onto a pre-existing world-readable file leaves the page owner-readable, whatever mode the file had", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const file = join(dir, "stream.jsonl");
  writeFileSync(file, jsonl([{ kind: "execution", host: "h", id: "e", program: { value: "api_key=sk-secret" }, start: "2026-09-16T10:00:00Z" }]));
  const out = join(dir, "page.html");
  writeFileSync(out, "stale ".repeat(200_000));
  chmodSync(out, 0o644);
  writeUi(file, out);
  const mode = statSync(out).mode & 0o777;
  assert.equal(mode & 0o077, 0, `the page holding the program text sits at mode ${mode.toString(8)}, readable by others`);
  const page = readFileSync(out, "utf8");
  assert.ok(page.includes("api_key=sk-secret"), "the page was not written at all, so the mode says nothing");
  assert.ok(!page.includes("stale"), "what the file held before is still in it after the page, which is longer");
});

test("--out onto a planted symbolic link is refused, not followed into what it names", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const file = join(dir, "stream.jsonl");
  writeFileSync(file, jsonl([{ kind: "execution", host: "h", id: "e", program: { value: "p" }, start: "2026-09-16T10:00:00Z" }]));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "original\n", { mode: 0o644 });
  const link = join(dir, "link.html");
  symlinkSync(victim, link);
  assert.throws(() => writeUi(file, link), "a page was written through the link");
  assert.equal(readFileSync(victim, "utf8"), "original\n", "the page was written through a planted link into the file it named");
});

test("--out onto something that is not a regular file is refused before it is emptied or its mode is changed", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const file = join(dir, "stream.jsonl");
  writeFileSync(file, jsonl([{ kind: "execution", host: "h", id: "e", program: { value: "p" }, start: "2026-09-16T10:00:00Z" }]));
  const before = statSync("/dev/null").mode & 0o777;
  assert.throws(() => writeUi(file, "/dev/null"), /not a regular file/, "a device took the page, and its mode");
  assert.equal(statSync("/dev/null").mode & 0o777, before);
});
