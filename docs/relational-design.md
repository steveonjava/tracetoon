# The relational/vector context builder

This builder is the relational/vector arm of the shape test. It turns the evidence behind a PR into the only context the PR-description writer reads:

- the user's requests, decisions and plans;
- the agent's edits;
- the commits and their messages;
- the diff.

The text is packed to a fixed budget of 2,112 tokens (characters / 4) and carries ids the writer cites.

Code: `src/relational/`

- `store.ts`: schema and ETL.
- `diff.ts`: diff parsing and chunking.
- `retrieve.ts`: relational links and hybrid search.
- `pack.ts`: packing and layout.
- `embed.ts`: embeddings.
- `builder.ts`: wires these together.
- `coverage.ts`: which chunks cover each commit sentence, for `render`.

Nothing here imports from `src/graph/` except the input types.

## Pipeline

```
GraphInputs ─ETL→ SQLite record tables ─SQL joins→ exact links ┐
                       │                                     ├→ evidence per item ─greedy pack→ text + refs
                       └─ queries → BM25 ∪ kNN ∪ mentions ─RRF┘
```

1. **ETL** (`loadStore`): the inputs are loaded into an in-memory SQLite database (the official wasm build) with foreign keys on.
2. **Exact links** (`relationalLinks`, `inheritApprovals`): plain joins on stored keys.
3. **Hybrid search** (`hybridSearch`): every request, decision, plan paragraph, commit subject and commit-message sentence is run as a query against the diff chunks. Three rankers are fused with reciprocal rank fusion, and the fusion itself is SQL.
4. **Packing** (`pack`): every possible line of output is a candidate with a value and an exact character cost. A greedy picks by value per character, with diminishing returns.
5. **Refs**: the ids that appear in the final text, each with the full text of its item, and nothing else.
6. **Links** (`links` in `relational-context.json`, computed after packing so the text is unaffected): the store's chunk, commit, sentence and fact links, for the review packet and render's sentence coverage (see `docs/review-packet-design.md`). The writer never sees them.

## Schema

| table                        | key                     | foreign keys / join keys                                                   | what it holds                                                                                                                                              |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`                    | `ref`                   |                                                                            | agent, band (included / ambiguous), span                                                                                                                   |
| `fact`                       | `id` (S#, D#, P#)       | `session_ref` → session; `turn_id` → fact (the prompt whose turn it is in) | requests, decisions (question → answer), plans; word count, `noise` flag (pasted tool output, interruption markers, Claude Code's AskUserQuestion wrapper) |
| `run`                        | `id` (R#, V#)           | `session_ref`, `turn_id`                                                   | runs and receipts (kept in the store; not shown, see below)                                                                                                |
| `edit`                       | `id`                    | `session_ref`; `turn_id`, `step_id` → fact; `file`                         | one captured edit, in trail order                                                                                                                          |
| `edit_line`                  |                         | `edit_id` → edit; `norm`                                                   | normalized added lines that also survive in the PR                                                                                                         |
| `file`                       | `id` (F#)               | `path` (unique)                                                            | status (new, deleted, renamed, modified), binary, role (behavior, tests, docs, config, generated), +/−                                                     |
| `chunk`                      | `id` (H#)               | `file_id` → file                                                           | new-file line range, enclosing scope, names defined and removed, test titles, search body                                                                  |
| `chunk_line`                 |                         | `chunk_id` → chunk; `norm`                                                 | every changed line with sign, line number and normalized text                                                                                              |
| `symbol`                     |                         | `chunk_id`; `name`                                                         | names defined, removed, or test titles                                                                                                                     |
| `ident`                      |                         | `chunk_id`; `name`                                                         | identifiers used on added lines (for "test uses X" and centrality joins)                                                                                   |
| `commit_`                    | `sha`                   | `ref` (12 chars, unique)                                                   | subject, body, time                                                                                                                                        |
| `commit_sentence`            | `id` (`commit:<sha>#n`) | `sha` → commit_                                                            | each body sentence or bullet; `result` flag for sentences that report results                                                                              |
| `commit_file`, `commit_line` |                         | `sha` → commit_; `path`, `norm`                                            | the commit's touched files and its own added and removed lines                                                                                             |
| `chunk_fts`                  |                         | `chunk_id`                                                                 | FTS5 (porter, unicode61) over the chunk body, identifiers split into words                                                                                 |
| `query`, `hit`               |                         | `query_id` → query; `chunk_id` → chunk                                     | every query and every ranker hit (rank, raw score, `strong`: clears the ranker's relative bar, `strength` 0..1)                                            |
| `fused`                      |                         |                                                                            | per (query, chunk): RRF score, number of rankers that agree strongly, summed strength, cosine, whether it was named                                        |
| `link`                       |                         | `chunk_id` → chunk; `src` (a fact, commit or sentence id)                  | the evidence: `edit`, `commit`, `search`, with weights                                                                                                     |

Commit-sentence numbering uses the same splitting rule that `render` checks sentence coverage against, so `commit:<sha>#n` means the same sentence on both sides.

**Disclosure: copied code.** `commitSentences` and `RESULT_CLAIM` in `src/relational/text.ts` are copied from `src/graph/build.ts`; they are not imported, because nothing under `src/graph/` may be imported. They are copied rather than rewritten because the numbering has to match: `render` checks the writer's `commit:<sha>#n` tags and commit-sentence coverage against the graph's numbering, so a different split would point `#3` at a different sentence. Everything else in `src/relational/` is written for this arm, including the diff parser and the definition and test-title readers.

## Diff parsing and chunking

`parsePatch` reads `git diff` output on its own:

- It reads file headers: new or deleted mode, rename from/to, `Binary files … differ`, `+++`.
- It reads each hunk body by the line counts in its `@@` header, so a removed line that starts with `--` or `++` is never taken for a header.

A hunk with up to 40 changed lines is one chunk. A larger hunk (a new file, a big rewrite) is split where a definition or test starts at the hunk's shallowest indent, once the current piece has at least 8 changed lines. It is hard-split at 80. So a chunk is about one function or one doc section. That matters twice:

- The writer can cite exactly the code that does a behavior.
- A mean-pooled static embedding of a 700-line file says little, while one of a 40-line function says a lot.

Each chunk records:

- its new-file line range (old-file range for a pure deletion);
- the enclosing scope (git's `@@` context, else the last top-level definition the hunk left open; never for new files, where it would be a sibling);
- names defined on added lines, and names defined on removed lines;
- test titles from `test('…')`, `it(…)`, `describe(…)`, `def test_…`, `func Test…` and `fn test_…`. These are read with a linear scan, because a backtracking regex took 1.5 s on one long comment line.

Definition regexes see at most 240 characters of a line and skip comment lines.

A name is **new** when it is defined on an added line and on no removed line anywhere in the patch. The layout says "adds X" for new names and "redefines X" for the rest, which follows the rule about calling a symbol new.

## Exact links (SQL)

- **edit**: `edit ⋈ edit_line ⋈ chunk_line ⋈ chunk ⋈ file` on (file path, normalized line), grouped by the edit's `turn_id` (the request) and `step_id` (the decision or plan just before the edit). The weight is the number of distinct surviving lines. This is the strongest "why": the turn's own lines are in this chunk.
- **commit**: `commit_line ⋈ chunk_line` on (path, normalized line, sign). A removed line matches a `-` chunk line. A commit with no matched lines (only short lines, or a binary file) falls back to the chunks of its touched files.
- **approvals**: a short prompt ("yes", "Execute the plan") or pasted output has no reason of its own. Its turn's edit links are copied to the nearest earlier substantive fact in the session, which is usually the plan or question it answered. One SQL statement does this with a correlated subquery.
- **time**: a fact typed after the PR's last commit can't be why the commits were made. Such facts are labelled and their value is cut to a quarter.
- **test → code**: `ident` (identifiers in test chunks) joined to `symbol` (names defined in non-test files) gives "uses greet (H1)" on test chunks.
- **centrality**: the same join, counted per file, gives "defines X used by N other changed files" for choosing where a reviewer should start. Only distinctive names count (camelCase, snake_case, PascalCase, or 8 characters or more), and the largest file is never put first.

## Hybrid search

**Queries:**

- every request and decision (clipped to 2,000 characters);
- each paragraph of a plan (up to 40 per plan);
- every commit subject;
- every commit sentence.

Noise prompts and prompts under three words are skipped.

**Rankers.** Each returns its top k for a query over N candidate chunks, with k = min(8, max(2, ⌈N/5⌉)). With few chunks, a fixed top 8 would make BM25 and the vectors "agree" on almost every chunk.

- **BM25**: FTS5 `MATCH` over the query's rarest content words, quoted and OR-ed, with `bm25()` ordering. The FTS body indexes code identifiers both whole and split (`survivalLinks` → `survival links`), with porter stemming.
- **Vector**: exact cosine kNN over unit vectors in TypeScript. A PR has a few hundred chunks, so a brute-force scan (about 1 ms per 1,000 chunk-query pairs) is exact and needs no ANN index.
- **Mention**: chunks that define a name the query uses (`backticked`, camelCase, snake_case, `fn()`), or that are in a file whose path it names. Naming code is the most precise signal a commit message has, and neither BM25 nor a static embedding scores it highly enough.

**Scoping.** A commit's subject and sentences only see the chunks that commit introduced, so "a sentence speaks for its own commit only" holds in retrieval as well as in the rules. For BM25 the filter is a subquery inside the `MATCH` statement; for the other two rankers it is a set filter.

**Agreement is relative.** A hit counts as agreeing only above its ranker's bar for that query:

- BM25: at least half of the query's best score;
- vector: cosine at least the query's mean over its candidates + 1σ;
- mention: always (naming code is exact).

**Fusion.** Reciprocal rank fusion with k = 60 runs in SQL (`sum(1/(60+rank))` grouped by query and chunk) and orders a query's chunks. The link weight is the agreeing rankers' summed strength divided by 3, where strength is the score relative to the query's best (for vectors, relative to the mean). A weight of 1.0 means all three rankers put the chunk at the top. Raw RRF was not used as the weight because it saturates: two rankers anywhere near the top give about the same score.

**Acceptance rule.** A fused hit becomes a `search` link only if one of these holds:

- two rankers agree strongly;
- the query names the chunk;
- the cosine alone is at least 0.55 and clears its bar.

RRF always ranks something first, and an unconditioned top-k would turn noise into "evidence".

**What `→` means.** A request, decision or plan prints `→` only to chunks it has an edit link to, or a search link with weight at least 0.6 (two rankers near their top, or all three agreeing). A commit sentence prints its strongest links within its own commit's code.

**Reranking.** No cross-encoder can run here (offline, under 2 s, in three runtimes), so reranking works from relational priors:

- `edit` links (exact) outweigh `search` links in a chunk's reasons;
- commit scoping removes cross-commit candidates;
- the mention ranker supplies the precise matches.

**Topical relevance.** For requests, decisions and plans, relevance combines three things:

- 40%: surviving edit lines, log-scaled;
- 45%: topical similarity, the cosine of the fact's embedding with the change's centroid (chunk vectors weighted by size and file role);
- 15%: the number of strong search links (weight 0.6 or more).

Topical similarity separates real asks from chatter: about 0.05–0.15 for "yes", "done" or "how is the test going", 0.33–0.5 for requests about the change, and 0.4–0.7 for plans. RRF scores could not do this, because they saturate (nearly every fact scored about 0.63).

**Opening request.** For each included session, this is the earliest prompt of 8 words or more whose topical similarity is at least 60% of the session's best.

**Long texts.** For long requests, plans and decisions, the shown text keeps the first sentence and then the sentences closest to the centroid, in their original order, with "…" marking gaps.

## Embeddings

The model is [`minishlab/potion-code-16M-v2`](https://huggingface.co/minishlab/potion-code-16M-v2) at revision `e9d2a44ca6a0` (MIT). It ships unchanged in `plugin/skills/tracetoon/assets/potion-code-16M-v2/`:

- `model.safetensors`: 32.5 MB, float16, 63,457 × 256;
- `tokenizer.json`: 1.0 MB;
- the model card and config.

Total: 33.5 MB. `build-dependencies.json` pins the revision and the SHA-256 of each file. `scripts/embedding-model.ts check` verifies them on every build, and `fetch` re-downloads the pinned revision.

Why this model:

- **The task is code retrieval from natural language.** The queries are requests and commit sentences; the documents are diff chunks. potion-code-16M-v2 is distilled from nomic-ai/CodeRankEmbed and contrastively fine-tuned on 1.2M natural-language query / code pairs from CornStack. On the CoIR benchmark it beats the general potion models by 7–8 nDCG points, and its card reports that BM25 hybrid fusion helps further, which is the setup used here.
- **Static embeddings fit the constraints.** Inference is normalize → BERT pre-tokenize → WordPiece → drop `[UNK]` → mean of float16 rows → L2 normalize, in pure TypeScript (`embed.ts`). There is no ONNX runtime, wasm, threads or network, so it is identical in Bun, the Node bundle and the compiled binary, and deterministic. Loading takes about 35 ms; one embedding takes about 16 µs. A whole 7,900-line PR (274 chunks and about 200 queries) embeds in under 100 ms. A MiniLM-class ONNX model would need a roughly 10 MB wasm runtime and about 5–10 ms per chunk, which breaks the 2 s budget on large PRs, and would buy context that static vectors don't have. The fused BM25 and mention rankers already cover the exact-token side.
- **Verified against the reference.** Token ids match Model2Vec 0.6.0's `StaticModel.tokenize` exactly, and vectors match `encode` to within about 1e-4 (numpy accumulates float16 means in float16; this code sums in float64). Model2Vec's 512-token cap and its character pre-truncation (512 × median token length) are reproduced. The unit tests pin the reference ids and vector values.

If the model files are missing, the builder runs on BM25 and mentions only, and `stats.retrieval.modelError` says why.

## Packing

There are about 700 candidate lines for a large PR. Each has:

- a section, a layout order and a value;
- an optional parent (a chunk needs its file line; code lines need their chunk; a commit sentence needs its commit);
- a group with a decay (each further chunk of one file is worth ×0.6; each further sentence of one commit ×0.85; each further request of one session ×0.9), and optionally a cap on how many of the group are chosen;
- an optional longer version.

The greedy picks the candidate with the highest marginal value per character. Each line's cost carries a fixed 40-character overhead in this ratio only (not in the budget), so short fragments don't win just for being short. A commit's later sentences also need its sentence #1 first: "It now applies to whoever drafts." never appears without the sentence it leans on. Marginal value applies the group decay and a gentle per-section decay (0.95–0.985 per line already chosen), so no single kind of evidence, typically code detail, takes the whole budget. This is the standard greedy for a submodular objective under a knapsack constraint.

- **Upgrades compete.** Upgrading a line to its longer version is a candidate worth 45% of the line's value. For a small PR the budget therefore goes to full commit sentences, longer request text and more before ⇒ after code lines, instead of to marginal facts.
- **Value floor.** Requests, decisions and plans worth less than 1.5 are left out even when room remains: an ambiguous session's aside costs the writer more than empty space does. Diff and commit lines have no floor.
- **Ambiguous sessions.** A fact from an ambiguous session with no surviving edits needs relevance 0.4 or more to be shown, and at most two such facts are shown.
- **Mandatory file roll-up.** Every changed file is named. For each section and directory, one mandatory `also in <dir>/:` line lists the files that have no line of their own. Test files go in the Tests section, behavior files under What changed, and the rest under Other. The roll-up's full cost is reserved before the greedy pass. It shrinks as files get their own lines, and the per-round re-measure gives the freed space back. If the full form (`[F#] name (new +12/−0)`) would take more than a quarter of the budget, files are listed compactly as `[F#] name`.
- **A floor for code.** On large PRs, file and chunk lines would otherwise win every time, and no code line would appear. Code lines of behavior chunks that add names or change a value (a before ⇒ after pair) are worth at least 9, decaying ×0.6 across such chunks, so a few of them show code.
- **Small budgets.** The text never exceeds `budgetTokens × 4` characters. Below 2,000 characters a one-line legend replaces the full one, and a last resort cuts the text to the budget.
- **Exact fit.** Cross-references (`→ H3`, `why S2`) are resolved after selection. They name a chunk only if it is shown, else its file, so every id in the text is something the writer can read. The text is re-measured after each round; a final pass drops the least valuable leaves if anything still overflows, which in practice doesn't happen.
- **Values, roughly:**
  - opening request: 40 (it is why the PR exists);
  - other requests: 2 + 14 × relevance, times an information factor for short texts;
  - commit subject: 8–10;
  - commit sentence: 6–9, with the first sentence ×1.3 and results, fragments and "…:" lead-ins discounted;
  - file line: by role, size and new names;
  - chunk line: by role, size, new names, tests and linked reasons;
  - code lines: 45% of their chunk.

  These were tuned by reading outputs on this repository's own history, never on evaluation cases. The exact ranges (base..head):

  - `9ac29c4918ab485fb8132cac2464a05df134d2f2..c1231603e913032bbc30c71b0da4aeb468a81a98` (main..c123160, 16 commits);
  - `dd66a07adccbbd6a45197b08a66a46ccb489f5f3..c1231603e913032bbc30c71b0da4aeb468a81a98` (single commit);
  - `af126ac4a9c9d6dfa4cee0180793a1968b8fb203..e3bc491aaf0a25926801b1a853877def2c55516f` (single commit);
  - `9ac29c4918ab485fb8132cac2464a05df134d2f2..885332867eee8c0211d9639c482f8220e1319bbe` (single large commit).

  Two more single commits (`e3bc491a..d94bd82e`, `ca6ac22d..ed752a90`) were extracted but their outputs were never read.

### What is left out

- **Runs and receipts.** `render` writes the Validation section from the recorded runs, and the writer must not restate results. Run lines would cost budget and invite exactly that.
- **Result sentences in commit messages.** These are kept but labelled "(a result the message reports, not a recorded run)", so the writer can attribute them as the rules require.

## Layout

```
legend: what each id kind is, what → and "why" mean
## Why: requests (the user, in session order)
[S1] (opening request) …text… → H1 H3 F4
[D1] (decision) question → answer → H1
[P1] (plan, approved) …closest sentences… → H2
## Why: commits (oldest first; a sentence speaks for its own commit only)
[commit:<sha>] subject → F1 F3 F4
  [commit:<sha>#1] sentence → H1 H3
## What changed, by file (H lines: new-file line ranges)
[F1] src/greet.ts (new, +8/−0): adds greet, farewell
  [H1] L1-8 adds greet, farewell; +8/−0; why D1, S1
      - old line  ⇒  + new line
## Tests added or changed
[F3] tests/greet.test.ts (new, tests, +4/−0): tests "greet says hello by name"
  [H3] L1-4 tests "…"; uses greet (H1); why S1
## Other changed files
[F4] README.md (docs, +2/−0): "…"
also in src/graph/vendor/: [F33] README.md (new generated +12/−0), …
## Where a reviewer could start
[F5] src/x.ts (defines A, B used by 4 other changed files); then [F2] …
```

- Every changed file is named at least once, with a citable F id: either on its own line or in its section's mandatory `also in` roll-up. A unit test checks this for every file at several budgets. On main..c123160 all 48 changed files are named; before the roll-up was made mandatory, 22 were missing.
- Content never forges a tag: anything in user text or code that looks like `[H1]` or `[commit:…]` is shown as `(H1)`.
- Refs are found by scanning the final text for known ids. Each ref carries the item's full text (a request up to 1,500 characters; a chunk's path, range, names and up to 60 changed lines), so `render`'s check that a tagged sentence names only code its refs mention has the names to compare against.

## Measured

| case                                             | diff lines | chunks | queries | relational build              |
| ------------------------------------------------ | ---------- | ------ | ------- | ----------------------------- |
| fixture (unit test, 1,000 synthetic lines)       | ~1,030     | ~230   |         | < 2 s asserted (about 150 ms) |
| this repository, one commit (`c123160`)          | 160        | 12     | 77      | about 0.16 s                  |
| this repository, one large commit (`8853328`)    | 4,300      | 177    | 50      | about 0.3 s                   |
| this repository, 16-commit evidence-graph branch | 7,900      | 274    | 202     | about 0.57 s standalone       |

For the last row, about 0.45 s is retrieval and the rest is packing.

Coverage on main..c123160, before and after the review fixes:

|                            | before         | after          |
| -------------------------- | -------------- | -------------- |
| changed files named        | 26 of 48       | 48 of 48       |
| Tests section              | 176 characters | 436 characters |
| commits' share of the text | 41%            | 30%            |
| code lines                 | 0              | 2              |

## With more time

- **A learned reranker** over (query, chunk) pairs, trained on this repository's own accepted PR descriptions: a small cross-encoder distilled into a static model, or a logistic layer over the ranker scores, the RRF score, link kinds and mentions. This would replace the hand-set acceptance rule and the value constants.
- **Per-sentence placement for commit messages.** Map each sentence to its implementing chunk (`→ H#`) with a joint assignment (Hungarian over sentence × chunk similarities within a commit) instead of independent top-2 lists, so two sentences don't both claim the same chunk.
- **Calibrated budgets.** Fit the section decays and values to maximize coverage of the facts a reviewer checks, measured on a held-out set of this repository's PRs. Today they are set by reading outputs.
- **Better chunk text for embeddings**: chunk summaries (signature, docstring, changed identifiers) embedded separately from raw lines, with the scores fused.
- **Run evidence for "what was wrong".** A test run that failed and later passed around an edit is evidence of the bug. The store has runs keyed to turns, but this arm leaves them out to keep the rules simple.
- **Incremental store.** Persist the SQLite database in the run folder (`opts.runDir`), so `render` and later passes can query it instead of rebuilding.
