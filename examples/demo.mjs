/**
 * A code-mode MCP server, instrumented, in one file. Run it with:
 *
 *   node examples/demo.mjs
 *
 * No SDK, no collector, no backend. `logTracer` turns every span into a flat record and hands it to
 * whatever you already log with, which here is the console. The same host code moves to real tracing
 * by passing a real tracer instead.
 */

import vm from "node:vm";
import { codeMode, logTracer } from "../packages/typescript/dist/index.js";

const records = [];

// ---------------------------------------------------------------- the server

const ORDERS = [
  { id: "ord-1", sku: "sku-1", qty: 2 },
  { id: "ord-2", sku: "sku-2", qty: 1 },
];

const tools = {
  "orders.list": async () => ORDERS,
  "inventory.check": async ({ sku }) => {
    if (sku !== "sku-1") throw new Error(`no such sku: ${sku}`);
    return { sku, onHand: 14 };
  },
  "orders.ship": async ({ id }) => ({ id, shipped: true }),
};

const callTool = async (name, args) => {
  const tool = tools[name];
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool(args ?? {});
};

/** The `execute` tool: the agent hands us a program and we run it with `callTool` reachable. */
async function executeCode(source, bridge) {
  const sandbox = { callTool: bridge, console, result: undefined };
  await vm.runInContext(`(async () => { ${source} })().then(r => { result = r; })`, vm.createContext(sandbox), { timeout: 5000 });
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
  tracer: logTracer({ write: (record) => print(record) }),
});

// ------------------------------------------------------------------ one run

const program = `
  const orders = await callTool("orders.list");
  for (const o of orders) {
    try { await callTool("inventory.check", { sku: o.sku }); }
    catch { continue; }
    await callTool("orders.ship", { id: o.id });
  }
  return orders.length;
`;

await observed.execution.run({ program, tool: "execute" }, async (execution) => {
  // The second wrapper. Everything the program calls through this is a span.
  return executeCode(program, execution.instrument(callTool));
});

// ------------------------------------------------------------- pretty print

/** Spans end innermost-first, so they are held and drawn as the tree a reader expects. */
function print(record) {
  records.push(record);
}

const C = { dim: "\x1b[2m", cyan: "\x1b[36m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
const dim = (s) => C.dim + s + C.off;

function draw() {
  const execution = records.find((r) => r.name.startsWith("execute_code"));
  const crossings = records.filter((r) => r.name.startsWith("execute_tool")).sort((a, b) => a["code_mode.crossing.seq"] - b["code_mode.crossing.seq"]);
  line(execution, false);
  crossings.forEach((c, i) => line(c, true, i === crossings.length - 1));
}

function line(r, child, last) {
  const state = r["code_mode.crossing.outcome"] ?? r["code_mode.execution.disposition"];
  const colour = r.status === "error" ? C.red : C.green;
  const ms = r.duration_ms.toFixed(1) + "ms";
  if (!child) {
    console.log(`${C.bold}${C.cyan}${r.name}${C.off}  ${colour}${state}${C.off}  ${dim(ms)}`);
    console.log(dim(`│  ${r["code_mode.program.hash"].slice(0, 20)}…   observes_crossings=${r["code_mode.observes_crossings"]}  unmediated_egress=${r["code_mode.unmediated_egress"]}`));
    console.log(dim("│"));
    return;
  }
  const tee = last ? "└─" : "├─";
  const reason = r["error.type"] ? dim("  error.type=") + r["error.type"] : "";
  console.log(`${dim(tee)} ${C.cyan}${r.name.replace("execute_tool ", "")}${C.off}  ${colour}${state}${C.off}  ${dim(ms)}${reason}`);
  console.log(dim(`${last ? " " : "│"}     seq=${r["code_mode.crossing.seq"]}  span_id=${r.span_id.slice(0, 8)}  parent=${r.parent_span_id.slice(0, 8)}`));
}

draw();
