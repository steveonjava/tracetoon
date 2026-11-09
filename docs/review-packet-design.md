# The relational arm's review packet

In relational mode, `tracetoon review-packet --lean` writes the shared header, the title and the line-numbered body. Everything below them comes from `buildPacketEvidence` in `src/packet/evidence.ts`. The lean reviewer reads only this packet, so the packet has to carry what each check in `reviewer-lean.md` needs, and little else.

## Inputs

The packet is built from the run's own files. It never reads the evidence graph. In relational mode it is always built, even when `relational-context.json` is missing (an empty context), so the graph packet never fills in for a relational run.

- `changes.patch`: re-chunked with the arm's own chunker (`chunkPatch` in `src/relational/diff.ts`). The H and F ids match the writer's context. Each parsed line keeps its `changes.patch` line number, so every `diff:N` in the packet is a real patch line.
- `relational-context.json`: the context's refs, plus `links`. `links` holds the store's own links, which the builder now saves next to the text:
  - chunk → requests and commit sentences tied to it;
  - test chunk → names it uses;
  - commit → its own chunks;
  - commit sentence → chunks of its own commit;
  - the requests, decisions and plans the builder weighed, with their labels.

  Before the packet uses `links`, it checks that they describe this patch: the same chunk ids, files and line ranges. If they don't (for example, the patch changed after `prepare`), the packet leaves them out and says so. It never attributes code by a stale id.

- `body.md`: the writer's ref tags.
- `brief-check.json`: untagged sentences and render's flags.

The context text the writer reads (`RelationalContext.text`) is unchanged: `links` is computed after packing. On the 7 benchmark cases, the text is byte-identical before and after this change.

## Sections

| section              | what it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the check it serves                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Legend (header line) | `body:N`, `diff:N`, `commit:<sha>#n`, `S#/D#/P#`, `path:line`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Citations that `review import` resolves. H and F are reading labels only, because the import maps `H#` to the graph's hunks.                  |
| Refs per body line   | `body:N ← H3, S1, commit:…#2`, matched from `body.md` to the rendered body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Checks each claim against the evidence it says it rests on. A line with no entry rests on nothing.                                            |
| Requests             | Requests, decisions and plans, verbatim: those the writer cites, opening requests, pushback, plans sent back, and any in the context. Cited prompts get up to 1,200 characters; others are clipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | "The user asked…" claims must match one of these.                                                                                             |
| Commit messages      | Every commit, its own chunks, and each sentence with the chunks the store ties it to. A sentence nothing was ranked for gets its commit's own code: "check whether they do it" when the commit has at most 3 chunks, otherwise "may be message-only". Result sentences are labelled. Each sentence is marked cited, covered by its code, or not cited.                                                                                                                                                                                                                                                                                                                                                           | Facts only a message states, written as fact; a file named for a behavior vs where the commit's code does it; uncited sentences as omissions. |
| Files and chunks     | Per file: status, role, size. Per chunk: new-file lines (`old L` for a pure deletion), its `diff:a-b` range, owning symbol (`in`), `new:` names (defined here and removed nowhere), `redefines:`, `removes:`, test titles, `uses` (test → code), the count of branching changed lines, specific requests tied to it, `tagged` (the writer's tags cite it, or a cited commit sentence is tied to it) or `named` (the prose names its file or a name it defines), and how it is shown. Chunks with nothing to say, and version-only bumps, collapse onto one `also` line. Generated, lock, version and binary files get one line with no diff.                                                                     | "New" vs existing symbols; where a behavior lives; absolutes against branching chunks; cite-able ranges for chunks not shown.                 |
| Coverage leads       | Files the body neither names nor cites (not generated, lock, version, binary or version-only files); open points: requests after the last commit, sent-back plans, pushback and ambiguous-session facts the body doesn't cite; added TODO/FIXME/XXX/HACK lines as `diff:N`; untagged sentences (as `body:N`); render's flags                                                                                                                                                                                                                                                                                                                                                                                     | Omissions, open points and unsupported sentences.                                                                                             |
| Diff                 | Whole when every diffable chunk, test files included, fits in 16,000 characters; whole with test files reduced to their `@@` line, titles and assertions when only that fits. Otherwise it is selected in priority order until 16,000 characters are used: tagged chunks in full; the first 3 branching lines (±1 line) of every branching chunk, most branches first, so one long chunk can't crowd out the rest; test assertions; the remaining branching lines; chunks only named in the prose; chunks adding names. Full chunks keep 3 context lines around their changed lines, so a condition just above a change stays visible. Lines are clipped at 200 characters and numbered by `changes.patch` line. | Branch and default checks, dropped conditions, test claims vs assertions.                                                                     |

The packet leaves out:

- Run results: the generated Validation section covers those, and it is elided.
- Requests the body doesn't touch beyond a 300-character clip.
- Requests tied to more than a third of the chunks, such as the opening ask, from the per-chunk `asked in`: they say nothing about any one chunk.

## Coverage for render

`graphBriefParts` (relational branch) adds a `coverage` section from the same links (`sentenceCoverage` in `src/relational/coverage.ts`):

- A commit sentence is covered when the body cites a chunk that hybrid search tied it to within its own commit.
- A sentence tied to nothing (and not reporting a result), in a commit whose own lines fall in at most 3 chunks, is covered by those chunks. It speaks for that commit, and the commit's code is that small.

Rows are keyed by the refs render's commit rows use, which may name the commit by a shorter sha.

## Size

Measured on the 7 benchmark cases with a short synthetic body:

| case   | patch chars | packet chars | diff mode |
| ------ | ----------- | ------------ | --------- |
| pr11   | 6,599       | 9,655        | whole     |
| pr12   | 8,592       | 11,842       | whole     |
| pr8    | 16,690      | 23,560       | whole     |
| vexaim | 35,763      | 23,916       | selected  |
| pr5    | 40,613      | 28,584       | selected  |
| pr9    | 55,868      | 27,618       | selected  |
| pr10   | 136,458     | 35,655       | selected  |

The diff is capped at 16,000 characters, so a large PR costs about 6–9k tokens.
