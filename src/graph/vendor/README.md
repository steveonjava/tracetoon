# Vendored: Relate (WebAssembly)

These files, together with `plugin/skills/tracetoon/assets/relate.wasm`, are
the wasm-bindgen output of [Relate](https://github.com/relatedb/relate)
(Apache-2.0), built from the tag, revision and toolchain pinned in
`build-dependencies.json` with Relate's own `scripts/build-wasm.sh --mode release`.
Do not edit them: `bun scripts/relate.ts check` verifies their SHA-256 (every
build runs it) and `bun scripts/relate.ts rebuild` reproduces them.

Tracetoon uses Relate as an in-memory, per-command evidence graph (and its
FULLTEXT index for prepare's graph search) and fails open (the digest is
still produced) when it cannot start.
