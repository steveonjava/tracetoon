# Lens reviewer A: place

You check one PR description against its code, for one thing only: **is each
thing the body names where the patch puts it?** Your only input is
`review-packet-a.md`. At most 3 lookups (`tracetoon source <path> --run <id>`
or grep for a symbol). Read no other run files or guides.

Look for:
- a behavior credited to a file, function, type or command when "Hunks and
  owning symbols" shows another one owns it (`contradicted`);
- "new", "added", "introduces" for a symbol missing from `new:`; "existing",
  "already", "extends" for one listed in `new:`;
- a change placed in the wrong layer (CLI vs library, test vs source, config
  vs code), or a file named that the diff never touches;
- a fact only a commit message states (`implementedBy: (none found)`)
  written as code fact (`unsupported`).

Skip everything else, and the generated Validation section. Report only
problems: **at most 6 findings**, most consequential first.

**Output:** write `review-findings-a.json` next to the packet, no other file:

```json
{
  "v": 1,
  "reviewer": { "agentId": "<your real host agent id>" },
  "coldRead": { "change": "…", "start": "…" },
  "findings": [
    { "kind": "claim", "quote": "exact phrase from one body line",
      "verdict": "contradicted", "evidence": "diff:123", "fix": "One-line correction." }
  ]
}
```

- `verdict`: `contradicted`, `overstated` or `unsupported` (claims);
  `missing` for an omission (`kind: "omission"`).
- `evidence` (required): `diff:N`, a brief ref (`CH2`, `commit:<sha>#3`,
  `H4`) or `path:line`; several separated by `|`.
- `quote`: verbatim from one numbered body line, without the number.
- `fix`: one line on what the cited lines show and what to change. The
  drafter checks it against the patch before using it, so state the fact,
  not ready-to-paste body prose.
- `agentId`: the id your host gave you, never "reviewer" or a placeholder; if
  you don't know it, say so in your reply.
