/**
 * Builds a run's evidence graph alongside its digest. Fails open: when the graph
 * engine cannot start, the digest is still written (with the trimming rules it
 * had before the graph) and says what is missing.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { submission } from '../contribution/guidance.ts';
import type { Relevance, SessionTrail, TraceDigest } from '../digest/build.ts';
import type { PrTruth } from '../git/pr.ts';
import { git } from '../util/exec.ts';
import { readJson, writeJson, type Run } from '../run.ts';
import { measured } from '../util/profile.ts';
import { evidenceLine } from '../correlate/correlate.ts';
import type { Run as DigestRun } from '../digest/build.ts';
import { buildEvidenceGraph } from './build.ts';
import { annotateDigest, deriveFromGraphJson, type GraphDerived } from './derive.ts';
import type { EvidenceGraph } from './model.ts';
import { evidenceEngine, withEvidence } from './store.ts';
import { SqlEngine } from '../sql/engine.ts';
import { relationalGuide, relationalMode, relationalParts } from '../sql/relational.ts';
import { briefParts, findQuery } from './queries.ts';
import type { BriefParts } from './briefRender.ts';
import { toToon } from './toon.ts';

export const GRAPH_FILE = 'evidence-graph.json';
export const GRAPH_REVIEW_FILE = 'graph-review.json';
/** The same evidence as SQLite tables, for any SQLite client (`sqlite3 evidence.sqlite`). */
export const SQL_FILE = 'evidence.sqlite';

export interface GraphOutcome {
  graph?: EvidenceGraph;
  derived?: GraphDerived;
  error?: string;
}

/** Which PR files each commit touched: one `git log` for the whole range. */
export function commitFiles(truth: PrTruth): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (truth.usedWorkingTree || !truth.commits.length) return out;
  const head = truth.headSha ?? truth.commits.at(-1)!.sha;
  const r = git(truth.toplevel, [
    'log',
    '--no-merges',
    '--no-renames',
    '--format=%x1e%H',
    '--name-only',
    `${truth.mergeBase}..${head}`,
  ]);
  if (!r.ok) return out;
  for (const rec of r.stdout.split('\x1e')) {
    const [sha, ...paths] = rec.trim().split(/\r?\n/);
    if (sha) out.set(sha.trim(), paths.map((p) => p.trim()).filter(Boolean));
  }
  return out;
}

/** Each commit's own added lines per file (normalized), from one `git log -p`. */
export function commitLines(truth: PrTruth): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  if (truth.usedWorkingTree || !truth.commits.length) return out;
  const head = truth.headSha ?? truth.commits.at(-1)!.sha;
  const r = git(truth.toplevel, [
    'log',
    '--no-merges',
    '--no-renames',
    '--no-color',
    '-p',
    '-U0',
    '--format=%x1e%H',
    `${truth.mergeBase}..${head}`,
  ]);
  if (!r.ok) return out;
  for (const rec of r.stdout.split('\x1e')) {
    const lines = rec.split(/\r?\n/);
    const sha = lines[0]?.trim();
    if (!sha) continue;
    const files = new Map<string, string[]>();
    let file: string | undefined;
    for (const line of lines.slice(1)) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        // A deleted file keeps the path from its "--- a/…" line.
        if (p !== '/dev/null') file = p.replace(/^b\//, '');
        continue;
      }
      if (line.startsWith('diff --git ')) {
        file = undefined;
        continue;
      }
      if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p !== '/dev/null') file = p.replace(/^a\//, '');
        continue;
      }
      if (file && (line.startsWith('+') || line.startsWith('-'))) {
        const e = evidenceLine(line.slice(1));
        if (e)
          files.set(file, [...(files.get(file) ?? []), line[0] === '-' ? `-${e}` : e]);
      }
    }
    out.set(sha, files);
  }
  return out;
}

/** The `enrich` hook for buildDigestPair: build, derive, annotate. */
export function graphEnricher(
  truth: PrTruth,
  out: GraphOutcome,
  /** Exact-content check receipts, so the graph can tell fresh checks from logged ones. */
  verification?: DigestRun[],
): (full: TraceDigest, trails: SessionTrail[]) => Relevance | undefined {
  return (full, trails) => {
    try {
      if (verification) full.verification = verification;
      const graph = measured('graph.build', () =>
        buildEvidenceGraph({
          full,
          trails,
          patch: submission(truth).patch,
          commitFiles: commitFiles(truth),
          commitLines: commitLines(truth),
        }),
      );
      const derived = measured('graph.derive', () => deriveFromGraphJson(graph));
      annotateDigest(full, derived);
      full.graph = graph.stats;
      out.graph = graph;
      out.derived = derived;
      return derived.relevance;
    } catch (e) {
      out.error = (e as Error).message;
      full.notes.push(
        `Evidence graph unavailable (${out.error}); per-file provenance and \`tracetoon query\` are missing from this run.`,
      );
      return undefined;
    }
  };
}

export function saveGraph(run: Run, outcome: GraphOutcome): void {
  for (const f of [GRAPH_FILE, GRAPH_REVIEW_FILE, SQL_FILE])
    if (existsSync(join(run.dir, f))) unlinkSync(join(run.dir, f));
  if (!outcome.graph || !outcome.derived) return;
  writeJson(run, GRAPH_FILE, outcome.graph);
  writeJson(run, GRAPH_REVIEW_FILE, outcome.derived.review);
  if (evidenceEngine() === 'sqlite')
    try {
      const db = SqlEngine.load(outcome.graph);
      try {
        db.exportTo(join(run.dir, SQL_FILE));
      } finally {
        db.close();
      }
    } catch {
      /* the JSON is the record; the database file is a convenience */
    }
}

export function loadGraph(run: Run): EvidenceGraph | undefined {
  return readJson<EvidenceGraph>(run, GRAPH_FILE);
}

export function loadGraphReview(run: Run): GraphDerived['review'] | undefined {
  return readJson<GraphDerived['review']>(run, GRAPH_REVIEW_FILE);
}

/**
 * The `query brief` result as text, for places every drafter reads before
 * writing (the `prepare` output, the top of evidence-notes.md). Agents that
 * draft inline often skip running queries, so they get it anyway.
 * Undefined when the graph can't be read; the digest never depends on it.
 */
/** The brief as data, for `render` to write the Validation section and check ref tags. */
export function graphBriefParts(graph: EvidenceGraph): BriefParts | undefined {
  try {
    return withEvidence(graph, (g) =>
      relationalMode() ? relationalParts(g) : briefParts(g),
    );
  } catch {
    return undefined;
  }
}

export function graphBrief(
  graph: EvidenceGraph,
  rowCap = 60,
  run = '<id>',
): string | undefined {
  try {
    // The relational arm prints the database guide in the brief's place.
    if (relationalMode()) return withEvidence(graph, (g) => relationalGuide(g, run));
    const sections = withEvidence(graph, (g) => findQuery('brief')!.run(g, []));
    return toToon(sections, { rowCap }).trimEnd();
  } catch {
    return undefined;
  }
}
