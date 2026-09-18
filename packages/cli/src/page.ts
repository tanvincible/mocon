/**
 * The viewer page for `mocon ui`: one HTML document with inline CSS and
 * JS and no network access beyond `view.json` on the same origin. Every
 * value from the stream enters the DOM as a text node or an attribute
 * through `el`, never as markup, so nothing in a record is parsed as HTML,
 * and `el` writes control characters and bidirectional formatting marks
 * as visible escapes, so a record cannot reorder or hide what is shown.
 * With `--out` the folded view is inlined instead, with `<` escaped so a
 * program containing `</script>` cannot end the block.
 */

/** The page. With `inline` (the view as JSON text) it is self-contained; without, it fetches `view.json`. */
export function page(inline?: string): string {
  const data = inline === undefined ? "" : `<script id="data" type="application/json">${inline.replace(/</g, "\\u003c")}</script>\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'">
<title>mocon</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <strong>mocon</strong>
  <span id="file" class="muted"></span>
  <span id="counts" class="small"></span>
  <button id="reload" type="button" hidden>reload</button>
</header>
<div id="hosts"></div>
<div id="app">
  <nav id="sessions"></nav>
  <main id="main"><p class="muted">loading</p></main>
</div>
${data}<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root { --fg:#1b1b1b; --muted:#666; --line:#e3e3e3; --panel:#f6f6f6; --ok:#1e7f3c; --bad:#b3261e; --warn:#a15c00; --grey:#777; }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.45 system-ui, sans-serif; color:var(--fg); background:#fff; }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; padding:10px 16px; border-bottom:1px solid var(--line); }
#hosts { padding:6px 16px; border-bottom:1px solid var(--line); font-size:13px; }
#hosts .host { overflow-wrap:anywhere; }
#app { display:grid; grid-template-columns:260px 1fr; min-height:calc(100vh - 90px); }
#sessions { border-right:1px solid var(--line); padding:8px; background:var(--panel); }
#main { padding:8px 16px 40px; min-width:0; }
button { font:inherit; }
button.session { display:block; width:100%; text-align:left; border:1px solid transparent; background:none; padding:6px 8px; border-radius:6px; cursor:pointer; color:inherit; }
button.session.active { background:#fff; border-color:var(--line); }
.name { font-weight:600; overflow-wrap:anywhere; }
.muted { color:var(--muted); } .small { font-size:12px; }
h2 { font-size:18px; margin:10px 0; } h3 { font-size:16px; margin:18px 0 8px; }
h4 { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:16px 0 6px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px; }
pre { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:8px 10px; overflow:auto; max-height:420px; white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0; }
table { border-collapse:collapse; width:100%; }
table.executions th, table.executions td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); }
table.executions tbody tr { cursor:pointer; } table.executions tr.selected { background:#eef3ff; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.badge { display:inline-block; font:600 10px/1 ui-monospace, monospace; padding:2px 4px; border-radius:3px; margin-left:4px; vertical-align:middle; cursor:help; }
.badge.P { background:#fff1cc; color:#7a4b00; border:1px solid #e6c36b; }
.badge.T { background:#e3f0ff; color:#0b3f8a; border:1px solid #9cbdf0; }
.disp { font-weight:600; } .disp.completed, .disp.output { color:var(--ok); } .disp.failed, .disp.error { color:var(--bad); }
.disp.terminated, .disp.abandoned { color:var(--warn); } .disp.running, .disp.other { color:var(--grey); }
.tag { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:10px; background:#fde8e6; color:var(--bad); font-size:11px; }
.flag { margin-left:6px; color:var(--warn); font-size:12px; }
dl.meta { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; margin:0; }
dl.meta dt { color:var(--muted); } dl.meta dd { margin:0; overflow-wrap:anywhere; }
.timeline { border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
.timeline .axis { display:flex; justify-content:space-between; gap:8px; padding-bottom:4px; border-bottom:1px dashed var(--line); }
.timeline .row { display:grid; grid-template-columns:minmax(200px, 40%) 1fr; gap:8px; align-items:start; padding:4px 0; border-bottom:1px solid var(--line); }
.timeline .row:last-child { border-bottom:0; }
.track { position:relative; height:14px; margin-top:4px; background:repeating-linear-gradient(90deg, var(--panel) 0 9.5%, #fff 9.5% 10%); border-radius:3px; }
.bar { position:absolute; top:0; height:14px; border-radius:3px; background:var(--ok); }
.bar.error { background:var(--bad); } .bar.abandoned { background:var(--warn); } .bar.running, .bar.other { background:var(--grey); }
.bar.open { background:repeating-linear-gradient(45deg, var(--warn) 0 4px, #fff 4px 8px); }
ul.crossings { padding-left:18px; } ul.crossings li { margin:4px 0; }
details.payload, .error-block { margin:4px 0; } summary { cursor:pointer; }
.cbody { padding:4px 0 4px 16px; border-left:2px solid var(--line); margin:4px 0 4px 6px; }
.error { color:var(--bad); }
@media (max-width: 720px) { #app { grid-template-columns:1fr; } #sessions { border-right:0; border-bottom:1px solid var(--line); } }
`;

const SCRIPT = String.raw`
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const P_TITLE = 'program-determined: authored by the program or derived from a channel it can write; unverified program output';
  const T_TITLE = 'target-relayed: passed unchanged from the target, or produced by the host handling this crossing; not verified against the world';
  const STATES = ['completed', 'failed', 'terminated', 'abandoned', 'output', 'error', 'running'];

  // JSON text of a value from the stream, indented when asked; a value nested past the browser's stack shows its type instead of stopping the page.
  function json(v, indent) {
    try { return JSON.stringify(v, null, indent) ?? String(v); } catch { return '[' + (Array.isArray(v) ? 'array' : typeof v) + ' nested too deep to show]'; }
  }
  // A string as it is, any other value as JSON: String() throws on a parsed object whose toString is not a function.
  function str(v) { return typeof v === 'string' ? v : json(v); }
  // Controls other than tab and line breaks, C1, and the bidirectional marks that reorder text on screen.
  const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  function visible(s) {
    return str(s).replace(HIDDEN, (c) => {
      const code = c.charCodeAt(0);
      return code < 0x100 ? '\\x' + code.toString(16).padStart(2, '0') : '\\u' + code.toString(16).padStart(4, '0');
    });
  }
  // Builds an element. Strings become text nodes, never markup, with hidden characters made visible.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, visible(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : visible(c));
    }
    return node;
  }
  function badge(m, field) {
    const c = m && m[field];
    if (!c) return null;
    return el('span', { class: 'badge ' + c, title: c === 'P' ? P_TITLE : T_TITLE }, c);
  }
  function stateClass(s) { return STATES.includes(s) ? s : 'other'; }
  // 64 characters is past the longest text Date.parse reads as a time, and its cost grows with the length of what it refuses.
  function parseTime(s) { const t = typeof s === 'string' && s.length <= 64 ? Date.parse(s) : NaN; return Number.isNaN(t) ? null : t; }
  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '';
    const sign = ms < 0 ? '-' : '', a = Math.abs(ms);
    if (a < 1000) return sign + Math.round(a) + 'ms';
    if (a < 60000) return sign + (a / 1000).toFixed(3) + 's';
    return sign + Math.floor(a / 60000) + 'm' + ((a % 60000) / 1000).toFixed(1) + 's';
  }
  function short(id) { id = str(id); return id.length > 14 ? id.slice(0, 14) + '…' : id; }
  function isObj(v) { return v !== null && typeof v === 'object'; }
  function flags(p) {
    const f = [];
    if (p.truncated === true) f.push('truncated');
    if (p.redacted === true) f.push('redacted');
    if (f.length && typeof p.bytes === 'number') f.push(p.bytes + ' bytes');
    return f;
  }
  function text(p) {
    if (!isObj(p) || p.value === undefined) return '';
    return typeof p.value === 'string' ? p.value : json(p.value, 1);
  }
  function preview(p, max) {
    if (!isObj(p) || p.value === undefined) return '(no value)';
    const t = p.truncated === true && typeof p.value === 'string' ? p.value : json(p.value);
    const flat = t.replace(/[\n\r\t]/g, ' ');
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }
  function payloadBlock(label, p, m, field) {
    if (!isObj(p)) return null;
    const f = flags(p), meta = [];
    if (typeof p.bytes === 'number') meta.push(p.bytes + ' bytes');
    if (typeof p.hash === 'string') meta.push(p.hash);
    return el('details', { class: 'payload' },
      el('summary', null, el('b', null, label), ' ', badge(m, field), ' ', el('span', { class: 'muted' }, preview(p, 120)), f.length ? el('span', { class: 'flag' }, f.join(', ')) : null),
      meta.length ? el('div', { class: 'muted small' }, meta.join('  ')) : null,
      p.value === undefined ? el('p', { class: 'muted' }, 'no value: ' + f.join(', ')) : el('pre', null, text(p)));
  }
  function errorBlock(label, e, m, prefix) {
    if (!isObj(e)) return null;
    return el('div', { class: 'error-block' },
      el('div', null, el('b', null, label), ' ', el('code', null, str(e.class)), badge(m, prefix + '.class'),
        e.message !== undefined ? [' ', str(e.message), badge(m, prefix + '.message')] : null),
      isObj(e.value) ? payloadBlock('error value', e.value, m, prefix + '.value') : null);
  }

  let model = null;
  const state = { session: 0, exec: 0 };

  function render() {
    document.title = 'mocon ' + (model.file || '');
    $('file').textContent = model.file || '';
    $('counts').textContent = model.executions + ' executions · ' + model.crossings + ' crossings · ' +
      model.unresolved.length + ' unresolved · ' + model.conflicts.length + ' conflicts · ' + model.skipped + ' skipped · ' + model.flagged + ' flagged';
    renderHosts();
    renderSessions();
    renderMain();
  }
  function renderHosts() {
    const box = $('hosts');
    box.replaceChildren();
    if (!model.hosts.length) { box.append(el('div', { class: 'muted' }, 'no host declaration: attested reads as [], observes_crossings as none')); return; }
    // The model has already read a key outside its type or closed set as absent.
    for (const h of model.hosts) {
      const attested = h.attested && h.attested.length ? h.attested.join(', ') : 'none';
      box.append(el('div', { class: 'host' }, el('b', null, str(h.host)), ' ', el('span', { class: 'muted' },
        'spec_version ' + (h.spec_version ?? 'absent') + ' · observes_crossings ' + (h.observes_crossings ?? 'absent (none)') +
        ' · unmediated_egress ' + (h.unmediated_egress ?? 'absent (unknown)') + ' · crossing_edge ' + (h.crossing_edge ?? 'absent') + ' · attested ' + attested)));
    }
  }
  function renderSessions() {
    const nav = $('sessions');
    nav.replaceChildren(el('h2', null, 'Sessions'));
    model.sessions.forEach((s, i) => {
      const first = s.executions[0] && s.executions[0].record;
      nav.append(el('button', { type: 'button', class: 'session' + (i === state.session ? ' active' : ''),
        onclick: () => { state.session = i; state.exec = 0; renderSessions(); renderMain(); } },
        el('div', { class: 'name' }, s.session === null ? '(no session)' : s.session),
        el('div', { class: 'muted small' }, s.executions.length + ' execution' + (s.executions.length === 1 ? '' : 's') + (first && first.start ? ' · ' + str(first.start) : ''))));
    });
  }
  function renderMain() {
    const main = $('main');
    main.replaceChildren();
    const s = model.sessions[state.session];
    if (!s) { main.append(el('p', { class: 'muted' }, 'no executions')); return; }
    main.append(el('h2', null, s.session === null ? 'Executions without a session' : 'Session ' + str(s.session)));
    main.append(executionsTable(s));
    const ex = s.executions[state.exec];
    if (ex) main.append(renderExecution(ex));
  }
  function executionsTable(s) {
    const rows = s.executions.map((ex, i) => {
      const r = ex.record;
      const st = ex.running ? 'running' : r && r.end ? str(r.end.disposition) : 'no record';
      return el('tr', { class: i === state.exec ? 'selected' : null, onclick: () => { state.exec = i; renderMain(); } },
        el('td', null, el('code', null, short(ex.id))),
        el('td', null, el('span', { class: 'disp ' + stateClass(st) }, st), ex.conflict ? el('span', { class: 'tag' }, 'conflict') : null),
        el('td', null, r ? str(r.start) : ''),
        el('td', { class: 'num' }, fmtMs(ex.durationMs)),
        el('td', { class: 'num' }, ex.crossings.length));
    });
    return el('table', { class: 'executions' },
      el('thead', null, el('tr', null, el('th', null, 'execution'), el('th', null, 'disposition'), el('th', null, 'start'), el('th', null, 'duration'), el('th', null, 'crossings'))),
      el('tbody', null, rows));
  }
  function renderExecution(ex) {
    const r = ex.record, m = ex.provenance;
    const box = el('section', { class: 'execution' }, el('h3', null, 'Execution ', el('code', null, ex.id)));
    if (!r) {
      box.append(el('p', { class: 'muted' }, 'No execution line was seen; only crossings name this id. Host ' + str(ex.host) + '.'), renderCrossings(ex));
      return box;
    }
    const disp = ex.running ? 'running' : str(r.end && r.end.disposition);
    const meta = el('dl', { class: 'meta' });
    const row = (k, ...v) => meta.append(el('dt', null, k), el('dd', null, v));
    row('host', str(r.host));
    row('disposition', el('span', { class: 'disp ' + stateClass(disp) }, disp),
      ex.conflict ? el('span', { class: 'tag', title: 'two distinct complete records share this key; the one whose canonical JSON sorts first is shown' }, 'conflict') : null,
      ex.running ? el('span', { class: 'muted' }, ' start notice only, no complete record yet') : null);
    if (r.language !== undefined) row('language', str(r.language), badge(m, 'language'));
    row('start', str(r.start));
    if (r.end && r.end.time !== undefined) row('end', str(r.end.time), ' ', el('span', { class: 'muted' }, fmtMs(ex.durationMs)));
    if (isObj(r.context) && r.context.traceparent !== undefined) row('traceparent', el('code', null, str(r.context.traceparent)));
    box.append(meta, el('h4', null, 'Program ', badge(m, 'program.value')));
    if (isObj(r.program)) {
      const p = r.program, f = flags(p), info = [];
      if (typeof p.bytes === 'number') info.push(p.bytes + ' bytes');
      if (typeof p.hash === 'string') info.push(p.hash);
      if (f.length) info.push(f.join(', '));
      box.append(el('div', { class: 'muted small' }, info.join('  ')));
      box.append(p.value === undefined ? el('p', { class: 'muted' }, 'program withheld (' + f.join(', ') + ')') : el('pre', { class: 'code' }, text(p)));
    } else {
      box.append(el('p', { class: 'muted' }, 'not on this notice'));
    }
    box.append(el('h4', null, 'Crossings ', el('span', { class: 'muted' }, '(' + ex.crossings.length + ')')), renderCrossings(ex));
    if (isObj(r.end)) {
      const end = r.end;
      box.append(el('h4', null, 'Outcome'));
      if (end.error) box.append(errorBlock('error', end.error, m, 'end.error'));
      if (end.result) box.append(payloadBlock('result', end.result, m, 'end.result.value'));
      for (const ch of Object.keys(isObj(end.outputs) ? end.outputs : {})) box.append(payloadBlock(ch, end.outputs[ch], m, 'end.outputs.' + ch + '.value'));
      if (!end.error && !end.result && !end.outputs) box.append(el('p', { class: 'muted' }, 'no error, result or outputs recorded'));
    }
    if (r.ext !== undefined) box.append(el('details', null, el('summary', null, el('b', null, 'ext'), ' ', badge(m, 'ext')), el('pre', null, json(r.ext, 1))));
    return box;
  }
  function crossingHead(c) {
    const r = c.record, m = c.provenance;
    const st = c.running ? 'running' : str(r.end && r.end.outcome);
    return el('span', { class: 'chead' },
      typeof r.seq === 'number' ? el('span', { class: 'seq muted' }, '#' + r.seq + ' ') : null,
      el('code', null, str(r.target)), badge(m, 'target'), ' ',
      el('span', { class: 'disp ' + stateClass(st) }, st), c.conflict ? el('span', { class: 'tag' }, 'conflict') : null, ' ',
      el('span', { class: 'muted' }, fmtMs(c.durationMs)));
  }
  function crossingBody(c) {
    const r = c.record, m = c.provenance, parts = [payloadBlock('input', r.input, m, 'input.value')];
    if (isObj(r.end) && r.end.outcome === 'output' && r.end.output) parts.push(payloadBlock('output', r.end.output, m, 'end.output.value'));
    if (isObj(r.end) && r.end.outcome === 'error' && r.end.error) parts.push(errorBlock('error', r.end.error, m, 'end.error'));
    const endTime = isObj(r.end) ? r.end.time : undefined;
    if (r.start !== undefined || endTime !== undefined) parts.push(el('div', { class: 'muted small' }, (r.start !== undefined ? 'start ' + str(r.start) : '') + (endTime !== undefined ? '  end ' + str(endTime) : '')));
    if (r.ext !== undefined) parts.push(el('details', null, el('summary', null, el('b', null, 'ext'), ' ', badge(m, 'ext')), el('pre', null, json(r.ext, 1))));
    return el('div', { class: 'cbody' }, parts);
  }
  // A crossing's payloads are built the first time its row is opened: one execution can hold thousands of crossings, each with a 64 KiB output.
  function crossingDetails(c, attrs) {
    let filled = false;
    const details = el('details', attrs, el('summary', null, crossingHead(c)));
    details.addEventListener('toggle', () => {
      if (details.open && !filled) { filled = true; details.append(crossingBody(c)); }
    });
    return details;
  }
  // A timeline when any crossing carries a host-clock start; otherwise a plain list, because no order is known.
  function renderCrossings(ex) {
    const cs = ex.crossings;
    if (!cs.length) return el('p', { class: 'muted' }, 'none recorded');
    if (!cs.some((c) => parseTime(c.record.start) !== null)) {
      return el('ul', { class: 'crossings' }, cs.map((c) => el('li', null, crossingDetails(c, null))));
    }
    // A loop, not Math.min(...times): spreading one argument per crossing overflows the stack on a long execution.
    let t0 = Infinity, t1 = -Infinity;
    const add = (v) => { const t = parseTime(v); if (t !== null) { if (t < t0) t0 = t; if (t > t1) t1 = t; } };
    if (ex.record) { add(ex.record.start); add(isObj(ex.record.end) ? ex.record.end.time : undefined); }
    for (const c of cs) { add(c.record.start); add(isObj(c.record.end) ? c.record.end.time : undefined); }
    const span = Math.max(t1 - t0, 1);
    const box = el('div', { class: 'timeline' },
      el('div', { class: 'axis muted small' }, el('span', null, new Date(t0).toISOString()), el('span', null, fmtMs(t1 - t0)), el('span', null, new Date(t1).toISOString())));
    for (const c of cs) {
      const s = parseTime(c.record.start), e = parseTime(isObj(c.record.end) ? c.record.end.time : undefined);
      let bar = el('span', { class: 'muted small' }, 'no time');
      if (s !== null) {
        const left = ((s - t0) / span) * 100, width = Math.max((((e === null ? t1 : e) - s) / span) * 100, 0.4);
        const st = c.running ? 'running' : str(c.record.end && c.record.end.outcome);
        bar = el('div', { class: 'bar ' + stateClass(st) + (e === null ? ' open' : ''), style: 'left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%',
          title: str(c.record.start) + (e === null ? ' (no end time)' : ' to ' + str(c.record.end.time)) });
      }
      box.append(el('div', { class: 'row' }, crossingDetails(c, { class: 'label' }), el('div', { class: 'track' }, bar)));
    }
    return box;
  }

  function load() {
    const inline = $('data');
    if (inline) { model = JSON.parse(inline.textContent); render(); return; }
    $('reload').hidden = false;
    fetch('view.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((m) => { model = m; render(); }, (e) => { $('main').replaceChildren(el('p', { class: 'error' }, 'could not load view.json: ' + e.message)); });
  }
  $('reload').addEventListener('click', load);
  load();
})();
`;
