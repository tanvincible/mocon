import assert from "node:assert/strict";
import test from "node:test";

import { mocon } from "@mocon/core";
import type { Capabilities } from "@mocon/core";

import { mastraSink } from "../src/index.js";
import type { MastraSpanLike } from "../src/index.js";

/** Records everything a Mastra span would be asked to do. */
class FakeSpan implements MastraSpanLike {
  readonly isValid = true;
  readonly children: FakeSpan[] = [];
  ended = false;
  output: unknown;
  errored: Error | undefined;
  attributes: Record<string, unknown> = {};
  metadata: Record<string, unknown> = {};

  constructor(
    readonly options: {
      type?: unknown;
      name?: string;
      input?: unknown;
      startTime?: Date;
      entityId?: string;
      entityName?: string;
      entityType?: unknown;
    } = {},
  ) {
    Object.assign(this.attributes, (options as { attributes?: Record<string, unknown> }).attributes ?? {});
    Object.assign(this.metadata, (options as { metadata?: Record<string, unknown> }).metadata ?? {});
  }

  createChildSpan(options: Parameters<MastraSpanLike["createChildSpan"]>[0]): FakeSpan {
    const child = new FakeSpan(options);
    this.children.push(child);
    return child;
  }

  end(options?: { output?: unknown; attributes?: Record<string, unknown>; metadata?: Record<string, unknown> }): void {
    this.ended = true;
    if (options?.output !== undefined) this.output = options.output;
    Object.assign(this.attributes, options?.attributes ?? {});
    Object.assign(this.metadata, options?.metadata ?? {});
  }

  error(options: { error: Error; attributes?: Record<string, unknown>; metadata?: Record<string, unknown> }): void {
    this.ended = true;
    this.errored = options.error;
    Object.assign(this.attributes, options.attributes ?? {});
    Object.assign(this.metadata, options.metadata ?? {});
  }
}

const CAPABILITIES: Capabilities = {
  observes_crossings: "all",
  unmediated_egress: false,
  crossing_edge: "invocation",
  attested: ["crossing.target", "crossing.input"],
};

function host(span: FakeSpan, capabilities: Capabilities = CAPABILITIES) {
  return mocon({ host: "example/mastra", capabilities, sinks: [mastraSink(span)] });
}

/** The execution span and its crossing children, after one dispatch. */
function tree(root: FakeSpan): { execution: FakeSpan; crossings: FakeSpan[] } {
  assert.equal(root.children.length, 1, "one execution span under the tool span");
  const execution = root.children[0]!;
  return { execution, crossings: execution.children };
}

test("a completed run becomes an execution span with a tool_call child per crossing", async () => {
  const root = new FakeSpan();
  const m = host(root);

  await m.execution.run({ program: "return await callTool('lookup', {id: 7});", language: "javascript" }, async (ex) => {
    const callTool = ex.instrument(async (_target: string, _args: unknown) => ({ name: "Acme" }));
    return { company: (await callTool("lookup", { id: 7 })).name };
  });

  const { execution, crossings } = tree(root);
  assert.equal(execution.options.type, "generic");
  assert.equal(execution.options.name, "mocon.execution");
  assert.equal(execution.options.input, "return await callTool('lookup', {id: 7});");
  assert.ok(execution.options.startTime instanceof Date);
  assert.equal(execution.ended, true);
  assert.deepEqual(execution.output, { company: "Acme" });
  assert.equal(execution.metadata["mocon.execution.disposition"], "completed");
  assert.equal(execution.metadata["mocon.host"], "example/mastra");
  assert.equal(execution.metadata["mocon.execution.language"], "javascript");
  assert.equal(execution.metadata["mocon.host.observes_crossings"], "all");
  assert.equal(execution.metadata["mocon.host.unmediated_egress"], false);
  assert.deepEqual(execution.metadata["mocon.host.attested"], ["crossing.target", "crossing.input"]);
  assert.match(String(execution.metadata["mocon.program.hash"]), /^sha256:[0-9a-f]{64}$/);

  assert.equal(crossings.length, 1);
  const call = crossings[0]!;
  assert.equal(call.options.type, "tool_call");
  assert.equal(call.options.name, "tool: 'lookup'");
  assert.equal(call.options.entityType, "tool");
  assert.equal(call.options.entityId, "lookup");
  assert.equal(call.options.entityName, "lookup");
  assert.deepEqual(call.options.input, { id: 7 });
  assert.deepEqual(call.output, { name: "Acme" });
  assert.equal(call.attributes.success, true);
  assert.equal(call.attributes.toolType, "code-mode");
  assert.equal(call.metadata["mocon.crossing.target"], "lookup");
  assert.equal(call.metadata["mocon.crossing.outcome"], "output");
  assert.equal(call.metadata["mocon.crossing.seq"], 1);
  assert.equal(call.metadata["mocon.crossing.timing"], undefined, "both host times present");
  assert.equal(call.metadata["mocon.execution.id"], execution.metadata["mocon.execution.id"]);
  assert.equal(call.attributes.toolCallId, call.metadata["mocon.crossing.id"]);
});

test("attested fields lose their P label; a relayed output keeps one", async () => {
  const root = new FakeSpan();
  const m = host(root);
  await m.execution.run({ program: "x" }, async (ex) => {
    await ex.instrument(async (_target: string, _args: unknown) => 1)("lookup", {});
  });
  const call = tree(root).crossings[0]!;
  // attested: crossing.target and crossing.input -> host-observed, so no label at all.
  assert.equal(call.metadata["mocon.provenance.crossing.target"], undefined);
  assert.equal(call.metadata["mocon.provenance.crossing.seq"], undefined);
  assert.equal(call.metadata["mocon.provenance.crossing.outcome"], undefined);
  assert.equal(call.metadata["mocon.provenance.crossing.input.value"], undefined);
  // crossing.output is not attested here, so the value is the program's claim.
  assert.equal(call.metadata["mocon.provenance.crossing.output.value"], "P");

  const relayed = new FakeSpan();
  const m2 = host(relayed, { ...CAPABILITIES, attested: ["crossing.target", "crossing.output"] });
  await m2.execution.run({ program: "x" }, async (ex) => {
    await ex.instrument(async (_target: string, _args: unknown) => 1)("lookup", {});
  });
  const call2 = tree(relayed).crossings[0]!;
  assert.equal(call2.metadata["mocon.provenance.crossing.output.value"], "T");
  assert.equal(call2.metadata["mocon.provenance.crossing.input.value"], "P", "input is not attested here");
  assert.equal(call2.metadata["mocon.provenance.program.value"], undefined, "labels sit on their own span");
  assert.equal(tree(relayed).execution.metadata["mocon.provenance.program.value"], "P");
});

test("a throwing bridge is an error span; a throwing program fails the execution span", async () => {
  const root = new FakeSpan();
  const m = host(root);
  await assert.rejects(
    m.execution.run({ program: "x" }, async (ex) => {
      const callTool = ex.instrument(async (_target: string, _args: unknown) => {
        throw new Error("upstream is down");
      });
      await callTool("lookup", {});
    }),
  );

  const { execution, crossings } = tree(root);
  const call = crossings[0]!;
  assert.equal(call.errored?.message, "upstream is down");
  assert.equal(call.errored?.name, "capability_error");
  assert.equal(call.attributes.success, false);
  assert.equal(call.metadata["mocon.crossing.outcome"], "error");
  assert.equal(call.metadata["mocon.crossing.error.class"], "capability_error");
  // The raw error the host captured survives, which Mastra's own errorInfo has no room for.
  const raw = call.metadata["mocon.crossing.error.value.value"] as { name: string; stack: string };
  assert.equal(raw.name, "Error");
  assert.match(raw.stack, /sink\.test\.ts/);
  assert.equal(call.errored?.stack, "capability_error: upstream is down", "no frames from inside the sink");

  assert.equal(execution.errored?.message, "upstream is down");
  assert.equal(execution.metadata["mocon.execution.disposition"], "failed");
});

test("an abandoned crossing ends without a success claim", async () => {
  const root = new FakeSpan();
  const m = host(root);
  const ex = m.execution.start({ program: "x" });
  ex.crossing.start({ target: "slow_tool", input: {} });
  ex.complete({ result: null });

  const { crossings } = tree(root);
  const call = crossings[0]!;
  assert.equal(call.ended, true);
  assert.equal(call.errored, undefined);
  assert.equal(call.attributes.success, undefined);
  assert.equal(call.metadata["mocon.crossing.outcome"], "abandoned");
  assert.equal(call.metadata["mocon.crossing.timing"], "start_only", "no end.time on an abandoned crossing");
});

test("a cancelled termination is not an error, and ext keys travel with their provenance", async () => {
  const root = new FakeSpan();
  const m = host(root);
  const ex = m.execution.start({ program: "x", ext: { "example.sandbox_id": "sb-1" } });
  ex.end({ disposition: "terminated", error: { class: "cancelled", message: "caller went away" } });

  const { execution } = tree(root);
  assert.equal(execution.errored, undefined, "cancelled is UNSET, not ERROR");
  assert.equal(execution.metadata["mocon.execution.disposition"], "terminated");
  assert.equal(execution.metadata["mocon.execution.error.class"], "cancelled");
  assert.equal(execution.metadata["mocon.ext.example.sandbox_id"], "sb-1");
  assert.deepEqual(execution.metadata["mocon.provenance.ext.p"], ["example.sandbox_id"]);
});

test("no span, an invalid span, and a malformed line all cost nothing", async () => {
  for (const span of [undefined, null, { isValid: false } as unknown as MastraSpanLike]) {
    const m = mocon({ host: "example/mastra", capabilities: CAPABILITIES, sinks: [mastraSink(span)] });
    assert.equal(await m.execution.run({ program: "x" }, async () => 42), 42);
  }

  const root = new FakeSpan();
  const sink = mastraSink(root);
  sink.write(["not json", "[]", '{"kind":"nope"}', '{"kind":"crossing","host":"h","id":"c"}']);
  assert.equal(root.children.length, 0);
});

test("a crossing whose execution this sink never saw still lands under the tool span", () => {
  const root = new FakeSpan();
  const sink = mastraSink(root);
  sink.write([
    JSON.stringify({
      kind: "crossing",
      host: "example/mastra",
      id: "c1",
      execution_id: "somewhere-else",
      target: "lookup",
      input: { value: { id: 1 } },
      end: { time: "2026-09-19T10:00:00.000Z", outcome: "output", output: { value: 2 } },
    }),
  ]);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0]!.options.name, "tool: 'lookup'");
  assert.equal(root.children[0]!.metadata["mocon.crossing.timing"], "end_only");
});
