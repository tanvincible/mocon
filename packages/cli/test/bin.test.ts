/**
 * The built binary as a user runs it: `node dist/bin.js`, as a child
 * process, against every golden stream and every invalid line, with the
 * ui server fetched over HTTP on 127.0.0.1 and `otlp --url` posting to a
 * local server that records the request.
 */

import assert from "node:assert/strict";
import { copyFileSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { assertBuilt, expectedOtlp, get, invalid, jsonl, mocon, recorder, startUi, stream, streams, tempDir, UNSAFE } from "./helpers.js";

before(assertBuilt);

test("validate exits 0 on every golden stream and prints OK", async () => {
  const runs = await Promise.all(streams.map((s) => mocon(["validate", s.path])));
  runs.forEach((r, i) => {
    const s = streams[i]!;
    assert.equal(r.status, 0, `${s.name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^${s.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\d+ lines, \\d+ skipped, 0 failed, 0 warnings -> OK\\n$`), s.name);
    assert.equal(r.stderr, "");
  });
});

test("validate exits 1 on every invalid line and names the line, unless the line is not JSON and is counted as skipped", async () => {
  const runs = await Promise.all(invalid.map((f) => mocon(["validate", f.path])));
  runs.forEach((r, i) => {
    const f = invalid[i]!;
    let json = true;
    try {
      JSON.parse(f.text);
    } catch {
      json = false;
    }
    if (!json) {
      // core.md 3: a line that is not a JSON object is skipped and counted by every consumer, never failed.
      assert.equal(r.status, 0, `${f.name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /: 1 lines, 1 skipped, 0 failed, 0 warnings -> OK\n/, f.name);
      return;
    }
    assert.equal(r.status, 1, `${f.name}: ${r.stdout}${r.stderr}`);
    // A line can fail a rule and trip a provenance.md 7 lint at once: `attested` holding a number does both.
    assert.match(r.stdout, /: 1 lines, 0 skipped, 1 failed, \d+ warnings -> FAIL\n/, f.name);
    assert.match(r.stdout, /^    line 1 (host|execution|crossing) /m, f.name);
  });
});

test("the exit code of validate is exactly whether some line has an error, warnings aside", async () => {
  const dir = tempDir();
  const warnOnly = join(dir, "warn.jsonl");
  writeFileSync(warnOnly, jsonl([{ kind: "host", host: "h", spec_version: "2.0" }]));
  const r = await mocon(["validate", warnOnly]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 warnings -> OK/);

  const typeError = join(dir, "type.jsonl");
  writeFileSync(typeError, jsonl([{ kind: "host", host: "h" }, { kind: "crossing", host: "h", id: "c", execution_id: "e", target: "t", input: { value: 1 }, seq: "1" }]));
  const t = await mocon(["validate", typeError]);
  assert.equal(t.status, 1);
  assert.match(t.stdout, /^    line 2 crossing c: crossing\.seq: must be a non-negative integer$/m);

  const skippedOnly = join(dir, "skipped.jsonl");
  writeFileSync(skippedOnly, "not json\n" + jsonl([{ kind: "metric", host: "h" }]));
  const s = await mocon(["validate", skippedOnly]);
  assert.equal(s.status, 0, "malformed lines and unknown kinds are counted, not failed");
  assert.match(s.stdout, /2 lines, 2 skipped, 0 failed/);
});

test("view prints a tree for every golden stream", async () => {
  const runs = await Promise.all(streams.map((s) => mocon(["view", s.path])));
  runs.forEach((r, i) => {
    assert.equal(r.status, 0, `${streams[i]!.name}: ${r.stderr}`);
    assert.match(r.stdout, /^\d+ hosts?, \d+ executions?, \d+ crossings?, \d+ unresolved, \d+ conflicts?, \d+ skipped, 0 flagged\n$/m);
  });
  const tree = runs[streams.findIndex((s) => s.name === "abandoned-at-end")]!.stdout;
  assert.match(tree, /^  3c95e2578dd5e0169e81c566e43fac92  terminated  5m0\.0s  javascript P/m);
  assert.match(tree, /└─ #2 connectors\.finance\.wireTransfer  abandoned$/m);
});

test("view escapes what a hostile stream puts in a target on its way to the terminal", async () => {
  const ESC = String.fromCharCode(0x1b);
  const file = join(tempDir(), "hostile.jsonl");
  writeFileSync(
    file,
    jsonl([
      { kind: "host", host: "h", observes_crossings: "all" },
      { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: ESC + "]0;pwned" + String.fromCharCode(0x07) + ESC + "[1A" + ESC + "[2K", input: { value: 1 }, end: { outcome: "output" } },
    ]),
  );
  const r = await mocon(["view", file]);
  assert.equal(r.status, 0);
  assert.equal(UNSAFE.exec(r.stdout.replace(/\n/g, "")), null);
  assert.ok(r.stdout.includes("\\x1b]0;pwned\\x07\\x1b[1A\\x1b[2K"));
});

test("otlp prints the request for every golden stream and counts what it skipped", async () => {
  const runs = await Promise.all(streams.map((s) => mocon(["otlp", s.path])));
  runs.forEach((r, i) => {
    const s = streams[i]!;
    assert.equal(r.status, 0, `${s.name}: ${r.stderr}`);
    const request = JSON.parse(r.stdout) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
    const spans = request.resourceSpans.reduce((n, rs) => n + rs.scopeSpans.reduce((m, ss) => m + ss.spans.length, 0), 0);
    assert.match(r.stderr, new RegExp(`^mocon otlp: ${spans} spans?; skipped: notice \\d+, malformed 0, unknown kind \\d+, bad enum 0, bad timestamp 0; host conflicts 0, other major versions 0\\n$`), s.name);
  });
  const sync = JSON.parse(runs[streams.findIndex((s) => s.name === "sync-bridge")]!.stdout) as { resourceSpans: unknown[] };
  assert.equal(sync.resourceSpans.length, (expectedOtlp("sync-bridge") as { resourceSpans: unknown[] }).resourceSpans.length);
});

test("otlp --url posts once with every --header, exits 0 on a 2xx and 1 otherwise", async () => {
  const collector = await recorder(200);
  try {
    const r = await mocon(["otlp", stream("sync-bridge").path, "--url", collector.url + "?api_key=s3cret", "--header", "Authorization=Bearer abc=", "--header", "x-tenant=t1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "nothing is printed when the request is posted");
    assert.match(r.stderr, new RegExp(`^mocon otlp: POST ${collector.url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} -> 200$`, "m"));
    assert.equal(collector.received.length, 1);
    assert.equal(collector.received[0]!.headers["authorization"], "Bearer abc=", "a value may itself contain =");
    assert.equal(collector.received[0]!.headers["x-tenant"], "t1");
    const printed = await mocon(["otlp", stream("sync-bridge").path]);
    const strip = (v: unknown): string => JSON.stringify(v).replace(/"(start|end)TimeUnixNano":"\d+"/g, "");
    assert.equal(strip(JSON.parse(collector.received[0]!.body)), strip(JSON.parse(printed.stdout)), "the posted request is the printed one");
    assert.ok(!r.stderr.includes("Bearer"), "header values never reach the terminal");
    assert.ok(!r.stderr.includes("s3cret"), "nor does a key in the query string");
    assert.equal(collector.received[0]!.url, "/v1/traces?api_key=s3cret", "the query string is still sent");
  } finally {
    await collector.close();
  }

  const refusing = await recorder(500);
  try {
    const r = await mocon(["otlp", stream("sync-bridge").path, "--url", refusing.url]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, / -> 500\n/);
    assert.match(r.stderr, /failed with 500/);
  } finally {
    await refusing.close();
  }

  const gone = await recorder(200);
  await gone.close();
  const unreachable = await mocon(["otlp", stream("sync-bridge").path, "--url", gone.url]);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, / -> no response\n/);
  assert.match(unreachable.stderr, /ECONNREFUSED/);
});

test("otlp refuses a malformed --header without echoing it, and --header without --url", async () => {
  const path = stream("sync-bridge").path;
  for (const bad of ["Authorization: Bearer s3cret", "=s3cret", "bad name=s3cret"]) {
    const r = await mocon(["otlp", path, "--url", "http://127.0.0.1:9/v1/traces", "--header", bad]);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--header takes name=value/);
    assert.ok(!r.stderr.includes("s3cret"), "a malformed pair may hold a credential");
  }
  const noUrl = await mocon(["otlp", path, "--header", "a=b"]);
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--header needs --url/);
});

test("ui --out writes the page and exits 0 without serving", async () => {
  const out = join(tempDir(), "page.html");
  const r = await mocon(["ui", stream("sync-bridge").path, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^mocon ui: wrote .*page\.html\n$/);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes('<script id="data" type="application/json">'));
  assert.ok(html.includes("company_identify"));
  if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
});

test("ui serves on 127.0.0.1 under a token, refuses a foreign Host, shows appended lines, and stops on ctrl-c", async () => {
  const file = join(tempDir(), "live.jsonl");
  copyFileSync(stream("sync-bridge").path, file);
  const ui = await startUi(file);
  try {
    assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
    const page = await fetch(ui.url);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("fetch('view.json'"));
    const view = async (): Promise<{ executions: number }> => (await (await fetch(ui.url + "view.json")).json()) as { executions: number };
    assert.equal((await view()).executions, 1);

    const origin = new URL(ui.url).origin;
    assert.equal((await fetch(origin + "/view.json")).status, 403, "no token, no stream");
    const rebound = await get(ui.url + "view.json", "attacker.example:" + new URL(ui.url).port);
    assert.equal(rebound.status, 421);
    assert.equal(rebound.body, "");

    appendFileSync(file, jsonl([{ kind: "execution", host: "example/mcp", id: "appended", program: { value: "p" }, start: "2026-09-16T11:00:00Z" }]));
    assert.equal((await view()).executions, 2, "a reload folds the file again");
  } finally {
    ui.child.kill("SIGINT");
  }
  const exit = await ui.exited;
  assert.ok(exit.signal === "SIGINT" || exit.status === 130, `exit ${JSON.stringify(exit)}`);
  await assert.rejects(fetch(ui.url), "nothing listens after ctrl-c");
});

test("ui exits 2 with a message on a bad --port or a port in use", async () => {
  for (const port of ["-1", "65536", "", "12ab", "1e3", "0x10"]) {
    const r = await mocon(["ui", stream("sync-bridge").path, `--port=${port}`]);
    assert.equal(r.status, 2, port);
    assert.match(r.stderr, /--port must be an integer between 0 and 65535/);
  }
  const first = await startUi(stream("sync-bridge").path);
  try {
    const r = await mocon(["ui", stream("sync-bridge").path, "--port", new URL(first.url).port]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^mocon: listen EADDRINUSE/);
  } finally {
    first.child.kill("SIGINT");
    await first.exited;
  }
});

test("usage errors exit 2, help exits 0", async () => {
  assert.equal((await mocon([])).status, 2);
  assert.equal((await mocon(["view"])).status, 2);
  const unknown = await mocon(["frobnicate", "x.jsonl"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command frobnicate/);
  const extra = await mocon(["view", stream("sync-bridge").path, "other.jsonl"]);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /unexpected argument other\.jsonl/);
  const option = await mocon(["ui", stream("sync-bridge").path, "--open"]);
  assert.equal(option.status, 2);
  assert.match(option.stderr, /Unknown option '--open'/);
  const missing = await mocon(["view", "/nonexistent/mocon.jsonl"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^mocon: ENOENT/);
  const help = await mocon(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: mocon <command> <file> \[options\]/);
});
