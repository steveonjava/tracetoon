// Brief text for the 7 dumped cases from a tip-era source tree (graphBrief(graph, {layout})).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [src, dir, out, tag, layout] = process.argv.slice(2) as [string, string, string, string, string];
const { buildEvidenceGraph } = await import(join(src, 'src/graph/build.ts'));
const { graphBrief } = await import(join(src, 'src/graph/evidence.ts'));
for (const c of ['pr10', 'pr11', 'pr12', 'pr5', 'pr8', 'pr9', 'vexaim']) {
  const inputs = JSON.parse(readFileSync(join(dir, `${c}.inputs.json`), 'utf8'), (_k, v) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v));
  const b = graphBrief(buildEvidenceGraph(inputs), { layout }) ?? 'NO BRIEF';
  writeFileSync(join(out, `${c}.${tag}.txt`), b);
  console.log(c, tag, b.length);
}
