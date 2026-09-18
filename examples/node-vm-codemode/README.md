# node-vm-codemode

A runnable code-mode MCP server instrumented with mocon. It exposes one tool, `execute({ code })`, runs the submitted JavaScript in `node:vm`, and gives the program a `callTool(name, args)` bridge over two fake tools: `company_lookup` and `person_search`. Both return fictional data about `acme.example`. Every execution and every crossing is written to `mocon.jsonl` through the core file sink.

**node:vm is not a security boundary.** A program can reach the host realm through the objects it is handed, and the `timeout` option covers only synchronous code. This example exists to show what a mocon stream looks like. Do not run untrusted code with it. The host declaration says `unmediated_egress: true` for the same reason: the program has ways out that the host does not see, so a reader must not infer that the recorded crossings are all the calls that happened. A host with a real sandbox would declare `false`.

**This host attests nothing, because attestation assumes isolation and this host has none.** Attesting a field claims it is host-observed — determined at a point the program cannot write through, for every record the host emits — and `provenance.md` 2 makes that claim conditional on the host's isolation not being bypassed. Here it is bypassed by design: a program that reaches the host realm can change what the host records, such as a tool's answer. So the declaration carries no `attested` list and no `crossing_edge`, every target, input and output stays program-determined, and `mocon view` marks them that way. The test suite keeps this honest by reaching `process` from a program, and by forging a recorded tool answer from one. A host that runs the program in a worker or a separate process, with the bridge as its only channel, is the one that can attest `crossing.target` and `crossing.input`; copying this example's wiring without that isolation does not earn them.

## Commands

After `npm install` at the repository root, from this directory:

```sh
npm run example
npx mocon view mocon.jsonl
npx mocon ui mocon.jsonl
npm test
```

`npm run example` builds `src/` and the `mocon` command with `tsc -b`, then runs `dist/drive.js`. The driver deletes any previous stream, starts `dist/server.js` as a child over stdio, connects an SDK `Client`, calls `execute` with a program that makes two overlapping tool calls and one that fails, checks that the stream holds one complete execution, and prints the result and the stream.

`npx mocon view mocon.jsonl` prints the stream as a tree with provenance markers. `npx mocon ui mocon.jsonl` serves a viewer at `http://127.0.0.1:7311/` with timing bars for the overlapping calls. `npx mocon validate mocon.jsonl` checks every line against the spec.

The stream file is set by the `MOCON_FILE` environment variable, for the driver and the server alike; the default is `mocon.jsonl` in this directory for the driver and in the working directory for the server. The server creates it readable by its owner only, because it holds program text and payloads. In a stdio server, stdout is the JSON-RPC channel, so nothing else is ever written there: a program's `console` goes nowhere, and the server's own reports go to stderr.

## What the stream shows

One `host` line with the capabilities declaration. One `execution` notice written before the program runs. Three `crossing` records: `company_lookup` and `person_search` overlap in time because the program awaited them together, and the second `company_lookup` ends with `outcome: "error"` because `nowhere.invalid` is not a known domain. Then the complete `execution` record with `disposition: "completed"` and the tool result as `result`. The program caught the failing call itself, so the execution completed even though one crossing failed.

## How each execution ends

| the program | disposition | `error.class` | written by |
|---|---|---|---|
| returns | `completed` | | the adapter |
| throws, or rejects | `failed` | `runtime` | the adapter |
| does not compile | `failed` | `validation` | the host, before the program runs |
| is still running at the time limit, one second by default | `terminated` | `timeout` | the host |
| is cancelled by the client | `terminated` | `cancelled` | the adapter |

The time limit covers the synchronous part, which `node:vm` interrupts, and the awaits, where the host stops waiting. A busy loop after the first `await` blocks the whole process, and nothing in `node:vm` can stop it. The host decides that the limit fired by its own clock, never from the error, which a program can imitate. A call still open when the execution ends is written as `abandoned` before the complete record, and its answer arrives later as a `late_settlement` event.

Once the host stops waiting, whether the program returned, threw, ran out of time or was cancelled, `callTool` refuses every call. The program can keep running, because `node:vm` cannot stop it, but no tool runs for it: each refused call is recorded as a crossing that ends in an error with class `refused`.

## The bridge

- The arguments cross as JSON, read once, as they would into a host outside the sandbox. A getter in the arguments runs once, and the input the crossing records is the input the tool receives. A tool name that is not a string, or arguments that do not serialize, fail inside the program and are not a crossing.
- Each tool answers with a fresh copy, so a program that changes an answer changes nothing a later call or a later execution sees. A program that escapes `node:vm` can still change what the record says a tool answered, which is why the declaration attests no crossing field.
- `node:vm` shares the process's promise rejection tracking. A program that leaves a rejected promise unhandled would otherwise stop the server and every execution in flight, so the server reports it on stderr and keeps serving. A stream file that fails to write is reported the same way; the call still answers.

## Layout

- `src/tools.ts` holds the two fake tools.
- `src/codemode.ts` builds the MCP server: `execute` registered with `moconTool`, the program compiled and run in `node:vm`, the time limit, and the bridge wrapped with `execution.instrument`. It exports `createServer(m, { timeLimitMs })`, `HOST` and `CAPABILITIES`.
- `src/server.ts` is the stdio entry point: the file sink, stderr reports, and the transport.
- `src/drive.ts` is the client side.

## Tests

`npm test` builds, then runs `node:test` over five files. `test/tools.test.ts` covers the fake tools. `test/codemode.test.ts` drives the server in process over the SDK's `InMemoryTransport` into a memory sink, one test per way an execution ends and per property of the bridge. `test/server.test.ts` starts the built server as a child over stdio: where the stream goes and its file mode, that stdout carries only JSON-RPC, that a program's unhandled rejection does not stop the server, and that a stream file that stops taking lines is reported. `test/drive.test.ts` runs the built driver and feeds its stream to `mocon validate` and `mocon view` as child processes. `test/property.test.ts` generates programs from awaited, raced, abandoned and chained calls and every ending, and checks the rules every stream of this host keeps: each line validates against `spec/schema`, the declaration comes first, the stream folds with nothing unresolved and no conflict, crossings are numbered from 1, and no call is dispatched after the host stopped waiting. `npm run typecheck` type-checks the tests against the source.
