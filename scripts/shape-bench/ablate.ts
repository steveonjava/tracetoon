// usage: bun ablate.ts <analysis src> <attr dir> <label>   (env TRACETOON_ABLATE / TRACETOON_EMBEDDING_DIR set by caller)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [src, dir, label] = process.argv.slice(2) as [string, string, string];
const { initRelational, buildRelationalContext } = await import(join(src, 'src/relational/builder.ts'));
await initRelational();
for (const c of ['pr10', 'pr11', 'pr12', 'pr5', 'pr8', 'pr9', 'vexaim']) {
  const inputs = JSON.parse(readFileSync(join(dir, `${c}.inputs.json`), 'utf8'), (_k, v) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v));
  if (label === 'full') process.env.TRACETOON_ATTR_OUT = join(dir, `${c}.attr.json`); else delete process.env.TRACETOON_ATTR_OUT;
  const ctx = buildRelationalContext(inputs, { budgetTokens: 2112 });
  writeFileSync(join(dir, `${c}.${label}.txt`), ctx.text);
  writeFileSync(join(dir, `${c}.${label}.stats.json`), JSON.stringify(ctx.stats));
}
console.log(label, 'done');
