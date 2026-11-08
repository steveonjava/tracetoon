/**
 * Retrieval over the store: relational links from stored keys, then hybrid
 * search for what keys can't show.
 *
 * 1. **Relational links** (SQL joins, exact):
 *    - `edit`: a prompt (or the decision/plan before an edit) → the chunks its
 *      turn's edit lines survive in (join on file and normalized line).
 *    - `commit`: a commit → the chunks its own added/removed lines are in (join
 *      on path and normalized line; its touched files when it has no lines).
 * 2. **Hybrid search**: every request, decision, plan paragraph, commit subject
 *    and commit sentence is a query against the chunks, ranked three ways:
 *    - `bm25`: FTS5 over the chunk text (porter stemming, identifiers split);
 *    - `vec`: cosine similarity of potion-code-16M-v2 embeddings, exact kNN;
 *    - `mention`: chunks defining a name, or in a file, the query names.
 *    The lists are fused with reciprocal rank fusion (k = 60) in SQL. A commit's
 *    queries only see that commit's chunks (a foreign-key filter), so a
 *    sentence never borrows code from another commit. A fused hit becomes a
 *    `search` link only when two rankers agree, the query names the chunk, or
 *    the embedding alone is close; ranking noise never becomes evidence.
 */
import { cosine, embeddingModel } from './embed.ts';
import { insertAll, rows, type Db, type Loaded } from './store.ts';
import {
  clip,
  ftsOr,
  identWords,
  mentionedNames,
  mentionedPaths,
  proseSentences,
  terms,
} from './text.ts';

export const RRF_K = 60;
export const TOP_K = 8;
/** A vector-only hit needs at least this cosine to count as a link. */
export const VEC_ALONE = 0.55;
/** Plan paragraphs searched per plan. */
const PLAN_PARAS = 40;

export interface QueryRow {
  source: string;
  kind: 'prompt' | 'decision' | 'plan' | 'subject' | 'sentence';
  text: string;
  scopeSha?: string;
}

export interface RetrievalStats {
  queries: number;
  hits: number;
  searchLinks: number;
  editLinks: number;
  commitLinks: number;
  vectors: boolean;
}

/** Plan text as paragraphs worth searching (headings and short lines folded in). */
export function planParagraphs(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.replace(/[#*`\-\s]/g, '').length > 30);
  return paras.slice(0, PLAN_PARAS).map((p) => clip(p, 900));
}

export function relationalLinks(db: Db): void {
  db.exec(`
    INSERT INTO link (src, chunk_id, kind, weight)
    SELECT src, chunk_id, 'edit', count(DISTINCT norm) FROM (
      SELECT e.turn_id AS src, cl.chunk_id, cl.norm
        FROM edit e
        JOIN edit_line el ON el.edit_id = e.id
        JOIN chunk_line cl ON cl.norm = el.norm AND cl.sign = '+'
        JOIN chunk c ON c.id = cl.chunk_id
        JOIN file f ON f.id = c.file_id AND f.path = e.file
       WHERE e.turn_id IS NOT NULL
      UNION ALL
      SELECT e.step_id, cl.chunk_id, cl.norm
        FROM edit e
        JOIN edit_line el ON el.edit_id = e.id
        JOIN chunk_line cl ON cl.norm = el.norm AND cl.sign = '+'
        JOIN chunk c ON c.id = cl.chunk_id
        JOIN file f ON f.id = c.file_id AND f.path = e.file
       WHERE e.step_id IS NOT NULL)
    GROUP BY src, chunk_id;

    INSERT INTO link (src, chunk_id, kind, weight)
    SELECT 'commit:' || k.ref, cl.chunk_id, 'commit', count(DISTINCT cl.sign || cl.norm)
      FROM commit_line kl
      JOIN commit_ k ON k.sha = kl.sha
      JOIN chunk_line cl ON cl.norm = kl.norm
           AND cl.sign = CASE kl.removed WHEN 1 THEN '-' ELSE '+' END
      JOIN chunk c ON c.id = cl.chunk_id
      JOIN file f ON f.id = c.file_id AND f.path = kl.path
     GROUP BY k.ref, cl.chunk_id;

    -- A commit with no matched lines (only short lines, a binary file): its files.
    INSERT INTO link (src, chunk_id, kind, weight)
    SELECT 'commit:' || k.ref, c.id, 'commit', 0.5
      FROM commit_ k
      JOIN commit_file cf ON cf.sha = k.sha
      JOIN file f ON f.path = cf.path
      JOIN chunk c ON c.file_id = f.id
     WHERE NOT EXISTS (SELECT 1 FROM link l WHERE l.src = 'commit:' || k.ref AND l.kind = 'commit');
  `);
}

/**
 * Approvals ("yes", "execute the plan") and pasted output carry no reason of
 * their own: their turn's edit links pass to the nearest earlier substantive
 * fact of the session (the plan or question they answered, or the request).
 */
export function inheritApprovals(db: Db): void {
  db.exec(`
    INSERT INTO link (src, chunk_id, kind, weight)
    SELECT prev, chunk_id, 'edit', weight FROM (
      SELECT (SELECT f2.id FROM fact f2
               WHERE f2.session_ref = p.session_ref AND f2.seq < p.seq
                 AND f2.words >= 8 AND f2.noise = 0
               ORDER BY f2.seq DESC LIMIT 1) AS prev,
             l.chunk_id, l.weight
        FROM fact p JOIN link l ON l.src = p.id AND l.kind = 'edit'
       WHERE p.kind = 'prompt' AND (p.words < 8 OR p.noise = 1))
    WHERE prev IS NOT NULL;
  `);
}

/** Every query the evidence asks of the diff. */
export function buildQueries(db: Db): QueryRow[] {
  const out: QueryRow[] = [];
  for (const f of rows(
    db,
    `SELECT f.id, f.kind, f.text FROM fact f JOIN session s ON s.ref = f.session_ref
      WHERE f.noise = 0 AND f.words >= 3 ORDER BY s.ord, f.seq`,
  )) {
    if (f.kind === 'plan')
      for (const p of planParagraphs(String(f.text)))
        out.push({ source: f.id, kind: 'plan', text: p });
    else out.push({ source: f.id, kind: f.kind, text: clip(String(f.text), 2000) });
  }
  for (const k of rows(db, 'SELECT sha, ref, subject FROM commit_ ORDER BY ord'))
    out.push({
      source: `commit:${k.ref}`,
      kind: 'subject',
      text: k.subject,
      scopeSha: k.sha,
    });
  for (const s of rows(
    db,
    `SELECT s.id, s.sha, s.text FROM commit_sentence s JOIN commit_ k ON k.sha = s.sha
      ORDER BY k.ord, s.n`,
  ))
    out.push({ source: s.id, kind: 'sentence', text: s.text, scopeSha: s.sha });
  return out;
}

/** Run the three rankers for every query, fuse in SQL, and write `search` links. */
export function hybridSearch(
  loaded: Loaded,
  queries: QueryRow[],
): { stats: RetrievalStats; vectors?: Map<string, Float32Array> } {
  const { db, chunks } = loaded;
  const model = embeddingModel();
  const qRows = queries.map((q, i) => [
    i + 1,
    q.source,
    q.kind,
    q.text,
    q.scopeSha ?? null,
  ]);
  insertAll(db, 'INSERT INTO query VALUES (?,?,?,?,?)', qRows);

  // A commit's queries only see the chunks that commit introduced.
  const scope = new Map<string, Set<string>>();
  for (const r of rows(
    db,
    `SELECT k.sha, l.chunk_id FROM link l JOIN commit_ k ON l.src = 'commit:' || k.ref
      WHERE l.kind = 'commit'`,
  )) {
    const s = scope.get(r.sha) ?? new Set<string>();
    s.add(r.chunk_id);
    scope.set(r.sha, s);
  }
  const allowed = (q: QueryRow) => (q.scopeSha ? scope.get(q.scopeSha) : undefined);

  // Document frequency of words over chunks: queries keep their rarest words.
  const df = new Map<string, number>();
  const chunkText = new Map<string, string>();
  for (const r of rows(db, 'SELECT id, body FROM chunk')) {
    chunkText.set(r.id, r.body);
    for (const w of new Set(identWords(r.body))) df.set(w, (df.get(w) ?? 0) + 1);
  }

  const hits: unknown[][] = [];
  // BM25 (FTS5). A commit's queries filter to its chunks inside SQL.
  const fts = db.prepare(
    `SELECT chunk_id, bm25(chunk_fts) AS s FROM chunk_fts WHERE chunk_fts MATCH ?
      ORDER BY s, chunk_id LIMIT ${TOP_K}`,
  );
  const ftsScoped = db.prepare(
    `SELECT chunk_id, bm25(chunk_fts) AS s FROM chunk_fts
      WHERE chunk_fts MATCH ? AND chunk_id IN (
        SELECT l.chunk_id FROM link l JOIN commit_ k ON l.src = 'commit:' || k.ref
         WHERE l.kind = 'commit' AND k.sha = ?)
      ORDER BY s, chunk_id LIMIT ${TOP_K}`,
  );
  try {
    queries.forEach((q, i) => {
      const words = [...new Set(terms(q.text))]
        .filter((w) => df.has(w))
        .sort((a, b) => df.get(a)! - df.get(b)! || a.localeCompare(b));
      const m = ftsOr(words);
      if (!m) return;
      const st = q.scopeSha && scope.has(q.scopeSha) ? ftsScoped : fts;
      st.bind(st === fts ? [m] : [m, q.scopeSha]);
      let rank = 0;
      while (st.step()) hits.push([i + 1, st.get(0), 'bm25', ++rank, -Number(st.get(1))]);
      st.reset();
    });
  } finally {
    fts.finalize();
    ftsScoped.finalize();
  }

  // Vectors: exact kNN over unit vectors (a few hundred chunks; no index needed).
  let vectors: Map<string, Float32Array> | undefined;
  if (model) {
    vectors = new Map(chunks.map((c) => [c.id, model.embed(chunkText.get(c.id) ?? '')]));
    const ids = chunks.map((c) => c.id);
    queries.forEach((q, i) => {
      const qv = model.embed(q.text);
      const ok = allowed(q);
      const scored: [string, number][] = [];
      for (const id of ids) {
        if (ok && !ok.has(id)) continue;
        scored.push([id, cosine(qv, vectors!.get(id)!)]);
      }
      scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      scored
        .slice(0, TOP_K)
        .forEach(([id, s], r) => s > 0 && hits.push([i + 1, id, 'vec', r + 1, s]));
    });
  }

  // Exact mentions: names the query uses that a chunk defines, or a path it names.
  const defs = new Map<string, string[]>();
  for (const r of rows(db, `SELECT name, chunk_id FROM symbol WHERE role != 'test'`)) {
    const list = defs.get(r.name) ?? [];
    list.push(r.chunk_id);
    defs.set(r.name, list);
  }
  const byFile = new Map<string, string[]>();
  for (const r of rows(
    db,
    'SELECT f.path, c.id FROM chunk c JOIN file f ON f.id = c.file_id',
  )) {
    const list = byFile.get(r.path) ?? [];
    list.push(r.id);
    byFile.set(r.path, list);
  }
  queries.forEach((q, i) => {
    const score = new Map<string, number>();
    for (const n of mentionedNames(q.text))
      for (const id of defs.get(n) ?? []) score.set(id, (score.get(id) ?? 0) + 2);
    for (const p of mentionedPaths(q.text))
      for (const [path, ids] of byFile)
        if (path === p || path.endsWith(`/${p}`))
          for (const id of ids) score.set(id, (score.get(id) ?? 0) + 1);
    const ok = allowed(q);
    [...score]
      .filter(([id]) => !ok || ok.has(id))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_K)
      .forEach(([id, s], r) => hits.push([i + 1, id, 'mention', r + 1, s]));
  });
  insertAll(db, 'INSERT INTO hit VALUES (?,?,?,?,?)', hits);

  // Reciprocal rank fusion and the acceptance rule, in SQL. Weight is the RRF
  // score scaled so three first-place rankers make 1.0. A source with several
  // queries (a plan's paragraphs) keeps its best score per chunk.
  db.exec(`
    CREATE TABLE fused AS
    SELECT q.id AS query_id, q.source, h.chunk_id,
           sum(1.0 / (${RRF_K} + h.rank)) * ${(RRF_K + 1) / 3} AS rrf,
           count(DISTINCT h.ranker) AS rankers,
           max(CASE WHEN h.ranker = 'vec' THEN h.score END) AS cos,
           max(h.ranker = 'mention') AS mentioned
      FROM hit h JOIN query q ON q.id = h.query_id
     GROUP BY q.id, h.chunk_id;

    INSERT INTO link (src, chunk_id, kind, weight)
    SELECT source, chunk_id, 'search', max(rrf)
      FROM fused
     WHERE rankers >= 2 OR mentioned OR cos >= ${VEC_ALONE}
     GROUP BY source, chunk_id;
  `);
  const n = (sql: string) => Number(db.selectValue(sql));
  return {
    vectors,
    stats: {
      queries: queries.length,
      hits: hits.length,
      searchLinks: n(`SELECT count(*) FROM link WHERE kind = 'search'`),
      editLinks: n(`SELECT count(*) FROM link WHERE kind = 'edit'`),
      commitLinks: n(`SELECT count(*) FROM link WHERE kind = 'commit'`),
      vectors: !!model,
    },
  };
}

export interface Reason {
  src: string;
  score: number;
  edit: number;
  search: number;
}

/**
 * The evidence for each chunk, best first: edit links (the turn's lines survive
 * here) outweigh search links; commits are listed separately.
 */
export function chunkReasons(db: Db): Map<string, Reason[]> {
  const out = new Map<string, Reason[]>();
  for (const r of rows(
    db,
    `SELECT chunk_id, src,
            sum(CASE kind WHEN 'edit' THEN weight ELSE 0 END) AS edit,
            sum(CASE kind WHEN 'search' THEN weight ELSE 0 END) AS search
       FROM link WHERE kind != 'commit'
      GROUP BY chunk_id, src`,
  )) {
    const score = Math.min(1, Math.log2(1 + Number(r.edit)) / 4) + Number(r.search);
    const list = out.get(r.chunk_id) ?? [];
    list.push({ src: r.src, score, edit: Number(r.edit), search: Number(r.search) });
    out.set(r.chunk_id, list);
  }
  for (const list of out.values())
    list.sort((a, b) => b.score - a.score || a.src.localeCompare(b.src));
  return out;
}

/** Sentences of a long text most similar to the change, in their original order. */
const sentenceCache = new WeakMap<Float32Array, Map<string, string>>();
const NO_CENTROID = new Float32Array(0);

export function bestSentences(
  text: string,
  centroid: Float32Array | undefined,
  budget: number,
): string {
  const cache = sentenceCache.get(centroid ?? NO_CENTROID) ?? new Map<string, string>();
  sentenceCache.set(centroid ?? NO_CENTROID, cache);
  const key = `${budget}\0${text}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = pickSentences(text, centroid, budget);
    cache.set(key, hit);
  }
  return hit;
}

function pickSentences(
  text: string,
  centroid: Float32Array | undefined,
  budget: number,
): string {
  const model = embeddingModel();
  const sents = proseSentences(text);
  if (!model || !centroid || sents.length <= 1 || text.length <= budget)
    return clip(text, budget);
  const scored = sents.map((s, i) => ({ s, i, v: cosine(model.embed(s), centroid) }));
  // The first sentence usually states the ask; keep it, then the closest ones.
  const keep = new Set([0]);
  let used = clip(sents[0]!, budget).length;
  for (const x of [...scored].sort((a, b) => b.v - a.v || a.i - b.i)) {
    if (keep.has(x.i)) continue;
    const add = Math.min(x.s.length, 240) + 3;
    if (used + add > budget) continue;
    keep.add(x.i);
    used += add;
  }
  const picked = [...keep].sort((a, b) => a - b);
  return picked
    .map((i, k) => (k > 0 && picked[k - 1] !== i - 1 ? '… ' : '') + clip(sents[i]!, 240))
    .join(' ');
}
