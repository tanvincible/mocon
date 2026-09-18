// Child of sinks.test.ts: a small stream through stderrSink to a parent
// that reads fd 2 and folds what arrives.
import { mocon, stderrSink } from "../../src/index.ts";
const m = mocon({ host: "child/host", capabilities: { observes_crossings: "all", unmediated_egress: false }, sinks: [stderrSink()] });
const ex = m.execution.start({ program: "return 1;", language: "javascript" });
const call = ex.instrument((_name, args) => ({ echoed: args, text: "é".repeat(100) }));
call("lookup", { id: 7 });
ex.complete({ result: 1 });
