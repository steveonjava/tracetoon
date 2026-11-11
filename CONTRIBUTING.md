# Contributing

## Setup

```sh
git clone https://github.com/Tingsters/tracetoon && cd tracetoon
bun run dependencies:prepare
bun install
bun run test
```

The dependency command prepares the exact Showtail revision in
`build-dependencies.json` under `.tracetoon-deps/Showtail`. It can use an
existing repository with `--source <path>`; it never builds from its moving
branch. `build.config.json` records the required Bun version and build recipe.

The evidence graph engine is [Relate](https://github.com/relatedb/relate)
compiled to WebAssembly, vendored as `plugin/skills/tracetoon/assets/relate.wasm`
plus its glue in `src/graph/vendor/`, pinned by tag, revision and SHA-256 in
`build-dependencies.json`. Builds refuse mismatched bytes
(`bun scripts/relate.ts check`). To reproduce or bump it, install Relate's
WebAssembly toolchain (Rust per its `rust-toolchain.toml` with the
`wasm32-unknown-unknown` target, `wasm-bindgen-cli` at the version in its
`Cargo.lock`, and binaryen via its `scripts/install-binaryen.sh DIR`, with
`DIR/bin` on `PATH`) and run `bun scripts/relate.ts rebuild --source <relate
checkout>` (add `--update` after changing the pin). The pinned revision is
exported to a temporary directory and built there, so the checkout is never
touched, and the build strips machine paths, so the bytes match wherever it
runs. `bun scripts/eval-graph.ts [--synthetic]`
reports what the graph changes for a branch: digest size and fact retention
per budget, provenance lookup cost, and timings.

## Layout

| Path | What lives there |
|---|---|
| `src/trace/` | One adapter per agent (Claude Code, Codex, Antigravity). Each turns raw logs into normalized `TraceRecord`s and keeps each record's own cwd and branch. |
| `src/git/` | What the PR is (base, commits, added lines), interop with Entire and git-ai |
| `src/correlate/` | Which sessions and records belong to this PR, and line attribution |
| `src/digest/` | The redacted, budgeted digest the agent writes from |
| `src/graph/` | The evidence graph: built from the digest, trails and patch (`build.ts`), loaded into Relate WebAssembly (`engine.ts`), named queries for agents (`queries.ts`), and what Tracetoon derives from it for digests, notes and review (`derive.ts`). `vendor/` is pinned generated code; never edit it |
| `src/comic/` | Script format, style ideas, bubbles, rasterizing, image providers |
| `src/github/` | PR body region and metadata, assets branch, repo templates and policy |
| `src/hook/` | The agent PR hook (`hook pre-pr`), its install/uninstall into each agent's config, and the on/off switches |
| `src/workflow/` | Worktree-local task lifecycle, exact-content validation receipts, host-session registry and publication recovery |
| `src/commands/` | The CLI commands |
| `plugin/skills/tracetoon/` | The Agent Skills folder that ships: SKILL.md, references, launchers, bundle, assets |

## Adding an agent

1. Look at real logs and write down the record shapes (names and types only).
2. Add `src/trace/<agent>.ts` implementing `TraceAdapter`: `home`, `count`,
   `discover` (cheap relevance check), `read` (full parse). Count unrecognized
   record types in `unknownTypes`, so `doctor --probe` can spot format drift.
3. Register it in `src/trace/registry.ts`, add parser tests in
   `tests/adapters.test.ts` and an end-to-end test in `tests/flow.test.ts` with an
   isolated home directory.

## Before sending a change

- Use Bun 1.3.14, as pinned by the build recipe and CI. `bun run test`
  runs the complete source suite with up to four fresh Bun processes. Each file
  gets a new process so native state cannot leak between files; tests within each
  file remain sequential. Once a full run has recorded each file's passing time
  (in `node_modules/.cache`), files start slowest first, so a long end-to-end
  file no longer starts last; without that history (a fresh checkout, CI) they
  start largest first. `bun run typecheck && bun run test`
  macOS runs one file at a time because the pinned Bun version's subprocess-heavy
  suites fail intermittently under concurrent macOS load. Full coverage is kept.
  Windows runs two files at a time to reduce Git-process contention; Linux runs
  up to four. Every invocation retains per-file logs under `node_modules/.cache/test-logs`.
- `bun run bundle` and commit `plugin/skills/tracetoon/dist/tracetoon.mjs`
- `bun run test:bundled` exercises the shipped bundle; `bun run build` followed
  by `bun run test:compiled` rehearses publication against the native executable.
  Packaged runs select the public CLI/asset/launcher contracts declared in
  scripts/packaged-contracts.ts. Their JUnit results must contain every selected
  contract; renamed, skipped, failed, or empty selections cannot pass silently.
  All source tests still run on each supported CI platform. Publication itself
  reuses current validation; it never launches these suites at publish.
  CI runs both packaged suites on every PR, on every platform, and is their
  gate before merge: any change to shipped code (`src/`, assets, the bundle,
  dependencies) can affect them. Locally they are optional and take about two
  minutes. Run them when you want that signal before CI, especially for
  packaging changes such as `scripts/bundle.ts`, `scripts/build*.ts`,
  `scripts/test-packaged.ts`, `scripts/test-files.ts`, the launchers in
  `plugin/skills/tracetoon/bin/`, `install.sh`, `install.ps1` or the release
  workflow. Otherwise record them as left to CI rather than as passed:
  `tracetoon check --run <id> --name test-bundled --skip "Left to CI, which runs
  the packaged contracts on every PR"` (likewise `test-compiled`).
- Never commit real session logs. Fixtures are synthetic or scrubbed.

Contributor research and review handoffs live in `src/contribution/`; their host
agent role prompts and v2 claim/source contracts are documented in the packaged skill's
`references/contribution-workflow.md`. Run `bun scripts/eval-contributions.ts
prepare`, supply separate baseline and three-phase drafts, then run
`review-inputs` and `score` to exercise the synthetic, source-cited evaluation.
Its lexical probes are smoke checks, not a semantic quality score. Evaluation
artifacts stay under `.git/tracetoon/eval-contributions/`.

For visual comic changes, `bun scripts/eval-comics.ts prepare` allocates paired
baseline/candidate runs for six synthetic scenarios and two held-out cases
(cache invalidation and documentation only). Existing flawed originals remain
negative controls. Have a drafter write candidates from each scenario.json;
draw and render explicitly through an approved image route. Preparation never
requests images, moves the latest task, or overwrites candidate scripts.
Run `bun scripts/eval-comics.ts blind` for image-only review, then `gallery` to
compare with facts, reader probes and schematic geometry proofs at PR/phone
widths. Optional scenario ids after any command select a subset. Record actual
observations, inference, payoff and factual fidelity separately; structural
tests and reader probes are not automated humor scores. Artifacts stay in .git/.

## Releasing

Bump only `package.json`, then run `bun run bundle`. The build stamps the skill
VERSION, plugin version and shared build identity; `bun run build:check` detects
drift. Commit the generated files and open a same-repository PR. After all three
platform suites pass, CI builds the five native targets and six skill archives,
checks reproducibility, and rehearses the exact candidate bundle and Windows
executable. It retains an artifact named for the source commit and workflow
attempt, with per-file checksums, output receipts and a complete skill inventory.
CI uses Python 3.11's standard library to package ZIPs with explicit Unix file
permissions. The archive tests also extract and execute the launcher on Linux
and macOS. Run those focused checks with `python -B -m unittest discover -s
.github/scripts -p test_package_candidate.py -v`.

Freeze the artifact's ID, run ID, GitHub digest and local checksums before
evaluation. Keep the originating source commit and runtime unchanged throughout
the fixed admission and confirmation stages. An inconclusive or failing gate
ends the round without a release. Only after passing the full development
(90 drafts/240 judgments) and held-out (36 drafts/96 judgments) adoption gates,
commit a reviewed `release-promotion.json` using the
`tracetoon.release-promotion/v1` contract in
`.github/scripts/release-assets.ts`. Record both experiment IDs and report hashes,
the immutable artifact identity, and the manifest, checksums, Windows executable
and bundle hashes. Private cases and raw model outputs must remain outside Git.

An explicit user request may authorize releasing a CI-tested candidate after an
inconclusive admission screen. Record that separate decision using
`tracetoon.release-promotion/v2`: include the request's reason and recording time,
the actual calibration/admission experiment IDs and report hashes, and mark
development and held-out confirmation as not run. This does not turn the
benchmark into a pass or establish a score/performance gain. The release notes
publish that limitation; artifact identity and byte verification still apply.

Push the matching `vX.Y.Z` tag after merging the validated changes. The release
workflow verifies the successful originating CI run, artifact identity, source
build identity, the recorded release basis and every asset checksum, then publishes
those exact bytes. It does not build replacement release files. Install from
that release and compare the installed runtime and skill against the retained
inventory. `tracetoon doctor --json` reports actual runtime and hook identities,
installed skill mismatches and observed hook events.

`bun run build:reproduce` builds bundle and native artifacts from two isolated
source snapshots. Output receipts bind the artifact hash to the compiler,
dependency manifest and target. Keep a passing reproduction report when changing
the build pipeline; it establishes reproducibility on that host/toolchain.
