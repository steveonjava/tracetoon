/**
 * What Tracetoon itself learns from the evidence graph, once per digest:
 *  - per file, the facts that explain it and the checks that ran after its last edit;
 *  - per run, the PR files edited after it (so "before later edits" names them);
 *  - a relevance score per fact, so budgeting drops what the PR doesn't need first;
 *  - review leads: behavior files never checked after their last edit, and hunks
 *    no captured edit explains.
 */
import type { TraceDigest } from '../digest/build.ts';
import { GraphEngine } from './engine.ts';
import type { EvidenceGraph } from './model.ts';
import { checksAfterLastEdit, unexplainedHunks } from './queries.ts';

export interface GraphDerived {
  fileFacts: Record<string, string[]>;
  fileChecks: Record<string, string[]>;
  runLaterEdits: Record<string, string[]>;
  relevance: Record<string, number>;
  review: {
    /** Behavior/test files with no passing check after their last captured edit. */
    unverified: { file: string; why: string }[];
    /** Behavior/test hunks with no surviving captured edit. */
    unexplained: {
      diff: string;
      file: string;
      commits: string[];
      removalOnly: boolean;
    }[];
  };
}

const MAX_FILE_FACTS = 6;
const MAX_LATER = 8;

export function deriveFromGraph(g: GraphEngine): GraphDerived {
  // Turns whose edits survive in each file, strongest first.
  const fileFacts: Record<string, string[]> = {};
  const turnRows = g.run(
    `MATCH (f:File {inPr: true})<-[:EDITS]-(e:Edit)-[:IN_TURN]->(p:Prompt)
     WHERE e.surviving > 0 AND EXISTS { MATCH (e)-[:IN_SESSION]->(:Session {band: 'included'}) }
     WITH f, p, sum(e.surviving) AS lines
     OPTIONAL MATCH (x)-[:IN_TURN]->(p) WHERE x:Decision OR x:Plan
     RETURN f.id AS file, p.id AS prompt, lines, collect(DISTINCT x.id) AS facts`,
  ).rows;
  const byFile = new Map<string, { prompt: string; lines: number; facts: string[] }[]>();
  for (const r of turnRows)
    byFile.set(String(r.file), [
      ...(byFile.get(String(r.file)) ?? []),
      {
        prompt: String(r.prompt),
        lines: Number(r.lines),
        facts: ((r.facts as string[]) ?? []).sort(),
      },
    ]);
  for (const [file, turns] of byFile) {
    turns.sort(
      (a, b) =>
        b.lines - a.lines || Number(a.prompt.slice(1)) - Number(b.prompt.slice(1)),
    );
    fileFacts[file] = [...new Set(turns.flatMap((t) => [t.prompt, ...t.facts]))].slice(
      0,
      MAX_FILE_FACTS,
    );
  }

  const checks = checksAfterLastEdit(g);
  const fileChecks: Record<string, string[]> = {};
  for (const c of checks)
    if (c.lastEdit && c.after.length)
      fileChecks[c.file] = c.after.slice(0, 3).map((x) => `${x.id}:${x.outcome}`);

  const runLaterEdits: Record<string, string[]> = {};
  for (const r of g.run(
    'MATCH (r:Run)-[:LATER_EDIT]->(f:File) RETURN r.id AS run, f.id AS file',
  ).rows)
    (runLaterEdits[String(r.run)] ??= []).push(String(r.file));
  for (const k of Object.keys(runLaterEdits))
    runLaterEdits[k] = runLaterEdits[k]!.sort().slice(0, MAX_LATER);

  // Relevance: how much of the PR a fact explains.
  const relevance: Record<string, number> = {};
  for (const r of g.run(
    `MATCH (p:Prompt)
     OPTIONAL MATCH (e:Edit)-[:IN_TURN]->(p)
     RETURN p.id AS id, sum(coalesce(e.surviving, 0)) AS lines, p.pushback AS pushback,
            NOT EXISTS { MATCH (:Prompt)-[:NEXT]->(p) } AS first`,
  ).rows) {
    const lines = Number(r.lines);
    relevance[String(r.id)] =
      (lines ? 2 + Math.min(lines, 200) / 20 : 0) +
      (r.pushback ? 3 : 0) +
      (r.first ? 2 : 0);
  }
  for (const r of g.run(
    `MATCH (x)-[:IN_TURN]->(p:Prompt) WHERE x:Decision OR x:Plan
     OPTIONAL MATCH (e:Edit)-[:IN_TURN]->(p)
     RETURN x.id AS id, sum(coalesce(e.surviving, 0)) AS lines`,
  ).rows) {
    const lines = Number(r.lines);
    relevance[String(r.id)] = 1 + (lines ? 2 + Math.min(lines, 200) / 20 : 0);
  }
  const cited = new Set(
    Object.values(fileChecks)
      .flat()
      .map((c) => c.split(':')[0]),
  );
  const lastOfCmd = new Map<string, string>();
  const runs = g
    .run(
      `MATCH (r:Run) RETURN r.id AS id, r.cmd AS cmd, r.t AS t, r.revision AS revision,
            COUNT { (r)-[:LATER_EDIT]->() } AS later`,
    )
    .rows.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
  for (const r of runs) lastOfCmd.set(String(r.cmd), String(r.id));
  const finals = new Set(lastOfCmd.values());
  for (const r of runs) {
    const id = String(r.id);
    relevance[id] =
      r.revision === 'after later work'
        ? 0
        : 1 +
          (Number(r.later) === 0 ? 3 : 0) +
          (finals.has(id) ? 2 : 0) +
          (cited.has(id) ? 2 : 0);
  }
  for (const id of Object.keys(relevance))
    relevance[id] = Math.round(relevance[id]! * 100) / 100;

  const unverified = checks
    .filter((c) => ['behavior', 'tests'].includes(c.role))
    .filter((c) => !c.lastEdit || !c.after.some((x) => x.outcome === 'passed'))
    .map((c) => ({
      file: c.file,
      why: !c.lastEdit
        ? 'no captured edit'
        : c.after.length
          ? `no passing check after the last edit (${c.after.map((x) => `${x.id}:${x.outcome}`).join(', ')})`
          : 'no check ran after the last edit',
    }));
  const unexplained = unexplainedHunks(g).map((h) => ({
    diff: String(h.diff),
    file: String(h.file),
    commits: h.commits as string[],
    removalOnly: !!h.removalOnly,
  }));
  return {
    fileFacts,
    fileChecks,
    runLaterEdits,
    relevance,
    review: { unverified, unexplained },
  };
}

/** Write derived provenance onto a digest's files and runs (full or compact). */
export function annotateDigest(d: TraceDigest, derived: GraphDerived): void {
  for (const f of d.files) {
    const facts = derived.fileFacts[f.path];
    const checks = derived.fileChecks[f.path];
    if (facts?.length) f.facts = facts;
    if (checks?.length) f.checksAfterLastEdit = checks;
  }
  for (const s of d.sessions)
    for (const r of s.runs) {
      const later = r.id ? derived.runLaterEdits[r.id] : undefined;
      if (later?.length && r.revision !== 'no later edits seen') r.laterEdits = later;
    }
}

export function deriveFromGraphJson(graph: EvidenceGraph): GraphDerived {
  const g = GraphEngine.load(graph);
  try {
    return deriveFromGraph(g);
  } finally {
    g.close();
  }
}
