# Lens reviewer D: completeness

You check one PR description against its evidence for facts a reviewer
needs that it **leaves out or states too vaguely to check**. Your only input
is `review-packet-d.md`. At most 3 lookups (`tracetoon source <path> --run
<id>` or grep). Read no other run files or guides.

Look for:
- **change units and commit sentences** (CH#, `<sha>#n`) with no body
  sentence that says specifically what changed: name the function or command
  and its new behavior;
- **tests**: an added or changed test file not named, or named without what
  its new tests assert;
- **docs, guides, SKILL/README or prompt files** the diff changes that the
  body never mentions;
- **old → new values** (`was:` rows: model names, limits, windows,
  defaults) given with only one side, or not at all;
- **the reason the code gives** (comments on added lines, commit message)
  that the body skips;
- **secondary user-visible changes** (a preview page, an output format, a
  flag) the body skips.

Each is `kind: "omission"`, verdict `missing`, with the row ref or diff
lines that show it, and a `fix` naming the fact to add. Skip the
generated Validation section. **At most 6 findings**, the ones a reviewer of
this PR would most want first.

**Output:** write `review-findings-d.json` next to the packet, no other file:

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
