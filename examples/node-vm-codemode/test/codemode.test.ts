/**
 * The `execute` tool in process, over an in-memory transport into a memory
 * sink: what each way a program can end writes, what crosses the bridge,
 * and the rules every stream of this host keeps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mocon } from "@mocon/core";
import { CAPABILITIES, createServer, HOST } from "../src/codemode.js";
import { assertHostRules, completeExecution, connect, crossingsOf, DRIVER_PROGRAM, settled, text, waitFor, type Rec } from "./helpers.js";

test("the driver's program completes with three crossings, two of them overlapping and one failed", async () => {
  const host = await connect();
  try {
    const result = await host.execute(DRIVER_PROGRAM);
    const expected = { company: "Acme Example Co", people: ["Avery Sample", "Riley Fixture", "Sam Placeholder"], failure: "company_lookup: no company at nowhere.invalid" };
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(text(result)), expected);

    const records = assertHostRules(host.sink.lines);
    const done = completeExecution(records);
    assert.equal(done["program"]["value"], DRIVER_PROGRAM);
    assert.equal(done["language"], "javascript");
    assert.equal(done["end"]["disposition"], "completed");
    assert.deepEqual(done["end"]["result"]["value"], result);

    const [company, people, failed] = crossingsOf(records) as [Rec, Rec, Rec];
    assert.deepEqual([company["target"], people["target"], failed["target"]], ["company_lookup", "person_search", "company_lookup"]);
    assert.deepEqual([company["seq"], people["seq"], failed["seq"]], [1, 2, 3]);
    assert.deepEqual(people["input"]["value"], { domain: "acme.example", limit: 3 });
    assert.equal(company["end"]["output"]["value"]["name"], "Acme Example Co");
    assert.ok(people["start"] < company["end"]["time"], "the two awaited-together calls overlap on the host clock");
    assert.equal(failed["end"]["outcome"], "error");
    assert.equal(failed["end"]["error"]["class"], "capability_error");
    assert.equal(failed["end"]["error"]["message"], expected.failure);
  } finally {
    await host.close();
  }
});

test("a program that does not compile is failed with class validation and runs nothing", async () => {
  const host = await connect();
  try {
    const result = await host.execute("callTool('company_lookup', {});\nreturn 1 +;");
    assert.equal(result.isError, true);
    assert.match(text(result), /^the program does not compile: /);

    const records = assertHostRules(host.sink.lines);
    const done = completeExecution(records);
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "validation");
    assert.equal(done["end"]["error"]["value"]["value"]["name"], "SyntaxError");
    assert.deepEqual(crossingsOf(records), []);
  } finally {
    await host.close();
  }
});

test("a program that throws is failed with class runtime, and its stack names the program's own line", async () => {
  const host = await connect();
  try {
    const result = await host.execute("const a = 1;\nthrow new Error('on line two');");
    assert.equal(result.isError, true);
    const done = completeExecution(assertHostRules(host.sink.lines));
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
    assert.equal(done["end"]["error"]["message"], "on line two");
    assert.match(done["end"]["error"]["value"]["value"]["stack"], /program\.js:2:/);
  } finally {
    await host.close();
  }
});

test("a busy loop is stopped at the time limit and recorded terminated with class timeout", async () => {
  const host = await connect({ timeLimitMs: 50 });
  try {
    const result = await host.execute("while (true) {}");
    assert.equal(result.isError, true);
    assert.equal(text(result), "the program did not finish within 50 ms");
    const done = completeExecution(assertHostRules(host.sink.lines));
    assert.equal(done["end"]["disposition"], "terminated");
    assert.deepEqual(done["end"]["error"], { class: "timeout", message: "the program did not finish within 50 ms" });
  } finally {
    await host.close();
  }
});

test("a program that imitates the limit's error is failed, not terminated: the host's clock decides", async () => {
  const host = await connect({ timeLimitMs: 5000 });
  try {
    const forged = "Object.assign(new Error('Script execution timed out after 5000ms'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' })";
    const result = await host.execute(`}\n)();\nthrow ${forged};\n(async () => {`);
    assert.equal(result.isError, true);
    const done = completeExecution(assertHostRules(host.sink.lines));
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
  } finally {
    await host.close();
  }
});

test("a program still awaiting at the time limit is terminated, and its open call is abandoned first", async () => {
  const host = await connect({ timeLimitMs: 30 });
  try {
    const result = await host.execute("callTool('person_search', { domain: 'acme.example' });\nawait new Promise(() => {});");
    assert.equal(text(result), "the program did not finish within 30 ms");
    await waitFor(() => host.records().some((r) => r["kind"] === "event"));

    const records = assertHostRules(host.sink.lines);
    const done = completeExecution(records);
    assert.equal(done["end"]["disposition"], "terminated");
    assert.equal(done["end"]["error"]["class"], "timeout");
    const [search] = crossingsOf(records) as [Rec];
    assert.deepEqual(search["end"], { outcome: "abandoned" });
    const late = records.find((r) => r["kind"] === "event")!;
    assert.equal(late["crossing_id"], search["id"]);
    assert.equal(late["data"]["outcome"], "output");
  } finally {
    await host.close();
  }
});

test("after the host stops waiting, a call is refused and recorded, and never reaches a tool", async () => {
  const host = await connect({ timeLimitMs: 30 });
  try {
    const program = `
      await callTool("company_lookup", { domain: "acme.example" });
      await callTool("company_lookup", { domain: "nowhere.invalid" });`;
    const result = await host.execute(program);
    assert.equal(result.isError, true);
    await waitFor(() => crossingsOf(host.records()).length === 2);
    await settled(host.sink);

    const records = assertHostRules(host.sink.lines);
    const [first, second] = crossingsOf(records) as [Rec, Rec];
    assert.deepEqual(first["end"], { outcome: "abandoned" });
    assert.deepEqual(second["input"]["value"], { domain: "nowhere.invalid" });
    assert.equal(second["end"]["outcome"], "error");
    assert.equal(second["end"]["error"]["class"], "refused");
    assert.equal(second["end"]["error"]["message"], "callTool: company_lookup was not called because the execution has ended");
    assert.ok(
      records.indexOf(second) > records.indexOf(completeExecution(records)),
      "the refusal is written after the complete record; a tool that ran would have answered with its own error",
    );
  } finally {
    await host.close();
  }
});

test("a call left running when the program returns is abandoned, and a call chained after it is refused", async () => {
  const host = await connect();
  try {
    const program = `
      callTool("company_lookup", { domain: "acme.example" })
        .then(() => callTool("person_search", { domain: "acme.example" }))
        .catch(() => {});
      return "returned";`;
    assert.equal(text(await host.execute(program)), '"returned"');
    await waitFor(() => crossingsOf(host.records()).length === 2);
    await settled(host.sink);

    const records = assertHostRules(host.sink.lines);
    assert.equal(completeExecution(records)["end"]["disposition"], "completed");
    const [lookup, search] = crossingsOf(records) as [Rec, Rec];
    assert.deepEqual(lookup["end"], { outcome: "abandoned" });
    assert.equal(search["target"], "person_search");
    assert.equal(search["end"]["error"]["class"], "refused");
  } finally {
    await host.close();
  }
});

test("a request the client cancels is terminated with class cancelled", async () => {
  const host = await connect({ timeLimitMs: 10_000 });
  try {
    const controller = new AbortController();
    const call = host.execute("callTool('company_lookup', { domain: 'acme.example' });\nawait new Promise(() => {});", { signal: controller.signal });
    await waitFor(() => crossingsOf(host.records()).length === 1);
    controller.abort("the agent moved on");
    await assert.rejects(call);
    await waitFor(() => host.records().some((r) => r["kind"] === "execution" && r["end"] !== undefined));

    const done = completeExecution(assertHostRules(host.sink.lines));
    assert.equal(done["end"]["disposition"], "terminated");
    assert.equal(done["end"]["error"]["class"], "cancelled");
    assert.equal(done["end"]["error"]["message"], "the agent moved on");
  } finally {
    await host.close();
  }
});

test("a cancel reason too long to relay reaches no line, though the host stops waiting by rejecting with it", async () => {
  const host = await connect({ timeLimitMs: 10_000 });
  try {
    const controller = new AbortController();
    const call = host.execute("callTool('company_lookup', { domain: 'acme.example' });\nawait new Promise(() => {});", { signal: controller.signal });
    await waitFor(() => crossingsOf(host.records()).length === 1);
    controller.abort("z".repeat(1 << 20));
    await assert.rejects(call);
    await waitFor(() => host.records().some((r) => r["kind"] === "execution" && r["end"] !== undefined));

    const done = completeExecution(assertHostRules(host.sink.lines));
    // `stopWaiting` rejects with the client's own reason, so it is what the body throws. The adapter relays a
    // reason of 256 characters or fewer as the message and nothing longer, whichever door it arrives through.
    assert.deepEqual(done["end"]["error"], { class: "cancelled" });
    assert.ok(!host.sink.lines.some((l) => l.includes("zzzz")), "a line carries the client's reason");
  } finally {
    await host.close();
  }
});

test("arguments cross once: a getter runs once and the tool receives the input the crossing records", async () => {
  const host = await connect();
  try {
    const program = `
      let reads = 0;
      const args = { get domain() { return reads++ === 0 ? "acme.example" : "nowhere.invalid"; } };
      const company = await callTool("company_lookup", args);
      return [company.name, reads];`;
    assert.deepEqual(JSON.parse(text(await host.execute(program))), ["Acme Example Co", 1]);
    const [lookup] = crossingsOf(assertHostRules(host.sink.lines)) as [Rec];
    assert.deepEqual(lookup["input"]["value"], { domain: "acme.example" });
    assert.equal(lookup["end"]["outcome"], "output");
  } finally {
    await host.close();
  }
});

test("a call with a name that is not a string, or arguments that do not serialize, fails in the program and is not a crossing", async () => {
  const host = await connect();
  try {
    const program = `
      const cyclic = {};
      cyclic.self = cyclic;
      const calls = [() => callTool(42, {}), () => callTool("company_lookup", { n: 1n }), () => callTool("company_lookup", cyclic)];
      const failures = [];
      for (const call of calls) {
        try {
          await call();
        } catch (e) {
          failures.push(e.name);
        }
      }
      return failures;`;
    assert.deepEqual(JSON.parse(text(await host.execute(program))), ["TypeError", "TypeError", "TypeError"]);
    const records = assertHostRules(host.sink.lines);
    assert.equal(completeExecution(records)["end"]["disposition"], "completed");
    assert.deepEqual(crossingsOf(records), []);
  } finally {
    await host.close();
  }
});

test("an answer one execution changes does not reach the next execution or its record", async () => {
  const host = await connect();
  try {
    await host.execute("const c = await callTool('company_lookup', { domain: 'acme.example' });\nc.name = 'Changed';\ndelete c.domain;\nreturn c.name;");
    const second = await host.execute("const c = await callTool('company_lookup', { domain: 'acme.example' });\nreturn [c.name, c.domain];");
    assert.deepEqual(JSON.parse(text(second)), ["Acme Example Co", "acme.example"]);
    const outputs = crossingsOf(assertHostRules(host.sink.lines)).map((c) => c["end"]["output"]["value"]["name"]);
    assert.deepEqual(outputs, ["Acme Example Co", "Acme Example Co"]);
  } finally {
    await host.close();
  }
});

test("the program's only host global is callTool, and what it logs goes nowhere", async () => {
  const host = await connect();
  try {
    const program = "console.log('hello');\nreturn [typeof process, typeof require, typeof setTimeout, typeof fetch, typeof callTool];";
    assert.deepEqual(JSON.parse(text(await host.execute(program))), ["undefined", "undefined", "undefined", "undefined", "function"]);
  } finally {
    await host.close();
  }
});

test("node:vm is not a boundary: a program reaches the host realm through callTool, so the host declares unmediated egress", async () => {
  const host = await connect();
  try {
    const result = await host.execute("return typeof callTool.constructor.constructor('return process')().pid;");
    assert.equal(text(result), '"number"');
    assert.equal(CAPABILITIES.unmediated_egress, true);
    assert.equal(assertHostRules(host.sink.lines)[0]!["unmediated_egress"], true);
  } finally {
    await host.close();
  }
});

test("node:vm is not a boundary: a program can forge the output a crossing records, so the host attests nothing", async () => {
  const host = await connect();
  try {
    const program = `
      const hostObject = callTool.constructor("return Object")();
      Object.defineProperty(hostObject.prototype, "toJSON", {
        configurable: true,
        value: function () { return this && this.domain === "acme.example" && this.headcount === 42 ? { name: "Evil Corp", headcount: 0 } : this; },
      });
      const company = await callTool("company_lookup", { domain: "acme.example" });
      delete hostObject.prototype.toJSON;
      return company.name;
    `;
    const result = await host.execute(program);
    assert.equal(JSON.parse(text(result)), "Acme Example Co", "the tool answered with its own data");
    const records = assertHostRules(host.sink.lines);
    const [crossing] = crossingsOf(records) as [Rec];
    assert.deepEqual(crossing["end"]["output"]["value"], { name: "Evil Corp", headcount: 0 }, "the record carries what the program wrote");
    assert.equal(records[0]!["attested"], undefined, "so no crossing field is declared host-observed or target-relayed");
    assert.equal(records[0]!["crossing_edge"], undefined);
  } finally {
    await host.close();
  }
});

test("a value the host cannot send back fails the execution", async () => {
  const host = await connect();
  try {
    const result = await host.execute("return 1n;");
    assert.equal(result.isError, true);
    const done = completeExecution(assertHostRules(host.sink.lines));
    assert.equal(done["end"]["disposition"], "failed");
    assert.equal(done["end"]["error"]["class"], "runtime");
    assert.equal(done["end"]["result"], undefined);
  } finally {
    await host.close();
  }
});

test("a time limit that node:vm or a timer would not honour is rejected when the server is built", () => {
  const m = mocon({ host: HOST, capabilities: CAPABILITIES, sinks: [] });
  for (const timeLimitMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
    assert.throws(() => createServer(m, { timeLimitMs }), RangeError, String(timeLimitMs));
  }
  assert.doesNotThrow(() => createServer(m, { timeLimitMs: 1 }));
});
