# The relational arm's review packet

In relational mode, `tracetoon review-packet --lean` writes the shared header, the title and the line-numbered body. Everything below them comes from `buildPacketEvidence` in `src/packet/evidence.ts`. The lean reviewer reads only this packet, so the packet has to carry what each check in `reviewer-lean.md` needs, and little else.

## Inputs

The packet is built from the run's own files. It never reads the evidence graph.

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

| section              | what it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | the check it serves                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Legend (header line) | `body:N`, `diff:N`, `commit:<sha>#n`, `S#/D#/P#`, `path:line`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Citations that `review import` resolves. H and F are reading labels only, because the import maps `H#` to the graph's hunks.                  |
| Refs per body line   | `body:N ← H3, S1, commit:…#2`, matched from `body.md` to the rendered body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Checks each claim against the evidence it says it rests on. A line with no entry rests on nothing.                                            |
| Requests             | Requests, decisions and plans, verbatim: those the writer cites, opening requests, pushback, plans sent back, and any in the context. Cited prompts get up to 1,200 characters; others are clipped.                                                                                                                                                                                                                                                                                                                                                                           | "The user asked…" claims must match one of these.                                                                                             |
| Commit messages      | Every commit, its own chunks, and each sentence with the chunks the store ties it to, or `nothing tied (only the message states this)`. Result sentences are labelled. Each sentence is marked cited, covered by its code, or not cited.                                                                                                                                                                                                                                                                                                                                      | Facts only a message states, written as fact; a file named for a behavior vs where the commit's code does it; uncited sentences as omissions. |
| Files and chunks     | Per file: status, role, size. Per chunk: new-file lines, its `diff:a-b` range, owning symbol (`in`), `new:` names (defined here and removed nowhere), `redefines:`, `removes:`, test titles, `uses` (test → code), the count of branching changed lines, specific requests tied to it, whether the body cites it, whether it is shown. Chunks with nothing to say collapse onto one `also` line. Generated, lock, version and binary files get one line with no diff.                                                                                                         | "New" vs existing symbols; where a behavior lives; absolutes against branching chunks; cite-able ranges for chunks not shown.                 |
| Coverage leads       | Files the body neither names nor cites; untagged sentences (as `body:N`); render's flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Omissions and unsupported sentences.                                                                                                          |
| Diff                 | Shown whole when the reduced diff is at most 16,000 characters. Otherwise it is selected in priority order until 16,000 characters are used: the chunks the body cites (including those tied to a cited commit sentence), test assertions, branching chunks (most branches first), then chunks adding names. Test files keep only their `@@` line, test titles and assertion lines. Other chunks keep 3 context lines around their changed lines, so a condition just above a change stays visible. Lines are clipped at 240 characters and numbered by `changes.patch` line. | Branch and default checks, dropped conditions, test claims vs assertions.                                                                     |

The packet leaves out:

- Run results: the generated Validation section covers those, and it is elided.
- Requests the body doesn't touch beyond a 300-character clip.
- Requests tied to more than a third of the chunks, such as the opening ask, from the per-chunk `asked in`: they say nothing about any one chunk.

## Coverage for render

`graphBriefParts` (relational branch) adds a `coverage` section from the same links (`sentenceCoverage` in `src/relational/coverage.ts`):

- A commit sentence is covered when the body cites a chunk that hybrid search tied it to within its own commit.
- A sentence tied to nothing, in a commit whose own lines fall in at most 3 chunks, is covered by those chunks. It speaks for that commit, and the commit's code is that small.

Rows are keyed by the refs render's commit rows use, which may name the commit by a shorter sha.

## Size

Measured on the 7 benchmark cases with a short synthetic body:

| case   | patch chars | packet chars | diff mode |
| ------ | ----------- | ------------ | --------- |
| pr11   | 6,599       | 10,004       | whole     |
| pr12   | 8,592       | 11,603       | whole     |
| pr8    | 16,690      | 20,963       | whole     |
| vexaim | 35,763      | 24,001       | selected  |
| pr5    | 40,613      | 27,543       | selected  |
| pr9    | 55,868      | 26,693       | selected  |
| pr10   | 136,458     | 35,326       | selected  |

The diff is capped at 16,000 characters, so a large PR costs about 6–9k tokens.
