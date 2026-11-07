/**
 * Which engine holds a run's evidence. On this branch SQLite is the default;
 * `TRACETOON_EVIDENCE_ENGINE=graph` selects cypherlite, so tests can check both
 * engines give the same answers from the same graph.
 */
import { SqlEngine, sqlEngineAvailable } from '../sql/engine.ts';
import type { EvidenceDb } from './db.ts';
import { GraphEngine, graphEngineAvailable } from './engine.ts';
import type { EvidenceGraph } from './model.ts';

export type EngineName = 'sqlite' | 'graph';

export function evidenceEngine(): EngineName {
  return process.env.TRACETOON_EVIDENCE_ENGINE === 'graph' ? 'graph' : 'sqlite';
}

export function openEvidence(
  graph: EvidenceGraph,
  engine: EngineName = evidenceEngine(),
): EvidenceDb {
  return engine === 'graph' ? GraphEngine.load(graph) : SqlEngine.load(graph);
}

/** Load the evidence, run `fn`, always release the database. */
export function withEvidence<T>(
  graph: EvidenceGraph,
  fn: (g: EvidenceDb) => T,
  engine: EngineName = evidenceEngine(),
): T {
  const db = openEvidence(graph, engine);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function evidenceEngineAvailable(
  engine: EngineName = evidenceEngine(),
): { ok: true; label: string } | { ok: false; reason: string } {
  if (engine === 'graph') {
    const r = graphEngineAvailable();
    return r.ok ? { ok: true, label: 'cypherlite, WebAssembly' } : r;
  }
  const r = sqlEngineAvailable();
  return r.ok ? { ok: true, label: `SQLite, ${r.driver}` } : r;
}
