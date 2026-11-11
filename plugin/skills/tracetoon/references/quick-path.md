# Quick brief path

Only when the user's own message asks for the cheapest or quickest PR. Draft →
check → review → final render → publish. Write the description yourself, inline, from the brief, then have one fresh reviewer check it. Skip the researcher, `guidance.json`, the delegated drafter and the full independent review (SKILL steps 3, 4 and 6); still apply SKILL step 3's AI-policy bullets from `context.json`. Read every command's whole output: never pipe `prepare`, `query` or `render` through `head` or `tail` (the rules and open points come first, and render's first line says what is left to fix).

1. Read the `brief` (in the prepare output; also `tracetoon query brief --run <id>`)
   and the diff refs it cites (`changes.patch`). Its `limits` rows are open points
   for the PR; the rules for what not to claim are in [drafting.md](drafting.md).
2. **Draft.** Write `title.txt` (one line; keep a title the user gave) and
   `body.md` following [writing-guide.md](writing-guide.md).
   Write for a reviewer, in plain prose, not as an inventory of files and symbols:
   - Open with the problem: the goal request (`requests` row marked goal),
     what the code did before and does now (only where `changes.was` or the
     removed lines show the old value; never infer old behavior from the new
     code), and what triggered the change, as the request or commit message
     says it.
   - Then what changed, grouped by behavior rather than file by file,
     covering each commit-message sentence. Name the file a sentence's
     `implementedBy` gives; where it is empty, describe the behavior without
     naming a file. Say what code does instead of listing identifiers; call a
     symbol new only if it is in `newSymbols`.
   - The consequences: what changes for users or callers, the riskiest part,
     and anything the PR deliberately leaves alone.
   - What the added tests check (`tests` rows; no test counts, no helper
     names), folded into the change they test or one short line; the open
     points (`limits` rows of kind `open`); one or two closing lines on which
     file to start reviewing with and the feedback you want; any PR or issue
     links the commits give; at most one clause for `housekeeping`.
   No fixed section list: headings only when the body needs them, no heading
   over a single line, nothing said twice, about 250–450 words for a typical
   PR.
   State plainly what the patch shows. Attribute only what it can't show (a
   reason, a result, a remark like "local only") to the request or commit
   message that says it; never invent a motive. Don't repeat what the
   Validation section says about runs.
3. Tag every sentence that states a fact with the brief refs it rests on, at
   the end of the sentence: `[CH1, S1]`, `[T1]`, `[commit:<sha>#2]`. A
   sentence you can't tag doesn't belong in the PR. Render removes the tags.
4. Write no test, build, lint or typecheck results yourself, anywhere. Put the
   line `<!-- tracetoon:validation -->` where the validation section belongs;
   render writes that section from the recorded checks.
5. **Required checks.** If `context.json` or the repository's contributing
   guide names checks contributors must run (tests, typecheck, lint), and the
   brief's validation rows have no `tracetoon check` receipt (a `V` row) for
   them, run each once with `tracetoon check --run <id> --name <check> -- <command>`
   (one at a time; this records the result on the submitted content, as the
   full path does). Don't run anything else to fill gaps.
6. **Check.** `tracetoon render --check --json --run <id>`. Fix every sentence
   it lists (rewording it; adding a tag doesn't fix a flagged sentence) and
   add one sentence for each uncovered brief row, then check again. Repeat, up
   to three rounds, until it reports nothing left to fix. This is not the
   final render.
7. **Review (always).** Start one fresh subagent, not a fork of this
   conversation, with [reviewer-brief.md](reviewer-brief.md)
   as its whole instruction and the run folder's path. It checks each
   sentence against the patch and writes `reviewer-notes.md`. If your host
   can't start a subagent, do that pass yourself, re-reading only what the
   reviewer brief lists.
8. **Apply and final render.** Check each note against the patch before
   applying it, and skip a note the patch doesn't support. For a scope
   finding, qualify the sentence rather than list every case; add each
   MISSING item as one clause. Then `tracetoon render --reviewed --json --run <id>`
   until it reports nothing left to fix.
9. Draw a comic if one is wanted (SKILL step 5, without a separate reviewer),
   then publish (SKILL step 7). Publish refuses a draft that was only checked, and one
   with sentences to fix or brief rows to cover. Only if the user's own
   message asks for the cheapest run (an unattended run is not that) may you
   skip steps 7–8 and publish with `--no-review`; `--accept-open` likewise
   needs the user's agreement in their own words.
