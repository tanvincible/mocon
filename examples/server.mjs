/**
 * A code-mode MCP server with mocon wired in. Everything here is real: a sandbox, a bridge, tools
 * that take as long as tools take, and one agent-submitted program running through all of it.
 *
 *   node examples/server.mjs
 *
 * No SDK, no collector, no backend. `logTracer` turns every span into a flat record and hands it to
 * whatever you already log with. Moving to real tracing later is a different tracer, not different
 * host code.
 */

import vm from "node:vm";
import { codeMode, logTracer } from "../packages/typescript/dist/index.js";

const records = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the server

/** Big enough that a search result genuinely does not fit on a span, because in production it won't. */
const CATALOG = [
  { sku: "APX-9", name: "aluminium bracket", price: 12.5, onHand: 240, warehouse: "LEE-2", lead_days: 3 },
  { sku: "APX-14", name: "steel bracket", price: 18.0, onHand: 0, warehouse: "LEE-2", lead_days: 21 },
  ...Array.from({ length: 140 }, (_, i) => ({
    sku: `BRK-${100 + i}`,
    name: `bracket, ${["galvanised", "powder-coated", "stainless", "mild steel"][i % 4]}, ${40 + i}mm`,
    price: 9.25 + i * 0.4,
    onHand: (i * 37) % 300,
    warehouse: ["LEE-2", "DER-1", "STO-4"][i % 3],
    lead_days: (i % 14) + 1,
  })),
];

/** Latency is real, not printed: these are the numbers the spans below actually measure. */
const tools = {
  "catalog.search": async ({ q }) => {
    await sleep(84);
    return CATALOG.filter((i) => i.name.includes(q));
  },
  "inventory.check": async ({ sku }) => {
    await sleep(32);
    const item = CATALOG.find((i) => i.sku === sku);
    return { sku, available: item ? item.onHand > 0 : false };
  },
  "orders.create": async ({ sku, qty }) => {
    await sleep(126);
    return { id: "ord-4471", sku, qty, status: "pending_payment" };
  },
  "payments.charge": async ({ order }) => {
    await sleep(9);
    throw new Error(`card declined for ${order}`);
  },
};

const callTool = async (name, args) => {
  const tool = tools[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool(args ?? {});
};

/** The `execute` tool: the agent hands us a program, we run it with `callTool` reachable inside. */
async function executeCode(source, bridge) {
  const sandbox = { callTool: bridge, console, result: undefined };
  await vm.runInContext(`(async () => { ${source} })().then(r => { result = r; })`, vm.createContext(sandbox), { timeout: 30_000 });
  return sandbox.result;
}

// ------------------------------------------------------------ the two hooks

const observed = codeMode({
  capabilities: {
    observes_crossings: "all", //   every call the program makes comes through our bridge
    unmediated_egress: false, //    and it has no other way out
    crossing_edge: "invocation", // spans describe what the program asked for
    attested: ["crossing.target", "crossing.input", "crossing.output"],
  },
  // Opt-in, and off by default: these are agent-written arguments and target data. A cap keeps a
  // 40 kB search result off the span, and the note below says the value was cut and how big it was.
  capture: { values: true, cap: 96 },
  tracer: logTracer({ write: (record) => records.push(record) }),
});

/** What the `execute` tool handler looks like once mocon is in it. */
export async function handleExecute(source) {
  return observed.execution.run({ program: source, tool: "execute" }, async (execution) => {
    // The second wrapper. Everything the program calls through this becomes a span.
    return executeCode(source, execution.instrument(callTool));
  });
}

// ------------------------------------------------------- one incoming request

const C = { dim: "\x1b[2m", cyan: "\x1b[36m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
const dim = (s) => C.dim + s + C.off;

const submitted = `
  const [bracket] = await callTool("catalog.search", { q: "bracket" });
  const stock = await callTool("inventory.check", { sku: bracket.sku });
  if (!stock.available) return "out of stock";
  const order = await callTool("orders.create", { sku: bracket.sku, qty: 4 });
  await callTool("payments.charge", { order: order.id });
  return order.id;
`;

console.log(`mcp server listening on :8931`);
console.log(`\x1b[2magent submitted a program, ${Buffer.byteLength(submitted)} bytes\x1b[0m\n`);

try {
  await handleExecute(submitted);
} catch {
  // The program's own failure, which the caller sees and the span already recorded.
}
draw();

// ------------------------------------------------------------------- the log

/** Spans end innermost-first, so they are held and drawn as the tree a reader expects. */
function draw() {
  const execution = records.find((r) => r.name.startsWith("execute_code"));
  const crossings = records
    .filter((r) => r.name.startsWith("execute_tool"))
    .sort((a, b) => a["code_mode.crossing.seq"] - b["code_mode.crossing.seq"]);

  const failed = execution.status === "error";
  console.log(`${C.bold}${C.cyan}${execution.name}${C.off}  ${failed ? C.red : C.green}${execution["code_mode.execution.disposition"]}${C.off}  ${dim(ms(execution))}`);
  console.log(dim(`│  ${execution["code_mode.program.hash"].slice(0, 20)}…  observes_crossings=${execution["code_mode.observes_crossings"]}  unmediated_egress=${execution["code_mode.unmediated_egress"]}`));

  const width = Math.max(...crossings.map((c) => c.name.length)) - "execute_tool ".length;
  crossings.forEach((c, i) => {
    const last = i === crossings.length - 1;
    const bar = last ? " " : "│";
    const tint = c.status === "error" ? C.red : C.green;
    const target = c.name.replace("execute_tool ", "").padEnd(width);
    const why = c["error.type"] ? "  " + dim(c["error.type"]) : "";
    console.log(dim("│"));
    console.log(`${dim(last ? "└─" : "├─")} ${C.cyan}${target}${C.off}  ${tint}${c["code_mode.crossing.outcome"].padEnd(7)}${C.off}${dim(ms(c).padStart(8))}${why}`);

    const note = c["code_mode.capture"] ?? {};
    payload(bar, "args  ", c["gen_ai.tool.call.arguments"], note["gen_ai.tool.call.arguments"]);
    if (c["code_mode.crossing.outcome"] === "error") payload(bar, "error ", c["code_mode.error.body"], note["code_mode.error.body"], C.red);
    else payload(bar, "result", c["gen_ai.tool.call.result"], note["gen_ai.tool.call.result"]);
  });
}

/** One captured value, and what the host had to do to it to fit it on a span. */
function payload(bar, label, value, note, tint = "") {
  if (value === undefined) return;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`${dim(bar + "    " + label)}  ${tint}${text}${tint ? C.off : ""}`);
  if (note?.truncated) {
    const kept = Buffer.byteLength(text);
    console.log(dim(`${bar}            ↳ kept ${kept} B of ${note.bytes.toLocaleString()} · ${note.hash.slice(0, 17)}… over the whole value`));
  }
}

function ms(r) {
  return r.duration_ms.toFixed(1) + "ms";
}
