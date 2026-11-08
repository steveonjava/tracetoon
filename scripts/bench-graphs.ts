// Synthetic multi-PR "repo history" evidence graphs for the engine benchmark.
//   bun run scripts/bench-graphs.ts --out <dir> --sizes 1,10,50,200 <evidence-graph.json|dir>...
// Each size N merges N real graphs (cycling through the sources): every id is
// namespaced by its source copy except File ids, which are repo paths and are
// shared, so later PRs touch the files earlier PRs touched, as in one repo's
// history. The result is labeled synthetic; it is only for scaling queries.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRAPH_SCHEMA,
  type EvidenceGraph,
  type GraphNode,
  type GraphRel,
} from '../src/graph/model.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const out = opt('--out');
const sizes = (opt('--sizes') ?? '1,10,50,200').split(',').map(Number);
if (!out || !args.length) {
  console.error(
    'usage: bench-graphs.ts --out <dir> [--sizes 1,10,50,200] <graphs or dirs>...',
  );
  process.exit(2);
}
const files: string[] = [];
const walk = (p: string) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (p.endsWith('evidence-graph.json')) files.push(p);
};
for (const a of args) walk(a);
// Graphs with change units are the current schema; they exercise every query.
const sources = files
  .sort()
  .map((f) => JSON.parse(readFileSync(f, 'utf8')) as EvidenceGraph)
  .filter((g) => g.nodes.some((n) => n.label === 'Change'));
if (!sources.length) throw new Error('no current-schema graphs among the sources');
mkdirSync(out, { recursive: true });

function merge(n: number): EvidenceGraph {
  const nodes = new Map<string, GraphNode>();
  const rels = new Map<string, GraphRel>();
  for (let i = 0; i < n; i++) {
    const g = sources[i % sources.length]!;
    const ns = (label: string, id: string) => (label === 'File' ? id : `g${i}:${id}`);
    for (const node of g.nodes) {
      const id = ns(node.label, node.id);
      const key = `${node.label}|${id}`;
      if (nodes.has(key)) continue;
      const props = { ...node.props };
      // Props that hold another node's id point at the same copy.
      for (const k of ['session', 'commit'] as const)
        if (typeof props[k] === 'string') props[k] = `g${i}:${props[k]}`;
      nodes.set(key, { label: node.label, id, props });
    }
    for (const r of g.rels) {
      const from = { label: r.from.label, id: ns(r.from.label, r.from.id) };
      const to = { label: r.to.label, id: ns(r.to.label, r.to.id) };
      const key = `${r.type}|${from.label}:${from.id}|${to.label}:${to.id}`;
      if (!rels.has(key))
        rels.set(key, { type: r.type, from, to, ...(r.props ? { props: r.props } : {}) });
    }
  }
  const all = [...nodes.values()];
  return {
    schema: GRAPH_SCHEMA,
    nodes: all,
    rels: [...rels.values()],
    stats: {
      nodes: all.length,
      rels: rels.size,
      hunks: all.filter((x) => x.label === 'Hunk').length,
      linkedHunks: 0,
      edits: all.filter((x) => x.label === 'Edit').length,
      deadEndEdits: 0,
    },
  };
}

for (const n of sizes) {
  const g = merge(n);
  const path = join(out, `synthetic-n${n}`, 'evidence-graph.json');
  mkdirSync(join(out, `synthetic-n${n}`), { recursive: true });
  writeFileSync(path, JSON.stringify(g));
  console.log(`n=${n}: ${g.nodes.length} nodes, ${g.rels.length} rels -> ${path}`);
}
