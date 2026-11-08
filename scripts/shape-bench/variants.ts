// Round-2 diagnostics: R contexts at G's per-case evidence size and/or without the link layer.
// usage: bun variants.ts <analysis src> <attr dir> <out contexts dir> <variant> <budget json|full>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [src, dir, out, variant, budgets] = process.argv.slice(2) as [string, string, string, string, string];
const { initRelational, buildRelationalContext } = await import(join(src, 'src/relational/builder.ts'));
const { contextText } = await import(join(src, 'src/relational/index.ts'));
await initRelational();
const B = budgets === 'full' ? null : JSON.parse(budgets);
for (const c of ['pr10', 'pr11', 'pr12', 'pr5', 'pr8', 'pr9', 'vexaim']) {
  const inputs = JSON.parse(readFileSync(join(dir, `${c}.inputs.json`), 'utf8'), (_k, v) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v));
  const budget = B ? B[c] : 2112;
  const ctx = buildRelationalContext(inputs, { budgetTokens: budget });
  const brief = contextText(ctx);
  mkdirSync(join(out, c), { recursive: true });
  writeFileSync(join(out, c, `${variant}.json`), JSON.stringify({ case: c, arm: variant, budget, contextTokens: ctx.tokens, brief, tokens: Math.ceil(brief.length / 4), stats: ctx.stats }, null, 1));
  console.log(variant, c, 'budget', budget, 'context', ctx.tokens, 'links', (ctx.text.match(/→|why /g) ?? []).length);
}
