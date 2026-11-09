/**
 * The evidence graph as SQLite tables: one typed table per node label and one
 * link table per relationship. Loaded from the same `EvidenceGraph` the graph
 * engine loads, so both arms answer from identical evidence.
 *
 * Lists are stored as JSON text (read them with json_each) and booleans as 0/1.
 * Row order (rowid) is the graph's node and relationship order.
 */
import { GraphError } from '../graph/db.ts';
import type { EvidenceGraph, NodeLabel, RelType, Value } from '../graph/model.ts';

interface Exec {
  exec(sql: string): void;
  prepare(sql: string): { all(params?: Record<string, unknown>): unknown[] };
}

/** Table and columns per node label. Columns are the props `buildEvidenceGraph` writes. */
export const NODE_TABLES: Record<
  NodeLabel,
  { table: string; columns: string[]; ownKinds?: true }
> = {
  Session: {
    table: 'sessions',
    columns: ['agent', 'band', 'score', 'title', 'failedCommands', 'failedCommand'],
  },
  Prompt: {
    table: 'prompts',
    columns: ['t', 'text', 'pushback', 'ledToEdits', 'session'],
  },
  Decision: {
    table: 'decisions',
    columns: ['t', 'text', 'answers', 'truncated', 'session'],
  },
  Plan: { table: 'plans', columns: ['t', 'approved', 'text', 'excerpt', 'session'] },
  Run: {
    table: 'runs',
    columns: ['t', 'cmd', 'kind', 'outcome', 'revision', 'summary', 'when', 'session'],
  },
  Receipt: { table: 'receipts', columns: ['cmd', 'kind', 'outcome', 'summary', 'when'] },
  Edit: {
    table: 'edits',
    columns: ['t', 'file', 'added', 'removed', 'surviving', 'inPr', 'via', 'session'],
  },
  File: { table: 'files', columns: ['role', 'inPr', 'added', 'removed', 'unmatched'] },
  Hunk: {
    table: 'hunks',
    columns: [
      'file',
      'start',
      'end',
      'added',
      'removed',
      'diff',
      'context',
      'scope',
      'symbols',
      'touched',
      'branches',
      'fresh',
      'pairs',
      'dropped',
      'conds',
      'tests',
      'words',
      'code',
    ],
  },
  Commit: { table: 'commits', columns: ['subject', 'body', 't'] },
  CommitClaim: { table: 'commit_claims', columns: ['commit', 'text', 'assertsResult'] },
  // Its files (a count) and fresh (a flag) share names with Change.files and
  // Hunk.fresh (lists), so its column kinds stay out of the shared decode map;
  // the headScan query names them itself.
  HeadRef: {
    table: 'head_refs',
    columns: [
      'kind',
      'term',
      'termKind',
      'hunk',
      'refs',
      'count',
      'files',
      'fresh',
      'definedIn',
    ],
    ownKinds: true,
  },
  Change: {
    table: 'changes',
    columns: ['key', 'files', 'roles', 'symbols', 'added', 'removed', 'branches'],
  },
};

/**
 * Link table per relationship: `from`/`to` name its id columns; `kind` keeps the
 * source label where several labels share one relationship.
 */
export const REL_TABLES: Record<
  RelType,
  { table: string; from: string; to: string; kind?: true; props?: string[] }
> = {
  IN_SESSION: { table: 'in_session', from: 'id', to: 'session', kind: true },
  IN_TURN: { table: 'in_turn', from: 'id', to: 'prompt', kind: true },
  NEXT: { table: 'prompt_next', from: 'prompt', to: 'next' },
  EDITS: { table: 'edit_file', from: 'edit', to: 'file' },
  SURVIVES_IN: { table: 'edit_hunk', from: 'edit', to: 'hunk', props: ['lines'] },
  OF: { table: 'hunk_file', from: 'hunk', to: 'file' },
  LATER_EDIT: { table: 'run_later_edit', from: 'run', to: 'file' },
  MADE: { table: 'session_commit', from: 'session', to: 'commit' },
  TOUCHES: { table: 'commit_file', from: 'commit', to: 'file' },
  INTRODUCED: { table: 'commit_hunk', from: 'commit', to: 'hunk', props: ['lines'] },
  SAYS: { table: 'commit_claim', from: 'commit', to: 'claim' },
  ASKED_BEFORE: { table: 'prompt_commit', from: 'prompt', to: 'commit' },
  HAS: { table: 'change_hunk', from: 'change', to: 'hunk' },
  ASKED_BY: { table: 'change_prompt', from: 'change', to: 'prompt', props: ['how'] },
  EXPLAINED_BY: { table: 'change_commit', from: 'change', to: 'commit' },
};

/** Column name → how to decode it on the way out (lists and booleans). */
export type ColumnKinds = Record<string, 'array' | 'bool'>;

export const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Views over the polymorphic links, so queries read like the schema doc. */
const VIEWS = `
CREATE VIEW facts AS
  SELECT 'Decision' AS kind, d.id, t, text, NULL AS approved, NULL AS excerpt, answers, truncated,
         session, d.rowid AS seq, n.n
  FROM decisions d JOIN node_order n ON n.label = 'Decision' AND n.id = d.id
  UNION ALL
  SELECT 'Plan', p.id, t, text, approved, excerpt, NULL, NULL, session, p.rowid, n.n
  FROM plans p JOIN node_order n ON n.label = 'Plan' AND n.id = p.id;
CREATE VIEW turn_facts AS
  SELECT it.kind, it.id, it.prompt FROM in_turn it WHERE it.kind IN ('Decision', 'Plan');
`;

export function schemaSql(): string {
  const out: string[] = [];
  for (const { table, columns } of Object.values(NODE_TABLES))
    out.push(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, ${columns.map(q).join(', ')});`,
    );
  for (const r of Object.values(REL_TABLES)) {
    const cols = [...(r.kind ? ['kind'] : []), r.from, r.to, ...(r.props ?? [])];
    out.push(`CREATE TABLE ${r.table} (${cols.map(q).join(', ')});`);
    out.push(`CREATE INDEX ${r.table}_from ON ${r.table} (${q(r.from)});`);
    out.push(`CREATE INDEX ${r.table}_to ON ${r.table} (${q(r.to)});`);
  }
  for (const [table, col] of [
    ['edits', 'file'],
    ['edits', 'session'],
    ['hunks', 'file'],
    ['runs', 'session'],
    ['prompts', 'session'],
    ['commit_claims', 'commit'],
  ] as const)
    out.push(`CREATE INDEX ${table}_${col} ON ${table} (${q(col)});`);
  out.push('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  // Graph node order across labels, as cypherlite scans a multi-label MATCH.
  out.push(
    'CREATE TABLE node_order (label TEXT, id TEXT, n INTEGER, PRIMARY KEY (label, id));',
  );
  return out.join('\n') + VIEWS;
}

const cell = (v: Value | undefined): unknown =>
  v === undefined || v === null
    ? null
    : typeof v === 'boolean'
      ? Number(v)
      : Array.isArray(v)
        ? JSON.stringify(v)
        : v;

/** Create the schema and insert the graph in one transaction; returns the column kinds. */
export function loadEvidence(db: Exec, graph: EvidenceGraph): ColumnKinds {
  const kinds: ColumnKinds = {};
  const mixed = new Set<string>();
  const note = (col: string, v: Value | undefined) => {
    const k = Array.isArray(v) ? 'array' : typeof v === 'boolean' ? 'bool' : undefined;
    if (!k || mixed.has(col)) return;
    if (kinds[col] && kinds[col] !== k) {
      delete kinds[col];
      mixed.add(col);
    } else kinds[col] = k;
  };
  db.exec('BEGIN');
  try {
    db.exec(schemaSql());
    const inserts = new Map<string, ReturnType<Exec['prepare']>>();
    const insert = (table: string, cols: string[], values: unknown[]) => {
      const key = `${table}|${cols.join(',')}`;
      let s = inserts.get(key);
      if (!s) {
        s = db.prepare(
          `INSERT OR IGNORE INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map((_, i) => `$p${i}`).join(', ')})`,
        );
        inserts.set(key, s);
      }
      s.all(Object.fromEntries(values.map((v, i) => [`p${i}`, v])));
    };
    let order = 0;
    for (const n of graph.nodes) {
      const spec = NODE_TABLES[n.label];
      if (!spec) throw new GraphError(`Bad label ${n.label}`);
      const unknown = Object.keys(n.props).filter((k) => !spec.columns.includes(k));
      if (unknown.length)
        throw new GraphError(
          `${n.label} has properties the SQLite schema lacks: ${unknown.join(', ')}`,
        );
      if (!spec.ownKinds) for (const c of spec.columns) note(c, n.props[c]);
      insert('node_order', ['label', 'id', 'n'], [n.label, n.id, order++]);
      insert(
        spec.table,
        ['id', ...spec.columns],
        [n.id, ...spec.columns.map((c) => cell(n.props[c]))],
      );
    }
    for (const r of graph.rels) {
      const spec = REL_TABLES[r.type];
      if (!spec) throw new GraphError(`Bad relationship ${r.type}`);
      const cols = [
        ...(spec.kind ? ['kind'] : []),
        spec.from,
        spec.to,
        ...(spec.props ?? []),
      ];
      for (const p of spec.props ?? []) note(p, r.props?.[p]);
      insert(spec.table, cols, [
        ...(spec.kind ? [r.from.label] : []),
        r.from.id,
        r.to.id,
        ...(spec.props ?? []).map((p) => cell(r.props?.[p])),
      ]);
    }
    insert('meta', ['key', 'value'], ['schema', graph.schema]);
    insert('meta', ['key', 'value'], ['kinds', JSON.stringify(kinds)]);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return kinds;
}
