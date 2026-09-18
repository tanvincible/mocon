# mocon conventions

`conventions_version: 1`. Status: draft, 2026-09-19. **Non-normative**, and versioned separately from `core.md`: nothing here is referenced by a MUST anywhere in the specification, no consumer has to read this file, and a revision of it is not a change to `spec_version`. It sits beside the spec, never inside it, so that a vocabulary can move at the speed vocabularies move at.

## 0. What this file is, and what it cannot do

`core.md` 5.1.1 lets a host declare what its own `ext` keys mean. That makes any host's values renderable and aggregatable by a consumer that has never heard of the host. It does not make two hosts' values *comparable by name*, because they will choose different names.

This file recommends names for the handful of concepts most code-mode servers have. It is a floor, not a mechanism.

**What it cannot do, stated up front.** A recommendation cannot retrofit a host that already exists. `vocabulary.md` 5 has recommended `vendor.exit_code` since 1.0, and the conformance corpus in this repository carries four different keys for that one concept — `example.exit_code`, `judge0.exit_code`, `jxcodes.exit_code`, and a fourth buried inside `autogen.blocks[].exit_code` — because each of those hosts maps an existing runtime and keeps its own names. Three hosts likewise carry a memory figure under three key names, in three units, in three encodings. **Cross-host comparison by key name is therefore not a property this format provides.** It is per-concept work a consumer does.

What the format does provide is better than a name: a declaration carries the unit and the aggregation with the value, so a consumer can find every additive `{credit}` key across hosts that never agreed on a name. Use these names when you are writing a new adaptor and have a free choice. Do not build on the assumption that another host used them.

## 1. The `mocon.` namespace

`core.md` 3 reserves `mocon.` to the specification and names the four envelope notes an emitter writes. The conventional keys below are the other thing that lives there: ordinary host-written `ext` keys with a shared name and **no special status**. They are program-determined at baseline like any other `ext` key, they are declarable and undeclarable like any other, and a host writing one is making exactly the claim it would make under its own namespace.

A host MUST NOT invent a key under `mocon.` that is not in this file or in `core.md` 3.

## 2. The keys

| key | `agg` | `unit` | typically on | meaning |
|---|---|---|---|---|
| `mocon.cost` | `sum` | the host's own, declared | crossing, execution | what this record's work cost |
| `mocon.attempts` | `sum` | `1` | crossing | how many dispatches this one crossing record stands for — the silent-retry count `core.md` 5.3 routes to `ext` |
| `mocon.cache` | `none`, `card: low` | — | crossing | recommended values `hit`, `miss`, `bypass`; open |
| `mocon.model` | `none`, `card: low` | — | execution, crossing | the model identifier that produced or served this |
| `mocon.sandbox` | `none`, `card: low` | — | execution | recommended `process`, `container`, `vm`, `wasm`, `isolate`, `none`; open |

## 3. Two rules that make this work

**A conventional key must still be declared.** There is no implicit vocabulary and no special case: a consumer needs a declaration to aggregate a key, whatever it is called, and `core.md` 12 forbids inferring a dimension from a key's name however conventional the name looks. Conventions fix the *name* and the *shape*; the declaration fixes the *unit* and carries the host's own claim about it. That is what lets one host's `mocon.cost` be `USD` and another's `{credit}` while a consumer still knows not to add them together.

**A revision may add keys and recommended values; it may never change the meaning, the `agg` or the unit shape of a published key.** Otherwise cross-host comparison breaks silently, under a version nobody reads.

## 4. Units

`unit` is a free string compared only by equality (`core.md` 5.1.1). The recommendation, following OpenTelemetry's own convention: UCUM where one exists — `By`, `KiBy`, `ms`, `s`, `USD` — and a curly-braced annotation otherwise — `{credit}`, `{token}`, `{row}`, `{cell}`. A dimensionless count is `1`, which is also what an absent `unit` reads as.

Pick the unit your host actually meters in and do not convert on the way out. A host whose meter reads kilobytes declares `KiBy`, not `By`; a consumer that needs bytes converts once, knowingly, rather than every host guessing.
