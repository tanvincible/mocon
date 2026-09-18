/**
 * Runs the viewer page's script outside a browser over a small DOM that
 * follows the parts of the platform the script touches, including that
 * `append` turns a non-Node argument into text, `null` included. Every
 * golden stream is rendered with every session and execution selected.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildModel } from "../src/model.js";
import { page } from "../src/page.js";
import { viewJson } from "../src/ui.js";
import { jsonl, stream, streams, tempDir } from "./helpers.js";

interface Dom {
  /** Places where a null or undefined child was appended and became the text "null" or "undefined". */
  nullAppends: string[];
  /** Elements by their `id` attribute. */
  ids: Map<string, Element>;
}

class Node {
  parentNode: Element | null = null;
  get textContent(): string {
    return "";
  }
}

class Text extends Node {
  constructor(readonly data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
}

class Element extends Node {
  readonly children: Node[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Array<(e: unknown) => void>>();
  className = "";
  hidden = false;
  open = false;
  constructor(
    readonly tagName: string,
    private readonly dom: Dom,
  ) {
    super();
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) this.listeners.set(type, [fn]);
    else list.push(fn);
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs.set(k, String(v));
    if (k === "id") this.dom.ids.set(String(v), this);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  append(...nodes: unknown[]): void {
    for (const n of nodes) {
      if (n instanceof Node) {
        n.parentNode = this;
        this.children.push(n);
      } else {
        if (n === null || n === undefined) this.dom.nullAppends.push(`${this.tagName}.${this.className}`);
        this.children.push(new Text(String(n)));
      }
    }
  }
  replaceChildren(...nodes: unknown[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  override set textContent(v: string) {
    this.children.length = 0;
    this.children.push(new Text(String(v)));
  }
  /** This element and every element under it, in document order. */
  all(): Element[] {
    const out: Element[] = [];
    const stack: Element[] = [this];
    while (stack.length > 0) {
      const e = stack.pop()!;
      out.push(e);
      for (let i = e.children.length - 1; i >= 0; i--) {
        const c = e.children[i];
        if (c instanceof Element) stack.push(c);
      }
    }
    return out;
  }
  find(pred: (e: Element) => boolean): Element[] {
    return this.all().filter(pred);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn({ stopPropagation() {} });
  }
  /** What a browser does when a `details` element is opened or closed. */
  toggle(): void {
    this.open = !this.open;
    for (const fn of this.listeners.get("toggle") ?? []) fn({});
  }
}

interface Document {
  title: string;
  body: Element;
  createElement(tag: string): Element;
  getElementById(id: string): Element | null;
}

function makeDocument(inline: string | undefined): { document: Document; dom: Dom } {
  const dom: Dom = { nullAppends: [], ids: new Map() };
  const body = new Element("body", dom);
  const withId = (tag: string, id: string): Element => {
    const e = new Element(tag, dom);
    e.setAttribute("id", id);
    body.append(e);
    return e;
  };
  for (const id of ["file", "counts", "hosts", "sessions", "main"]) withId("div", id);
  withId("button", "reload").hidden = true;
  // The page inlines the JSON with `<` escaped; the DOM hands the script the escaped text.
  if (inline !== undefined) withId("script", "data").textContent = inline.replace(/</g, "\\u003c");
  const document: Document = {
    title: "",
    body,
    createElement: (tag) => new Element(tag, dom),
    getElementById: (id) => dom.ids.get(id) ?? null,
  };
  return { document, dom };
}

function scriptOf(html: string): string {
  const m = /\n<script>([\s\S]*)<\/script>\n<\/body>/.exec(html);
  assert.ok(m?.[1] !== undefined, "the page carries one inline script before </body>");
  return m[1];
}

function boot(inline: string | undefined, fetchImpl?: (url: string) => Promise<unknown>): { document: Document; dom: Dom } {
  const { document, dom } = makeDocument(inline);
  const fetch = fetchImpl ?? (() => Promise.reject(new Error("no network")));
  runInNewContext(scriptOf(page(inline)), { document, Node, fetch, console });
  return { document, dom };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Opens every closed `details` under `root`, including ones that opening another one added. */
function openAll(root: Element): void {
  for (let closed = root.find((e) => e.tagName === "details" && !e.open); closed.length > 0; closed = root.find((e) => e.tagName === "details" && !e.open)) {
    for (const d of closed) d.toggle();
  }
}

const by =
  (tag: string, cls?: string) =>
  (e: Element): boolean =>
    e.tagName === tag && (cls === undefined || e.className === cls);

function fileWith(lines: unknown[]): string {
  const file = join(tempDir(), "stream.jsonl");
  writeFileSync(file, jsonl(lines));
  return file;
}

for (const s of streams) {
  test(`the page renders ${s.name}: every session and every execution`, () => {
    const { document, dom } = boot(viewJson(s.path));
    const model = buildModel(s.text);
    assert.equal(document.title, `mocon ${s.name}.jsonl`);
    const main = (): Element => document.getElementById("main")!;
    const buttons = document.getElementById("sessions")!.find((e) => e.tagName === "button" && e.className.startsWith("session"));
    assert.equal(buttons.length, model.sessions.length);
    buttons.forEach((button, si) => {
      button.click();
      const expected = model.sessions[si]!.executions;
      const rows = main().find((e) => e.tagName === "tr" && e.listeners.has("click"));
      assert.equal(rows.length, expected.length);
      rows.forEach((row, ei) => {
        row.click();
        const sections = main().find(by("section", "execution"));
        assert.equal(sections.length, 1);
        assert.ok(sections[0]!.textContent.includes(expected[ei]!.id));
        const node = expected[ei]!;
        const timed = node.crossings.some((c) => typeof c.record.start === "string");
        if (node.crossings.length > 0) {
          assert.equal(sections[0]!.find(by("div", "timeline")).length, timed ? 1 : 0, "a timeline only when a crossing has a host-clock start");
          assert.equal(sections[0]!.find(by("ul", "crossings")).length, timed ? 0 : 1);
        }
        for (const c of node.crossings) assert.ok(sections[0]!.textContent.includes(String(c.record.target)));
        const bodies = (): number => sections[0]!.find(by("div", "cbody")).length;
        assert.equal(bodies(), 0, "a crossing body is built only when its row is opened");
        openAll(sections[0]!);
        assert.equal(bodies(), node.crossings.length);
        const rows = sections[0]!.find((e) => e.tagName === "details" && e.listeners.has("toggle"));
        rows[0]?.toggle();
        rows[0]?.toggle();
        assert.equal(bodies(), node.crossings.length, "closing and reopening a row does not build its body twice");
      });
    });
    assert.match(document.getElementById("counts")!.textContent, / · 0 flagged$/);
    assert.deepEqual(dom.nullAppends, [], "a null child was appended and rendered as the text 'null'");
  });
}

test("badges follow the provenance map on the rendered page", () => {
  const { document } = boot(viewJson(stream("crossing-error").path));
  openAll(document.getElementById("main")!);
  const badges = document.getElementById("main")!.find((e) => e.tagName === "span" && e.className.startsWith("badge "));
  const classes = new Set(badges.map((b) => b.className));
  assert.ok(classes.has("badge T"), "attested output and error are target-relayed");
  assert.ok(classes.has("badge P"), "program, result and outputs are program-determined");
  for (const b of badges) assert.ok(b.attrs.get("title")?.includes("program-determined") || b.attrs.get("title")?.includes("target-relayed"));
});

test("the served page fetches view.json, reloads on demand, and reports a failed load", async () => {
  const model: unknown = JSON.parse(viewJson(stream("sync-bridge").path));
  const urls: string[] = [];
  const ok = boot(undefined, (url) => {
    urls.push(url);
    return Promise.resolve({ ok: true, status: 200, json: async () => model });
  });
  await tick();
  assert.deepEqual(urls, ["view.json"], "a relative URL, so the request stays under the token path the page was served from");
  assert.equal(ok.document.title, "mocon sync-bridge.jsonl");
  const reload = ok.document.getElementById("reload")!;
  assert.equal(reload.hidden, false);
  reload.click();
  await tick();
  assert.equal(urls.length, 2);

  const bad = boot(undefined, () => Promise.resolve({ ok: false, status: 500 }));
  await tick();
  assert.match(bad.document.getElementById("main")!.textContent, /could not load view\.json: HTTP 500/);
});

test("the page shows an unknown closed-set or mistyped capability as absent and counts flagged lines", () => {
  const file = fileWith([
    { kind: "host", host: "h", spec_version: 1, observes_crossings: "most", unmediated_egress: "false", crossing_edge: "sideways", attested: ["crossing.target", 5] },
    { kind: "execution", host: "h", id: "e1", program: { value: "x" }, start: "2026-09-16T10:00:00Z", end: { time: "2026-09-16T10:00:01Z", disposition: "success" } },
  ]);
  const { document } = boot(viewJson(file));
  const hosts = document.getElementById("hosts")!.textContent;
  assert.match(hosts, /spec_version absent · observes_crossings absent \(none\) · unmediated_egress absent \(unknown\) · crossing_edge absent · attested crossing\.target$/);
  assert.match(document.getElementById("counts")!.textContent, /1 unresolved · 0 conflicts · 0 skipped · 2 flagged$/);
  const main = document.getElementById("main")!;
  assert.match(main.textContent, /running/);
  assert.doesNotMatch(main.textContent, /success/);
});

test("control characters and bidirectional marks in a record are shown as visible escapes, in text and in attributes", () => {
  const ch = (code: number): string => String.fromCharCode(code);
  const RLO = ch(0x202e);
  const file = fileWith([
    { kind: "host", host: "h", observes_crossings: "all" },
    { kind: "execution", host: "h", id: "e1", program: { value: "line one\r\n\tline two" + ch(0x1b) + "[2J" }, start: "2026-09-16T10:00:00Z", end: { time: "2026-09-16T10:00:02Z", disposition: "completed" } },
    { kind: "crossing", host: "h", id: "c1", execution_id: "e1", target: "crm." + RLO + "etadpu", input: { value: 1 }, start: "2026-09-16T10:00:00Z" + ch(0x9b), end: { outcome: "output", time: "2026-09-16T10:00:01Z" } },
  ]);
  const { document } = boot(viewJson(file));
  const main = document.getElementById("main")!;
  const text = main.textContent;
  assert.ok(text.includes("crm.\\u202eetadpu"), "the override is shown, not applied");
  assert.ok(!text.includes(RLO));
  const pre = main.find((e) => e.tagName === "pre")[0]!;
  assert.equal(pre.textContent, "line one\r\n\tline two\\x1b[2J", "program text keeps its line breaks and tabs");
  for (const e of main.all()) for (const v of e.attrs.values()) assert.ok(!v.includes(ch(0x9b)), "attribute values are escaped too");
});

test("a long execution renders its timeline without spreading every time into one call", () => {
  const lines: unknown[] = [
    { kind: "host", host: "h", observes_crossings: "all" },
    { kind: "execution", host: "h", id: "e1", program: { value: "x" }, start: "2026-09-16T10:00:00Z", end: { time: "2026-09-16T11:00:00Z", disposition: "completed" } },
  ];
  for (let i = 0; i < 70_000; i++) {
    lines.push({ kind: "crossing", host: "h", id: `c${i}`, execution_id: "e1", target: "t", input: { value: i }, seq: i, start: "2026-09-16T10:00:01Z", end: { outcome: "output", time: "2026-09-16T10:00:02Z" } });
  }
  const { document } = boot(viewJson(fileWith(lines)));
  const timeline = document.getElementById("main")!.find(by("div", "timeline"))[0]!;
  assert.equal(timeline.children.length, 1 + 70_000, "an axis and one row per crossing: 140,002 times, past the arguments a spread call can take");
});

test("the file name is escaped like everything else the page shows: a name carrying a control character or a bidirectional mark reaches neither the header nor the title raw", () => {
  const ch = (code: number): string => String.fromCharCode(code);
  const RLO = ch(0x202e);
  const ESC = ch(0x1b);
  // The name comes from the command line, not from the stream, but it lands in the same header the stream's
  // own values do, and in the document title, where a terminal-style escape or an override is as good a lie.
  const dir = tempDir();
  const name = `a${RLO}b${ESC}[31mc.jsonl`;
  const file = join(dir, name);
  writeFileSync(file, jsonl([{ kind: "host", host: "h", observes_crossings: "all" }]));
  const { document } = boot(viewJson(file));
  const shown = document.getElementById("file")!.textContent;
  assert.ok(!shown.includes(RLO) && !shown.includes(ESC), `the header shows the name raw: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes("\\u202e") && shown.includes("\\x1b"), `the name is not shown as escapes: ${JSON.stringify(shown)}`);
  assert.ok(!document.title.includes(RLO) && !document.title.includes(ESC), `the title carries the name raw: ${JSON.stringify(document.title)}`);
});
