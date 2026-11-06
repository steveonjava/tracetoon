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
import { buildEvidenceGraph } from './build.ts';
import { annotateDigest, deriveFromGraphJson, type GraphDerived } from './derive.ts';
import type { EvidenceGraph } from './model.ts';
import { withGraph } from './engine.ts';
import { findQuery } from './queries.ts';
import { toToon } from './toon.ts';

export const GRAPH_FILE = 'evidence-graph.json';
export const GRAPH_REVIEW_FILE = 'graph-review.json';

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

/** The `enrich` hook for buildDigestPair: build, derive, annotate. */
export function graphEnricher(
  truth: PrTruth,
  out: GraphOutcome,
): (full: TraceDigest, trails: SessionTrail[]) => Relevance | undefined {
  return (full, trails) => {
    try {
      const graph = measured('graph.build', () =>
        buildEvidenceGraph({
          full,
          trails,
          patch: submission(truth).patch,
          commitFiles: commitFiles(truth),
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
  for (const f of [GRAPH_FILE, GRAPH_REVIEW_FILE])
    if (existsSync(join(run.dir, f))) unlinkSync(join(run.dir, f));
  if (!outcome.graph || !outcome.derived) return;
  writeJson(run, GRAPH_FILE, outcome.graph);
  writeJson(run, GRAPH_REVIEW_FILE, outcome.derived.review);
}

export function loadGraph(run: Run): EvidenceGraph | undefined {
  return readJson<EvidenceGraph>(run, GRAPH_FILE);
}

export function loadGraphReview(run: Run): GraphDerived['review'] | undefined {
  return readJson<GraphDerived['review']>(run, GRAPH_REVIEW_FILE);
}

/**
 * The `query outline` result as text, for places every drafter reads before
 * writing (the `prepare` output, the top of evidence-notes.md). Agents that
 * draft inline often skip running queries, so they get the map anyway.
 * Undefined when the graph can't be read; the digest never depends on it.
 */
export function graphOutline(graph: EvidenceGraph, rowCap = 40): string | undefined {
  try {
    const sections = withGraph(graph, (g) => findQuery('outline')!.run(g, []));
    return toToon(sections, { rowCap }).trimEnd();
  } catch {
    return undefined;
  }
}
