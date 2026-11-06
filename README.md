# Tracetoon

<p align="center"><img src="docs/tracetoon-hero.png" alt="Before: a developer recoils from a pull request reading 'Improves robustness and code quality. All tests pass (probably)'. After: the same developer grins and points at a short pull request reading 'What you asked. What ran. What changed.' with a comic pinned to it." width="760"></p>

**AI-written pull requests are mostly slop:** vague, padded, and confident
about tests nobody saw pass. Tracetoon writes the PR from what actually
happened in your agent sessions (your prompts, the plan, the decisions, the
commands that ran), and adds a comic of the story that people want to read.
When you ask your agent for a PR, Tracetoon writes it, checks it, and creates it.

## Better PRs

The sessions behind your branch are already on your machine: Claude Code, Codex
and Antigravity keep their logs. Tracetoon finds the ones that produced this
branch and turns them into a redacted digest your agent writes from.

- **Written from evidence.** What you asked for, the plan you approved, the
  decisions you made, and every test, build and lint run with its result. No
  invented motivation, and no "all tests pass" unless a run showed it.
- **Honest about what's known.** A run that passed before the last edits is
  described that way. Something that wasn't captured is "not captured", not
  "not done".
- **Short and reviewable.** The problem and the result first, the reason for
  the approach, what was checked, and where to start reviewing. No
  file-by-file lists or test-count inventories.
- **Checked before it's posted.** An advisory claim check marks sentences the
  evidence contradicts or doesn't establish, and an independent reviewer checks
  the description against the diff. It also works on text you wrote yourself.
- **Optional notes, never a form.** Tracetoon lists what a reviewer may want
  that the logs don't show (a manual check, the reason for a choice). Your agent
  may mention them after the PR is up; add them or skip them.
- **Your words stay yours.** Text you write in the PR, or edit on GitHub later,
  is kept on the next update.
- **Follows the repo's rules.** It reads AI policies, `AGENTS.md`, PR templates
  and contribution guides. It adds the disclosure a repo asks for, leaves the
  comic out where a repo forbids images in PRs (unless the comic setting is
  `always`), and reports any policy against AI contributions or agent PRs (your
  request for the PR is the override).

In a test on 8 real PRs, drafts written this way had no factual errors (the
original descriptions had 10) and 2 unsupported claims instead of 34, at about
three quarters of the length. A blind judge preferred them in all 8 cases. They
covered a little less background (76% vs 81% of the key context). The judges
were AI models and the sample is small, so read these as development numbers.

## Comics

Every PR gets a one-off comic: a joke about how the work really went, with
characters and an art style made up for that PR. There are no mascots and no
recurring cast. The agent picks a format (a gag strip, a before/after, a movie
poster, an instruction manual and more) and any art style that differs from the
repo's recent comics. An image model you choose draws the whole page, lettering
included, and the agent proofreads every word.

<p align="center"><a href="https://github.com/Tingsters/tracetoon/pull/17"><img src="docs/example-pr17.png" alt="A three-panel comic in 1950s Broadway playbill style: an empty stage under a NOW CASTING sign, a casting director watching a teapot, a knight and a cactus audition, and the teapot taking a bow under a STARRING: WHOEVER FITS sign." width="640"></a><br><sub>The comic Tracetoon made for <a href="https://github.com/Tingsters/tracetoon/pull/17">PR #17</a>, which removed the old recurring cast.</sub></p>

Comics are optional. Without an image route, or with `tracetoon config set
comic off`, the PR simply has none, and the message after the PR says why.

## Install

One command installs Tracetoon for every agent on your machine, with a prebuilt
binary, so nothing else is needed:

```sh
# macOS, Linux, Git Bash
curl -fsSL https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.ps1 | iex
```

The installer puts a `tracetoon` command on your PATH and ends with a line about
comics: which image route it found and what to do next. Restart your agent,
then in any repo with your work on a branch, ask:
_"Open a PR for this branch with Tracetoon."_

| Agent                     | Status                                        |
| ------------------------- | --------------------------------------------- |
| Claude Code               | supported                                     |
| Codex (CLI and app)       | supported                                     |
| Antigravity (CLI and IDE) | supported                                     |
| Gemini CLI                | runs the skill (its own logs aren't read yet) |
| Copilot CLI               | planned                                       |

Re-run the command to update. To remove, set `TRACETOON_UNINSTALL=1` and run it
again. Downloads are checked against the release's SHA-256 checksums.
After an update, reload your host; Codex may require trusting the new entries
in `/hooks`. `tracetoon doctor --json` distinguishes configured hooks, observed
handler invocations, and mismatched runtimes.

### Set up comics

Run `tracetoon images` to see which image routes are on your machine, whether
each can draw, and what to do next:

- **Codex CLI** (recommended if you have ChatGPT): install it and run
  `codex login` with your ChatGPT account. Images count toward your plan's
  Codex usage; no key needed. A Codex set up for another model provider (in
  `~/.codex/config.toml`, such as a LiteLLM proxy) has no image tool.
- **Antigravity CLI** (experimental): signed in, it uses your Antigravity quota.
- **OpenAI or Gemini API**: set `OPENAI_API_KEY` or `GEMINI_API_KEY`, billed
  per image to your key. On Windows run `setx OPENAI_API_KEY "<key>"`; on macOS
  or Linux add `export OPENAI_API_KEY="<key>"` to your shell profile. Then
  restart your agent so it sees the key.

Approve one and check it really draws (one small test picture, no repo content):
`tracetoon images --approve codex --test`. Your agent offers the same at the
start of your first PR.

### Tracetoon is the default for PRs, and easy to turn off

The installer adds a small hook to each agent. When an agent tries to open a PR
(or rewrite its title or body), the hook points it to Tracetoon, which writes
the description and comic, then creates the PR. It recognizes `gh pr create`
and `gh pr edit`, gh aliases for them, `hub pull-request`, git-extras
`git pull-request`, Git Town `git town propose`, writes to GitHub's pulls API
(through `gh api`, `hub api`, curl, wget, HTTPie or PowerShell, including
GraphQL `createPullRequest`) and the GitHub connector tools agents use.
Stacking tools such as Graphite and git-spice are left alone, since they manage
whole stacks of PRs, as are API reads, state-only changes (closing a PR) and
other forges' APIs. A call made from inside a script, or a GraphQL mutation
read from a file, can't be recognized from the command line. Ordinary `git push`
is left alone: pushing a branch for CI, a tag or a release commit is your
workflow, not a PR. The hook only touches its
own entries in each agent's config, backs up each file before the first change,
and lists every file it changed. If a PR command was redirected, the agent's
stop hook keeps it from finishing until that PR is published, so a redirected PR
isn't left behind. Skip it with `TRACETOON_NO_HOOK=1`. Codex asks
you to trust a new hook once (`/hooks`), and the Antigravity IDE picks it up
after a restart.

Turn it off at whichever level you need. Any "off" wins:

| Scope                   | Off                                                                 | On again               |
| ----------------------- | ------------------------------------------------------------------- | ---------------------- |
| One command             | `TRACETOON=0 gh pr create ...`                                      | (just once)            |
| You, everywhere         | `tracetoon off`                                                     | `tracetoon on`         |
| This repo, for everyone | `tracetoon off --repo` (writes `.github/tracetoon.json`; commit it) | `tracetoon on --repo`  |
| This repo, just you     | `tracetoon off --local` (git config)                                | `tracetoon on --local` |
| CI                      | off automatically when `CI=true`                                    | `TRACETOON=1`          |

`tracetoon status` shows whether it's on here and which setting decided.

<details>
<summary>Other ways to install</summary>

- **Claude Code plugin:** `/plugin marketplace add Tingsters/tracetoon`, then
  `/plugin install tracetoon@tracetoon`.
- **By hand:** unzip `tracetoon-skill.zip` (or a per-platform
  `tracetoon-skill-<os>-<arch>.zip`, which includes the binary) from a
  [release](https://github.com/Tingsters/tracetoon/releases) into your agent's
  skills folder:

| Agent       | Folder                                                               |
| ----------- | -------------------------------------------------------------------- |
| Claude Code | `~/.claude/skills/tracetoon`                                         |
| Codex       | `~/.agents/skills/tracetoon` (or `.agents/skills/` in a repo)        |
| Antigravity | `~/.gemini/config/skills/tracetoon` (or `.agents/skills/` in a repo) |
| Gemini CLI  | `~/.gemini/skills/tracetoon`                                         |

</details>

## How it works

Tracetoon runs when you ask your agent for a PR (or when the agent runs
`gh pr create` and the hook redirects it). Finishing a task does not open a PR
on its own. There is no preview or approval step: the agent prepares the PR,
has it reviewed, and creates it, then tells you what it did:

```text
Tracetoon created PR #34: https://github.com/o/r/pull/34
Comic: included.
Left out: 1 session that may not belong to this PR.
Comics: tracetoon config set comic off|allowed|always (now: allowed)
```

When there's no comic, the second line says why (comics off in your settings,
the repo's contributing rules forbid images in PRs, no image route set up, or
drawing failed). The GitHub URL is returned without waiting for remote CI.
The publishing command does not merge. Your agent can continue with CI monitoring,
PR edits or merging when requested, using its normal tools and permissions.

Hooks observe session/repository metadata locally without injecting startup rules
or blocking the end of a turn. PR preparation initializes its run when needed;
earlier coding does not require registration, branch changes or wrapped tests.
`task begin`, `check`, `task complete`, `task defer` and `task block` remain optional
for users who want explicit evidence receipts or bookkeeping. Existing PR edits,
metadata changes, merges, pushes, help and dry runs are not intercepted.

`tracetoon check` streams command output to stderr while it runs, including in
JSON mode. The receipt and validation lock stay active until the command exits;
stdout contains the final receipt. A quiet interval alone does not establish a
stalled check. Interrupted checks do not establish a passing result.

1. **`tracetoon doctor`** checks git and gh, whether you can push to the repo,
   and whether a comic can be drawn, when PR preparation starts.
2. **`tracetoon digest`** reads the branch from git (base, commits, the exact
   lines added) and finds the agent sessions behind it. The evidence: edits
   whose lines are still in the diff, commits made during a session (including
   from worktrees since deleted), PR links, the branch, timing and working
   folder. It keeps your prompts, plans, decisions and each verification run,
   with how that run relates to later edits. Everything is redacted: secrets,
   personal data, your home path and username. Sessions that may not belong to
   the PR are left out and counted in the message after the PR.
   It also builds the run's **evidence graph** (`evidence-graph.json`): each
   prompt linked to the edits made in its turn, each edit to the diff hunks its
   lines survive in, each run to the files edited after it, each commit to the
   session that made it. Tracetoon uses it to say which request and which
   checks are behind every changed file, to name the files a cited test run
   didn't see, and to trim the digest by relevance instead of recency. Your
   agent asks it questions with `tracetoon query` (`outline`, `why <path>`,
   `unverified`, …) instead of reading every fact and the whole patch. The
   graph runs in-process on [cypherlite](https://github.com/neo4j-labs/cypherlite)
   compiled to WebAssembly: no native modules, no database file, and the
   digest is still written if it can't start.
3. **`tracetoon context`** reads the PR template, AI policies and agent
   instructions, any existing PR (and edits made to it on GitHub), your
   settings, and the art styles of the repo's recent comics. It also prepares
   a contributor-research packet and the submitted diff.
4. **Your agent coordinates a researcher and a drafter.** The researcher collects
   applicable local and linked guidelines, scoped instructions, conditions and
   exceptions. `tracetoon guidance check` validates that handoff. A separate
   drafter receives the guidance, redacted traces and submitted code, then writes
   the description (`body.md`) and comic brief (`comic.json`).
5. **`tracetoon comic art` / `comic render`** draw the page with the image
   route you approved (subject to the `comic` setting), add a small "made with
   Tracetoon" footer bar, and print the words to proofread.
   The drafter first compares three short story/layout/cast concepts, then draws
   one image. Composition follows the joke: a single visual metaphor, a two-panel
   comparison, a vertical pause, unequal frames, insets or a diagonal split.
   Visible titles are optional. Fictional people, useful creature/object
   metaphors and characterless scenes are all available; there is no animal cast
   default or fixed rotation.
6. **`tracetoon render`** builds the final body (Tracetoon only owns a marked
   region, so your own text is kept), runs the leak scan and the claim check,
   lists optional notes, and prepares the exact rendered PR for an independent
   reviewer. The reviewer checks adherence against the original guidance and
   evidence; the drafter gets up to two correction rounds. Re-rendering shows
   current findings, source citations, collection gaps and missing evidence in
   its output (and `--json`). Changed inputs invalidate old reviews. Reviews are
   advisory; the leak scan and freshness checks still apply.
7. **`tracetoon publish --run <id>`** posts the rendered PR right away: the
   comic goes on the repo's `tracetoon-assets` branch (or as a GitHub
   attachment for private repos), and `gh` creates or updates the PR. The
   branch is pushed if necessary; `--no-push` requires it to already be on the
   remote at the rendered commit. `--draft` opens a draft PR. Network retries
   reconcile an existing PR before creating one. It prints the short message
   above (also `message` in `--json`).

Other commands: `images`, `status`, `on`/`off`, `hook install`/`uninstall`,
`scan`, `expand`, `comic prompts`/`reroll`, `export --agent-trace`
([Agent Trace](https://agent-trace.dev) line attribution), `config`. Every
command takes `--json`.

These roles use the current host's native subagents, without another model API
or credentials. Hosts without delegation use a clearly labeled inline draft and
self-review. `context --offline` disables GitHub lookups and tells the researcher
and reviewer to leave external references as collection gaps. Source snapshots
and reports stay in the local run folder; only the rendered PR text and comic
are published. The CLI validates handoff structure and local source hashes; the
independent reviewer checks interpretation and remote sources. Role identity is
reported by the host, not independently certified by the CLI.

The [contribution workflow](plugin/skills/tracetoon/references/contribution-workflow.md)
documents role prompts and the versioned `guidance.json` / `review.json` contracts.

Tracetoon reads compact creative metadata from earlier PRs: style family, layout,
panel count, title treatment and cast categories. It reads PR bodies to extract
that metadata, then passes only those summaries into the next comic's context.
Prior plots, character descriptions and traces are not creative context. Legacy
missing fields remain unknown, and pinned styles still win. Run folders live in `.git/tracetoon/runs/` (git never tracks them),
and the newest 20 scratch runs are kept.

Nothing is posted from an old render. New commits or working-tree changes
after a render need a fresh digest and render (commit working-tree changes
first), and `publish` checks that the remote branch matches the rendered commit.
A possible secret found by the leak scan stops posting until the text is
rewritten, or until you say the finding is fine (`render --allow-findings`).

The [art-direction guide](plugin/skills/tracetoon/references/comic-direction.md)
links the manga and joke-comic research behind these choices. New v2 scripts
can supply `composition` geometry shared by image prompts and the overlay
renderer. Legacy scripts retain their old defaults. Changing the script or
composition invalidates cached art and rendered output; rerolling formats must
respect the story's panel count.

## Settings

`tracetoon config set <key> <value>`, or per repo in `.github/tracetoon.json`:

| Key             | Default       | Meaning                                                                                                                                                                  |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`       | `true`        | Use Tracetoon for PRs (also `tracetoon on`/`off`)                                                                                                                        |
| `comic`         | `allowed`     | `off`, `allowed` (include a comic unless the repo's contributing rules forbid images in PRs) or `always` (ignore those rules). `true`/`false` still mean `allowed`/`off` |
| `style`         | `auto`        | Pin one art style for every comic (an idea from `references/styles.md` or any description), or `auto` to vary                                                            |
| `promptQuoting` | `paraphrase`  | `verbatim` quotes your prompts in the PR                                                                                                                                 |
| `disclosure`    | `assisted-by` | Disclosure style (a repo's AI policy can ask for another)                                                                                                                |
| `hosting`       | `auto`        | Where the comic goes: `branch`, `attach`, or `auto`                                                                                                                      |
| `imageConsent`  | `[]`          | Image routes you approved (set by `tracetoon images --approve`; user config only)                                                                                        |
| `budgetTokens`  | `12000`       | Digest size                                                                                                                                                              |

### Image routes

`tracetoon comic art` uses the first route you approved that can draw, in this
order:

| Route                        | Needs                                                                                                       | Prompts go to                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `codex`                      | the Codex CLI, signed in with ChatGPT (`codex login`)                                                       | OpenAI, counted against your Codex usage       |
| `antigravity` (experimental) | the Antigravity CLI, signed in                                                                              | Google, counted against your Antigravity quota |
| `openai`                     | `OPENAI_API_KEY` (model `gpt-image-2.5-flare`, change with `TRACETOON_OPENAI_MODEL`)                        | OpenAI, billed to your key                     |
| `gemini`                     | `GEMINI_API_KEY` or `GOOGLE_API_KEY` (model `gemini-nano-banana-2.1`, change with `TRACETOON_GEMINI_MODEL`) | Google, billed to your key                     |

Prompts contain only the comic's scenes and character descriptions, never code
or log text. Nothing is sent until you approve a route, and only you can approve
one: a repo's `.github/tracetoon.json` can't. To stop using one, remove it from
`imageConsent` with `tracetoon config set imageConsent <list>`, or turn a CLI
route off with `TRACETOON_CODEX_BIN=none` / `TRACETOON_AGY_BIN=none`.

## Running it

The skill ships a small launcher (`bin/tracetoon`, `bin/tracetoon.cmd`). It uses,
in order: a binary next to it, the installed binary, Bun, or Node 22+ with the
bundled `dist/tracetoon.mjs`. With your permission it can instead download the
release binary and verify its checksum.

If the repo already records provenance with [Entire](https://entire.io)
checkpoints or git-ai notes, the digest says so.

## Develop

```sh
bun run dependencies:prepare  # isolated Showtail source at build-dependencies.json
bun install
bun test
bun run typecheck
bun run bundle      # rebuilds plugin/skills/tracetoon/dist/tracetoon.mjs
```

Tracetoon builds on [`@showtail/agent-traces`](https://github.com/Tingsters/Showtail/tree/main/packages/agent-traces),
the log readers and redaction shared with [Showtail](https://github.com/Tingsters/Showtail).
Until that package is on npm, builds use the locked, isolated checkout in `.tracetoon-deps/Showtail` instead of a mutable checkout next to
this repo (see `tsconfig.json` paths). See [CONTRIBUTING.md](CONTRIBUTING.md).

Apache-2.0. The bundled Comic Neue font is under the SIL Open Font License
(`plugin/skills/tracetoon/assets/fonts/OFL.txt`).

Builds pin shared source in `build-dependencies.json` and compiler/target recipes in `build.config.json`. `bun run build:reproduce` compares bundle and native output hashes from two isolated source snapshots. Output `.build.json` receipts record the exact artifact, compiler executable, input manifest, and target. `bun run dependencies:prepare --source <local-Showtail-repository>` can seed the locked checkout without a network clone.
