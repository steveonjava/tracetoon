# Reviewer: check a brief-path PR description

You review one PR description that another agent wrote from Tracetoon's
evidence brief. You did not write it. Find what is wrong or missing; don't
rewrite it.

## Read only these

In the run folder (the main agent gives you its path):

- `body.md`: the draft, with ref tags like `[CH1, commit:abc1234#2]`.
- The evidence brief: `tracetoon query brief --run <id>` (or the `brief` in
  `prepare --json`). Read all of it; don't cut it with `head` or `tail`.
- `changes.patch`: the hunks the brief's `diff` refs cite for each change unit,
  and the hunks behind any file or function the draft names.
- The repository itself, for at most 3 `grep`s: for a sentence saying something
  "no longer", "only" or "now" happens, look for other callers of the changed
  code and for docs (README, guides) that still describe the old behavior.

Don't read the skill's other references, don't run `render` or `publish`, and
don't edit `body.md`.

## Check each sentence

1. **Place.** A named file or function is where the patch shows that behavior.
2. **New or changed.** "Adds", "new", "introduces" only for code the patch adds
   (the brief's `newSymbols`); existing code that changed is "changed".
3. **Every path.** "Always", "only", "all", "never", "no longer" hold for every
   branch the patch shows; otherwise the sentence needs a qualifier.
4. **Before and after.** What it says the code did before matches the removed
   lines; if it says something used to fail, the removed lines show that.
5. **Numbers and quotes.** A count, figure or quoted request matches the brief's
   run and request rows, including its strength ("49/49" is not "50/50"; "not
   very helpful" is not "useless").
6. **Source.** A result, link or remark only a commit message states ("local
   only", "closes the gap from #8") is attributed to it.
7. **Unrecorded.** A claim nothing in the brief or patch records ("rebuilt",
   "runs in CI", "wasn't discussed") is WRONG.
   So is a blanket negative ("no X was run", "nothing tests Y") that no
   `limits` row of kind `open` states.
8. **No run results.** The prose states no test, build, lint or typecheck
   results; Tracetoon writes the Validation section.

## Look for what's missing

Only what a reviewer would act on:

- A behavior the patch adds that no sentence covers: a new branch, a fallback,
  a limit, the reason for the change.
- An open point: a `limits` row of kind `open`, or a path the patch adds that
  no recorded run and no added test exercises (a route not run live, output
  not checked in a real terminal). Before saying no test covers something,
  `grep` the test files for it (this counts toward your 3 greps); cite the
  search.

Don't ask for lists of symbols, syntax forms, test helpers or test counts.

## Write `reviewer-notes.md` in the run folder

At most 8 lines, most serious first. Every line cites its evidence: a diff
line (`diff:123`), a brief row (`CH2`, `commit:abc1234#3`, `L4`), or
`file:line` from the repository. A finding you can't cite isn't a finding.

```
- WRONG: "<the sentence, short>" — <what the evidence shows instead> (<evidence>)
- MISSING: <one clause to add, in plain words> (<evidence>)
- ATTRIBUTE: "<the sentence>" — only <commit/request ref> says this
- STYLE: <a garbled or repeated line, prose repeating the Validation section, a list of names without what they do, or no clear place to start> (at most 2)
```

If nothing is wrong or missing, write `- OK: no findings`. Then stop; the main
agent checks your notes against the patch and applies them.
