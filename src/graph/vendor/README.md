# Vendored: cypherlite (WebAssembly)

These files, together with `plugin/skills/tracetoon/assets/cypherlite.wasm`, are
the wasm-bindgen output of [cypherlite](https://github.com/neo4j-labs/cypherlite)
(Neo4j Labs, Apache-2.0), built from the tag, revision and toolchain pinned in
`build-dependencies.json` with cypherlite's own `scripts/build-wasm.sh --mode release`.
Do not edit them: `bun scripts/cypherlite.ts check` verifies their SHA-256 (every
build runs it) and `bun scripts/cypherlite.ts rebuild` reproduces them.

Cypherlite is a Neo4j Labs project: experimental and community-supported, with
no warranty. Tracetoon uses it as an in-memory, per-command evidence graph and
fails open (the digest is still produced) when it cannot start.
