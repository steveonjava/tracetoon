/**
 * Search links for the evidence graph: `TIED_TO {score, rankers}` from a commit
 * sentence (CommitClaim), a commit subject (Commit), a request (Prompt) or a
 * plan paragraph (Plan) to the hunks whose text it describes, for the facts no
 * structural link places (docs and scripts hunks, sentences that share few
 * rare words with one file).
 *
 * Built once at prepare time, while the patch is at hand, and stored in the
 * graph like any other relationship, so `query brief` needs no search engine.
 *
 * Rankers:
 * - `bm25`: Relate's FULLTEXT index (BM25, k1 1.2, b 0.75) over each hunk's
 *   file path, symbol names and changed lines. Relate indexes tokens as given,
 *   so the indexed text and the query words are Porter-stemmed here
 *   (porter.ts), identifiers split into words, as SQLite FTS5's porter
 *   tokenizer did before. The score's absolute scale differs from FTS5 (its
 *   idf is ln(1 + …), never zero), but the rules below only read ratios to the
 *   query's best hit, so no extra normalization is applied;
 * - `mention`: hunks that define or change a name the text uses, or are in a
 *   file it names.
 *
 * A commit's sentences only see that commit's hunks (INTRODUCED, else the hunks
 * of the files it TOUCHES), so a sentence never borrows another commit's code.
 * A hit becomes a link only when both rankers agree, the text names the hunk's
 * symbol or path, or BM25 alone is dominant: the top hit, clearly ahead of the
 * next one, sharing at least three of the text's rarer words. Ranking noise
 * never becomes evidence.
 */
import { readJson, writeJson, type Run } from '../run.ts';
import { patchHunks, type PatchHunk } from './build.ts';
import { evidenceLines, literalTokens, stem } from './codeEvidence.ts';
import { GraphEngine } from './engine.ts';
import { porterStem } from './porter.ts';
import { identWords, mentionedNames, mentionedPaths, terms } from './text.ts';
import type { EvidenceGraph, NodeLabel } from './model.ts';

export type GraphSearch = 'fulltext' | 'none';
export const GRAPH_SEARCHES: readonly GraphSearch[] = ['fulltext', 'none'];
export const SEARCH_FILE = 'graph-search.json';
/** What a prepare gets when neither a flag, the SKILL line nor the run folder says. */
export const DEFAULT_GRAPH_SEARCH: GraphSearch = 'fulltext';
/** Older names: `bm25` was the SQLite FTS5 search that `fulltext` replaced. */
const ALIASES: Record<string, GraphSearch> = { bm25: 'fulltext' };

/** A `--graph-search` value or SKILL `Graph search:` line, checked; undefined when none. */
export function parseGraphSearch(value: unknown): GraphSearch | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if ((GRAPH_SEARCHES as readonly string[]).includes(v)) return v as GraphSearch;
  if (ALIASES[v]) return ALIASES[v];
  throw new Error(
    `Unknown graph search "${String(value)}": use ${GRAPH_SEARCHES.join(', ')} (bm25 is an alias of fulltext).`,
  );
}

/** The search mode stored for this run, if prepare stored one. */
export function storedGraphSearch(run: Run): GraphSearch | undefined {
  try {
    return parseGraphSearch(readJson<{ search?: string }>(run, SEARCH_FILE)?.search);
  } catch {
    return undefined;
  }
}

export function saveRunGraphSearch(run: Run, search: GraphSearch): void {
  writeJson(run, SEARCH_FILE, { search });
}

/** Hits per ranker for a query over `n` candidate hunks (relational's rule). */
const topK = (n: number) => Math.min(8, Math.max(2, Math.ceil(n / 5)));
/** A BM25 hit agrees only at half the query's best score or more. */
const BM25_BAR = 0.5;
/** BM25 alone links only its top hit, and only this far ahead of the next one. */
const BM25_ALONE_LEAD = 0.67;
/** …sharing at least this many of the query's words with the hunk. */
const BM25_ALONE_WORDS = 3;
/** …and links at most this many hunks of its file. */
const SAME_FILE = 2;
/** Hits read per query, before scoping (ranked over every hunk, like idf). */
const FTS_LIMIT = 256;
/** Query words per search, rarest first. */
const MAX_QUERY_WORDS = 24;
/** Links kept per source (a request or a plan keeps its best). */
const MAX_LINKS = 4;
/** Paragraphs searched per request or plan. */
const MAX_PARAS = 24;

interface Query {
  label: NodeLabel;
  id: string;
  text: string;
  /** Hunk ids the query may link to; undefined = every hunk. */
  scope?: Set<string>;
}

/** Long prose as the paragraphs worth searching (blank-line separated). */
export function paragraphs(text: string, max = MAX_PARAS): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.replace(/[#*`\-\s]/g, '').length > 30)
    .slice(0, max)
    .map((p) => (p.length > 900 ? p.slice(0, 900) : p));
}

/** The text a hunk is indexed by: path, symbols, then its changed lines. */
export function hunkBody(h: PatchHunk, maxChars = 2400): string {
  const head = [h.file, h.scope, ...h.symbols, ...h.touched, ...h.dropped]
    .filter(Boolean)
    .join(' ');
  const lines = [
    ...(h.minus ?? []).map((l) => `-${l.trim().slice(0, 200)}`),
    ...(h.plus ?? []).map((l) => `+${l.trim().slice(0, 200)}`),
  ]
    .join('\n')
    .slice(0, maxChars);
  return `${head}\n${lines}`;
}

export interface SearchStats {
  queries: number;
  links: number;
}

/** Lowercase alphanumeric tokens (FTS5 unicode61's split), Porter-stemmed. */
export function stemmedTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(porterStem);
}

export interface SearchInput {
  graph: EvidenceGraph;
  patch: string;
  /** Full request and plan texts by fact id (the graph's own are clipped). */
  prompts?: { id: string; text: string }[];
  plans?: { id: string; text: string }[];
  mode: GraphSearch;
}

/**
 * Add each hunk's key lines and the TIED_TO search links (key lines only when
 * the graph engine cannot start). Mode `none` adds nothing: the graph, and so the
 * brief, is as without search. Mutates the graph; returns what it did, or
 * undefined when no search ran.
 */
export function addSearchLinks(input: SearchInput): SearchStats | undefined {
  const { graph } = input;
  if (input.mode === 'none') return undefined;
  const hunkNodes = new Map(
    graph.nodes.filter((n) => n.label === 'Hunk').map((n) => [n.id, n]),
  );
  const hunks = patchHunks(input.patch).filter((h) => hunkNodes.has(h.id));
  // Key lines for the brief: added comments, values, conditions (codeEvidence.ts).
  for (const h of hunks) {
    const node = hunkNodes.get(h.id)!;
    const lines = evidenceLines(h.minus ?? [], h.plus ?? [], h.file);
    if (lines.length) node.props.keyLines = lines;
    const literals = literalTokens(h.minus ?? [], h.plus ?? []);
    if (literals.length) node.props.literals = literals;
  }
  if (!hunks.length) return undefined;
  let db: GraphEngine;
  try {
    db = GraphEngine.open();
  } catch {
    return undefined; // no graph engine: no search links, the rest is unchanged
  }
  try {
    return searchInto(db, input, hunks);
  } catch {
    return undefined; // a failed search adds no links; the graph is otherwise whole
  } finally {
    db.close();
  }
}

function searchInto(db: GraphEngine, input: SearchInput, all: PatchHunk[]): SearchStats {
  const { graph } = input;
  const role = new Map(
    graph.nodes
      .filter((n) => n.label === 'File')
      .map((n) => [n.id, String(n.props.role)]),
  );
  // Generated files (a bundle) match everything and explain nothing.
  const hunks = all.filter((h) => role.get(h.file) !== 'generated');
  const bodies = new Map(hunks.map((h) => [h.id, hunkBody(h)]));
  const fileOf = new Map(hunks.map((h) => [h.id, h.file]));
  // A scratch database: one Hunk node per searchable hunk, its text stemmed.
  db.run('CREATE FULLTEXT INDEX hunk_text FOR (h:Hunk) ON EACH [h.text]');
  const docs = hunks.map((h) => {
    const body = bodies.get(h.id)!;
    return {
      id: h.id,
      text: stemmedTokens(`${body}\n${identWords(body).join(' ')}`).join(' '),
    };
  });
  for (let i = 0; i < docs.length; i += 500)
    db.run('UNWIND $rows AS r CREATE (h:Hunk) SET h += r', {
      rows: docs.slice(i, i + 500),
    });
  const words = new Map(hunks.map((h) => [h.id, new Set(identWords(bodies.get(h.id)!))]));
  const stems = new Map([...words].map(([id, ws]) => [id, new Set([...ws].map(stem))]));
  const df = new Map<string, number>();
  // Document frequency by stem, so "pins" meets a hunk's "pinned".
  for (const ws of stems.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);

  // Queries: commit subjects and sentences (scoped to the commit), requests and plans.
  const queries: Query[] = [];
  const introduced = new Map<string, Set<string>>();
  const touches = new Map<string, Set<string>>();
  for (const r of graph.rels) {
    if (r.type === 'INTRODUCED' && bodies.has(r.to.id)) {
      const s = introduced.get(r.from.id) ?? new Set<string>();
      s.add(r.to.id);
      introduced.set(r.from.id, s);
    }
    if (r.type === 'TOUCHES') {
      const s = touches.get(r.from.id) ?? new Set<string>();
      for (const h of hunks) if (h.file === r.to.id) s.add(h.id);
      touches.set(r.from.id, s);
    }
  }
  const scopeOf = (sha: string) => {
    const s = introduced.get(sha);
    if (s?.size) return s;
    const t = touches.get(sha);
    return t?.size ? t : undefined;
  };
  // Tests describe behavior; the code that does it is what a commit's text links to.
  const code = (scope: Set<string> | undefined) => {
    const out = new Set(
      [...(scope ?? [])].filter((id) => role.get(fileOf.get(id)!) !== 'tests'),
    );
    return out.size ? out : undefined;
  };
  const commitQueries = (
    label: NodeLabel,
    id: string,
    text: string,
    scope: Set<string> | undefined,
  ) => {
    if (!scope || !text.trim()) return;
    queries.push({ label, id, text, scope });
    // A sentence joining several changes ("a; b", "a, and b") is also asked part by part.
    const parts = text
      .split(/;\s+|,\s+and\s+|\s+—\s+/)
      .filter((p) => p.trim().split(/\s+/).length >= 4);
    if (parts.length >= 2)
      for (const p of parts) queries.push({ label, id, text: p, scope });
  };
  for (const n of graph.nodes) {
    if (n.label === 'Commit')
      commitQueries('Commit', n.id, String(n.props.subject ?? ''), code(scopeOf(n.id)));
    else if (n.label === 'CommitClaim' && n.props.assertsResult !== true)
      commitQueries(
        'CommitClaim',
        n.id,
        String(n.props.text ?? ''),
        code(scopeOf(String(n.props.commit))),
      );
  }
  const factIds = new Set(
    graph.nodes
      .filter((n) => n.label === 'Prompt' || n.label === 'Plan')
      .map((n) => n.id),
  );
  for (const [label, list] of [
    ['Prompt', input.prompts ?? []],
    ['Plan', input.plans ?? []],
  ] as const)
    for (const f of list)
      if (factIds.has(f.id))
        for (const p of paragraphs(f.text)) queries.push({ label, id: f.id, text: p });

  // Names a hunk defines or changes, and its file, for exact mentions.
  const names = new Map<string, Set<string>>();
  for (const h of hunks)
    for (const n of [
      ...h.symbols,
      ...h.touched,
      ...h.dropped,
      ...(h.scope ? [h.scope] : []),
    ]) {
      const s = names.get(n) ?? new Set<string>();
      s.add(h.id);
      names.set(n, s);
    }

  // Query words, rarest first (document frequency by crude stem, so "pins"
  // meets a hunk's "pinned"), and every query's BM25 ranking in one statement.
  const wordsOf = queries.map((q) =>
    [...new Set(terms(q.text))]
      .filter((w) => df.has(stem(w)))
      .sort((a, b) => df.get(stem(a))! - df.get(stem(b))! || a.localeCompare(b)),
  );
  const rankings = fulltextRankings(
    db,
    queries.map((q, i) => ({
      i,
      text: wordsOf[i]!.filter((w) => /^[a-z0-9]+$/.test(w))
        .slice(0, MAX_QUERY_WORDS)
        .map(porterStem)
        .join(' '),
      scope: q.scope ? [...q.scope] : null,
    })),
  );
  // Best link per (source, hunk).
  const best = new Map<
    string,
    { label: NodeLabel; id: string; hunk: string; score: number; rankers: string[] }
  >();
  {
    for (const [qi, q] of queries.entries()) {
      const allowed = (id: string) => !q.scope || q.scope.has(id);
      const n = q.scope ? q.scope.size : hunks.length;
      const k = topK(n);
      type Hit = { strong: boolean; strength: number; rank: number };
      const hit = new Map<string, Partial<Record<'bm25' | 'mention', Hit>>>();
      const put = (id: string, r: 'bm25' | 'mention', h: Hit) => {
        const x = hit.get(id) ?? {};
        x[r] = h;
        hit.set(id, x);
      };
      // BM25, ranked over all hunks and then kept to the query's scope.
      const qWords = wordsOf[qi]!;
      const ranked = rankings.get(qi) ?? [];
      const bm = ranked.slice(0, k);
      const top = bm[0]?.[1] ?? 0;
      bm.forEach(([id, s], rank) =>
        put(id, 'bm25', {
          strong: top > 0 && s >= BM25_BAR * top,
          strength: top > 0 ? s / top : 0,
          rank,
        }),
      );
      // Mentions: names the text uses that a hunk defines or changes, or a path it names.
      const ment = new Map<string, number>();
      for (const name of mentionedNames(q.text))
        for (const id of names.get(name) ?? [])
          if (allowed(id)) ment.set(id, (ment.get(id) ?? 0) + 2);
      for (const p of mentionedPaths(q.text))
        for (const h of hunks)
          if (allowed(h.id) && (h.file === p || h.file.endsWith(`/${p}`)))
            ment.set(h.id, (ment.get(h.id) ?? 0) + 1);
      const mlist = [...ment]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, k);
      const mtop = mlist[0]?.[1] ?? 1;
      mlist.forEach(([id, s], rank) =>
        put(id, 'mention', { strong: true, strength: s / mtop, rank }),
      );
      // BM25 alone: its top hit, clearly ahead of the best hit in any other
      // file and sharing enough of the text's words; the same file's other
      // strong hits come with it.
      const alone = new Set<string>();
      if (bm.length && top > 0) {
        const lead = bm[0]![0];
        const rival =
          ranked.find(([id]) => fileOf.get(id) !== fileOf.get(lead))?.[1] ?? 0;
        const group = bm
          .filter(
            ([id, sc]) => fileOf.get(id) === fileOf.get(lead) && sc >= BM25_BAR * top,
          )
          .slice(0, SAME_FILE)
          .map(([id]) => id);
        // Words the text shares with those hunks together (a file's hunks split them).
        const qStems = new Set(qWords.map(stem));
        const shared = [...qStems].filter((w) =>
          group.some((id) => stems.get(id)!.has(w)),
        ).length;
        if (rival <= BM25_ALONE_LEAD * top && shared >= BM25_ALONE_WORDS)
          for (const id of group) alone.add(id);
      }
      // Acceptance.
      for (const [id, x] of hit) {
        const strong = (['bm25', 'mention'] as const).filter((r) => x[r]?.strong);
        let ok = strong.length >= 2 || !!x.mention;
        if (!ok) ok = alone.has(id);
        if (!ok) continue;
        const rankers = strong.length ? [...strong] : (['bm25'] as string[]);
        const score =
          Math.round(
            (strong.reduce((a, r) => a + (x[r]?.strength ?? 0), 0) / 3 ||
              (x.bm25?.strength ?? 0) / 3) * 100,
          ) / 100;
        const key = `${q.label}|${q.id}|${id}`;
        const prev = best.get(key);
        if (!prev || score > prev.score)
          best.set(key, { label: q.label, id: q.id, hunk: id, score, rankers });
      }
    }
  }

  // At most MAX_LINKS per source, strongest first.
  const bySource = new Map<
    string,
    { label: NodeLabel; id: string; hunk: string; score: number; rankers: string[] }[]
  >();
  for (const l of best.values()) {
    const k = `${l.label}|${l.id}`;
    bySource.set(k, [...(bySource.get(k) ?? []), l]);
  }
  let links = 0;
  for (const list of bySource.values())
    for (const l of list
      .sort((a, b) => b.score - a.score || hunkNum(a.hunk) - hunkNum(b.hunk))
      .slice(0, MAX_LINKS)) {
      graph.rels.push({
        type: 'TIED_TO',
        from: { label: l.label, id: l.id },
        to: { label: 'Hunk', id: l.hunk },
        props: { score: l.score, rankers: l.rankers },
      });
      links++;
    }
  graph.stats.rels = graph.rels.length;
  return { queries: queries.length, links };
}

/**
 * Each query's BM25 hits within its scope, best first (ties by hunk id), from
 * Relate's FULLTEXT index: the top FTS_LIMIT over every hunk, then scoped.
 */
function fulltextRankings(
  db: GraphEngine,
  qs: { i: number; text: string; scope: string[] | null }[],
): Map<number, [string, number][]> {
  const out = new Map<number, [string, number][]>();
  const asked = qs.filter((q) => q.text);
  for (let i = 0; i < asked.length; i += 200) {
    const { rows } = db.run(
      `UNWIND $qs AS q
       CALL (q) {
         MATCH (h:Hunk)
         SEARCH h IN (FULLTEXT INDEX hunk_text FOR q.text LIMIT ${FTS_LIMIT}) SCORE AS s
         RETURN h.id AS id, s
       }
       WITH q, id, s WHERE q.scope IS NULL OR id IN q.scope
       RETURN q.i AS i, id, s`,
      { qs: asked.slice(i, i + 200) },
    );
    for (const r of rows) {
      const i = Number(r.i);
      const list = out.get(i) ?? [];
      list.push([String(r.id), Number(r.s)]);
      out.set(i, list);
    }
  }
  for (const list of out.values())
    list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

const hunkNum = (id: string) => Number(id.replace(/\D/g, '')) || 0;
