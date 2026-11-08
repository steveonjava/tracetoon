/**
 * The relational store: record tables with keys and foreign keys, loaded from
 * `GraphInputs` (ETL). Everything later steps read is a SQL query over these
 * tables; nothing reads the inputs again.
 *
 *   session ─< fact (prompt | decision | plan) ─< edit ─< edit_line
 *          └─< run                       turn_id ┘
 *   file ─< chunk ─< chunk_line, symbol, ident        chunk_fts (FTS5, BM25)
 *   commit_ ─< commit_sentence, commit_file, commit_line
 *   query ─< hit (bm25 | vec | mention) → link (edit | commit | search)
 *
 * Joins on stored keys: an edit's lines meet chunk lines on (file, norm); a
 * commit's lines meet them on (path, norm); a prompt owns the edits of its turn
 * (turn_id); commits and prompts meet on time.
 */
import type { GraphInputs } from './index.ts';
import { chunkFile, normLine, parsePatch, type Chunk, type DiffFile } from './diff.ts';
import { commitSentences, identWords, oneLine, RESULT_CLAIM } from './text.ts';
import { openDb } from './sqlite.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Db = any;

export const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE session (
  ref TEXT PRIMARY KEY, ord INTEGER NOT NULL, agent TEXT, title TEXT,
  band TEXT NOT NULL, t_start TEXT, t_end TEXT);
CREATE TABLE fact (
  id TEXT PRIMARY KEY,
  session_ref TEXT NOT NULL REFERENCES session(ref),
  kind TEXT NOT NULL CHECK (kind IN ('prompt','decision','plan')),
  seq INTEGER NOT NULL, t TEXT, text TEXT NOT NULL,
  pushback INTEGER NOT NULL DEFAULT 0, led_to_edits INTEGER NOT NULL DEFAULT 0,
  approved INTEGER,
  turn_id TEXT REFERENCES fact(id),
  words INTEGER NOT NULL,
  noise INTEGER NOT NULL DEFAULT 0);
CREATE TABLE run (
  id TEXT PRIMARY KEY, session_ref TEXT REFERENCES session(ref), seq INTEGER,
  t TEXT, cmd TEXT NOT NULL, kind TEXT, outcome TEXT, revision TEXT, summary TEXT,
  receipt INTEGER NOT NULL DEFAULT 0, turn_id TEXT REFERENCES fact(id));
CREATE TABLE edit (
  id INTEGER PRIMARY KEY, session_ref TEXT NOT NULL REFERENCES session(ref),
  seq INTEGER NOT NULL, t TEXT, file TEXT NOT NULL, in_pr INTEGER NOT NULL,
  added INTEGER, removed INTEGER, via TEXT,
  turn_id TEXT REFERENCES fact(id), step_id TEXT REFERENCES fact(id));
CREATE TABLE edit_line (edit_id INTEGER NOT NULL REFERENCES edit(id), norm TEXT NOT NULL);
CREATE TABLE file (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, old_path TEXT, ord INTEGER NOT NULL,
  status TEXT NOT NULL, binary INTEGER NOT NULL, role TEXT NOT NULL,
  added INTEGER NOT NULL, removed INTEGER NOT NULL);
CREATE TABLE chunk (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES file(id), ord INTEGER NOT NULL,
  hunk INTEGER NOT NULL, start INTEGER, end_ INTEGER, added INTEGER, removed INTEGER,
  scope TEXT, defined TEXT NOT NULL, removed_defs TEXT NOT NULL, tests TEXT NOT NULL,
  body TEXT NOT NULL);
CREATE TABLE chunk_line (
  chunk_id TEXT NOT NULL REFERENCES chunk(id), n INTEGER NOT NULL, sign TEXT NOT NULL,
  line_no INTEGER, text TEXT NOT NULL, norm TEXT);
CREATE TABLE symbol (
  name TEXT NOT NULL, chunk_id TEXT NOT NULL REFERENCES chunk(id),
  role TEXT NOT NULL CHECK (role IN ('defined','removed','test')));
CREATE TABLE ident (chunk_id TEXT NOT NULL REFERENCES chunk(id), name TEXT NOT NULL);
CREATE TABLE commit_ (
  sha TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, ord INTEGER NOT NULL, t TEXT,
  subject TEXT NOT NULL, body TEXT);
CREATE TABLE commit_sentence (
  id TEXT PRIMARY KEY, sha TEXT NOT NULL REFERENCES commit_(sha), n INTEGER NOT NULL,
  text TEXT NOT NULL, result INTEGER NOT NULL);
CREATE TABLE commit_file (sha TEXT NOT NULL REFERENCES commit_(sha), path TEXT NOT NULL);
CREATE TABLE commit_line (
  sha TEXT NOT NULL REFERENCES commit_(sha), path TEXT NOT NULL, norm TEXT NOT NULL,
  removed INTEGER NOT NULL);
CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, body, tokenize = 'porter unicode61');
CREATE TABLE query (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  scope_sha TEXT REFERENCES commit_(sha));
CREATE TABLE hit (
  query_id INTEGER NOT NULL REFERENCES query(id), chunk_id TEXT NOT NULL REFERENCES chunk(id),
  ranker TEXT NOT NULL CHECK (ranker IN ('bm25','vec','mention')), rank INTEGER NOT NULL,
  score REAL NOT NULL);
CREATE TABLE link (
  src TEXT NOT NULL, chunk_id TEXT NOT NULL REFERENCES chunk(id),
  kind TEXT NOT NULL CHECK (kind IN ('edit','commit','search')), weight REAL NOT NULL);
CREATE INDEX edit_turn ON edit(turn_id);
CREATE INDEX edit_line_norm ON edit_line(norm);
CREATE INDEX edit_line_edit ON edit_line(edit_id);
CREATE INDEX chunk_file ON chunk(file_id);
CREATE INDEX chunk_line_norm ON chunk_line(norm);
CREATE INDEX chunk_line_chunk ON chunk_line(chunk_id);
CREATE INDEX symbol_name ON symbol(name);
CREATE INDEX ident_name ON ident(name);
CREATE INDEX commit_line_norm ON commit_line(norm);
CREATE INDEX hit_query ON hit(query_id);
CREATE INDEX link_chunk ON link(chunk_id);
CREATE INDEX link_src ON link(src);
`;

export interface Loaded {
  db: Db;
  files: DiffFile[];
  chunks: Chunk[];
  /** Short (12-char) commit ref → full sha as the digest gives it. */
  commitRefs: Map<string, string>;
}

/** Insert many rows with one prepared statement. */
export function insertAll(db: Db, sql: string, rows: unknown[][]): void {
  if (!rows.length) return;
  const st = db.prepare(sql);
  try {
    for (const r of rows) st.bind(r).stepReset();
  } finally {
    st.finalize();
  }
}

const wordCount = (t: string) => (t.trim().match(/\S+/g) ?? []).length;

/**
 * Text typed into the prompt box that isn't a request: pasted tool output,
 * slash-command wrappers, interruption markers.
 */
export const isNoise = (t: string) =>
  /^\s*(<(bash|command|local-command|task-notification|system|user-prompt)[\w-]*>|\[Request interrupted|Caveat:)/i.test(
    t,
  );

/** Identifiers used on a chunk's added lines (for symbol-use joins). */
function identsOf(c: Chunk): string[] {
  const out = new Set<string>();
  for (const l of c.lines)
    if (l.sign === '+')
      for (const m of l.text.matchAll(/[A-Za-z_$][\w$]{3,}/g)) out.add(m[0]);
  return [...out];
}

/** The text a chunk is searched and embedded by: path, scope, names, then its changed lines. */
export function chunkBody(c: Chunk, maxChars = 2400): string {
  const head = [c.file, c.scope, ...c.defined, ...c.tests].filter(Boolean).join(' ');
  const body = c.lines
    .map((l) => `${l.sign}${l.text.trim().slice(0, 200)}`)
    .join('\n')
    .slice(0, maxChars);
  return `${head}\n${body}`;
}

export function loadStore(inputs: GraphInputs): Loaded {
  const db = openDb();
  db.exec(SCHEMA);
  const { full, trails } = inputs;
  db.exec('BEGIN');

  // Sessions and their facts.
  const sessions = full.sessions;
  insertAll(
    db,
    'INSERT INTO session VALUES (?,?,?,?,?,?,?)',
    sessions.map((s, i) => [
      s.ref,
      i + 1,
      s.agent,
      s.title ?? null,
      s.band,
      s.span.start ?? null,
      s.span.end ?? null,
    ]),
  );
  const factRows: unknown[][] = [];
  const runRows: unknown[][] = [];
  const editRows: unknown[][] = [];
  const editLineRows: unknown[][] = [];
  const seenFact = new Set<string>();
  const known = new Set(sessions.map((s) => s.ref));
  let editId = 0;
  for (const trail of trails) {
    if (!known.has(trail.ref)) continue;
    let turn: string | undefined;
    let step: string | undefined;
    trail.events.forEach((e, seq) => {
      if (e.kind === 'edit') {
        editId++;
        editRows.push([
          editId,
          trail.ref,
          seq,
          e.t ?? null,
          e.file,
          e.inPr ? 1 : 0,
          e.added,
          e.removed,
          e.via ?? null,
          turn ?? null,
          step ?? null,
        ]);
        for (const l of new Set(e.lines)) editLineRows.push([editId, l]);
        return;
      }
      const id = e.fact.id;
      if (!id) return;
      if (e.kind === 'run') {
        if (!seenFact.has(id))
          runRows.push([
            id,
            trail.ref,
            seq,
            e.fact.t ?? null,
            e.fact.cmd,
            e.fact.kind,
            e.fact.outcome,
            e.fact.revision,
            e.fact.summary.join('; '),
            0,
            turn ?? null,
          ]);
        seenFact.add(id);
        return;
      }
      if (e.kind === 'prompt') {
        turn = id;
        step = undefined;
      } else step = id;
      if (seenFact.has(id)) return;
      seenFact.add(id);
      const f = e.fact as {
        t?: string;
        text?: string;
        excerpt?: string;
        pushback?: boolean;
        ledToEdits?: boolean;
        approved?: boolean;
        questions?: { question: string; options: string[]; answer?: string }[];
      };
      const text =
        e.kind === 'plan'
          ? (f.excerpt ?? '')
          : e.kind === 'decision' && f.questions?.length
            ? f.questions
                .map((q) => `${q.question} → ${q.answer ?? '(no answer)'}`)
                .join(' / ')
            : (f.text ?? '');
      factRows.push([
        id,
        trail.ref,
        e.kind,
        seq,
        f.t ?? null,
        text,
        f.pushback ? 1 : 0,
        f.ledToEdits ? 1 : 0,
        f.approved === undefined ? null : f.approved ? 1 : 0,
        e.kind === 'prompt' ? null : (turn ?? null),
        wordCount(text),
        isNoise(text) ? 1 : 0,
      ]);
    });
  }
  // Facts in the digest that no trail carried (keeps every S/D/P id resolvable).
  sessions.forEach((s) => {
    const add = (
      id: string | undefined,
      kind: string,
      t: string | undefined,
      text: string,
      extra: Partial<{ pushback: boolean; led: boolean; approved: boolean }> = {},
    ) => {
      if (!id || seenFact.has(id)) return;
      seenFact.add(id);
      factRows.push([
        id,
        s.ref,
        kind,
        100000 + factRows.length,
        t ?? null,
        text,
        extra.pushback ? 1 : 0,
        extra.led ? 1 : 0,
        extra.approved === undefined ? null : extra.approved ? 1 : 0,
        null,
        wordCount(text),
        isNoise(text) ? 1 : 0,
      ]);
    };
    for (const p of s.prompts)
      add(p.id, 'prompt', p.t, p.text, { pushback: p.pushback, led: p.ledToEdits });
    for (const d of s.decisions) add(d.id, 'decision', d.t, d.text);
    for (const p of s.plans) add(p.id, 'plan', p.t, p.excerpt, { approved: p.approved });
    for (const r of s.runs)
      if (r.id && !seenFact.has(r.id)) {
        seenFact.add(r.id);
        runRows.push([
          r.id,
          s.ref,
          null,
          r.t ?? null,
          r.cmd,
          r.kind,
          r.outcome,
          r.revision,
          r.summary.join('; '),
          0,
          null,
        ]);
      }
  });
  (full.verification ?? []).forEach((r) => {
    if (r.id && !seenFact.has(r.id))
      runRows.push([
        r.id,
        null,
        null,
        r.t ?? null,
        r.cmd,
        r.kind,
        r.outcome,
        r.revision,
        r.summary.join('; '),
        1,
        null,
      ]);
  });
  // Prompts first so turn_id foreign keys resolve.
  factRows.sort((a, b) => Number(a[2] !== 'prompt') - Number(b[2] !== 'prompt'));
  insertAll(db, 'INSERT INTO fact VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', factRows);
  insertAll(db, 'INSERT INTO run VALUES (?,?,?,?,?,?,?,?,?,?,?)', runRows);
  insertAll(db, 'INSERT INTO edit VALUES (?,?,?,?,?,?,?,?,?,?,?)', editRows);
  insertAll(db, 'INSERT INTO edit_line VALUES (?,?)', editLineRows);

  // The diff: files, chunks, lines, symbols, identifiers, full-text index.
  const files = parsePatch(inputs.patch);
  const chunks: Chunk[] = [];
  insertAll(
    db,
    'INSERT INTO file VALUES (?,?,?,?,?,?,?,?,?)',
    files.map((f, i) => [
      `F${i + 1}`,
      f.path,
      f.oldPath ?? null,
      i,
      f.status,
      f.binary ? 1 : 0,
      f.role,
      f.added,
      f.removed,
    ]),
  );
  files.forEach((f, i) => {
    for (const c of chunkFile(f)) {
      c.id = `H${chunks.length + 1}`;
      chunks.push(c);
      (c as Chunk & { fileId: string }).fileId = `F${i + 1}`;
    }
  });
  const chunkRows: unknown[][] = [];
  const lineRows: unknown[][] = [];
  const symRows: unknown[][] = [];
  const identRows: unknown[][] = [];
  const ftsRows: unknown[][] = [];
  chunks.forEach((c, i) => {
    const body = chunkBody(c);
    chunkRows.push([
      c.id,
      (c as Chunk & { fileId: string }).fileId,
      i,
      c.hunk,
      c.start,
      c.end,
      c.added,
      c.removed,
      c.scope ?? null,
      JSON.stringify(c.defined),
      JSON.stringify(c.removedDefs),
      JSON.stringify(c.tests),
      body,
    ]);
    c.lines.forEach((l, n) =>
      lineRows.push([
        c.id,
        n,
        l.sign,
        l.sign === '-' ? (l.oldNo ?? null) : (l.newNo ?? null),
        l.text,
        normLine(l.text) ?? null,
      ]),
    );
    for (const d of c.defined) symRows.push([d, c.id, 'defined']);
    for (const d of c.removedDefs) symRows.push([d, c.id, 'removed']);
    for (const t of c.tests) symRows.push([t, c.id, 'test']);
    for (const n of identsOf(c)) identRows.push([c.id, n]);
    // Identifiers split into words too, so "survival links" finds survivalLinks.
    ftsRows.push([c.id, `${body}\n${identWords(body).join(' ')}`]);
  });
  insertAll(db, 'INSERT INTO chunk VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', chunkRows);
  insertAll(db, 'INSERT INTO chunk_line VALUES (?,?,?,?,?,?)', lineRows);
  insertAll(db, 'INSERT INTO symbol VALUES (?,?,?)', symRows);
  insertAll(db, 'INSERT INTO ident VALUES (?,?)', identRows);
  insertAll(db, 'INSERT INTO chunk_fts (chunk_id, body) VALUES (?,?)', ftsRows);

  // Commits: subject, body sentences, files and own lines.
  const commitRefs = new Map<string, string>();
  const commits = full.pr.commits;
  const byPrefix = <T>(m: Map<string, T> | undefined, sha: string): T | undefined => {
    if (!m) return undefined;
    const direct = m.get(sha);
    if (direct) return direct;
    for (const [k, v] of m) if (k.startsWith(sha) || sha.startsWith(k)) return v;
    return undefined;
  };
  const commitRows: unknown[][] = [];
  const sentRows: unknown[][] = [];
  const cfRows: unknown[][] = [];
  const clRows: unknown[][] = [];
  commits.forEach((c, i) => {
    const ref = c.sha.slice(0, 12);
    if (commitRefs.has(ref)) return;
    commitRefs.set(ref, c.sha);
    commitRows.push([c.sha, ref, i, c.time ?? null, oneLine(c.subject), c.body ?? null]);
    commitSentences(c.body ?? '').forEach((text, n) =>
      sentRows.push([
        `commit:${ref}#${n + 1}`,
        c.sha,
        n + 1,
        text,
        RESULT_CLAIM.test(text) ? 1 : 0,
      ]),
    );
    for (const p of byPrefix(inputs.commitFiles, c.sha) ?? []) cfRows.push([c.sha, p]);
    for (const [p, lines] of byPrefix(inputs.commitLines, c.sha) ?? new Map())
      for (const l of new Set(lines as string[])) {
        // "-x" is a removed line, unless it is an added line that starts with "-"
        // (a Markdown bullet, a flag): normalized lines never start with a space,
        // so "- item" is added; other "-…" lines are kept both ways.
        const removed = l.startsWith('-') && l[1] !== ' ';
        clRows.push([c.sha, p, removed ? l.slice(1) : l, removed ? 1 : 0]);
        if (removed) clRows.push([c.sha, p, l, 0]);
      }
  });
  insertAll(db, 'INSERT INTO commit_ VALUES (?,?,?,?,?,?)', commitRows);
  insertAll(db, 'INSERT INTO commit_sentence VALUES (?,?,?,?,?)', sentRows);
  insertAll(db, 'INSERT INTO commit_file VALUES (?,?)', cfRows);
  insertAll(db, 'INSERT INTO commit_line VALUES (?,?,?,?)', clRows);
  db.exec('COMMIT');
  return { db, files, chunks, commitRefs };
}

/** Rows as objects. */
export const rows = <T = Record<string, any>>(
  db: Db,
  sql: string,
  bind?: unknown[],
): T[] => db.selectObjects(sql, bind) as T[];

export const count = (db: Db, table: string): number =>
  Number(db.selectValue(`SELECT count(*) FROM ${table}`));
