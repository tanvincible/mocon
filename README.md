# mocon

mocon is a record format for observing code-mode MCP servers: it makes visible what a code-mode execution did while it ran. See `spec/README.md` for the full explanation, `core.md` section 1 for the definition of a code-mode MCP, and section 4 for the stateless, supersede-based record model.

Status: draft 1.1, dated 2026-09-19, and not yet stable. 1.1 is additive over 1.0: a host declares what its own `ext` keys mean (`core.md` 5.1.1), `links` relates a retry or a fork to what it came from (`spec/extensions/links.md`), and every 1.0 stream stays valid and reads the same. The specification is written and is the source of truth for the format. A host can conform without any library by emitting the JSON Lines described in the spec directly; `core.md` section 13 shows the shape in about sixty lines of plain JavaScript with no dependency, and `spec/conformance/README.md` section 5 is what you check a real adaptor against.

The full specification, its conformance levels, and a file-by-file index live at `spec/README.md`.

## Repository

- `spec/` is the specification, its JSON Schema and the conformance suite.
- `packages/core` is `@mocon/core`, the emitter. Zero runtime dependencies.
- `packages/otel` is `@mocon/otel`, the OTLP sink.
- `packages/adapter-mcp` is `@mocon/adapter-mcp`, wrappers for the MCP TypeScript SDK.
- `packages/cli` is `@mocon/cli`, the `mocon validate|view|ui|otlp` command.
- `packages/testkit` is test support every package shares: the spec schema through ajv, and an in-memory MCP transport pair. Not published.
- `examples/node-vm-codemode` is a runnable code-mode host that writes a stream.

Commands at the repository root: `npm test` builds every package and runs its tests, `npm run bench` runs the hot-path benchmark, `npm run conformance` runs the spec's reference checker.

## License

Licensed under either of the Apache License, Version 2.0 (LICENSE-APACHE) or the MIT license (LICENSE-MIT), at your option. Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this work by you shall be dual licensed as above, without any additional terms or conditions.
