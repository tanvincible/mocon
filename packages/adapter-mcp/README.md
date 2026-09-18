# @mocon/adapter-mcp

mocon wrappers for hosts built on `@modelcontextprotocol/sdk`. One wrapper around the tool handler that runs a program, one around the SDK client a program calls through, and one reader for the request context. Everything else comes from `@mocon/core`.

The SDK is a peer dependency. This package uses its types only; the built module imports nothing at runtime. It holds no state across executions: the only state is inside one execution handle, for the length of one tool call.

## Public functions

- `moconTool(m, { program, language?, context?, ext?, notice?, classify?, run })` returns a tools/call handler, `(args, extra) => Promise<CallToolResult>`. The host registers it under its own name, description and schema. The handler starts an execution before `run` and ends it after, on both exits. `program(args)` returns the program text from the tool arguments. `run(args, { execution, extra })` is the body; it receives the execution handle and returns the `CallToolResult` the host sends back. `language` is a string, or a function of the arguments for a tool that takes the language as one. `context(extra)` returns the execution context; the default is `contextFromMcp(extra)`. `ext` is an object, or a function of the arguments and `extra` for what is known at start, such as `extra.requestId`; it is written on the start notice and the complete record. `notice` is passed through to `start` and defaults to `true`. `classify(cause, extra)` names the disposition and class of a call that did not end normally, described below.
- `instrumentMcpClient(client, { execution, target? })` returns an object with the client's `callTool`, `readResource` and `getPrompt` signatures. Each call is one crossing of `execution`. The wrapper holds nothing but the handle and the client, so make one per execution.
- `contextFromMcp(extra)` is pure. It reads `extra.sessionId` into `context.session` and `extra._meta.traceparent` into `context.traceparent`, both verbatim, and omits whichever is absent, not a string, or longer than 256 characters.

## Registering the handler

With `McpServer`, the handler is the callback of `registerTool`. The SDK validates the arguments against the schema before the handler runs, so `args` is typed. `crmClient` is an SDK `Client` connected to an upstream server and `runInSandbox` is the host's own sandbox.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fileSink, mocon } from "@mocon/core";
import { moconTool, instrumentMcpClient } from "@mocon/adapter-mcp";
import { z } from "zod";

const m = mocon({
  host: "example/mcp",
  capabilities: { observes_crossings: "all", unmediated_egress: false, crossing_edge: "invocation", attested: ["crossing.target", "crossing.input"] },
  sinks: [fileSink("mocon.jsonl")],
});

const server = new McpServer({ name: "example", version: "1.0.0" });

server.registerTool(
  "execute",
  { description: "Run a program", inputSchema: { code: z.string() } },
  moconTool(m, {
    program: (args) => args.code,
    language: "javascript",
    run: async ({ code }, { execution }) => {
      const upstream = instrumentMcpClient(crmClient, { execution, target: (name) => "crm/" + name });
      const value = await runInSandbox(code, { callTool: (name, args) => upstream.callTool({ name, arguments: args }) });
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    },
  }),
);
```

With the low-level `Server`, the host owns the tools/list and tools/call handlers and passes the arguments through. `rawCallTool` is the host's own bridge to its tools.

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { moconTool } from "@mocon/adapter-mcp";

const executeTool = {
  name: "execute",
  description: "Run a program",
  inputSchema: { type: "object" as const, properties: { code: { type: "string" } }, required: ["code"] },
};

const execute = moconTool(m, {
  program: (args: { code: string }) => args.code,
  language: "javascript",
  run: async ({ code }, { execution }) => {
    const callTool = execution.instrument(rawCallTool);
    const value = await runInSandbox(code, { callTool });
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  },
});

const server = new Server({ name: "example", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [executeTool] }));
server.setRequestHandler(CallToolRequestSchema, (request, extra) => execute(request.params.arguments as { code: string }, extra));
```

The bridge a sandbox calls need not be an MCP client. `execution.instrument(fn)` wraps any function, as the second example shows.

## What the handler records

The start notice is written before `run`. When `run` settles, every crossing still open is written as `abandoned`, then the complete record, in one write. The disposition follows what the body did.

| `run` | disposition | `end` |
|---|---|---|
| returns a result without `isError` | `completed` | `result` is the result, because that is the value on the host's return channel |
| returns a result with `isError: true` | `failed` | `error.class` is `runtime`, `error.value` is the whole result, no `result` |
| throws | `failed` | `error.class` is `runtime`, `error.message` and `error.value` from the thrown error under the core cause rule |
| throws, or returns `isError`, while `extra.signal` is aborted | `terminated` | `error.class` is `cancelled`, `error.message` is the client's cancel reason when it sent one of 256 characters or fewer, `error.value` as above unless what `run` threw *is* that reason, which the wrapper relays only as the message |

An aborted signal means the client sent `notifications/cancelled`, or the connection closed, and the SDK acted on it. The host stopped waiting, so the record is `terminated`, and it says so even if the sandbox keeps running. A result that arrives without `isError` after the abort is still `completed`: the program finished, whether or not the transport delivers the value.

`classify(cause, extra)` decides first for the last three rows. `cause` is what `run` threw or the `isError` result it returned. It returns `{ disposition?, class? }` with `disposition` one of `failed` and `terminated`, or `undefined`. A field it gives replaces that field's default; a field it leaves out keeps it. `message` and `value` still come from `cause` under the core cause rule, and the client's cancel reason is the message while the class is the default `cancelled`, or when the reason is what `run` surfaced and so the only text there is. A host limit that surfaces as a throw is the usual case: core.md 5.2 records the host acting on its own limit as `terminated`, which the wrapper cannot tell from a program's own error without being told.

```ts
import { moconTool } from "@mocon/adapter-mcp";

const execute = moconTool(m, {
  program: (args: { code: string }) => args.code,
  language: "javascript",
  classify: (cause) => ((cause as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? { disposition: "terminated", class: "timeout" } : undefined),
  run: async ({ code }) => ({ content: [{ type: "text", text: JSON.stringify(await runInSandbox(code, { callTool: rawCallTool })) }] }),
});
```

A `classify` that throws, or returns anything else, leaves the defaults, so a mistake in it never costs the record or replaces the error the SDK sees.

A body that settles the handle itself wins, because a handle ignores every settlement after the first. Use that for a rejection before the program runs, `execution.fail(error, { class: "validation" })`, for outputs known only at the end, `execution.complete({ result, outputs })`, and for `ext` known only at the end, `execution.complete({ result, ext })`.

Two kinds of call are not recorded. A call whose `program(args)`, `language(args)`, `context(extra)` or `ext(args, extra)` throws, or gives a value `start` rejects, such as a `language` that is not a string, fails before any execution starts. A request the SDK rejects before the handler runs, an unknown tool or arguments that fail the schema, never reaches the handler.

`McpServer` turns a thrown handler into an `isError` result for the client. The record is unaffected: the wrapper saw the throw and wrote `failed` before the SDK converted it. The low-level `Server` sends a JSON-RPC error instead.

## Crossings from an MCP client

`instrumentMcpClient` opens one crossing per call and settles it when the call returns.

| call | `target` | `input` |
|---|---|---|
| `callTool({ name, arguments })` | `name` | `arguments` |
| `readResource({ uri })` | `uri` | none, written as `null` |
| `getPrompt({ name, arguments })` | `name` | `arguments` |

`target(name)`, when given, maps the name or uri to the target. A proxy that fronts several upstream servers prefixes it, `(name) => "crm/" + name`, so the target reads `server/name`. `_meta` is not recorded; a host that wants it puts it in `ext` through a crossing it opens by hand.

A result with `isError: true` settles the crossing as `error` with class `capability_error` and the result as `value`, because the target reported a failure. A thrown error does the same with the error as `value`. Everything else is `output`. The value returned or thrown reaches the caller unchanged.

The wrapper reads `name` or `uri` and `arguments` once each and hands the caller's `params` object to the client as it is. A name the program passed that is not a string is recorded through `String()`, and the call still goes to the client, which decides what it means. Every method returns a promise, as the client's do, so a throw from reading `params` or from `target` rejects it.

The wrapper takes anything with the three methods, so a `Client` with custom request types fits.

## Other integration shapes

The wrappers cover a host that runs the program and serves its calls in one process. Three other shapes need a handle in a different place, and each is a few lines of `@mocon/core`.

### An RPC proxy

A host whose tool calls land behind an RPC boundary, such as a service binding or another process, with no async context to carry a handle across it, wraps the stub rather than the far side: the crossing is opened where the call is made, with the target and input the program passed, and settled with what the boundary returned. Nothing crosses the boundary but the call.

```ts
import { moconTool } from "@mocon/adapter-mcp";

const execute = moconTool(m, {
  program: (args: { code: string }) => args.code,
  language: "javascript",
  run: async ({ code }, { execution }) => {
    const callTool = execution.instrument((name: string, args: unknown) => rpc.callTool({ name, args }), {
      target: (name: string) => name,
      input: (_name: string, args: unknown) => args,
    });
    const value = await runInSandbox(code, { callTool });
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  },
});
```

A far side that must record the crossing itself, because only it sees what the target actually received, continues the same execution there instead. The call carries the fields the near side gave `start`, and the far side opens its handle with `notice: false`: its first crossing line brings a start notice identical to the near side's, byte for byte, which a consumer supersedes as one record.

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface Dispatch {
  id: string;
  program: string;
  language: string;
  start: string;
}

// The near side: the tools/call handler. It gives `start` itself, so the dispatch it sends names the same instant the record does.
export async function execute({ code }: { code: string }): Promise<CallToolResult> {
  const start = new Date().toISOString();
  return m.execution.run({ program: code, language: "javascript", start }, async (execution) => {
    const dispatch: Dispatch = { id: execution.id, program: code, language: "javascript", start };
    let seq = 0;
    const callTool = (name: string, args: unknown) => rpc.callTool({ dispatch, seq: ++seq, name, args });
    const value = await runInSandbox(code, { callTool });
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  });
}

// The far side: the RPC target, which holds nothing between calls.
export async function callTool({ dispatch, seq, name, args }: { dispatch: Dispatch; seq: number; name: string; args: unknown }): Promise<unknown> {
  const crossing = far.execution.start({ ...dispatch, notice: false }).crossing.start({ target: name, input: args, seq });
  try {
    const value = await runTool(name, args);
    crossing.output(value);
    return value;
  } catch (error) {
    crossing.error(error);
    throw error;
  }
}
```

`far` is the far side's own `mocon` instance under the same host string; the host line each instance writes is identical, which a consumer reads as one declaration. The near side's handle never saw those crossings, so it abandons none of them: a call still in flight when `run` returns is closed by the far side's settlement whenever that arrives, and if nothing settles it the key stays unresolved, which core.md 4 allows. Exactly one handle settles a crossing. Two handles that both settle one key write two complete records for it, which core.md 4 counts as a conflict, so a far side that hands a call back for the near side to close sends its outcome back as data instead of settling it.

### A batch-at-end host

A host that sees only what the sandbox hands back when it exits, the exit code, stdout and stderr, has no crossings to record and declares `observes_crossings: "none"`. The body settles the handle with what it got, because a body that settles wins. `runInContainer` is the host's own sandbox call.

```ts
import { moconTool } from "@mocon/adapter-mcp";

const execute = moconTool(m, {
  program: (args: { code: string }) => args.code,
  language: "python",
  run: async ({ code }, { execution }) => {
    const { exitCode, stdout, stderr } = await runInContainer(code);
    const outputs = { stdout, stderr };
    const ext = { "example.exit_code": exitCode };
    if (exitCode === 0) execution.complete({ result: stdout, outputs, ext });
    else execution.fail({ exit_code: exitCode }, { outputs, ext });
    return { content: [{ type: "text", text: exitCode === 0 ? stdout : stderr }], isError: exitCode !== 0 };
  },
});
```

### A multi-turn observer

An application that calls a model with programmatic tool calling sees one execution across several HTTP turns: the response that carries the program, then one pause for each tool call the application answers, then the final response. There is no MCP request to wrap. The application keeps the execution's own fields, which it chose, in the state it already persists between turns, and opens a handle from them on each turn; a turn that writes a crossing brings the start notice with it, and the complete record repeats the program. The tool call's own id is unique, so it serves as the crossing id, and the application knows each call's position in the run, which is its `seq`. `store` is the application's durable state and `runTool` its own tool.

```ts
interface Dispatch {
  id: string;
  program: string;
  language: string;
  start: string;
  context: { traceparent: string };
}

// The response that carries the program.
export async function onProgram(runId: string, code: string, traceparent: string): Promise<void> {
  const dispatch: Dispatch = { id: runId, program: code, language: "python", start: new Date().toISOString(), context: { traceparent } };
  m.execution.start(dispatch);
  await store.set(runId, JSON.stringify(dispatch));
}

// Each pause: the run is waiting for one tool call.
export async function onToolCall(runId: string, call: { id: string; name: string; input: unknown; position: number }): Promise<unknown> {
  const dispatch = JSON.parse(await store.get(runId)) as Dispatch;
  const execution = m.execution.start({ ...dispatch, notice: false });
  const crossing = execution.crossing.start({ id: call.id, target: call.name, input: call.input, seq: call.position });
  try {
    const value = await runTool(call.name, call.input);
    crossing.output(value);
    return value;
  } catch (error) {
    crossing.error(error);
    throw error;
  }
}

// The final response.
export async function onFinish(runId: string, stdout: string): Promise<void> {
  const dispatch = JSON.parse(await store.get(runId)) as Dispatch;
  m.execution.start({ ...dispatch, notice: false }).complete({ outputs: { stdout } });
}
```

Idempotence belongs to a handle, not to a key. Two handles opened from the same dispatch, such as a retried turn and the original, each write a complete record for the same execution, which core.md 4 counts as a conflict. The library cannot see that without keeping state across calls, so an application that can receive the same turn twice makes its own settle path idempotent, keyed on the id its state already carries.

## Context

`contextFromMcp` reads two fields the SDK hands every handler. `extra.sessionId` is the transport's session id, which `core.md` 5.2 names as one meaning of `context.session`. `extra._meta.traceparent` is the W3C header a caller put in the request's `_meta`, copied as received, malformed or not, because `core.md` 5.2 says the host relays it unmodified. When the execution carries a `traceparent`, the core handle copies it onto every crossing, so a stateless OTLP sink places the crossings in the caller's trace.

Both values come from the client, and `traceparent` is written once per crossing on the request path, so a value longer than 256 characters is dropped, not cut. A W3C `traceparent` is 55 characters. Dropping keeps the relay unmodified: the record carries the caller's value or no value, never a prefix that reads as a different trace or session.

A cancel reason is the same, and the wrapper holds the rule against the body as well. The client chooses the reason, so one longer than 256 characters is never written; a body that stops waiting by surfacing the reason itself — `extra.signal.throwIfAborted()`, or a race the signal rejects — does not get it into the record by the other door, because a cause that *is* the string reason does not go to the cause rule. Such an execution ends with `error.class` `cancelled` and the reason as `error.message` within the cap, and with the class alone past it. A body that throws its own error keeps that error as `error.value` either way.

A host with its own notion of session passes `context: (extra) => ({ session: mySessionOf(extra) })`.

## Tests

`npm test` runs `node:test`. Unit tests cover each module on its own: the context reader and its length cap; the handler's disposition table, `classify`, the per-call `language` and `ext`, and parity with the core cause rule on every non-normal path; and the client wrapper's three calls, names that are not strings, and `params` objects whose getters count their reads. Property tests generate what `run` can do (return a result, return `isError`, throw any value, settle the handle itself, leave crossings open) under any abort and any `classify`, and check that every handled call writes exactly one complete record with the table's disposition and class, after every crossing it left open, and hands back exactly what `run` returned or threw; others generate `extra` shapes and check that the context reader relays a string within the cap verbatim and nothing else. Integration tests run the handler behind `McpServer` and the low-level `Server` over the SDK's `InMemoryTransport`, and in a server process over stdio, where they check that the lines reach the file or stderr, that stdout carries JSON-RPC and nothing else, and that a cancel sent across the pipe ends the execution `terminated` after abandoning its open crossing. Security regressions cover an inflated `traceparent` or session, a cancel reason of 2 MB both as the body's own throw and as what the body surfaces, hostile arguments (getters, `toJSON`, an own `__proto__` key) through `program(args)` and the client wrapper, and a thrown value whose every trap throws. Other tests encode the integration shapes above, compare adapter-produced streams with the `sync-bridge`, `terminated-timeout` and `pre-run-rejection` golden streams field by field, bound the size of a ref sent per call, and type-check every TypeScript block in this README. The performance tests bound each wrapper against the core calls it makes — the one execution, the one crossing — as a ratio between two measurements taken in the same process, each the shortest of several rounds after a warmup, never a figure in microseconds; absolute figures belong in `bench/hot-path.mjs`, which gates them on a known machine. Every emitted line is validated against `spec/schema/line.json` with ajv, and every stream folded with `@mocon/core`'s `fold`. `npm run typecheck` type-checks the tests against the source.
