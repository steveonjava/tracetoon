# digest.json fields

Prompts, decisions, plans and runs carry short ids (`S1`, `D1`, `P1`, `R1`) so
you can keep track of which fact supports which sentence. Don't print the ids in
the PR.

Exact-content validation receipts have separate `V1`, `V2` ids. Reviewers cite
them as `digest:V1`; `tracetoon expand V1 --run <id>` prints their evidence.
They do not turn historical runs into proof of the current revision, and a
passing receipt supports only the command and environment that were checked.

| Field | Meaning |
|---|---|
| `pr` | Base, head, merge base, commits (short SHA, subject, trailers, commit time), existing PR number and URL |
| `pr.commits[].body` | Optional redacted commit explanation. Attribute commit-only accounts and related references; cite locally as `commit:<sha>`. A mention does not imply a saga relationship |
| `pr.usedWorkingTree` | True when there are no commits yet and the digest describes uncommitted changes |
| `pr.dirty` | Uncommitted changes existed: a run may have tested code that isn't in the PR |
| `stats.agentMatchedPct` | Share of non-trivial added lines that match a captured agent edit |
| `stats.commitsMadeInSessions` / `stats.commits` | Commits a session made (printed by its git commands, or its message in a `git commit`) |
| `stats.about` | These numbers are Tracetoon's line matching for the trace section, not authorship: don't report them in the description |
| `sessions[].ref` | Stable hashed id; use it with `--include`, `--exclude`, `expand` |
| `sessions[].band` | `included`, or `ambiguous` (ask the user) |
| `sessions[].score`, `reasons` | Why the session was matched |
| `sessions[].prompts` | What the user typed (redacted, clipped). `ledToEdits`: the turn produced lines that are in the PR. `pushback`: typed while rejecting the agent's action, so it corrects or steers it |
| `sessions[].delegations` | Tasks the agent gave its own subagents (not the user's words) |
| `sessions[].plans` | Plan excerpts. `approved: false` means sent back, which doesn't by itself mean the design was rejected (Codex plans have no approval step) |
| `sessions[].artifacts` | Documents the agent kept (Antigravity task, implementation plan, walkthrough), with its own summary |
| `sessions[].decisions` | Questions the agent asked and the answers. `questions[]` (when recorded) has each question's `options` and the exact `answer`; `ownWords` means the user answered in their own words instead of picking an option. An option that wasn't picked is only that: not picked |
| `sessions[].runs` | Individual verification runs: `kind` (test, build, lint, typecheck, eval), `outcome` (passed, failed, unknown), `basis` (exit status, output, none), up to three result lines in `summary`, and `revision`: `before later edits` (PR files changed after it), `no later edits seen`, `after later work` (ran after the PR's last commit and further edits, so it tested code that isn't in this PR: don't cite it), or `unknown`. A run never proves the final revision passes; word it as what ran and what it showed |
| `verification` | Current explicit receipts as `V#` facts, with `verificationBasis: exact-content-receipt`. Their recorded command outcome is bound to the current content and execution environment; inferred `R#` session runs remain separate |
| `validation` | All check statuses, including failed, stale, running, skipped and CI-only checks, their reasons and durations. Skipped/unavailable checks are never passing evidence |
| `checksSha` | Fingerprint of the local receipt collection at digest time. Changed receipts require refreshed evidence and review |
| `sessions[].commands` | Grouped shell commands with counts, failures, and an `isTest` flag |
| `sessions[].milestones` | Deterministic events: plan approved, tests went from failing to passing, edits that didn't survive |
| `sessions[].usage`, `sessionCostUsd` | Token totals for the matched part; cost is for the whole session |
| `files[]` | Per file: `role` (behavior, tests, docs, config, generated, version), lines added/removed, lines matched to each session, lines not matched to captured evidence |
| `files[].facts` | Facts (S/D/P) whose turns' edits survive in this file, strongest first. From the evidence graph |
| `files[].checksAfterLastEdit` | Check runs after the file's last captured edit, latest first (`R4:passed`). Absent: none captured. Historical log evidence, not proof the submitted content passes |
| `sessions[].runs[].laterEdits` | PR files the session edited after this run: what the run did not see. Qualify a cited result as from before those edits |
| `graph` | Size of the run's evidence graph (`evidence-graph.json`): nodes, relationships, hunks, hunks linked to an agent edit, edits, dead-end edits |
| `disclosure` | Agents, models, suggested and existing AI trailers |
| `interop` | Provenance other tools recorded: Entire checkpoints in commit trailers, git-ai notes |
| `privacy` | Redaction count and records dropped because they belonged to other repos |
| `linkedPrs` | Other PRs the sessions linked themselves to (context for the writer) |
| `notes` | Things to tell the user or reflect in the text |
| `truncated` | What was trimmed to fit the budget; use `tracetoon expand <ref>` for full detail |

`no later edits seen` is a legacy heuristic over normalized edit records, which
can miss shell writes even inside the same session. It never establishes that
code stayed unchanged. Historical tested content remains unverified; use current
matching-content receipts for claims about the submitted content.

## Evidence graph

`digest` also builds `evidence-graph.json`: prompts, decisions, plans, runs,
edits, files, diff hunks and commits, connected by the turn each happened in,
the hunks an edit's lines survive in, the files edited after each run, and the
commits each session made. Ask it with `tracetoon query <name> --run <id>`:

| Query | Answers |
|---|---|
| `brief` | Start here: change units with their owning symbols, the requests and commit-message sentences behind each (scoped to their commit), checks dated against the edits, limits, and what not to claim |
| `outline` | Every changed file: role, size, hunks, prompts whose edits survive in it, commits, checks after its last edit |
| `why <path\|path:line\|H#\|diff:N>` | The turns behind a file or hunk (prompt, decisions, plans, diff refs), its commits and its checks |
| `verified [path]` / `unverified` | Check runs after each file's last captured edit / behavior and test files with no passing one |
| `unexplained` | Behavior and test hunks no captured agent edit survives in |
| `turn <S#>` | What one prompt led to, including dead-end edits |
| `stale <R#>` | Files edited after a run |
| `dead-ends`, `pushback` | Abandoned edits; prompts that redirected the agent |
| `schema`, `--cypher` | The graph's labels and relationships; your own read-only Cypher |

Diff refs (`diff:120-141`) are `changes.patch` line ranges, citable as change-map
`behaviorChecks` evidence. Graph links are captured evidence: a missing link
means it was not captured. `graph-review.json` holds the review leads copied
into `review-input.json` (`graphLeads`).

`digest` also writes `evidence-notes.md` before drafting, separating historical
checks, current receipts and validation gaps. `expand` accepts session refs,
individual `S1`, `D1`, `P1`, `R1`, `V1` facts (also `digest:R1`), and
`commit:<sha>`. Complete redacted fact text and runs live in `digest-full.json`;
ids stay consistent with the compact digest. Expanding an ambiguous session does
not include it in the PR. Review packets fingerprint the full evidence as well
as the optional change-map content; old packets remain readable.
