# mocon

mocon is a record format for observing code-mode MCP servers: it makes visible what a code-mode execution did while it ran. See `spec/README.md` for the full explanation, `core.md` section 1 for the definition of a code-mode MCP, and section 4 for the stateless, supersede-based record model.

Status: draft 1.0, dated 2026-09-17, and not yet stable. The specification is written and is the source of truth for the format. No library exists yet in any language; a host conforms today by emitting the JSON Lines described in the spec directly, which the spec's core document shows how to do in about sixty lines of plain JavaScript with no dependency.

The full specification, its conformance levels, and a file-by-file index live at `spec/README.md`.

## License

Licensed under either of the Apache License, Version 2.0 (LICENSE-APACHE) or the MIT license (LICENSE-MIT), at your option. Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this work by you shall be dual licensed as above, without any additional terms or conditions.
