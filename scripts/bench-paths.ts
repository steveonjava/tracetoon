// The path questions a PR workflow asks, cypherlite vs SQLite (both WebAssembly).
//
//   bun run scripts/bench-paths.ts --out <dir> [--pairs 200] [--timeout 300] <graph.json|dir>...
//
// Each question is asked one pair at a time, the way an agent's tool call would:
//   Q1  how did this request lead to this hunk?      Prompt -> Hunk
//   Q2  which request is behind this commit?          Commit -> Prompt
//   Q3  how are these two changed files connected?   File -> File
// in two variants: "path" returns the shortest path itself (what a "why" answer
// needs); "len" returns only its length, where SQL gets its best form (a
// breadth-first search that de-duplicates as it goes). Pairs are a fixed-seed
// sample. Every (engine, graph, question, variant) cell runs in its own process;
// the orchestrator checks the engines agree on every length and that every
// returned path is a real, minimal path in the graph.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvidenceGraph, NodeLabel } from '../src/graph/model.ts';

const MAX_DEPTH = 8;
type Question = { id: string; from: NodeLabel; to: NodeLabel };
const QUESTIONS: Question[] = [
  { id: 'Q1-prompt-to-hunk', from: 'Prompt', to: 'Hunk' },
  { id: 'Q2-commit-to-prompt', from: 'Commit', to: 'Prompt' },
  { id: 'Q3-file-to-file', from: 'File', to: 'File' },
];
const VARIANTS = ['path', 'path-bfs', 'len'] as const;
type Variant = (typeof VARIANTS)[number];

/** The same undirected edge table as bench-engines.ts (node key = Label:id). */
const EDGES_SQL = `
CREATE TABLE bench_edges (a TEXT, b TEXT);
INSERT INTO bench_edges
  SELECT kind || ':' || id, 'Session:' || session FROM in_session
  UNION ALL SELECT kind || ':' || id, 'Prompt:' || prompt FROM in_turn
  UNION ALL SELECT 'Prompt:' || prompt, 'Prompt:' || next FROM prompt_next
  UNION ALL SELECT 'Edit:' || edit, 'File:' || file FROM edit_file
  UNION ALL SELECT 'Edit:' || edit, 'Hunk:' || hunk FROM edit_hunk
  UNION ALL SELECT 'Hunk:' || hunk, 'File:' || file FROM hunk_file
  UNION ALL SELECT 'Run:' || run, 'File:' || file FROM run_later_edit
  UNION ALL SELECT 'Session:' || session, 'Commit:' || "commit" FROM session_commit
  UNION ALL SELECT 'Commit:' || "commit", 'File:' || file FROM commit_file
  UNION ALL SELECT 'Commit:' || "commit", 'Hunk:' || hunk FROM commit_hunk
  UNION ALL SELECT 'Commit:' || "commit", 'CommitClaim:' || claim FROM commit_claim
  UNION ALL SELECT 'Prompt:' || prompt, 'Commit:' || "commit" FROM prompt_commit
  UNION ALL SELECT 'Change:' || change, 'Hunk:' || hunk FROM change_hunk
  UNION ALL SELECT 'Change:' || change, 'Prompt:' || prompt FROM change_prompt
  UNION ALL SELECT 'Change:' || change, 'Commit:' || "commit" FROM change_commit;
CREATE TABLE bench_uedges AS SELECT a, b FROM bench_edges UNION ALL SELECT b, a FROM bench_edges;
CREATE INDEX bench_uedges_a ON bench_uedges (a);`;

const cypher = (q: Question, variant: Variant) =>
  `MATCH (a:${q.from} {id: $a}), (b:${q.to} {id: $b}) MATCH p = shortestPath((a)-[*..${MAX_DEPTH}]-(b)) ` +
  (variant !== 'len'
    ? `RETURN [n IN nodes(p) | labels(n)[0] + ':' + n.id] AS path`
    : `RETURN length(p) AS len`);

/**
 * SQL forms. "path": the textbook idiom (carry the path, no revisits), which
 * enumerates simple paths. "path-bfs": SQL's best path form: a breadth-first
 * search that de-duplicates as it goes, then a walk back from the target along
 * nodes one step closer to the source. "len": that search, length only.
 */
const BFS = `WITH RECURSIVE r(node, d) AS (
    SELECT $a, 0
    UNION SELECT e.b, r.d + 1 FROM r JOIN bench_uedges e ON e.a = r.node WHERE r.d < ${MAX_DEPTH})`;
const sql = (variant: Variant) =>
  variant === 'path'
    ? `WITH RECURSIVE r(node, path, d) AS (
         SELECT $a, $a, 0
         UNION ALL
         SELECT e.b, r.path || '|' || e.b, r.d + 1 FROM r JOIN bench_uedges e ON e.a = r.node
         WHERE r.d < ${MAX_DEPTH} AND r.node <> $b AND instr('|' || r.path || '|', '|' || e.b || '|') = 0)
       SELECT path FROM r WHERE node = $b ORDER BY d LIMIT 1`
    : variant === 'path-bfs'
      ? `${BFS},
       dist(node, d) AS (SELECT node, min(d) FROM r GROUP BY node),
       back(node, d, path) AS (
         SELECT node, d, node FROM dist WHERE node = $b AND d > 0
         UNION ALL
         SELECT nxt.node, back.d - 1, nxt.node || '|' || back.path
         FROM back JOIN (SELECT e.a AS from_node, min(e.b) AS node, x.d AS d FROM bench_uedges e
                         JOIN dist x ON x.node = e.b GROUP BY e.a, x.d) nxt
           ON nxt.from_node = back.node AND nxt.d = back.d - 1
         WHERE back.d > 0)
       SELECT path FROM back WHERE d = 0`
      : `${BFS}
       SELECT min(d) AS len FROM r WHERE node = $b`;

/** A fixed-seed sample of (from, to) id pairs for a question. */
function pairs(graph: EvidenceGraph, q: Question, cap: number): [string, string][] {
  const ids = (label: NodeLabel) =>
    graph.nodes
      .filter((n) => n.label === label && (label !== 'File' || n.props.inPr === true))
      .map((n) => n.id);
  const a = ids(q.from);
  const b = ids(q.to);
  const all: [string, string][] = [];
  for (const x of a) for (const y of b) if (x !== y || q.from !== q.to) all.push([x, y]);
  const h = (s: string) => Number(Bun.hash(s) % 1000000007n);
  return all.sort((p, r) => h(p.join('>')) - h(r.join('>'))).slice(0, cap);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : null;
};

async function cell(
  engine: 'graph' | 'sqlite',
  graphFile: string,
  qid: string,
  variant: 'path' | 'len',
  cap: number,
) {
  const { initSqlWasm, SqlEngine } = await import('../src/sql/engine.ts');
  const { GraphEngine, graphWasmMemoryBytes } = await import('../src/graph/engine.ts');
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as EvidenceGraph;
  const q = QUESTIONS.find((x) => x.id === qid)!;
  const ps = pairs(graph, q, cap);
  let run: (a: string, b: string) => unknown;
  let mem: () => number | undefined;
  let close: () => void;
  const t0 = performance.now();
  if (engine === 'sqlite') {
    await initSqlWasm();
    const db = SqlEngine.load(graph);
    const raw = (db as unknown as { db: { exec(s: string): void } }).db;
    raw.exec('PRAGMA query_only = OFF');
    raw.exec(EDGES_SQL);
    raw.exec('PRAGMA query_only = ON');
    const text = sql(variant);
    run = (a, b) => {
      const row = db.sql(text, { a: `${q.from}:${a}`, b: `${q.to}:${b}` }).rows[0];
      return variant !== 'len'
        ? row?.path
          ? String(row.path).split('|')
          : null
        : (row?.len ?? null);
    };
    mem = () => db.memoryBytes();
    close = () => db.close();
  } else {
    const db = GraphEngine.load(graph);
    const text = cypher(q, variant);
    run = (a, b) => {
      const row = db.run(text, { a, b }).rows[0];
      return variant !== 'len'
        ? ((row?.path as string[] | undefined) ?? null)
        : (row?.len ?? null);
    };
    mem = graphWasmMemoryBytes;
    close = () => db.close();
  }
  const loadMs = performance.now() - t0;
  const lat: number[] = [];
  const answers: unknown[] = [];
  for (const [a, b] of ps) {
    const t = performance.now();
    answers.push(run(a, b));
    lat.push(performance.now() - t);
  }
  // Warm: the same pairs again; latency per query.
  const warm: number[] = [];
  for (const [a, b] of ps) {
    const t = performance.now();
    run(a, b);
    warm.push(performance.now() - t);
  }
  const out = {
    engine,
    graph: graphFile,
    nodes: graph.nodes.length,
    rels: graph.rels.length,
    question: qid,
    variant,
    pairs: ps,
    loadMs: Math.round(loadMs * 10) / 10,
    coldP50: pct(lat, 50),
    warmP50: pct(warm, 50),
    warmP95: pct(warm, 95),
    warmMax: pct(warm, 100),
    warmTotal: warm.reduce((x, y) => x + y, 0),
    wasmBytesPeak: mem() ?? null,
    maxRssKB: process.resourceUsage().maxRSS,
    answers,
  };
  close();
  return out;
}

/** Undirected adjacency of the evidence graph, keys Label:id, for checking returned paths. */
function adjacency(graph: EvidenceGraph) {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) =>
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const r of graph.rels) {
    const a = `${r.from.label}:${r.from.id}`;
    const b = `${r.to.label}:${r.to.id}`;
    add(a, b);
    add(b, a);
  }
  return adj;
}

const args = process.argv.slice(2);
if (args[0] === '--cell') {
  const [, engine, graphFile, qid, variant, cap] = args;
  console.log(
    JSON.stringify(
      await cell(
        engine as 'graph' | 'sqlite',
        graphFile!,
        qid!,
        variant as 'path' | 'len',
        Number(cap),
      ),
    ),
  );
  process.exit(0);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const out = resolve(opt('--out') ?? 'paths-out');
const cap = Number(opt('--pairs') ?? 200);
const timeoutS = Number(opt('--timeout') ?? 300);
const files: string[] = [];
const walk = (p: string) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (p.endsWith('evidence-graph.json')) files.push(p);
};
for (const a of args) walk(a);
mkdirSync(out, { recursive: true });
const results = join(out, 'paths-results.jsonl');
for (const f of files) {
  const graph = JSON.parse(readFileSync(f, 'utf8')) as EvidenceGraph;
  const adj = adjacency(graph);
  for (const q of QUESTIONS)
    for (const variant of VARIANTS) {
      const rows: Record<string, any> = {};
      for (const engine of ['graph', 'sqlite'] as const) {
        const r = spawnSync(
          process.execPath,
          [import.meta.path, '--cell', engine, f, q.id, variant, String(cap)],
          {
            encoding: 'utf8',
            timeout: timeoutS * 1000,
            maxBuffer: 1 << 28,
          },
        );
        let row: Record<string, any>;
        try {
          row = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
        } catch {
          row = {
            engine,
            graph: f,
            nodes: graph.nodes.length,
            question: q.id,
            variant,
            error:
              r.error?.message.includes('ETIMEDOUT') || r.signal
                ? `timeout ${timeoutS}s`
                : (
                    (r.stderr || '')
                      .split('\n')
                      .find((l) => /^\w*error:/i.test(l.trim())) ?? 'no output'
                  ).trim(),
          };
        }
        rows[engine] = row;
      }
      // Checks: the engines agree on every length; every path is real and minimal.
      const g = rows.graph,
        s = rows.sqlite;
      const len = (x: unknown) =>
        x == null ? null : Array.isArray(x) ? x.length - 1 : Number(x);
      let agree = 0,
        disagree = 0,
        invalid = 0;
      if (g.answers && s.answers)
        g.answers.forEach((ga: unknown, i: number) => {
          const sa = s.answers[i];
          if (len(ga) === len(sa)) agree++;
          else disagree++;
          for (const p of [ga, sa])
            if (Array.isArray(p)) {
              const [a, b] = g.pairs[i];
              const ok =
                p[0] === `${q.from}:${a}` &&
                p[p.length - 1] === `${q.to}:${b}` &&
                p.every((n: string, k: number) => k === 0 || adj.get(p[k - 1])?.has(n));
              if (!ok) invalid++;
            }
        });
      for (const engine of ['graph', 'sqlite']) {
        const { answers: _a, pairs: _p, ...slim } = rows[engine];
        appendFileSync(
          results,
          JSON.stringify({ ...slim, pairsAsked: rows[engine].pairs?.length ?? null }) +
            '\n',
        );
      }
      const check = {
        check: true,
        graph: f,
        nodes: graph.nodes.length,
        question: q.id,
        variant,
        agree,
        disagree,
        invalid,
        reachable: (g.answers ?? []).filter((x: unknown) => x != null).length,
      };
      appendFileSync(results, JSON.stringify(check) + '\n');
      const show = (r: any) =>
        r.error
          ? r.error
          : `p50 ${r.warmP50?.toFixed(2)}ms p95 ${r.warmP95?.toFixed(2)}ms`;
      console.log(
        `${String(graph.nodes.length).padStart(4)}n ${q.id.padEnd(20)} ${variant.padEnd(8)} graph ${show(g).padEnd(28)} sqlite ${show(s).padEnd(28)} agree ${agree} disagree ${disagree} invalid ${invalid}`,
      );
    }
}
