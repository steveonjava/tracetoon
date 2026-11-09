// Build time and memory of each arm's fact store + brief, per case, from the dumped GraphInputs.
// usage: bun build-cost.ts <graph|relational> <src> <attr dir>   (one arm per process, so memory is its own)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [arm, src, dir] = process.argv.slice(2) as [string, string, string];
const revive = (_k: string, v: any) => (v && v.__map ? new Map(v.__map) : v && v.__set ? new Set(v.__set) : v);
let build: (inputs: unknown) => number;
if (arm === 'graph') {
  const { buildEvidenceGraph } = await import(join(src, 'src/graph/build.ts'));
  const { graphBrief } = await import(join(src, 'src/graph/evidence.ts'));
  build = (inputs) => (graphBrief(buildEvidenceGraph(inputs)) ?? '').length;
} else {
  const { initRelational, buildRelationalContext } = await import(join(src, 'src/relational/builder.ts'));
  await initRelational();
  build = (inputs) => buildRelationalContext(inputs, { budgetTokens: 2112 }).text.length;
}
const rss0 = process.memoryUsage().rss;
for (const c of ['pr10', 'pr11', 'pr12', 'pr5', 'pr8', 'pr9', 'vexaim']) {
  const inputs = JSON.parse(readFileSync(join(dir, `${c}.inputs.json`), 'utf8'), revive);
  build(inputs); // warm
  const t = performance.now();
  const n = 5;
  let len = 0;
  for (let i = 0; i < n; i++) len = build(inputs);
  const ms = (performance.now() - t) / n;
  console.log(JSON.stringify({ arm, case: c, ms: Math.round(ms * 10) / 10, chars: len, rssMB: Math.round(process.memoryUsage().rss / 1e6), rssStartMB: Math.round(rss0 / 1e6) }));
}
