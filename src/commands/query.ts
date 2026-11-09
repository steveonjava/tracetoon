/** `tracetoon query`: ask a run's evidence graph a named question or read-only Cypher. */
import { GraphError, withGraph } from '../graph/engine.ts';
import { graphBrief, loadGraph, R_CONTEXT_FILE } from '../graph/evidence.ts';
import { isNeighborhood, parseLayout, runLayout } from '../graph/layout.ts';
import {
  briefParts,
  findQuery,
  QUERIES,
  rawQuery,
  type Section,
} from '../graph/queries.ts';
import { contextText, type RelationalContext } from '../relational/index.ts';
import { isRelational } from '../relational/mode.ts';
import { readJson } from '../run.ts';
import { toToon } from '../graph/toon.ts';
import { assertRunOwner, findRun } from '../run.ts';
import { count } from '../util/profile.ts';
import { repository } from '../workflow/state.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export interface QueryOpts extends OutOpts {
  run?: string;
  cypher?: string;
  params?: string;
  all?: boolean;
  /** `query brief` only: toon, neighborhood or neighborhood-wide (default: the layout `prepare` chose). */
  layout?: string;
}

/** Rows printed per section unless --all: enough to act on, bounded for agent context. */
export const ROW_CAP = 60;

export function queryHelp(): string {
  return [
    'Named queries (tracetoon query <name> [args] --run <id>):',
    ...QUERIES.map((q) => `  ${`${q.name} ${q.args}`.trim().padEnd(34)} ${q.help}`),
    '  --cypher "<MATCH ... RETURN ...>"   your own read-only query (see `query schema`)',
  ].join('\n');
}

export function queryCmd(cwd: string, words: string[], opts: QueryOpts): void {
  const [name, ...args] = words;
  if (!name && !opts.cypher) {
    emit(
      opts,
      { queries: QUERIES.map(({ name, args, help }) => ({ name, args, help })) },
      queryHelp,
    );
    return;
  }
  const named = name ? findQuery(name) : undefined;
  if (name && !named) throw new UserError(`Unknown query "${name}".\n${queryHelp()}`);
  if (named?.name === 'schema') {
    const sections = named.run(undefined as never, args);
    emit(opts, { query: 'schema', sections }, () => toToon(sections));
    return;
  }
  let asked;
  try {
    asked = parseLayout(opts.layout);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  if (asked && named?.name !== 'brief')
    throw new UserError('--layout applies only to `tracetoon query brief`.');
  const repo = repository(cwd);
  const run = findRun(repo.gitDir, opts.run);
  assertRunOwner(run, repo.root, repo.branch);
  // Relational evidence mode: the writer's evidence is the static context that
  // prepare printed (also `query brief`); there are no lookups.
  if (isRelational(run)) {
    if (named?.name !== 'brief')
      throw new UserError(
        "This run's evidence is the context printed by `prepare` (also `tracetoon query brief`); no other lookups are available.",
      );
    if (asked)
      throw new UserError(
        '--layout applies only to the graph evidence mode; this run uses the relational context.',
      );
    const ctx = readJson<RelationalContext>(run, R_CONTEXT_FILE);
    if (!ctx)
      throw new UserError(
        `Run ${run.id} has no evidence context; refresh it with \`tracetoon prepare\`.`,
      );
    const text = contextText(ctx);
    count('graph.queries');
    emit(opts, { run: run.id, query: 'brief', evidenceMode: 'relational', text }, () => text);
    return;
  }
  const graph = loadGraph(run);
  if (!graph)
    throw new UserError(
      `Run ${run.id} has no evidence graph. Refresh it with \`tracetoon digest --run ${run.id}\`; if that reports the graph unavailable, use \`tracetoon expand\` instead.`,
    );
  let params: Record<string, unknown> = {};
  if (opts.params) {
    try {
      params = JSON.parse(opts.params) as Record<string, unknown>;
    } catch {
      throw new UserError('--params must be a JSON object.');
    }
  }
  // The brief reads as in `prepare`: the run's layout unless --layout says otherwise.
  const layout = named?.name === 'brief' ? (asked ?? runLayout(run)) : 'toon';
  let sections: Section[];
  try {
    sections = withGraph(graph, (g) =>
      isNeighborhood(layout)
        ? briefParts(g, { layout }).sections
        : named
          ? named.run(g, args)
          : rawQuery(g, opts.cypher!, params),
    );
  } catch (e) {
    if (e instanceof GraphError) throw new UserError(e.message);
    throw e;
  }
  count('graph.queries');
  const briefText = isNeighborhood(layout) ? graphBrief(graph, { layout }) : undefined;
  emit(
    opts,
    {
      run: run.id,
      query: named?.name ?? 'cypher',
      ...(named?.name === 'brief' ? { layout } : {}),
      sections,
    },
    () => briefText ?? toToon(sections, { rowCap: opts.all ? Infinity : ROW_CAP }),
  );
}
