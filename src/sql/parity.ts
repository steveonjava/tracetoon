/**
 * Do both engines answer every named question the same way from one graph?
 * Used by tests and `scripts/sql-parity.ts` (over real runs' evidence-graph.json),
 * so the base / graph / sqlite comparison differs only in the engine.
 */
import { isDeepStrictEqual } from 'node:util';
import { deriveFromGraph } from '../graph/derive.ts';
import type { EvidenceDb } from '../graph/db.ts';
import type { EvidenceGraph } from '../graph/model.ts';
import { briefParts, QUERIES } from '../graph/queries.ts';
import { withEvidence } from '../graph/store.ts';

export interface Mismatch {
  question: string;
  graph: unknown;
  sqlite: unknown;
}

/** Every question a run can be asked: each named query with each argument it takes. */
function questions(graph: EvidenceGraph): [string, (g: EvidenceDb) => unknown][] {
  const ids = (label: string) =>
    graph.nodes.filter((n) => n.label === label).map((n) => n.id);
  const out: [string, (g: EvidenceDb) => unknown][] = [
    ['briefParts', (g) => briefParts(g)],
    ['deriveFromGraph', (g) => deriveFromGraph(g)],
  ];
  const attempt = (name: string, args: string[]) => (g: EvidenceDb) => {
    try {
      return QUERIES.find((q) => q.name === name)!.run(g, args);
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  for (const q of QUERIES) {
    if (q.name === 'schema' || q.name === 'search') continue;
    const argSets =
      q.name === 'why'
        ? [...ids('File'), ...ids('Hunk')].map((x) => [x])
        : q.name === 'verified'
          ? [[], ...ids('File').map((x) => [x])]
          : q.name === 'turn'
            ? ids('Prompt').map((x) => [x])
            : q.name === 'stale'
              ? ids('Run').map((x) => [x])
              : [[]];
    for (const args of argSets)
      out.push([`${q.name} ${args.join(' ')}`.trim(), attempt(q.name, args)]);
  }
  return out;
}

export function compareEngines(graph: EvidenceGraph): Mismatch[] {
  const qs = questions(graph);
  // Parity is about the shared questions: the SQLite-only extras stay off.
  const saved = process.env.TRACETOON_SQLITE_EXTRAS;
  process.env.TRACETOON_SQLITE_EXTRAS = '0';
  let a: unknown[], b: unknown[];
  try {
    a = withEvidence(graph, (g) => qs.map(([, f]) => f(g)), 'graph');
    b = withEvidence(graph, (g) => qs.map(([, f]) => f(g)), 'sqlite');
  } finally {
    if (saved === undefined) delete process.env.TRACETOON_SQLITE_EXTRAS;
    else process.env.TRACETOON_SQLITE_EXTRAS = saved;
  }
  const out: Mismatch[] = [];
  qs.forEach(([question], i) => {
    if (!isDeepStrictEqual(a[i], b[i])) out.push({ question, graph: a[i], sqlite: b[i] });
  });
  return out;
}
