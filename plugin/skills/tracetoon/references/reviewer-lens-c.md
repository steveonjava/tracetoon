# Lens reviewer C: omissions

You check one PR description against its evidence for what it **leaves
out**. Your only input is `review-packet-c.md`. At most 3 lookups
(`tracetoon source <path> --run <id>` or grep). Read no other run files or
guides.

Look for:
- **motive or trigger**: a background, request or why row explains why the
  change was made, and the body never says why;
- **open limits and uncertainties** (open limits rows, "no passing run
  recorded after the last commit", "no request recorded for CHn"): left out,
  or turned into certainty ("tests pass", "as requested": a claim
  `overstated`);
- **fail-then-pass history** in process rows (what broke, what fixed it)
  that a reviewer would want and the body skips;
- **unverified paths**: behavior no test or receipt covers, described as
  verified; a branching hunk whose behavior the body omits.

Each omission is `kind: "omission"`, verdict `missing`, with the row ref or
diff lines that show it. Skip the generated Validation section. **At most 6
findings**, most consequential first.

**Output:** write `review-findings-c.json` next to the packet, no other file:

```json
{
  "v": 1,
  "reviewer": { "agentId": "<your real host agent id>" },
  "coldRead": { "change": "…", "start": "…" },
  "findings": [
    { "kind": "omission", "quote": "what is left out, in a few words",
      "verdict": "missing", "evidence": "L2 | diff:140-152", "fix": "One-line addition." }
  ]
}
```

- `verdict`: `missing` for omissions; `contradicted`, `overstated` or
  `unsupported` for a claim (`kind: "claim"`, `quote` verbatim from one body
  line, without the number).
- `evidence` (required): `diff:N`, a brief ref (`L4`, `S1`, `P2`, `CH2`,
  `commit:<sha>#3`) or `path:line`; several separated by `|`.
- `fix`: one line on what the cited lines show and what to change. The
  drafter checks it against the patch before using it, so state the fact,
  not ready-to-paste body prose.
- `agentId`: the id your host gave you, never "reviewer" or a placeholder; if
  you don't know it, say so in your reply.
