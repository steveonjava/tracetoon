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
import { addHeadScan } from './headScan.ts';
import { annotateDigest, deriveFromGraphJson, type GraphDerived } from './derive.ts';
import type { EvidenceGraph } from './model.ts';
import { withGraph } from './engine.ts';
import { briefParts, findQuery } from './queries.ts';
import type { BriefParts } from './briefRender.ts';
import { toToon } from './toon.ts';
import { renderNeighborhood } from './neighborhood.ts';
import { briefBudget, isNeighborhood, type BriefLayout } from './layout.ts';
import {
  budgetTokens,
  contextText,
  type RelationalContext,
} from '../relational/index.ts';
import { buildRelationalContext } from '../relational/builder.ts';
import { isRelational, type EvidenceMode } from '../relational/mode.ts';
import { sentenceCoverage } from '../relational/coverage.ts';

export const GRAPH_FILE = 'evidence-graph.json';
export const GRAPH_REVIEW_FILE = 'graph-review.json';
/** The relational/vector arm's context (shape test). */
export const R_CONTEXT_FILE = 'relational-context.json';

export interface GraphOutcome {
  graph?: EvidenceGraph;
  derived?: GraphDerived;
  relational?: RelationalContext;
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
  /** The run's evidence mode (src/relational/mode.ts). */
  mode: EvidenceMode = 'graph',
): (full: TraceDigest, trails: SessionTrail[]) => Relevance | undefined {
  return (full, trails) => {
    try {
      if (verification) full.verification = verification;
      const inputs = {
        full,
        trails,
        patch: submission(truth).patch,
        commitFiles: commitFiles(truth),
        commitLines: commitLines(truth),
      };
      if (mode === 'relational') {
        // The writer's context comes from the relational/vector store, built
        // from the same inputs. The graph is still built, but only for render's
        // shared Validation section; it doesn't annotate the digest.
        out.relational = measured('relational.build', () =>
          buildRelationalContext(inputs, { budgetTokens: budgetTokens() }),
        );
        out.graph = buildEvidenceGraph(inputs);
        out.derived = deriveFromGraphJson(out.graph);
        return undefined;
      }
      const graph = measured('graph.build', () => buildEvidenceGraph(inputs));
      // What the head tree still says about removed names, and who calls the changed ones.
      measured('graph.headScan', () =>
        addHeadScan(
          graph,
          truth.toplevel,
          truth.usedWorkingTree
            ? undefined
            : (truth.headSha ?? truth.commits.at(-1)?.sha),
        ),
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
  for (const f of [GRAPH_FILE, GRAPH_REVIEW_FILE, R_CONTEXT_FILE])
    if (existsSync(join(run.dir, f))) unlinkSync(join(run.dir, f));
  if (outcome.relational) writeJson(run, R_CONTEXT_FILE, outcome.relational);
  if (!outcome.graph || !outcome.derived) return;
  writeJson(run, GRAPH_FILE, outcome.graph);
  // The reviewer's graph-derived leads belong to the graph arm only.
  if (!outcome.relational) writeJson(run, GRAPH_REVIEW_FILE, outcome.derived.review);
}

/**
 * A relational run's brief parts, for render and the review import: the shared
 * Validation rows, commit sentences for coverage (without the graph's file
 * placement), the relational context's refs for tag checks, and which chunks
 * stand for each commit sentence (the store's links).
 */
function relationalBriefParts(
  graph: EvidenceGraph,
  run: Run,
): BriefParts & { hunkLinks: Record<string, string[]> } {
  const parts = withGraph(graph, (g) => briefParts(g));
  const ctx = readJson<RelationalContext>(run, R_CONTEXT_FILE);
  const keep = (title: string) => parts.sections.find((s) => s.title === title);
  const commits = keep('commitMessages');
  return {
    unchecked: parts.unchecked,
    hunkLinks: {},
    sections: [
      ...(commits
        ? [{ ...commits, rows: commits.rows.map(({ implementedBy: _p, ...r }) => r) }]
        : []),
      {
        title: 'context',
        columns: ['ref', 'text'],
        rows: (ctx?.refs ?? []).map((r) => ({ ref: r.id, text: r.text })),
      },
      ...(keep('validation') ? [keep('validation')!] : []),
      ...(ctx?.links
        ? [
            {
              title: 'coverage',
              columns: ['ref', 'coveredBy'],
              rows: sentenceCoverage(
                ctx.links,
                (commits?.rows ?? []).map((r) => String(r.ref ?? '')),
              ),
            },
          ]
        : []),
    ],
  };
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
export function graphBriefParts(
  graph: EvidenceGraph,
  layout: BriefLayout = 'toon',
  /** The run, so a relational run's parts come from its context instead. */
  run?: Run,
): (BriefParts & { hunkLinks: Record<string, string[]> }) | undefined {
  try {
    if (run && isRelational(run)) return relationalBriefParts(graph, run);
    return withGraph(graph, (g) => briefParts(g, { layout }));
  } catch {
    return undefined;
  }
}

export function graphBrief(
  graph: EvidenceGraph,
  opts: { rowCap?: number; layout?: BriefLayout; run?: Run } = {},
): string | undefined {
  const rowCap = opts.rowCap ?? 60;
  try {
    if (opts.run && isRelational(opts.run)) {
      const ctx = readJson<RelationalContext>(opts.run, R_CONTEXT_FILE);
      return ctx ? contextText(ctx) : undefined;
    }
    if (isNeighborhood(opts.layout))
      return withGraph(graph, (g) => {
        const { sections } = briefParts(g, { layout: 'neighborhood' });
        const budget = briefBudget(opts.layout);
        // As long as the TOON brief of the same run, so the layouts compare at equal size.
        const targetChars = budget.matchToon
          ? toToon(
              sections.filter((s) => s.title !== 'hunks'),
              { rowCap },
            ).trimEnd().length
          : undefined;
        return renderNeighborhood(sections, { budgetTokens: budget.tokens, targetChars });
      }).trimEnd();
    const sections = withGraph(graph, (g) => findQuery('brief')!.run(g, []));
    return toToon(sections, { rowCap }).trimEnd();
  } catch {
    return undefined;
  }
}
