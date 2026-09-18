/**
 * The terminal tree for `mocon view`. Each program-determined or
 * target-relayed field carries a `P` or `T` marker after its value; a
 * marker after the target covers `seq` and `end.outcome`, which follow it
 * (provenance.md 3). Host-observed fields carry no marker. Every line goes
 * through `safe` on the way out, so nothing in the stream reaches the
 * terminal as a control character, and every value the stream chose — a
 * payload, and equally an id, a target, a session or an error class —
 * goes through `field` or `payload`, so nothing in it reaches the terminal
 * longer than the width either.
 */

import type { HostLine } from "@mocon/core";
import { payloadFlags, type CrossingNode, type ExecutionNode, type Model } from "./model.js";
import type { ProvenanceMap } from "./provenance.js";
import { head, isRecord, quoted, safe } from "./text.js";

const WIDTH = 100;
/**
 * Code units of a value the display reads. Escaping never shortens a
 * string, so the first `WIDTH + 1` of them decide every cut, and `head`
 * writes no more of a value than that whatever its shape: a value a
 * program made 5 MB long costs what a 100-character one costs to show.
 */
const SCAN = WIDTH + 1;
/** Entries of `attested` the host line shows. A declaration naming more says how many it holds back. */
const ATTESTED_ENTRIES = 8;

export function renderView(model: Model): string {
  const out: string[] = [];
  for (const h of model.hosts) out.push(hostLine(h));
  if (model.hosts.length === 0) out.push("no host declaration: attested reads as [], observes_crossings as none");
  for (const s of model.sessions) {
    out.push(s.session === null ? "session (none)" : `session ${field(s.session)}`);
    for (const ex of s.executions) renderExecution(ex, out);
  }
  out.push(
    `${model.hosts.length} host${plural(model.hosts.length)}, ${model.executions} execution${plural(model.executions)}, ` +
      `${model.crossings} crossing${plural(model.crossings)}, ${model.unresolved.length} unresolved, ${model.conflicts.length} conflict${plural(model.conflicts.length)}, ` +
      `${model.skipped} skipped, ${model.flagged} flagged`,
  );
  return out.map(safe).join("\n") + "\n";
}

function hostLine(h: HostLine): string {
  return (
    `host ${field(h.host)}  spec_version ${field(h.spec_version ?? "absent")}  observes_crossings ${field(h.observes_crossings ?? "absent (none)")}  ` +
    `unmediated_egress ${field(h.unmediated_egress ?? "absent (unknown)")}  crossing_edge ${field(h.crossing_edge ?? "absent")}  attested ${attestedText(h.attested)}`
  );
}

/** The declaration's `attested` list: at most `ATTESTED_ENTRIES` entries, each cut to the width, and a count of the rest. */
function attestedText(list: unknown): string {
  if (!Array.isArray(list) || list.length === 0) return "none";
  const shown = list.slice(0, ATTESTED_ENTRIES);
  const more = list.length - shown.length;
  return cut(shown.map((entry) => head(entry, SCAN)).join(", ")) + (more > 0 ? ` (+${more} more)` : "");
}

function renderExecution(ex: ExecutionNode, out: string[]): void {
  const r = ex.record;
  const m = ex.provenance;
  if (r === null) {
    out.push(`  ${field(ex.id)}  no execution record  host ${field(ex.host)}`);
  } else {
    const state = ex.running ? "running" : field(r.end?.disposition);
    const parts = [field(ex.id), state + (ex.conflict ? " (conflict)" : ""), fmtDuration(ex.durationMs), r.language === undefined ? "" : field(r.language) + mark(m, "language"), `start ${field(r.start)}`];
    out.push("  " + parts.filter((s) => s !== "").join("  "));
    const context: unknown = r.context;
    if (isRecord(context) && context["traceparent"] !== undefined) out.push(`    traceparent ${field(context["traceparent"])}`);
    if (r.program !== undefined) out.push(`    program${mark(m, "program.value")}  ${programLine(r.program)}`);
  }
  ex.crossings.forEach((c, i) => renderCrossing(c, i === ex.crossings.length - 1, out));
  const end: unknown = r?.end;
  if (isRecord(end)) {
    if (end["error"] !== undefined) out.push(`    error  ${errorText(end["error"], m, "end.error")}`);
    if (end["result"] !== undefined) out.push(`    result  ${payload(end["result"], m, "end.result.value")}`);
    const outputs = end["outputs"];
    if (isRecord(outputs)) for (const channel of Object.keys(outputs)) out.push(`    ${field(channel)}  ${payload(outputs[channel], m, `end.outputs.${channel}.value`)}`);
  }
  if (r?.ext !== undefined) out.push(`    ext  ${field(r.ext)}${mark(m, "ext")}`);
}

function renderCrossing(c: CrossingNode, last: boolean, out: string[]): void {
  const r = c.record;
  const m = c.provenance;
  const branch = last ? "└─ " : "├─ ";
  const indent = last ? "     " : "│    ";
  const seq = typeof r.seq === "number" ? `#${r.seq} ` : "";
  const state = c.running ? "running" : field(r.end?.outcome);
  const parts = [seq + field(r.target) + mark(m, "target"), state + (c.conflict ? " (conflict)" : ""), fmtDuration(c.durationMs)];
  out.push("    " + branch + parts.filter((s) => s !== "").join("  "));
  out.push(`    ${indent}input  ${payload(r.input, m, "input.value")}`);
  const end: unknown = r.end;
  if (isRecord(end) && end["outcome"] === "output" && end["output"] !== undefined) out.push(`    ${indent}output  ${payload(end["output"], m, "end.output.value")}`);
  if (isRecord(end) && end["outcome"] === "error" && end["error"] !== undefined) out.push(`    ${indent}error  ${errorText(end["error"], m, "end.error")}`);
  if (r.ext !== undefined) out.push(`    ${indent}ext  ${field(r.ext)}${mark(m, "ext")}`);
}

function errorText(e: unknown, m: ProvenanceMap, prefix: string): string {
  if (!isRecord(e)) return "(not an Error object)";
  const parts = [field(e["class"]) + mark(m, `${prefix}.class`)];
  if (e["message"] !== undefined) parts.push(cutQuoted(e["message"]) + mark(m, `${prefix}.message`));
  if (isRecord(e["value"])) parts.push("value " + payload(e["value"], m, `${prefix}.value`));
  return parts.join("  ");
}

/** The value's preview, its marker, then its out-of-band flags. */
function payload(p: unknown, m: ProvenanceMap, field: string): string {
  const flags = payloadFlags(p);
  return preview(p) + mark(m, field) + (flags.length > 0 ? `  (${flags.join(", ")})` : "");
}

function mark(m: ProvenanceMap, field: string): string {
  const c = m[field];
  return c === undefined ? "" : " " + c;
}

/** The first line of the program text, then its size and hash so two executions can be matched (core.md 5.2). */
function programLine(p: unknown): string {
  if (!isRecord(p)) return "(not a Payload)";
  const meta: string[] = payloadFlags(p);
  if (!meta.some((f) => f.endsWith("bytes")) && typeof p["bytes"] === "number") meta.push(`${p["bytes"]} bytes`);
  const hash = p["hash"];
  if (typeof hash === "string") meta.push(hash.length > 16 ? hash.slice(0, 15) + "…" : hash);
  const note = meta.length > 0 ? `  (${meta.join(", ")})` : "";
  const value = p["value"];
  if (value === undefined) return "(no value)" + note;
  const all = head(value, SCAN);
  const first = all.length > SCAN ? all.slice(0, SCAN) : all;
  const nl = first.indexOf("\n");
  return cut(nl === -1 ? first : first.slice(0, nl) + "…") + note;
}

/** One line of display for a Payload's value: its serialization, cut to the column width, or its type when it is nested deeper than the width can show. Never interpreted (core.md 5.4). */
function preview(p: unknown): string {
  if (!isRecord(p)) return "(not a Payload)";
  const value = p["value"];
  if (value === undefined) return "(no value)";
  return cut(p["truncated"] === true && typeof value === "string" ? value : head(value, SCAN));
}

/**
 * Any field the stream chose — an id, a host string, a target, a session,
 * a language, a timestamp, a channel name, an error class, a closed-set
 * value — shown like a value: at most `WIDTH` characters, with no more
 * than `SCAN` of it read. Every one of these is a program's or a host's
 * choice and none is bounded by core.md, so a line cannot flood the
 * terminal through a field the display treats as short.
 */
function field(v: unknown): string {
  return cut(head(v, SCAN));
}

/** At most `WIDTH` code points of `s`, made safe first so an escape counts toward the width it takes, reading no more of it than the cut can show. */
function cut(s: string): string {
  const start = s.length > SCAN ? s.slice(0, SCAN) : s;
  const clean = safe(start);
  if (start.length === s.length && clean.length <= WIDTH) return clean;
  const chars = Array.from(clean.slice(0, WIDTH + 1));
  return chars.slice(0, WIDTH).join("") + "…";
}

/** A value as its JSON literal, cut to the width, quoting no more of a string than the cut shows. */
function cutQuoted(v: unknown): string {
  return cut(typeof v === "string" ? quoted(v.length > SCAN ? v.slice(0, SCAN) : v) : head(v, SCAN));
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(3)}s`;
  return `${sign}${Math.floor(abs / 60_000)}m${((abs % 60_000) / 1000).toFixed(1)}s`;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
