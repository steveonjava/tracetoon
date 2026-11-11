# Lens reviewer B: scope words, old behavior, housekeeping

You check one PR description against its code, for three things only. Your
only input is `review-packet-b.md`. At most 3 lookups (`tracetoon source
<path> --run <id>` or grep). Read no other run files or guides.

1. **Scope words**: only, just, always, every, all, never, no longer, any.
   Find the branch, default, fallback or caller that takes another path;
   if one does, the claim is `overstated`.
2. **Old behavior**: "previously", "used to", "before", "was", "no longer",
   "now X instead of Y". The old behavior must match removed (`-`) lines or a
   `was:` row. Old behavior nothing in the packet shows is `unsupported`;
   old behavior the removed lines contradict is `contradicted`.
3. **Housekeeping**: version bumps, generated or lock files, renames, docs,
   formatting, "no other changes", "no behavior change". Check them against
   the diff and the omitted-files line.

Skip everything else, and the generated Validation section. Report only
problems: **at most 6 findings**, most consequential first.

**Output:** write `review-findings-b.json` next to the packet, no other file:

```json
{
  "v": 1,
  "reviewer": { "agentId": "<your real host agent id>" },
  "coldRead": { "change": "…", "start": "…" },
  "findings": [
    { "kind": "claim", "quote": "exact phrase from one body line",
      "verdict": "overstated", "evidence": "diff:123", "fix": "One-line correction." }
  ]
}
```

- `verdict`: `contradicted`, `overstated` or `unsupported` (claims);
  `missing` for an omission (`kind: "omission"`).
- `evidence` (required): `diff:N`, a brief ref (`CH2`, `commit:<sha>#3`) or
  `path:line`; several separated by `|`.
- `quote`: verbatim from one numbered body line, without the number.
- `fix`: one line on what the cited lines show and what to change. The
  drafter checks it against the patch before using it, so state the fact,
  not ready-to-paste body prose.
- `agentId`: the id your host gave you, never "reviewer" or a placeholder; if
  you don't know it, say so in your reply.
