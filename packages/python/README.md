# mocon (Python)

OpenTelemetry for code-mode MCP servers.
The specification is in [`spec/otel-code-mode.md`](../../spec/otel-code-mode.md); this is the Python
emitter, a port of [`mocon`](../typescript) that writes the same attribute names and values.

In code mode an agent submits a *program* instead of calling one tool. The host runs it in a
sandbox, and from inside, the program reaches the host's tools through a bridge. From outside, the
whole run is one opaque tool call. This package makes it two spans: one **execution**, and one
**crossing** per call the program made, each carrying a declaration of what the host can actually
observe and a per-field label separating what the host saw from what the program merely claimed.

## Install

**Not published to PyPI yet.** Clone it and install the package directory:

```sh
git clone https://github.com/tanvincible/mocon
pip install ./mocon/packages/python
```

The distribution will be `pymocon` and the import is `mocon`, because `mocon` on PyPI is an unrelated
project. On npm the package is just `mocon`.

It depends on `opentelemetry-api` and never the SDK, which is OpenTelemetry's own rule for
instrumentation and the reason this is worth doing: the spans reach whatever exporters the
application owner already configured. If nothing is configured, every call is a no-op.

## Integration

```python
from mocon import Capabilities, CapturePolicy, CodeMode

observed = CodeMode(
    Capabilities(
        observes_crossings="all",      # every call through the bridge is recorded
        unmediated_egress=False,       # the program has no other way out
        crossing_edge="invocation",    # spans describe what the program asked for
        attested=("crossing.target",), # the host observed the target itself
    ),
    capture=CapturePolicy(values=False),  # payloads are Opt-In, and off by default
)

# Wrapper one: around the handler that runs a program.
with observed.execution(program=source, tool="execute", execution_id=run_id) as ex:
    # Wrapper two: around the function the sandbox calls to reach the host.
    call_tool = ex.instrument(bridge.call_tool)
    sandbox.run(source, call_tool)
```

The context manager settles `completed` on a clean exit and `failed` on an exception, which it
re-raises. Anything else is explicit:

```python
ex.end("terminated", error_type="timeout", message="execution TTL elapsed")
```

`instrument` also reads as a decorator, works on `async def` bridges, and takes hooks for hosts
whose bridge answers with an envelope rather than raising:

```python
@ex.instrument(target=lambda server, tool, args: f"{server}.{tool}")
async def call_tool(server, tool, args): ...
```

By hand, when the bridge shape does not fit a wrapper:

```python
with ex.crossing("orders.cancel", input={"id": "rec_50"}) as crossing:
    crossing.output(result)
```

## Output

| | |
|---|---|
| Spans | `execute_code {tool}` and `execute_tool {target}`, correctly parented |
| Metrics | `code_mode.execution.duration`, and `code_mode.crossing.duration` whose dimensions are dropped unless the host attested `crossing.target` (section 9) |
| Logs | `code_mode.execution.started` / `.ended`, carrying `trace_id` and `span_id`, because a span says nothing until it ends |

## Rules

**No emitter fault raises into the caller.** Serializing a payload runs program-authored code: a
property that raises, a `__dict__` that lies, a cycle, a `__str__` that throws. Each costs that one
value, which the `code_mode.capture` note then reports as `redacted`, and never the call. Bad
*configuration* raises loudly at construction instead.

**Absence of a provenance label means host-observed.** A field the emitter has never heard of is
simply not labelled, so it under-claims rather than over-claims. `code_mode.attested` is what moves
a field up; the label beside the value is what a consumer reads without having to find this
document.

## Tests

```
python -m pytest
```
