// Compare the graph and SQLite engines on real runs' evidence graphs.
//   bun run scripts/sql-parity.ts <evidence-graph.json|dir>... [--verbose]
// Exits 1 when any named question gets a different answer.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceGraph } from '../src/graph/model.ts';
import { compareEngines } from '../src/sql/parity.ts';

const verbose = process.argv.includes('--verbose');
const files: string[] = [];
const walk = (p: string) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (p.endsWith('evidence-graph.json')) files.push(p);
};
for (const a of process.argv.slice(2).filter((a) => !a.startsWith('--'))) walk(a);
if (!files.length) {
  console.error('usage: sql-parity.ts <evidence-graph.json|dir>... [--verbose]');
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  const graph = JSON.parse(readFileSync(f, 'utf8')) as EvidenceGraph;
  const t0 = performance.now();
  const diffs = compareEngines(graph);
  const ms = Math.round(performance.now() - t0);
  console.log(
    `${diffs.length ? 'DIFF' : 'same'}  ${graph.nodes.length} nodes ${graph.rels.length} rels  ${ms}ms  ${f}`,
  );
  for (const d of diffs) {
    bad++;
    console.log(`  ${d.question}`);
    if (verbose)
      console.log(
        `    graph:  ${JSON.stringify(d.graph).slice(0, 2000)}\n    sqlite: ${JSON.stringify(d.sqlite).slice(0, 2000)}`,
      );
  }
}
process.exit(bad ? 1 : 0);
