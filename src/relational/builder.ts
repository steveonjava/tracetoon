/**
 * The relational/vector context builder (shape test).
 *
 * - `initRelational()`: loads SQLite (wasm) and the bundled static embedding
 *   model, once, before evidence commands.
 * - `buildRelationalContext(inputs, opts)`: synchronous. ETL into SQLite record
 *   tables (store.ts), relational links and hybrid BM25 + vector + mention
 *   search fused with RRF (retrieve.ts), then a budgeted greedy pack into a
 *   sectioned text the writer cites by id (pack.ts).
 *
 * See docs/relational-design.md. Nothing here imports from src/graph/ except
 * the input types.
 */
import type {
  BuildOptions,
  ContextRef,
  GraphInputs,
  RelationalContext,
} from './index.ts';
import { initSqlWasm } from './sqlite.ts';
import { cosine, embeddingError, embeddingModel, initEmbeddings } from './embed.ts';
import { count, loadStore, rows } from './store.ts';
import {
  bestSentences,
  buildQueries,
  chunkReasons,
  hybridSearch,
  inheritApprovals,
  relationalLinks,
  RRF_K,
  TOP_K,
  VEC_ALONE,
  type Reason,
} from './retrieve.ts';
import { keyLines, pack, safe, type Item, type SectionKey } from './pack.ts';
import type { Chunk } from './diff.ts';
import { clip, oneLine } from './text.ts';

export async function initRelational(): Promise<void> {
  initEmbeddings();
  await initSqlWasm();
}

export const LEGEND = [
  'PR evidence from the session logs, commits and diff, retrieved by relevance and packed to fit (not everything is shown).',
  'Cite the id in brackets for what a sentence rests on: S user request, D decision, P plan, commit:<sha> a commit, commit:<sha>#n one sentence of its message, F a changed file, H a diff chunk.',
  '"→" lists the files or chunks an item is tied to (its edits survive there, or its words match); "why" lists the requests and commit sentences tied to a chunk.',
].join('\n');

const ROLE_WEIGHT: Record<string, number> = {
  behavior: 1.2,
  tests: 1.0,
  docs: 0.7,
  config: 0.55,
  generated: 0.25,
  version: 0.25,
};

const fmtNames = (names: string[], n: number) =>
  names.length <= n
    ? names.join(', ')
    : `${names.slice(0, n).join(', ')} +${names.length - n} more`;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function buildRelationalContext(
  inputs: GraphInputs,
  opts: BuildOptions,
): RelationalContext {
  const t0 = performance.now();
  const budgetChars = Math.max(400, Math.floor(opts.budgetTokens * 4));
  const loaded = loadStore(inputs);
  const { db, chunks } = loaded;
  try {
    relationalLinks(db);
    inheritApprovals(db);
    const queries = buildQueries(db);
    const { stats: rstats, vectors } = hybridSearch(loaded, queries);
    const reasons = chunkReasons(db);
    const tRetrieve = performance.now();

    const refText = new Map<string, string>();
    const items: Item[] = [];
    const chunkById = new Map(chunks.map((c) => [c.id, c]));

    // ---- Files and chunks ------------------------------------------------
    const files = rows(db, 'SELECT * FROM file ORDER BY ord');
    const fileOf = new Map<string, string>(); // chunk → file id
    const chunksOf = new Map<string, Chunk[]>();
    for (const r of rows(db, 'SELECT id, file_id FROM chunk ORDER BY ord')) {
      fileOf.set(r.id, r.file_id);
      const list = chunksOf.get(r.file_id) ?? [];
      list.push(chunkById.get(r.id)!);
      chunksOf.set(r.file_id, list);
    }
    // New names: defined on added lines and on no removed line of the patch.
    const fresh = new Set(
      rows(
        db,
        `SELECT DISTINCT name FROM symbol WHERE role = 'defined'
           AND name NOT IN (SELECT name FROM symbol WHERE role = 'removed')`,
      ).map((r) => r.name as string),
    );
    // Commits per chunk.
    const commitsOfChunk = new Map<string, string[]>();
    for (const r of rows(
      db,
      `SELECT l.chunk_id, l.src FROM link l JOIN commit_ k ON l.src = 'commit:' || k.ref
        WHERE l.kind = 'commit' ORDER BY k.ord`,
    )) {
      const list = commitsOfChunk.get(r.chunk_id) ?? [];
      list.push(r.src);
      commitsOfChunk.set(r.chunk_id, list);
    }
    // What each test chunk uses: names defined in other files' chunks (join on identifiers).
    const testUses = new Map<string, { name: string; chunk: string }[]>();
    for (const r of rows(
      db,
      `SELECT i.chunk_id AS test_chunk, s.name, min(s.chunk_id) AS def_chunk
         FROM ident i
         JOIN chunk tc ON tc.id = i.chunk_id
         JOIN file tf ON tf.id = tc.file_id AND tf.role = 'tests'
         JOIN symbol s ON s.name = i.name AND s.role = 'defined'
         JOIN chunk dc ON dc.id = s.chunk_id
         JOIN file df ON df.id = dc.file_id AND df.role != 'tests'
        GROUP BY i.chunk_id, s.name
        ORDER BY i.chunk_id, s.name`,
    )) {
      const list = testUses.get(r.test_chunk) ?? [];
      list.push({ name: r.name, chunk: r.def_chunk });
      testUses.set(r.test_chunk, list);
    }

    const chunkValue = new Map<string, number>();
    const fileWhat = new Map<string, string>();
    const fileValue = new Map<string, number>();
    const sectionOf = (role: string): SectionKey =>
      role === 'tests' ? 'tests' : role === 'behavior' ? 'changes' : 'other';
    const visibleChunk = (chosen: Set<string>) => (id: string) =>
      chosen.has(`chunk:${id}`)
        ? id
        : chosen.has(`file:${fileOf.get(id)}`)
          ? fileOf.get(id)!
          : undefined;
    const refsTo = (ids: string[], chosen: Set<string>, n: number) => {
      const vis = visibleChunk(chosen);
      const out: string[] = [];
      for (const id of ids) {
        const v = vis(id);
        if (v && !out.includes(v)) out.push(v);
        if (out.length >= n) break;
      }
      return out;
    };

    for (const f of files) {
      const fid = f.id as string;
      const role = f.binary ? 'generated' : (f.role as string);
      const list = chunksOf.get(fid) ?? [];
      const changed = Number(f.added) + Number(f.removed);
      const defs = [...new Set(list.flatMap((c) => c.defined))];
      const newDefs = defs.filter((d) => fresh.has(d));
      const scopes = [
        ...new Set(list.flatMap((c) => (c.scope ? [c.scope] : []).concat(c.defined))),
      ];
      const titles = [...new Set(list.flatMap((c) => c.tests))];
      const status =
        f.status === 'added'
          ? 'new'
          : f.status === 'deleted'
            ? 'deleted'
            : f.status === 'renamed'
              ? `renamed from ${f.old_path}`
              : '';
      const kind = f.binary ? 'binary' : role === 'behavior' ? '' : role;
      const size = f.binary ? '' : `+${f.added}/−${f.removed}`;
      const meta = [status, kind, size].filter(Boolean).join(', ');
      const quote = (s: string) => `"${safe(clip(s, 90))}"`;
      const firstLine = list
        .flatMap((c) => c.lines)
        .find((l) => l.sign === '+' && /[A-Za-z]{3}/.test(l.text));
      const what = (n: number) =>
        role === 'tests' && titles.length
          ? `tests ${titles.slice(0, n).map(quote).join('; ')}${titles.length > n ? `; +${titles.length - n} more` : ''}`
          : newDefs.length
            ? `adds ${fmtNames(newDefs, n + 1)}`
            : scopes.length
              ? `changes ${fmtNames(scopes, n + 1)}`
              : firstLine && role !== 'generated'
                ? `"${safe(clip(firstLine.text, 80))}"`
                : '';
      fileWhat.set(fid, what(1));
      const line = (n: number) => {
        const w = what(n);
        return `[${fid}] ${f.path} (${meta})${w ? `: ${w}` : ''}`;
      };
      refText.set(
        fid,
        `${f.path} (${meta})${defs.length ? `; defines ${defs.join(', ')}` : ''}${titles.length ? `; tests: ${titles.join('; ')}` : ''}${scopes.length ? `; in ${scopes.join(', ')}` : ''}`,
      );
      const w = ROLE_WEIGHT[role] ?? 0.5;
      const v = w * (2.2 + Math.log2(1 + changed) / 2.5) * (newDefs.length ? 1.15 : 1);
      fileValue.set(fid, v);
      items.push({
        key: `file:${fid}`,
        section: sectionOf(role),
        order: [Number(f.ord)],
        value: v,
        render: () => line(2),
        expand: () => line(6),
      });

      // Chunks of this file.
      list.forEach((c) => {
        const ch = c.added + c.removed;
        const why = reasons.get(c.id) ?? [];
        const top = why[0]?.score ?? 0;
        const cv =
          w *
          (0.8 + Math.log2(1 + ch) / 3) *
          (c.defined.some((d) => fresh.has(d)) ? 1.3 : 1) *
          (1 + 0.4 * Math.min(1, top)) *
          (c.tests.length ? 1.15 : 1) *
          (c.defined.length || c.tests.length || c.scope || c.removedDefs.length
            ? 1
            : 0.6);
        chunkValue.set(c.id, cv);
        const range = c.start === c.end ? `L${c.start}` : `L${c.start}-${c.end}`;
        const adds = c.defined.filter((d) => fresh.has(d));
        const changes = c.defined.filter((d) => !fresh.has(d));
        const uses = testUses.get(c.id) ?? [];
        const head = (chosen: Set<string>, n: number) => {
          const parts: string[] = [];
          if (c.scope) parts.push(`in ${c.scope}`);
          if (c.tests.length)
            parts.push(
              `tests ${c.tests
                .slice(0, n)
                .map((t) => `"${safe(clip(t, 80))}"`)
                .join('; ')}${c.tests.length > n ? ` +${c.tests.length - n}` : ''}`,
            );
          if (adds.length) parts.push(`adds ${fmtNames(adds, n + 1)}`);
          if (changes.length) parts.push(`redefines ${fmtNames(changes, n)}`);
          if (c.removedDefs.length && !c.defined.length)
            parts.push(`removes ${fmtNames(c.removedDefs, n)}`);
          parts.push(`+${c.added}/−${c.removed}`);
          if (uses.length) {
            const u = uses.slice(0, 3).map((x) => {
              const r = visibleChunk(chosen)(x.chunk);
              return r ? `${x.name} (${r})` : x.name;
            });
            parts.push(`uses ${u.join(', ')}`);
          }
          const whyIds = why
            .map((r) => r.src)
            .filter((s) => visibleSource(chosen, s))
            .slice(0, 2);
          if (whyIds.length) parts.push(`why ${whyIds.join(', ')}`);
          return `  [${c.id}] ${range} ${parts.join('; ')}`;
        };
        refText.set(
          c.id,
          `${c.file} ${range}${c.scope ? ` in ${c.scope}` : ''}${c.defined.length ? `; defines ${c.defined.join(', ')}` : ''}${c.removedDefs.length ? `; removes ${c.removedDefs.join(', ')}` : ''}${c.tests.length ? `; tests: ${c.tests.join('; ')}` : ''}\n${c.lines
            .slice(0, 60)
            .map((l) => `${l.sign} ${l.text.trim().slice(0, 160)}`)
            .join('\n')}`.slice(0, 2400),
        );
        items.push({
          key: `chunk:${c.id}`,
          section: sectionOf(role),
          order: [Number(f.ord), c.start, c.id],
          value: cv,
          parent: `file:${fid}`,
          group: `file:${fid}`,
          decay: 0.6,
          render: (chosen) => head(chosen, 2),
          expand: (chosen) => head(chosen, 5),
        });
        if (role !== 'generated') {
          const kl = keyLines(c, 2);
          const kl4 = keyLines(c, 6);
          if (kl.length)
            items.push({
              key: `code:${c.id}`,
              section: sectionOf(role),
              order: [Number(f.ord), c.start, c.id, 1],
              value: cv * 0.45,
              parent: `chunk:${c.id}`,
              render: () => kl.map((l) => `      ${l}`).join('\n'),
              expand: () => kl4.map((l) => `      ${l}`).join('\n'),
            });
        }
      });
    }

    // Every changed file at least by name: one line per directory listing the
    // files not detailed above (their F ids are citable).
    const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
    const dirs = new Map<string, typeof files>();
    for (const f of files)
      dirs.set(dirOf(f.path), [...(dirs.get(dirOf(f.path)) ?? []), f]);
    for (const [dir, list] of dirs) {
      const render = (chosen: Set<string>) => {
        const rest = list.filter((f) => !chosen.has(`file:${f.id}`));
        if (!rest.length) return '';
        const name = (f: (typeof files)[number]) => {
          const base = dir === '.' ? f.path : f.path.slice(dir.length + 1);
          const tag = f.binary ? 'binary' : f.role === 'behavior' ? '' : String(f.role);
          const st =
            f.status === 'added' ? 'new' : f.status === 'deleted' ? 'deleted' : '';
          const meta = [st, tag, f.binary ? '' : `+${f.added}/−${f.removed}`]
            .filter(Boolean)
            .join(' ');
          return `[${f.id}] ${base} (${meta})`;
        };
        return `${dir === '.' ? '(root)' : `${dir}/`}: ${rest.map(name).join(', ')}`;
      };
      items.push({
        key: `dir:${dir}`,
        section: 'other',
        order: ['~', dir],
        value: 2.5 + list.length,
        render,
      });
    }

    // ---- Requests, decisions, plans ---------------------------------------
    const editBySrc = new Map<string, number>();
    const searchBySrc = new Map<string, number[]>();
    const chunksBySrc = new Map<string, { id: string; w: number }[]>();
    for (const r of rows(
      db,
      `SELECT src, chunk_id, kind, weight FROM link WHERE kind != 'commit'
        ORDER BY src, weight DESC, chunk_id`,
    )) {
      if (r.kind === 'edit')
        editBySrc.set(r.src, (editBySrc.get(r.src) ?? 0) + Number(r.weight));
      else searchBySrc.set(r.src, [...(searchBySrc.get(r.src) ?? []), Number(r.weight)]);
      const w =
        r.kind === 'edit'
          ? Math.min(1, Math.log2(1 + Number(r.weight)) / 4) + 0.5
          : Number(r.weight);
      chunksBySrc.set(r.src, [...(chunksBySrc.get(r.src) ?? []), { id: r.chunk_id, w }]);
    }
    // Topical similarity: cosine of a text's embedding with the change's
    // centroid, rescaled (approvals and chatter sit near 0.1, requests about the
    // change near 0.35-0.5, plans higher).
    const topicalCache = new Map<string, number>();
    const topical = (src: string, text: string) => {
      let t = topicalCache.get(src);
      if (t === undefined) {
        const model = embeddingModel();
        t =
          model && centroid
            ? Math.max(
                0,
                Math.min(
                  1,
                  (cosine(model.embed(text.slice(0, 3000)), centroid) - 0.15) / 0.3,
                ),
              )
            : 0.5;
        topicalCache.set(src, t);
      }
      return t;
    };
    /**
     * How tied a request, decision or plan is to this change, 0..1: its turn's
     * edits that survive in the diff, its topical similarity, and how many
     * chunks hybrid search links it to.
     */
    const relevance = (src: string, text: string) => {
      const e = editBySrc.get(src) ?? 0;
      const n = (searchBySrc.get(src) ?? []).length;
      return (
        0.4 * Math.min(1, Math.log2(1 + e) / 8) +
        0.45 * topical(src, text) +
        0.15 * Math.min(1, n / 4)
      );
    };
    const targetsOf = (src: string) => {
      const agg = new Map<string, number>();
      for (const x of chunksBySrc.get(src) ?? [])
        agg.set(x.id, (agg.get(x.id) ?? 0) + x.w);
      return [...agg]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id]) => id);
    };
    // The change's centroid (size-weighted chunk vectors) picks sentences of long texts.
    let centroid: Float32Array | undefined;
    if (vectors?.size) {
      const dim = vectors.values().next().value!.length;
      centroid = new Float32Array(dim);
      for (const c of chunks) {
        const v = vectors.get(c.id)!;
        const wgt =
          Math.log2(2 + c.added + c.removed) *
          (ROLE_WEIGHT[loaded.files.find((f) => f.path === c.file)?.role ?? 'behavior'] ??
            0.5);
        for (let j = 0; j < dim; j++) centroid[j]! += v[j]! * wgt;
      }
      let n = 0;
      for (let j = 0; j < dim; j++) n += centroid[j]! ** 2;
      n = Math.sqrt(n) || 1;
      for (let j = 0; j < dim; j++) centroid[j]! /= n;
    }
    const facts = rows(
      db,
      `SELECT f.*, s.band, s.ord AS sord FROM fact f JOIN session s ON s.ref = f.session_ref
        ORDER BY s.ord, f.seq`,
    );
    // The opening request of each included session: its earliest substantive
    // request that is at least 40% as tied to the change as its most tied one.
    const goals = new Set<string>();
    const firstAsk = new Set<string>();
    for (const ref of new Set(facts.map((f) => f.session_ref as string))) {
      const asks = facts.filter(
        (f) =>
          f.session_ref === ref &&
          f.kind === 'prompt' &&
          f.band === 'included' &&
          !f.noise &&
          Number(f.words) >= 8,
      );
      const best = Math.max(0, ...asks.map((f) => topical(f.id, f.text)));
      if (best <= 0) continue;
      const goal = asks.find((f) => topical(f.id, f.text) >= 0.6 * best);
      if (goal) goals.add(goal.id);
      if (goal && goal.id === asks[0]?.id) firstAsk.add(goal.id);
    }
    const multiSession = new Set(facts.map((f) => f.session_ref)).size > 1;
    // Time join: a fact typed after the PR's last commit can't be why the
    // commits were made (only when every commit has a time).
    const afterHead = new Set(
      rows(
        db,
        `SELECT f.id FROM fact f
          WHERE f.t IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM commit_ WHERE t IS NULL)
            AND EXISTS (SELECT 1 FROM commit_)
            AND f.t > (SELECT max(t) FROM commit_)`,
      ).map((r) => r.id as string),
    );
    const seenText = new Set<string>();
    for (const f of facts) {
      const id = f.id as string;
      const text = String(f.text ?? '');
      const norm = oneLine(text).toLowerCase();
      refText.set(id, clip(text, 1500));
      if (!norm || seenText.has(norm)) continue;
      seenText.add(norm);
      const rel = relevance(id, text);
      const e = editBySrc.get(id) ?? 0;
      // Worth: how tied to the change, times how much it says on its own.
      const info = 0.35 + 0.65 * Math.min(1, Number(f.words) / 12);
      let v: number;
      if (f.noise || (Number(f.words) < 4 && !f.pushback)) continue;
      if (f.kind === 'prompt')
        v = (goals.has(id) ? 40 : 2 + 14 * rel) * info + (f.pushback ? 2 : 0);
      else v = (1.5 + 10 * rel) * info + (f.approved ? 1.5 : 0);
      if (e === 0 && rel < 0.15) v *= 0.4;
      if (f.band !== 'included') v *= 0.3;
      if (afterHead.has(id)) v *= 0.25;
      const labels = [
        f.kind === 'decision' ? 'decision' : '',
        f.kind === 'plan'
          ? f.approved === 1
            ? 'plan, approved'
            : f.approved === 0
              ? 'plan, sent back'
              : 'plan'
          : '',
        firstAsk.has(id) ? 'opening request' : '',
        f.pushback ? 'pushback' : '',
        f.band !== 'included' ? 'ambiguous session: confirm before describing' : '',
        afterHead.has(id) ? 'after the last commit' : '',
        multiSession && firstAsk.has(id) ? `session ${f.sord}` : '',
      ].filter(Boolean);
      const targets = targetsOf(id);
      // Markdown emphasis and heading marks cost characters and say nothing.
      const plain = text.replace(/^\s*#{1,6}\s+/gm, '').replace(/\*\*|__/g, '');
      const render = (len: number) => (chosen: Set<string>) => {
        const to = refsTo(targets, chosen, 3);
        const body = safe(bestSentences(plain, centroid, len));
        return `[${id}]${labels.length ? ` (${labels.join('; ')})` : ''} ${body}${to.length ? ` → ${to.join(' ')}` : ''}`;
      };
      const base = f.kind === 'prompt' ? (goals.has(id) ? 360 : 200) : 180;
      items.push({
        key: `fact:${id}`,
        section: 'requests',
        order: [Number(f.sord), Number(f.seq)],
        value: v,
        group: `session:${f.session_ref}`,
        decay: 0.9,
        render: render(base),
        expand: render(base * 2.2),
      });
    }

    // ---- Commits and their sentences --------------------------------------
    const commits = rows(db, 'SELECT * FROM commit_ ORDER BY ord');
    const chunksOfCommit = new Map<string, string[]>();
    for (const r of rows(
      db,
      `SELECT src, chunk_id FROM link WHERE kind = 'commit' ORDER BY src, weight DESC, chunk_id`,
    ))
      chunksOfCommit.set(r.src, [...(chunksOfCommit.get(r.src) ?? []), r.chunk_id]);
    for (const k of commits) {
      const cid = `commit:${k.ref}`;
      const own = chunksOfCommit.get(cid) ?? [];
      refText.set(cid, clip(`${k.subject}\n${k.body ?? ''}`, 1500));
      const fileIds = [...new Set(own.map((c) => fileOf.get(c)!))];
      const render = (n: number) => (chosen: Set<string>) => {
        const vis = fileIds.filter((f) => chosen.has(`file:${f}`));
        const more = fileIds.length - Math.min(n, vis.length);
        return `[${cid}] ${safe(clip(k.subject, 120))}${vis.length ? ` → ${vis.slice(0, n).join(' ')}${more > 0 ? ` +${plural(more, 'file')}` : ''}` : fileIds.length ? ` (${plural(fileIds.length, 'file')})` : ''}`;
      };
      items.push({
        key: `commit:${k.ref}`,
        section: 'commits',
        order: [Number(k.ord)],
        value: 8 + Math.min(2, Math.log2(1 + own.length) / 3),
        render: render(3),
        expand: render(6),
      });
      for (const s of rows(db, 'SELECT * FROM commit_sentence WHERE sha = ? ORDER BY n', [
        k.sha,
      ])) {
        const sid = s.id as string;
        refText.set(sid, String(s.text));
        const targets = targetsOf(sid);
        const words = String(s.text).split(/\s+/).length;
        const linkW = Math.max(0, ...(searchBySrc.get(sid) ?? [0]));
        let v = 6 + 3 * Math.min(1, linkW);
        if (Number(s.n) === 1) v *= 1.3;
        if (s.result) v *= 0.3;
        if (words < 6) v *= 0.3;
        if (/:\s*$/.test(String(s.text))) v *= 0.4;
        // "It now applies to whoever drafts.": a fragment that leans on the sentence before.
        if (/^(it|this|that|they|these|those|then)\b/i.test(String(s.text)) && words < 10)
          v *= 0.6;
        const render = (len: number) => (chosen: Set<string>) => {
          const to = refsTo(targets, chosen, 2);
          return `  [${sid}] ${safe(clip(String(s.text), len))}${s.result ? ' (a result the message reports, not a recorded run)' : ''}${to.length ? ` → ${to.join(' ')}` : ''}`;
        };
        items.push({
          key: `sent:${sid}`,
          section: 'commits',
          order: [Number(k.ord), Number(s.n)],
          value: v,
          parent: `commit:${k.ref}`,
          group: `commit:${k.ref}`,
          decay: 0.85,
          render: render(170),
          expand: render(400),
        });
      }
    }

    // ---- Where to start ---------------------------------------------------
    const centrality = rows(
      db,
      `SELECT f.id, f.path, f.added + f.removed AS size,
              count(DISTINCT f2.id) AS users,
              group_concat(DISTINCT s.name) AS names
         FROM symbol s
         JOIN chunk c ON c.id = s.chunk_id
         JOIN file f ON f.id = c.file_id AND f.role = 'behavior'
         JOIN ident i ON i.name = s.name
         JOIN chunk c2 ON c2.id = i.chunk_id
         JOIN file f2 ON f2.id = c2.file_id AND f2.id != f.id
        WHERE s.role = 'defined'
          AND (length(s.name) >= 8 OR s.name GLOB '*[A-Z_]*' AND length(s.name) >= 4)
        GROUP BY f.id
        ORDER BY users DESC, size DESC, f.ord`,
    );
    const behavior = files.filter((f) => f.role === 'behavior' && !f.binary);
    const largest = [...files].sort(
      (a, b) =>
        Number(b.added) + Number(b.removed) - (Number(a.added) + Number(a.removed)),
    )[0]?.id;
    const startRank = new Map<string, number>();
    for (const f of behavior) {
      const c = centrality.find((r) => r.id === f.id);
      const goalLink = [...goals].reduce(
        (n, g) => n + (targetsOf(g).some((h) => fileOf.get(h) === f.id) ? 1 : 0),
        0,
      );
      startRank.set(
        f.id,
        (c ? Number(c.users) * 2 : 0) + goalLink * 1.5 + (fileValue.get(f.id) ?? 0) * 0.3,
      );
    }
    const startOrder = [...startRank]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
    if (startOrder.length > 1 && startOrder[0] === largest)
      startOrder.push(startOrder.shift()!); // never the largest file first
    if (startOrder.length) {
      items.push({
        key: 'start',
        section: 'start',
        order: [0],
        value: 100,
        must: true,
        render: () => {
          const parts = startOrder.slice(0, 2).map((id) => {
            const f = files.find((x) => x.id === id)!;
            const c = centrality.find((r) => r.id === id);
            const names = c
              ? String(c.names)
                  .split(',')
                  .filter((n) => fresh.has(n))
                  .slice(0, 3)
              : [];
            const why =
              c && Number(c.users)
                ? `defines ${names.length ? names.join(', ') : 'names'} used by ${plural(Number(c.users), 'other changed file')}`
                : fileWhat.get(id);
            return `[${id}] ${f.path}${why ? ` (${why})` : ''}`;
          });
          return `${parts[0]}${parts[1] ? `; then ${parts[1]}` : ''}.`;
        },
      });
    }

    const packed = pack(LEGEND, items, budgetChars);
    const text = packed.text;

    // ---- Refs: exactly the ids that appear in the text --------------------
    const refs: ContextRef[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(
      /(?<![\w:])(commit:[0-9a-f]{12}(?:#\d+)?|[SDPRVFH]\d+)(?![\w#])/g,
    )) {
      const id = m[1]!;
      if (seen.has(id) || !refText.has(id)) continue;
      seen.add(id);
      refs.push({ id, text: refText.get(id)! });
    }
    const t1 = performance.now();
    return {
      text,
      refs,
      tokens: Math.ceil(text.length / 4),
      stats: {
        budgetTokens: opts.budgetTokens,
        ms: { retrieve: Math.round(tRetrieve - t0), total: Math.round(t1 - t0) },
        tables: {
          sessions: count(db, 'session'),
          facts: count(db, 'fact'),
          runs: count(db, 'run'),
          edits: count(db, 'edit'),
          editLines: count(db, 'edit_line'),
          files: count(db, 'file'),
          chunks: count(db, 'chunk'),
          chunkLines: count(db, 'chunk_line'),
          commits: count(db, 'commit_'),
          commitSentences: count(db, 'commit_sentence'),
          commitLines: count(db, 'commit_line'),
        },
        retrieval: {
          ...rstats,
          rrfK: RRF_K,
          topK: TOP_K,
          vecAlone: VEC_ALONE,
          model: embeddingModel()?.name ?? null,
          modelError: embeddingModel() ? undefined : embeddingError(),
        },
        packed: {
          candidates: items.length,
          chosen: packed.chosen.size,
          expanded: packed.expanded.size,
          chars: text.length,
          budgetChars,
        },
      },
    };

    function visibleSource(chosen: Set<string>, src: string): boolean {
      return chosen.has(`fact:${src}`) || chosen.has(`sent:${src}`) || chosen.has(src);
    }
  } finally {
    db.close();
  }
}

export type { Reason };
