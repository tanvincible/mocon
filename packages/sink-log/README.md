# @mocon/sink-log

mocon records as flat log lines, so the panels a team already has keep working.

A log backend facets on named fields. A mocon record that reaches the log stream as one JSON blob
inside one field is data every panel is blind to — the records are better and the dashboard is worse,
which is a bad trade to ask anyone to make. This package turns one line into one flat object whose
keys are names a query can spell, and writes those objects wherever the host's own log lines already
go.

Zero runtime dependencies beyond `@mocon/core`. Nothing is buffered, nothing is timed, and one line
in is one record out.

## Wiring it

```ts
import { mocon } from "@mocon/core";
import { logSink } from "@mocon/sink-log";

const m = mocon({
  host: "example/mcp",
  capabilities: { observes_crossings: "all", dimensions: { "example.tenant_id": { agg: "none", card: "low" } } },
  sinks: [logSink((record) => log.info(record))],
});
```

`logSink` takes your logger's own method, or anything with a `write` — `logSink(process.stdout)`
gives you one JSON object per line. `flatten(line, declaration)` is the same projection as a pure
function, for a host that has a log path of its own.

## What it promotes

**Core fields**, under fixed names:

| field | from | |
|---|---|---|
| `ev` | always `"mocon"` | so `ev:mocon` selects these lines |
| `kind` | `kind` | `execution`, `crossing`, or whatever an extension added |
| `mocon_host` | `host` | identifier |
| `exec_id` | the execution's `id`, or a crossing's `execution_id` | identifier |
| `crossing_id` | a crossing's `id` | identifier |
| `target` | `target` | |
| `seq` | `seq` | |
| `session`, `traceparent` | `context.*` | identifiers |
| `language` | `language` | |
| `disposition` / `outcome` | `end.disposition` / `end.outcome` | |
| `ok` | a confirmed normal end | see below |
| `duration_ms` | `end.time` less `start` | |
| `error_class`, `error_message` | `end.error.*` | |
| `program_bytes`, `program_hash` | `program.*` | matches two runs of one program |
| `mocon` | the line itself, verbatim | |

**Every declared `ext` key**, under the key's local part: `example.credits_used` is promoted as
`credits_used`. The host already said what its own keys mean — core.md 5.1.1 gives each one an `agg`,
a `unit` and a `card` on the host line of every stream — so there is nothing here to configure, and
**the key name is the log field name**. A host whose panels read `tenant_id` declares
`example.tenant_id` and the panels keep working untouched.

An undeclared key is not promoted: core.md 12 forbids treating one as meaningful, and here that rule
is also what bounds the column space to something the host writes down.

**Everything else** stays in `mocon`, the original line. Nothing is ever dropped.

## What it will not do

- **Promote a nested value.** An array of objects spread into columns is what makes a log backend
  fall over. Only strings, finite numbers and booleans are promoted; an object, an array, and a
  `null` (which core.md 5.1.1 reads as *no value*) stay in `mocon`.
- **Promote a value that does not match its `agg`.** A string under `sum` reads as undeclared for
  that record, and is never parsed into a number.
- **Promote onto a name something else owns.** A log pipeline sets its own fields and deletes the
  app's before flattening — one deployment's shipper drops `app`, `origin`, `pod_name`,
  `pod_namespace`, `node_name`, `container_name` and `container_image`, and every logger writes its
  own `level`, `time`, `host` and `message`. A promoted key landing on one of those vanishes
  silently, so it is not promoted. Nor is a key whose name a core field above has taken, nor one two
  namespaces both want, nor one a query cannot spell. In every case the value is still in `mocon`.
- **Invent a disposition.** A start notice carries no `disposition`, `ok` or `duration_ms`; filter
  with `disposition:*` to count settled runs only. `ok` is the host confirming a normal end —
  `completed`, or `output` on a crossing — and is absent on `abandoned`, where the host never
  determined an end at all.

## Cardinality

`card` on a declared key tells you which promoted names are safe to group by. `low` is a facet;
`high`, which is also the default, is an identifier: promoted so you can look a record up by it,
never something to `stats by`. The flat record cannot enforce that — every field in it is an
ordinary queryable field — so it is the one thing this package asks you to read off the declaration
yourself. The identifiers in the core table above are marked.
