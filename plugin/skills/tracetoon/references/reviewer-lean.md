# Lean reviewer

You check one PR description against its code. Your only input is
`review-packet.md` (the path given). You may make at most 3 lookups
for location checks (`tracetoon source <path> --run <id>` or grep for a
symbol's callers). Do not read other run files, the brief query, or guides.

1. **Cold read.** Read only the title and body. In two lines: what changed,
   and where you would start reviewing (`coldRead.change`, `coldRead.start`).
2. **Claim audit.** For each factual sentence, try to disprove it from the
   packet. Look hardest at:
   - "always", "only", "no longer", "every", "all": does a branch hunk, default
     or fallback take another path?
   - conditions and defaults the body drops or states wrongly;
   - a file or function named for a behavior vs the hunk's owning symbol;
   - "new"/"added" for a symbol missing from `new:` (newSymbols);
   - a fact only a commit message states (commitMessages) written as fact;
   - "the user asked for…" vs the verbatim requests (background rows are
     context, not this PR's request);
   - test claims vs the assertion lines actually shown;
   - **unsupported**: a factual sentence no brief row (process and background
     included) or diff line backs: verdict `unsupported`, evidence `body:N`,
     fix "drop it" or "attribute it".
3. **Dropped uncertainties.** Each open limit and process fact such as "no
   passing run recorded after the last commit" or "no request recorded for
   CHn": if the body omits it, kind `omission`; if it says the opposite
   ("tests pass", "as requested"), a claim `overstated`. Also omitted
   branch-hunk behavior.

Skip the generated Validation section (elided in the packet). Report only
problems; a correct sentence needs no entry. At most 8 findings, most
consequential first.

**Output:** write `review-findings.json` in the run directory (next to the
packet), exactly this shape, and no other file:

```json
{
  "v": 1,
  "reviewer": { "agentId": "<your real host agent id>" },
  "coldRead": { "change": "…", "start": "…" },
  "findings": [
    {
      "kind": "claim",
      "quote": "exact phrase copied from one body line",
      "verdict": "overstated",
      "evidence": "diff:123",
      "fix": "One-line correction."
    },
    {
      "kind": "omission",
      "quote": "the behavior left out, in a few words",
      "verdict": "missing",
      "evidence": "diff:140-152",
      "fix": "One-line addition."
    }
  ]
}
```

- `verdict`: `contradicted`, `overstated` or `unsupported` for claims;
  `missing` for omissions.
- `evidence` (required): `diff:N` (the number left of a diff line), a brief
  ref (`CH2`, `commit:<sha>#3`, `L4`, `T1`, `S1`) or `path:line`. Prefer
  `diff:`; separate several with `|`.
- `quote`: verbatim from one numbered body line, without the number.
- `fix`: one line on what the cited lines show and what to change. The
  drafter checks it against the patch before using it, so state the fact,
  not ready-to-paste body prose.
- `agentId`: the id your host gave you (not "reviewer" or a placeholder). If
  you don't know it, say so in your reply and the coordinator passes it.

**Confirmation round:** given the changed lines and your findings, update
`review-findings.json` in one turn: drop fixed ones, reword the rest.

The coordinator then runs `tracetoon review import --run <id>` and
`tracetoon render --json --run <id>`.
