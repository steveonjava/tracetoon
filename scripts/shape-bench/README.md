# Shape test scripts

The scripts behind `prbench/results/shape-test/`: graph-shaped (G) vs relational/vector-shaped (R) PR context.

- `contexts.ts`: stages each case as prbench does and captures each arm's `prepare` context (measure 1).
- `judge.ts`, `summarize.py`: blind fact-support judging and the preregistered measure-1 summary.
- `arm-report.py`: the paired prbench report, including the measure-2 G vs R table.
- `dump-inputs.ts`, `ablate.ts`, `attr-report.py`: R link attribution and ablations.
  - **Sources:** exact joins vs BM25, embeddings and name mentions.
  - **Ablations:** no embeddings, no search, no joins.
  - **Setup:** these need an analysis checkout of this branch with two env hooks added by hand: `TRACETOON_DUMP_INPUTS` in `src/graph/evidence.ts`, and `TRACETOON_ATTR_OUT` / `TRACETOON_ABLATE` in `src/relational/builder.ts`. The frozen R design itself has no hooks.
- `variants.ts`, `summarize-r2.py`: round-2 diagnostics (R at G's per-case evidence size, R without the link layer) and their summary vs G.
- `lookups.py`: counts the `tracetoon query` calls writers made, from the prbench writer traces.
