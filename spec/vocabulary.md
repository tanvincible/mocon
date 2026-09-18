# mocon vocabulary

Status: draft 1.0, 2026-09-17. Non-normative. Companion to `core.md` and `provenance.md`.

## 0. What this file is

`core.md` section 8 leaves four things open: `error.class`, output channel names, `language`, and `ext` namespaces. This file gives recommended values for each. A recommended value is not required. A host MAY emit a value not listed here, and a consumer MUST display an unknown value verbatim rather than drop it or reinterpret it (`core.md` 8). Adding a value to this file is a minor version change under `core.md` 11, never a breaking one.

Everything below is illustration, drawn from real code-mode implementations. Where a recommended value is not grounded in a real implementation, this file says so instead of inventing an example. Where `core.md` does not define something this file would otherwise need, this file says that too, rather than deciding on `core.md`'s behalf.

## 1. `error.class` for executions

`Execution.end.error.class` is one open string (`core.md` 5.5). `core.md` fixes one value by rule: "A pre-execution rejection is a complete record with `failed` and `error.class` `validation`" (`core.md` 5.2). The rest below are recommendations, not rules.

| value | meaning |
|---|---|
| `validation` | The host rejected the submission before the program ran, for any reason: the text did not parse, an unresolvable target name, a missing required annotation, a policy check on the program text. This is the class `core.md` itself names, by rule, for every pre-execution rejection, parse failures included; there is no separate class for "did not parse." |
| `runtime` | An ordinary error the program raised after admission succeeded and execution began, with no more specific cause known. |
| `timeout` | The host's own limit on how long the execution may run elapsed. |
| `resource_limit` | The execution was ended for exceeding a declared, non-time limit: memory, step count, output size, concurrency. |
| `cancelled` | The execution was stopped by the caller or an external actor before it reached a terminal state on its own, distinct from the host's own timeout or resource limit. |
| `approval_rejected` | A human or policy gate the host paused the execution for declined to let it continue. |
| `host_failure` | The host's own process or infrastructure failed, or a later reconciliation closed the record `abandoned` on the host's behalf (`core.md` 5.2, 10); not something the program did, and distinct from `timeout`, where the host acts on its own limit at the moment it is reached and closes the execution `terminated`. |
| `unknown` | The host has a disposition but no reason it can name, or the reason does not fit any other value. |

## 2. `error.class` for crossings

`Crossing.end.error.class` is the same open string type, used in a different context, with a different typical vocabulary. `core.md` fixes part of its meaning directly: "the program received an error, whether from the target, from the host refusing to dispatch (`error.class` `refused`), or from host policy" (`core.md` 5.3).

| value | meaning |
|---|---|
| `capability_error` | The target returned an error for this call, or the host cannot say more about why the call failed. The default when nothing more specific is known. |
| `validation` | The target, or a schema check ahead of it, rejected this call's input as malformed. Distinct from `refused` below: here the host recognized and attempted the call, and something reported the input itself was bad; `Error.value` (`core.md` 5.5) preserves the raw target error. Not isolated at the single-crossing level by any known implementation. |
| `refused` | The host recognized the call but declined to dispatch it by its own policy, before the target ever saw it. |
| `timeout` | This one call's own time budget elapsed, distinct from the execution's overall timeout. No known implementation shows a clean per-crossing timeout separate from the execution timeout. |
| `cancelled` | The call settled with a cancellation reported by the target or the host. Distinct from a call still in flight when its own execution ends, which `core.md` 5.3 records as `end.outcome` `abandoned` and which carries no error at all. Not demonstrated by any known implementation. |
| `approval_rejected` | A human or policy gate on this specific call declined it, as opposed to the whole execution. |
| `unknown` | The host cannot classify the failure further. |

## 3. Output channel names

`core.md` 5.2 defines `Execution.end.outputs` as "object mapping channel name to Payload," and names the recommended channels directly: "stdout, stderr, logs, files." Presence of a channel is the only declaration that the host captures it. Output values are always program-determined (`provenance.md` 3), so no attestation question arises here.

| channel | meaning |
|---|---|
| `stdout` | The program's standard output stream, captured whole or truncated. |
| `stderr` | The program's standard error stream. Anything a host derives from it is program-determined unless attested (`provenance.md` 3). |
| `logs` | A structured or host-curated log distinct from raw stdout/stderr. |
| `files` | Files the program wrote that the host chose to capture and return. `core.md` lists the name but does not define its shape further, and no known implementation demonstrates it cleanly; a host with more than one file folds them into a single Payload value (for example a JSON array of `{name, content}` objects) or uses `ext`. |

## 4. `language` labels

`Execution.language` is "an open string; a role hint, not a guarantee" (`core.md` 5.2). Recommended labels are lowercase and name the notation, not a version or dialect: `javascript`, `typescript`, `python`, `starlark`.

`language` is a role hint only, matching `core.md` 5.2: a consumer MUST NOT use it to predict what will parse or to validate anything.

Unknown language: `core.md` does not define a reserved token for this case. `language` is already optional (`core.md` 5.2), and absence is legitimate. Where a host genuinely cannot name what it dispatched to, for example a polyglot runtime keyed by an opaque runtime id, or a bring-your-own-interpreter design where the interpreter travels with the submission, the recommendation is to omit `language` rather than guess. A host that wants to record the dispatch key anyway should put it in `ext` (for example `vendor.runtime_id`), not force it into `language`.

## 5. `ext` namespace conventions

`core.md` 3 defines `ext` as an "open map of namespaced keys, `vendor.key`," and reserves one namespace, `mocon.`, to the specification itself. It does not say how many segments a key may have, or whether a value may be a nested object. This file does not decide that either. The working convention is: prefix every key with your organization's name or a reverse-domain form, `vendor.key` or `domain.key`, and never emit a bare key with no separator. A bare key has no way to signal who defined it, and will collide across hosts and relays.

Two rules govern every recommendation below.

**Declare what you emit.** `core.md` 5.1.1 lets a host declare, once per host string, what each of its own `ext` keys means: how it aggregates, in what unit, and whether it is safe to group by. An undeclared key behaves exactly as it did in 1.0 — displayed verbatim, never totalled, never grouped by — so declaring is how a recurring key below becomes useful to a consumer that has never met the host. `core.md` 12 forbids inferring a dimension from a key's name, so a conventional-looking name buys nothing on its own.

**Attesting is per key and needs two gates.** `provenance.md` 3 marks `ext.*` P at baseline. Since 1.1 there are two ways out, and a host may use both. The `ext.declared` entry in `host.attested` upgrades to H exactly those keys whose declaration carries `observed: true` (`provenance.md` 4) — so a subprocess exit code the host read from the OS itself is now attestable, where in 1.0 it was not. An `ext.<extension>` entry published by an extension under `spec/extensions/` upgrades the keys that extension documents; none of the recurring keys below is covered by one today. A consumer MUST display and aggregate an `ext` value as program-determined unless one of those paths applies to that key; absent that, the key name implies nothing about its provenance.

Recurring keys seen across real adaptors, given as illustration, not a registry:

- **Process exit code.** A subprocess or container exit status a subprocess-shaped host captured. `core.md` has no first-class field for this. Recommended shape: `vendor.exit_code`, declared `{"agg": "none", "card": "low"}` — an exit code is a category, not a quantity, and totalling exit codes is meaningless — with `observed: true` when the host read it from the OS itself rather than parsing it out of program output.
- **A credits key.** Cost or billing metering. Cost metering is unresolved for the core spec, so it stays in `ext`. Recommended shape: `vendor.credits_used` and `vendor.credits_remaining`, or `mocon.cost` (`conventions.md`). These two are the case the declaration exists for: both are numbers, both are in credits, and they aggregate differently. Spend is `{"agg": "sum", "unit": "{credit}"}`; a running balance is `{"agg": "last", "unit": "{credit}"}`, because totalling balances over ten executions reports a number that means nothing.
- **Native id keys.** A server's own identifier for the execution or the call, kept alongside mocon's own `id`. `core.md` 6 licenses this directly: "Native ids (a server's own execution id, a tool-use block id) MAY be used as `id` directly when they are unique, or placed in `ext` next to a generated id." MCP's own `Mcp-Session-Id` transport header is a related native id one layer up, at the session rather than the execution. Recommended shape: `vendor.native_id`, or a more specific name such as `vendor.tool_use_id` or `vendor.container_id`.
- **Sandbox-authored timestamps.** A time value the code running inside the sandbox produced itself, not the declaring host's clock. `core.md` 7 is explicit that these MUST NOT go in `start` or `end.time` and MAY go in `ext`. Recommended shape: `vendor.sandbox_time`. Label it as such in any display; by the rule above it is P regardless of how precisely the sandbox measured it.
