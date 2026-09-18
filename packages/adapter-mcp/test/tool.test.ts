/**
 * `moconTool` on its own, called with a hand-built `extra`: the
 * disposition table, `classify`, the per-call `language` and `ext`, and
 * the core cause rule on every non-normal path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { moconTool, type MoconToolOptions } from "../src/index.js";
import { assertValidStream, extraOf, harness, type Harness, type Rec } from "./helpers.js";

type Args = { code: string };

function handler(h: Harness, options: Partial<MoconToolOptions<Args>> & Pick<MoconToolOptions<Args>, "run">) {
  return moconTool<Args>(h.m, { program: (a) => a.code, ...options });
}

/** The `error` that `fail(cause, { class })` writes for the same cause, from a separate instance. */
function failReference(cause: unknown, cls = "runtime"): Rec {
  const ref = harness();
  ref.m.execution.start({ program: "x", notice: false }).fail(cause, { class: cls });
  return ref.done()["end"]["error"];
}

const OK: CallToolResult = { content: [{ type: "text", text: "ok" }] };
const DENIED: CallToolResult = { content: [{ type: "text", text: "denied" }], isError: true };

test("a result without isError is completed with the result, returned as the same object", async () => {
  const h = harness();
  const result = await handler(h, { run: () => OK })({ code: "x" }, extraOf());
  assert.equal(result, OK);
  assertValidStream(h.sink.lines);
  const done = h.done();
  assert.equal(done["end"]["disposition"], "completed");
  assert.deepEqual(done["end"]["result"]["value"], OK);
  assert.equal(done["end"]["error"], undefined);
});

test("an isError result is failed with class runtime and the whole result as the error value", async () => {
  const h = harness();
  assert.equal(await handler(h, { run: async () => DENIED })({ code: "x" }, extraOf()), DENIED);
  assertValidStream(h.sink.lines);
  const end = h.done()["end"];
  assert.equal(end["disposition"], "failed");
  assert.deepEqual(end["error"], failReference(DENIED));
  assert.deepEqual(end["error"]["value"]["value"], DENIED);
  assert.equal(end["result"], undefined);
});

test("a throw is failed with class runtime, the error written exactly as fail(cause) writes it, and rethrown as the same value", async () => {
  for (const thrown of [new Error("outer", { cause: new RangeError("root") }), 42, "text", { ok: false, status: 503 }, null, undefined]) {
    const h = harness();
    await assert.rejects(
      handler(h, {
        run: () => {
          throw thrown;
        },
      })({ code: "x" }, extraOf()),
      (e) => e === thrown,
    );
    assertValidStream(h.sink.lines);
    const end = h.done()["end"];
    assert.equal(end["disposition"], "failed");
    assert.deepEqual(end["error"], failReference(thrown));
  }
});

test("an aborted request is terminated with class cancelled; the client's reason is the message and the value follows the core rule, cause chain included", async () => {
  const h = harness();
  const thrown = new Error("outer", { cause: new RangeError("root") });
  await assert.rejects(
    handler(h, {
      run: () => {
        throw thrown;
      },
    })({ code: "x" }, extraOf({ abort: { reason: "user cancelled" } })),
  );
  assertValidStream(h.sink.lines);
  const error = h.done()["end"]["error"];
  assert.equal(h.done()["end"]["disposition"], "terminated");
  assert.equal(error["class"], "cancelled");
  assert.equal(error["message"], "user cancelled");
  const expected = failReference(thrown, "cancelled");
  assert.equal(expected["value"]["value"]["cause"]["name"], "RangeError", "the core rule keeps the nested cause");
  assert.deepEqual(error["value"], expected["value"]);
});

test("an aborted request without a string reason takes the message from the cause, String() for a primitive", async () => {
  for (const reason of [{ code: "CANCEL" }, undefined]) {
    const h = harness();
    await assert.rejects(
      handler(h, {
        run: () => {
          throw 42;
        },
      })({ code: "x" }, extraOf({ abort: { reason } })),
    );
    assertValidStream(h.sink.lines);
    assert.equal(h.done()["end"]["disposition"], "terminated");
    assert.deepEqual(h.done()["end"]["error"], { class: "cancelled", message: "42" });
  }
});

test("an isError result on an aborted request is terminated, and a result without isError is still completed", async () => {
  const h = harness();
  await handler(h, { run: () => DENIED })({ code: "x" }, extraOf({ abort: { reason: "stop" } }));
  await handler(h, { run: () => OK })({ code: "y" }, extraOf({ abort: { reason: "stop" } }));
  assertValidStream(h.sink.lines);
  const [denied, ok] = h.ofKind("execution").filter((r) => r["end"] !== undefined) as [Rec, Rec];
  assert.equal(denied["end"]["disposition"], "terminated");
  assert.equal(denied["end"]["error"]["message"], "stop");
  assert.deepEqual(denied["end"]["error"]["value"]["value"], DENIED);
  assert.equal(ok["end"]["disposition"], "completed");
});

test("classify: a host limit that surfaces as a throw, a node:vm timeout, is terminated with class timeout", async () => {
  const h = harness();
  const execute = handler(h, {
    language: "javascript",
    classify: (cause) => ((cause as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? { disposition: "terminated", class: "timeout" } : undefined),
    run: async ({ code }) => {
      const value = await (runInNewContext(`(async () => {${code}\n})()`, {}, { timeout: 20 }) as Promise<unknown>);
      return { content: [{ type: "text", text: JSON.stringify(value) ?? "undefined" }] };
    },
  });
  await assert.rejects(execute({ code: "while (true) {}" }, extraOf()), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" });
  await assert.rejects(execute({ code: "throw new TypeError('bad')" }, extraOf()), { name: "TypeError", message: "bad" });
  assertValidStream(h.sink.lines);
  const [timedOut, failed] = h.ofKind("execution").filter((r) => r["end"] !== undefined) as [Rec, Rec];
  assert.equal(timedOut["end"]["disposition"], "terminated");
  assert.equal(timedOut["end"]["error"]["class"], "timeout");
  assert.match(timedOut["end"]["error"]["message"], /timed out/);
  assert.equal(timedOut["end"]["error"]["value"]["value"]["code"], "ERR_SCRIPT_EXECUTION_TIMEOUT");
  assert.equal(failed["end"]["disposition"], "failed", "classify returned undefined: the default");
  assert.equal(failed["end"]["error"]["class"], "runtime");
});

test("classify receives the cause and extra, and a field it leaves out keeps the default", async () => {
  const seen: unknown[] = [];
  const h = harness();
  const thrown = new Error("quota");
  const extra = extraOf({ abort: { reason: "stop" } });
  await assert.rejects(
    handler(h, {
      classify: (cause, e) => {
        seen.push(cause, e);
        return { class: "resource_limit" };
      },
      run: () => {
        throw thrown;
      },
    })({ code: "x" }, extra),
  );
  assert.deepEqual(seen, [thrown, extra]);
  const end = h.done()["end"];
  assert.equal(end["disposition"], "terminated", "the aborted default");
  assert.equal(end["error"]["class"], "resource_limit");
  assert.equal(end["error"]["message"], "quota", "the cancel reason is the message only on the default cancel");

  const h2 = harness();
  await handler(h2, { classify: () => ({ disposition: "terminated" }), run: () => DENIED })({ code: "x" }, extraOf());
  assert.equal(h2.done()["end"]["disposition"], "terminated");
  assert.equal(h2.done()["end"]["error"]["class"], "runtime");
  assert.deepEqual(h2.done()["end"]["error"]["value"]["value"], DENIED, "classify saw the isError result as the cause");
});

test("classify is not consulted when the call completes", async () => {
  const h = harness();
  let calls = 0;
  await handler(h, {
    classify: () => {
      calls++;
      return { disposition: "failed", class: "x" };
    },
    run: () => OK,
  })({ code: "x" }, extraOf());
  assert.equal(calls, 0);
  assert.equal(h.done()["end"]["disposition"], "completed");
});

test("a classify that throws, returns something else, or names values outside its set leaves the defaults and the body's error intact", async () => {
  const hostile = {
    get disposition(): never {
      throw new Error("getter");
    },
  };
  const answers: Array<() => unknown> = [
    () => {
      throw new Error("classify broke");
    },
    () => null,
    () => "terminated",
    () => ({ disposition: "completed", class: 5 }),
    () => ({ disposition: "abandoned" }),
    () => hostile,
    () => new Proxy({}, { get: () => { throw new Error("trap"); } }),
  ];
  for (const answer of answers) {
    const h = harness();
    const thrown = new Error("body");
    await assert.rejects(
      handler(h, {
        classify: answer as MoconToolOptions<Args>["classify"],
        run: () => {
          throw thrown;
        },
      })({ code: "x" }, extraOf()),
      (e) => e === thrown,
    );
    assertValidStream(h.sink.lines);
    assert.equal(h.done()["end"]["disposition"], "failed");
    assert.equal(h.done()["end"]["error"]["class"], "runtime");
  }
});

test("language follows a per-call argument, and a static language applies to every call", async () => {
  const h = harness();
  type Polyglot = { code: string; language: string };
  await moconTool<Polyglot>(h.m, { program: (a) => a.code, language: (a) => a.language, run: async () => ({ content: [] }) })({ code: "print(1)", language: "python" }, extraOf());
  assertValidStream(h.sink.lines);
  const [notice, done] = h.ofKind("execution") as [Rec, Rec];
  assert.equal(notice["language"], "python");
  assert.equal(done["language"], "python");

  const h2 = harness();
  await moconTool<Polyglot>(h2.m, { program: (a) => a.code, language: () => undefined, run: async () => ({ content: [] }) })({ code: "x", language: "?" }, extraOf());
  assert.equal("language" in h2.done(), false, "a function may leave the language out");
});

test("ext known at start, such as the request id, is on the notice and the complete record, and a body's settle ext merges over it", async () => {
  const h = harness();
  await handler(h, {
    ext: (_a, e) => ({ "example.request_id": String(e.requestId) }),
    run: async () => ({ content: [] }),
  })({ code: "x" }, extraOf({ requestId: 7 }));
  assertValidStream(h.sink.lines);
  const [notice, done] = h.ofKind("execution") as [Rec, Rec];
  assert.deepEqual(notice["ext"], { "example.request_id": "7" });
  assert.deepEqual(done["ext"], { "example.request_id": "7" });

  const h2 = harness();
  await handler(h2, {
    ext: { "example.tier": "free" },
    run: async (_a, { execution }) => {
      execution.complete({ result: 1, ext: { "example.credits": 3 } });
      return { content: [] };
    },
  })({ code: "x" }, extraOf());
  assert.deepEqual(h2.done()["ext"], { "example.tier": "free", "example.credits": 3 });
});

test("a throw from program, language, context or ext, or a value start rejects, fails the call before any execution starts", async () => {
  const boom = new Error("hook");
  const hooks: Array<Partial<MoconToolOptions<Args>>> = [
    {
      program: () => {
        throw boom;
      },
    },
    {
      language: () => {
        throw boom;
      },
    },
    {
      context: () => {
        throw boom;
      },
    },
    {
      ext: () => {
        throw boom;
      },
    },
    { language: (() => 42) as unknown as () => string },
    { ext: (() => "not an object") as unknown as () => undefined },
  ];
  for (const hook of hooks) {
    const h = harness();
    let ran = false;
    await assert.rejects(
      handler(h, {
        ...hook,
        run: () => {
          ran = true;
          return OK;
        },
      })({ code: "x" }, extraOf()),
    );
    assert.equal(ran, false);
    assert.deepEqual(
      h.records().map((r) => r["kind"]),
      ["host"],
    );
  }
});

test("a body that settles the handle itself wins", async () => {
  const h = harness();
  const result = await handler(h, {
    run: (_args, { execution }) => {
      execution.fail("rejected before it ran", { class: "validation" });
      return DENIED;
    },
  })({ code: "nope" }, extraOf());
  assert.equal(result, DENIED);
  assertValidStream(h.sink.lines);
  assert.deepEqual(h.done()["end"]["error"], { class: "validation", message: "rejected before it ran" });
});

test("every crossing the body leaves open is written abandoned before the one complete record", async () => {
  const h = harness();
  await handler(h, {
    run: (_args, { execution }) => {
      execution.crossing.start({ target: "left-open", input: 1 });
      execution.crossing.start({ target: "settled", input: 2 }).output(3);
      return OK;
    },
  })({ code: "x" }, extraOf());
  assertValidStream(h.sink.lines);
  const kinds = h.records().map((r) => [r["kind"], r["target"] ?? r["end"]?.["disposition"] ?? null, r["end"]?.["outcome"] ?? null]);
  assert.deepEqual(kinds, [
    ["host", null, null],
    ["execution", null, null],
    ["crossing", "settled", "output"],
    ["crossing", "left-open", "abandoned"],
    ["execution", "completed", null],
  ]);
});

test("notice: false writes no start notice", async () => {
  const h = harness();
  await handler(h, { notice: false, run: async () => ({ content: [] }) })({ code: "x" }, extraOf());
  assert.equal(h.ofKind("execution").length, 1);
  assert.equal(h.done()["end"]["disposition"], "completed");
});

test("context defaults to contextFromMcp(extra) and can be replaced", async () => {
  const h = harness();
  await handler(h, { run: () => OK })({ code: "x" }, extraOf({ sessionId: "s-1", _meta: { traceparent: "tp" } }));
  assert.deepEqual(h.done()["context"], { session: "s-1", traceparent: "tp" });
  const h2 = harness();
  await handler(h2, { context: () => ({ session: "mine" }), run: () => OK })({ code: "x" }, extraOf({ sessionId: "s-1" }));
  assert.deepEqual(h2.done()["context"], { session: "mine" });
});

test("an extra the SDK shape no longer carries costs a field, never the record: a call that fails without a signal is still written failed, with the body's own error", async () => {
  // `signal` is required of `extra` in the SDK this package is built against. Reading it unguarded would
  // throw inside the wrapper's own catch, which replaces the body's error on its way to the caller and
  // leaves the execution with a start notice and no complete record — the one outcome the wrapper exists
  // to prevent.
  const h = harness();
  const boom = new Error("bad program");
  const noSignal = { requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) } as never;
  await assert.rejects(
    handler(h, {
      run: () => {
        throw boom;
      },
    })({ code: "x" }, noSignal),
    (thrown: unknown) => thrown === boom,
  );
  assertValidStream(h.sink.lines);
  const done = h.done();
  assert.equal(done["end"]["disposition"], "failed", "no signal reads as not aborted, so the call failed");
  assert.equal(done["end"]["error"]["class"], "runtime");
  assert.deepEqual(done["end"]["error"], failReference(boom), "the body's error still goes through the core cause rule");
});
