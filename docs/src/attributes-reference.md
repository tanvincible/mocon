# Attributes

Everything mocon writes. The [specification](./spec.md) has the normative detail.

## Both spans

| Attribute | |
|---|---|
| `code_mode.observes_crossings` | `all`, `some` or `none` |
| `code_mode.unmediated_egress` | can the program get out without you seeing |
| `code_mode.crossing_edge` | `invocation` or `dispatch` |
| `code_mode.attested` | what your server observed |
| `code_mode.attested_attributes` | your keys you measured |
| `code_mode.relayed_attributes` | your keys a target reported |
| `code_mode.execution.id` | your own run id, on every span of the run |
| `code_mode.capture` | what got truncated or redacted |
| `code_mode.provenance.<key>` | `P` or `T` for any value your server didn't observe |

## Run span

| Attribute | |
|---|---|
| `gen_ai.operation.name` | always `execute_code` |
| `code_mode.execution.disposition` | `completed`, `failed`, `terminated`, `abandoned` |
| `code_mode.program.hash` | sha256 of the program, always written |
| `code_mode.program.language` | a display hint, omit rather than guess |
| `code_mode.program.text` | the program, opt-in |
| `code_mode.declared` | what your own attributes mean |
| `code_mode.output.<channel>` | stdout, stderr and so on, opt-in |
| `gen_ai.tool.name` | your code-mode tool's name |
| `gen_ai.tool.call.id` | the caller's id for this dispatch |
| `gen_ai.conversation.id` | only if your grouping really is a conversation |
| `mcp.session.id` | the MCP session |
| `error.type` | when the run failed |

## Call span

| Attribute | |
|---|---|
| `gen_ai.operation.name` | always `execute_tool` |
| `gen_ai.tool.name` | the target |
| `code_mode.crossing.outcome` | `output`, `error`, `abandoned` |
| `code_mode.crossing.dispatched` | did the call actually leave |
| `code_mode.crossing.seq` | order it started in, from 1 |
| `code_mode.crossing.timing` | set when a time had to be made up |
| `gen_ai.tool.call.id` | your own id for this call |
| `gen_ai.tool.type` | `function`, `extension` or `datastore` |
| `gen_ai.tool.call.arguments` | the input, opt-in |
| `gen_ai.tool.call.result` | the result, opt-in |
| `code_mode.error.message` | why it failed, opt-in |
| `code_mode.error.body` | the raw error, opt-in |
| `mcp.method.name`, `mcp.resource.uri` | if the call went over MCP |
| `error.type` | when it failed |

## Values

**Disposition** is `completed`, `failed`, `terminated`, `abandoned`.

**Outcome** is `output`, `error`, `abandoned`.

**Error types on a run:** `validation`, `runtime`, `timeout`, `resource_limit`, `cancelled`,
`approval_rejected`, `host_failure`, `_OTHER`.

**Error types on a call:** `capability_error`, `validation`, `refused`, `timeout`, `cancelled`,
`approval_rejected`, `tool_error`, `_OTHER`.

Both lists of error types are open, so use a more specific low-cardinality name if you have one. The
disposition and outcome lists are closed and nothing else is allowed.

## Names

| | Name | Kind |
|---|---|---|
| Run | `execute_code {tool}` | `server`, or `internal` in-process |
| Call | `execute_tool {target}` | `client`, or `internal` if you serve it |

If your targets are unbounded, like URLs, pass a `name` to keep the span name low cardinality and
leave the full target in `gen_ai.tool.name`.

## Status

Status is a display hint. Read the disposition and outcome attributes instead.

| | Status |
|---|---|
| `completed`, `abandoned`, `output` | unset |
| `failed`, `terminated`, `error` | error |

The description carries `error.type`, never the program's words, because it's the one field nothing
can label.
