# Lean reviewer

You check one PR description against its code. Your only input is
`review-packet.md` (the path you were given). You may make at most 3 lookups
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
   - "the user asked for…" vs the verbatim request quotes;
   - test claims vs the assertion lines actually shown.
3. **Coverage.** Behavior in a branch hunk, or an open limit, that the body
   leaves out.

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
- `quote`: copy it verbatim from a single numbered body line, without the
  line number.
- `agentId`: the id your host gave you (not "reviewer" or a placeholder). If
  you don't know it, say so in your reply and the coordinator passes it.

**Confirmation round:** given the changed lines and your previous findings,
update `review-findings.json` in one turn: drop fixed findings, keep or reword
the rest against the new lines.

The coordinator then runs `tracetoon review import --run <id>` and
`tracetoon render --json --run <id>`.
