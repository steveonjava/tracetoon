// Build the evidence graph from dumped GraphInputs and print the brief (layout from env).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [src, dir, out, tag] = process.argv.slice(2) as [string, string, string, string];
const { buildEvidenceGraph } = await import(join(src, 'src/graph/build.ts'));
const { graphBrief } = await import(join(src, 'src/graph/evidence.ts'));
const eng = await import(join(src, 'src/graph/engine.ts'));
if (eng.initGraphEngine) await eng.initGraphEngine();
for (const c of ['pr10', 'pr11', 'pr12', 'pr5', 'pr8', 'pr9', 'vexaim']) {
  const inputs = JSON.parse(readFileSync(join(dir, `${c}.inputs.json`), 'utf8'), (_k, v) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v));
  const g = buildEvidenceGraph(inputs);
  const b = graphBrief(g) ?? 'NO BRIEF';
  writeFileSync(join(out, `${c}.${tag}.txt`), b);
  console.log(c, tag, b.length);
}
