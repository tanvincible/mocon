/**
 * What an MCP client or a program controls: the request's `_meta` and
 * session, the tool arguments, the names and arguments a program passes
 * to a bridge, and what it throws. None of it may make the host write
 * without bound, throw out of a wrapper, run program code twice, or
 * pollute a prototype.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fold } from "@mocon/core/fold";
import { contextFromMcp, instrumentMcpClient, moconTool, type McpClientCalls } from "../src/index.js";
import { withMcpServer } from "./codemode.js";
import { assertValidStream, complete, extraOf, harness, waitFor } from "./helpers.js";

test("a traceparent or session the client inflates is not copied onto the execution or any crossing line", async () => {
  const h = harness();
  const execute = moconTool<{ code: string }>(h.m, {
    program: (a) => a.code,
    run: async (_a, { execution }) => {
      for (let i = 0; i < 3; i++) execution.crossing.start({ target: "t", input: i }).output(i);
      return { content: [] };
    },
  });
  const inflated = "00-" + "f".repeat(1 << 20);
  await execute({ code: "p" }, extraOf({ sessionId: inflated, _meta: { traceparent: inflated } }));
  assertValidStream(h.sink.lines);
  const largest = Math.max(...h.sink.lines.map((l) => l.length));
  assert.ok(largest < 4096, `one request wrote a line of ${largest} bytes from client-supplied context`);
  assert.equal(h.done()["context"], undefined);
  assert.deepEqual(contextFromMcp({ _meta: { traceparent: inflated } }), {});
});

test("hostile tool arguments, getters, toJSON and an own __proto__ key, pass through program(args) and instrumentMcpClient without a throw, a second run of their code, or a polluted prototype", async () => {
  const h = harness();
  const counts = { code: 0, toJSON: 0, getter: 0 };
  // What JSON.parse makes of a request: `__proto__` is an own key, not the prototype.
  const args = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
  Object.defineProperty(args, "code", {
    enumerable: true,
    get() {
      counts.code++;
      return "return await callTool('lookup', {})";
    },
  });
  const toolArguments = {
    get secret(): string {
      counts.getter++;
      throw new Error("a getter that throws");
    },
  };
  const serialized = {
    toJSON() {
      counts.toJSON++;
      return JSON.parse('{"ok":true,"__proto__":{"polluted":true}}') as unknown;
    },
  };
  const received: unknown[] = [];
  const upstream: McpClientCalls = {
    callTool: (async (params: unknown) => {
      received.push(params);
      return { content: [] };
    }) as McpClientCalls["callTool"],
    readResource: (async () => ({ contents: [] })) as McpClientCalls["readResource"],
    getPrompt: (async (params: unknown) => {
      received.push(params);
      return { messages: [] };
    }) as McpClientCalls["getPrompt"],
  };
  const execute = moconTool<Record<string, unknown>>(h.m, {
    program: (a) => String(a["code"]),
    run: async (_a, { execution }) => {
      const client = instrumentMcpClient(upstream, { execution });
      const first = { name: "lookup", arguments: toolArguments };
      const second = { name: "prompt", arguments: serialized as unknown as Record<string, string> };
      const third = { name: "echo", arguments: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown> };
      await client.callTool(first);
      await client.getPrompt(second);
      await client.callTool(third);
      assert.deepEqual(received, [first, second, third], "the client received the caller's own objects");
      return { content: [] };
    },
  });
  const result = await execute(args, extraOf());
  assert.deepEqual(result, { content: [] });
  assert.deepEqual(counts, { code: 1, toJSON: 1, getter: 1 }, "each piece of program code ran once: the host's own read of code, the capture of the rest");
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assertValidStream(h.sink.lines);
  const [lookup, prompt, echo] = h.ofKind("crossing");
  assert.equal(lookup!["input"]["redacted"], true, "a value whose serialization throws is written redacted");
  assert.deepEqual(prompt!["input"]["value"], JSON.parse('{"ok":true,"__proto__":{"polluted":true}}'));
  assert.ok(Object.hasOwn(echo!["input"]["value"], "__proto__"), "__proto__ stays an own key of the recorded value");
  assert.deepEqual(fold(h.sink.lines).unresolved, []);
});

test("a thrown value whose every trap throws is rethrown as itself and still ends the execution", async () => {
  const h = harness();
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error("get");
      },
      getPrototypeOf: () => {
        throw new Error("proto");
      },
      ownKeys: () => {
        throw new Error("keys");
      },
      has: () => {
        throw new Error("has");
      },
    },
  );
  const execute = moconTool<{ code: string }>(h.m, {
    program: (a) => a.code,
    classify: () => hostile as never,
    run: () => {
      throw hostile;
    },
  });
  // Not assert.rejects, which reads the rejection's properties and would trip the traps itself.
  let caught: unknown;
  try {
    await execute({ code: "x" }, extraOf({ abort: { reason: hostile } }));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught === hostile);
  assertValidStream(h.sink.lines);
  assert.equal(h.done()["end"]["disposition"], "terminated");
  assert.equal(h.done()["end"]["error"]["class"], "cancelled");
});

test("a client cancel reason of 2 MB reaches no line, not even through the body that surfaces it", async () => {
  const h = harness();
  const cm = await withMcpServer(h.m);
  try {
    const controller = new AbortController();
    const pending = cm.client.callTool({ name: "execute", arguments: { code: "await callTool('slow', {}); return 1" } }, undefined, { signal: controller.signal });
    await cm.slowStarted;
    // `codeMode` stops waiting by racing a promise the signal rejects with its reason, the ordinary shape, so the
    // client's own string is what the body throws. It must still reach the record through the 256-character rule only.
    controller.abort("r".repeat(2 << 20));
    await assert.rejects(pending);
    await waitFor(() => h.ofKind("execution").some((r) => r["end"] !== undefined));
    const error = complete(h.ofKind("execution"))["end"]["error"];
    assert.deepEqual(error, { class: "cancelled" }, "nothing of the client's reason is written");
    assert.ok(
      !h.sink.lines.some((l) => l.includes("rrrr")),
      "a line carries the client's reason",
    );
    const longest = Math.max(...h.sink.lines.map((l) => Buffer.byteLength(l)));
    assert.ok(longest < 1 << 12, `the longest line is ${longest} bytes`);
  } finally {
    await cm.close();
  }
});

test("a cancel reason of 256 characters or fewer is the message, and a longer one is not relayed, whether the body throws its own error or the reason itself", async () => {
  const cases = [
    // The body's own error: the reason is the message within the cap, and past it the cause supplies one.
    { reason: "r".repeat(256), own: true, message: "r".repeat(256) },
    { reason: "r".repeat(257), own: true, message: "the run stopped" },
    // The reason itself: within the cap it is the message, past it the record says only that the call was cancelled.
    { reason: "r".repeat(256), own: false, message: "r".repeat(256) },
    { reason: "r".repeat(257), own: false, message: undefined },
  ];
  for (const { reason, own, message } of cases) {
    const h = harness();
    const handler = moconTool(h.m, {
      program: () => "p",
      run: (_a, { extra }) => {
        // The two ways a body ends under a cancel: its own error, or the signal's reason as `throwIfAborted` throws it.
        if (own) throw new Error("the run stopped");
        extra.signal.throwIfAborted();
        return { content: [] };
      },
    });
    await assert.rejects(handler({}, extraOf({ abort: { reason } })));
    const error = complete(h.ofKind("execution"))["end"]["error"];
    const where = `reason of ${reason.length}, ${own ? "the body's own error" : "the reason itself"}`;
    assert.equal(error["class"], "cancelled", where);
    assert.equal(error["message"], message, where);
    if (!own) assert.equal(error["value"], undefined, `${where}: the reason was written as the error value`);
  }
});
