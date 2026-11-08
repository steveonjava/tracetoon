// Engine benchmark: cypherlite (WebAssembly) vs SQLite (WebAssembly) on the
// same evidence graphs. Every (engine, graph, query) cell runs in a fresh
// process so memory figures don't bleed between cells.
//
//   bun run scripts/bench-engines.ts --out <dir> [--timeout 120] [--workloads pr,hop] <graph.json|dir>...
//   bun run scripts/bench-engines.ts --audit <graph.json>   # which wasm imports cypherlite calls while querying
//
// W1 "pr": the PR workload (brief, derive, every named query); both engines give
// identical answers (parity). W2 "hop": multi-hop graph queries written in
// Cypher and in SQL (recursive CTEs over an undirected edge table); each pair's
// result must match, so every cell is also a correctness check.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { EvidenceDb } from '../src/graph/db.ts';
import type { EvidenceGraph } from '../src/graph/model.ts';

type Hop = { id: string; cypher: string; sql: string };

/** SQL side: an undirected edge table over every link table (node key = Label:id). */
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

const HOP_SQL_B1 = (k: number) => `WITH RECURSIVE r(src, node, d) AS (
    SELECT 'Prompt:' || id, 'Prompt:' || id, 0 FROM prompts
    UNION SELECT r.src, e.b, r.d + 1 FROM r JOIN bench_uedges e ON e.a = r.node WHERE r.d < ${k})
  SELECT count(*) AS n FROM (SELECT DISTINCT src, node FROM r WHERE node <> src)`;
const HOP_SQL_B2 = (d: number) => `WITH RECURSIVE cc(a, b) AS (
    SELECT DISTINCT x.file, y.file FROM commit_file x JOIN commit_file y ON x."commit" = y."commit" AND x.file <> y.file),
  r(a, b, d) AS (SELECT a, b, 1 FROM cc UNION SELECT r.a, cc.b, r.d + 1 FROM r JOIN cc ON cc.a = r.b WHERE r.d < ${d})
  SELECT count(*) AS n FROM (SELECT DISTINCT a, b FROM r WHERE a <> b)`;

const HOPS: Hop[] = [
  // B1: distinct nodes within k hops of each prompt, over any relationship.
  ...[1, 2, 3, 4, 5, 6].map((k) => ({
    id: `B1-khop-k${k}`,
    cypher: `MATCH (p:Prompt)-[*1..${k}]-(n) WHERE n <> p WITH DISTINCT p, n RETURN count(*) AS n`,
    sql: HOP_SQL_B1(k),
  })),
  // B2: files that co-change through commits, transitively, up to d commit steps.
  ...[1, 2, 3, 4].map((d) => ({
    id: `B2-cochange-d${d}`,
    cypher: `MATCH (a:File)-[:TOUCHES*1..${2 * d}]-(b:File) WHERE a <> b WITH DISTINCT a, b RETURN count(*) AS n`,
    sql: HOP_SQL_B2(d),
  })),
  // B1/B2 again in a graph engine's best formulation: one shortest-path
  // (breadth-first) search per pair instead of enumerating every path. Same
  // answers; the SQL is the same recursive query.
  ...[1, 2, 3, 4, 5, 6].map((k) => ({
    id: `B1sp-khop-k${k}`,
    cypher: `MATCH (p:Prompt), (n) WHERE n <> p MATCH sp = shortestPath((p)-[*..${k}]-(n)) RETURN count(sp) AS n`,
    sql: HOP_SQL_B1(k),
  })),
  ...[1, 2, 3, 4].map((d) => ({
    id: `B2sp-cochange-d${d}`,
    cypher: `MATCH (a:File), (b:File) WHERE a <> b MATCH sp = shortestPath((a)-[:TOUCHES*..${2 * d}]-(b)) RETURN count(sp) AS n`,
    sql: HOP_SQL_B2(d),
  })),
  // B3: shortest path (up to 8 hops) from every prompt to every commit.
  {
    id: 'B3-shortest-prompt-commit',
    cypher: `MATCH (p:Prompt), (c:Commit) MATCH sp = shortestPath((p)-[*..8]-(c)) RETURN count(sp) AS n, sum(length(sp)) AS total`,
    sql: `WITH RECURSIVE r(src, node, d) AS (
            SELECT 'Prompt:' || id, 'Prompt:' || id, 0 FROM prompts
            UNION SELECT r.src, e.b, r.d + 1 FROM r JOIN bench_uedges e ON e.a = r.node WHERE r.d < 8)
          SELECT count(*) AS n, sum(md) AS total FROM (
            SELECT src, node, min(d) AS md FROM r WHERE node LIKE 'Commit:%' GROUP BY src, node)`,
  },
  // B4: a 5-hop provenance chain with a variable-length middle.
  {
    id: 'B4-provenance-chain',
    cypher: `MATCH (h:Hunk)<-[:SURVIVES_IN]-(:Edit)-[:IN_TURN]->(:Prompt)-[:NEXT*0..]->(:Prompt)<-[:ASKED_BY]-(c:Change) WITH DISTINCT h, c RETURN count(*) AS n`,
    sql: `WITH RECURSIVE nx(a, b) AS (SELECT id, id FROM prompts UNION SELECT nx.a, pn.next FROM nx JOIN prompt_next pn ON pn.prompt = nx.b)
          SELECT count(*) AS n FROM (SELECT DISTINCT eh.hunk, cp.change FROM edit_hunk eh
            JOIN in_turn it ON it.kind = 'Edit' AND it.id = eh.edit
            JOIN nx ON nx.a = it.prompt JOIN change_prompt cp ON cp.prompt = nx.b)`,
  },
  // B5: cycle closure: a change, its hunk, the commit that introduced it, back to the change.
  {
    id: 'B5-cycle-closure',
    cypher: `MATCH (c:Change)-[:HAS]->(:Hunk)<-[:INTRODUCED]-(:Commit)<-[:EXPLAINED_BY]-(c) RETURN count(*) AS n`,
    sql: `SELECT count(*) AS n FROM change_hunk ch JOIN commit_hunk ck ON ck.hunk = ch.hunk
          JOIN change_commit cc ON cc.change = ch.change AND cc."commit" = ck."commit"`,
  },
];

/** JSON with object keys sorted, so equal answers hash equal whatever each engine's key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const time = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};

/** One cell, in this process: load the graph into one engine, run one query (cold, then warm). */
/**
 * cypherlite's only host calls while querying are clocks (performance.now and
 * Date, ~9 per statement: statement timing). "graph-noclock" replaces them with
 * constants, the nearest thing to telemetry off without rebuilding the engine.
 */
function stubClocks() {
  const Real = WebAssembly.Instance;
  (WebAssembly as unknown as { Instance: unknown }).Instance = function (
    mod: WebAssembly.Module,
    imports: Record<string, Record<string, unknown>>,
  ) {
    for (const fns of Object.values(imports ?? {}))
      for (const name of Object.keys(fns)) {
        if (/^__wbg_now_/.test(name)) fns[name] = () => 0;
        if (/^__wbg_getTime_/.test(name)) fns[name] = () => 0;
        if (/^__wbg_getTimezoneOffset_/.test(name)) fns[name] = () => 0;
      }
    return new Real(mod, imports as WebAssembly.Imports);
  };
}

async function cell(
  engineArg: 'graph' | 'graph-noclock' | 'sqlite',
  graphFile: string,
  query: string,
): Promise<Record<string, unknown>> {
  if (engineArg === 'graph-noclock') stubClocks();
  const engine = engineArg === 'sqlite' ? 'sqlite' : 'graph';
  const { initSqlWasm, SqlEngine } = await import('../src/sql/engine.ts');
  const { GraphEngine, graphWasmMemoryBytes } = await import('../src/graph/engine.ts');
  const { questions } = await import('../src/sql/parity.ts');
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as EvidenceGraph;
  const memAfterInit = { v: 0 };
  let db: EvidenceDb;
  let loadMs: number;
  let edgesMs = 0;
  let mem: () => number | undefined;
  let dbBytes: number | undefined;
  if (engine === 'sqlite') {
    const [, initMs] = await (async () => {
      const t = performance.now();
      await initSqlWasm();
      return [0, performance.now() - t] as const;
    })();
    const sql = (() => {
      const [e, ms] = time(() => SqlEngine.load(graph));
      loadMs = ms;
      return e;
    })();
    mem = () => sql.memoryBytes();
    memAfterInit.v = initMs;
    if (query.startsWith('B')) {
      // The graph-emulation table is part of what SQL pays for multi-hop work.
      [, edgesMs] = time(() => {
        (sql as unknown as { db: { exec(s: string): void } }).db.exec(
          'PRAGMA query_only = OFF',
        );
        (sql as unknown as { db: { exec(s: string): void } }).db.exec(EDGES_SQL);
        (sql as unknown as { db: { exec(s: string): void } }).db.exec(
          'PRAGMA query_only = ON',
        );
      });
    }
    const pages = sql.sql(
      'SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS b',
    ).rows[0]?.b;
    dbBytes = Number(pages);
    db = sql;
  } else {
    const [e, ms] = time(() => GraphEngine.load(graph));
    loadMs = ms;
    mem = graphWasmMemoryBytes;
    db = e;
  }
  const memAfterLoad = mem();
  let run: () => unknown;
  if (query === 'pr') {
    // Shared questions only, as in the parity check: the SQLite-only extras stay off.
    process.env.TRACETOON_SQLITE_EXTRAS = '0';
    const qs = questions(graph);
    run = () => qs.map(([, f]) => f(db));
  } else {
    const hop = HOPS.find((h) => h.id === query);
    if (!hop) throw new Error(`unknown query ${query}`);
    run = () => db.run({ cypher: hop.cypher, sql: hop.sql }).rows[0];
  }
  let result: unknown, coldMs: number;
  try {
    [result, coldMs] = time(run);
  } catch (e) {
    return {
      engine: engineArg,
      graph: graphFile,
      nodes: graph.nodes.length,
      rels: graph.rels.length,
      query,
      loadMs: Math.round(loadMs! * 10) / 10,
      error: (e as Error).message.slice(0, 200),
      wasmBytesAtFailure: mem() ?? null,
      maxRssKB: process.resourceUsage().maxRSS,
    };
  }
  const warm: number[] = [];
  // Warm repeats only when cheap enough to repeat.
  for (let i = 0; i < (coldMs < 2000 ? 5 : coldMs < 15000 ? 2 : 0); i++)
    warm.push(time(run)[1]);
  const out = {
    engine: engineArg,
    graph: graphFile,
    nodes: graph.nodes.length,
    rels: graph.rels.length,
    query,
    loadMs: Math.round(loadMs! * 10) / 10,
    edgesMs: Math.round(edgesMs * 10) / 10,
    coldMs: Math.round(coldMs * 10) / 10,
    warmMedianMs: warm.length ? Math.round(median(warm) * 10) / 10 : null,
    wasmBytesAfterLoad: memAfterLoad ?? null,
    wasmBytesPeak: mem() ?? null,
    dbBytes: dbBytes ?? null,
    maxRssKB: process.resourceUsage().maxRSS,
    // The answer, for cross-engine checks (W1 is large: keep a hash).
    result: query === 'pr' ? Bun.hash(canonical(result)).toString(16) : result,
  };
  db.close();
  return out;
}

/** Which wasm imports cypherlite calls while loading and querying (telemetry check). */
async function audit(graphFile: string) {
  const counts = new Map<string, number>();
  const Real = WebAssembly.Instance;
  (WebAssembly as unknown as { Instance: unknown }).Instance = function (
    mod: WebAssembly.Module,
    imports: Record<string, Record<string, unknown>>,
  ) {
    const wrapped: Record<string, Record<string, unknown>> = {};
    for (const [ns, fns] of Object.entries(imports ?? {})) {
      wrapped[ns] = {};
      for (const [name, f] of Object.entries(fns))
        wrapped[ns]![name] =
          typeof f === 'function'
            ? (...a: unknown[]) => {
                counts.set(name, (counts.get(name) ?? 0) + 1);
                return (f as (...x: unknown[]) => unknown)(...a);
              }
            : f;
    }
    return new Real(mod, wrapped as WebAssembly.Imports);
  };
  const { GraphEngine } = await import('../src/graph/engine.ts');
  const { questions } = await import('../src/sql/parity.ts');
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as EvidenceGraph;
  const e = GraphEngine.load(graph);
  const afterLoad = new Map(counts);
  counts.clear();
  for (const [, f] of questions(graph)) f(e);
  for (const h of HOPS.filter((x) => !x.id.startsWith('B3'))) e.run(h.cypher);
  e.close();
  const show = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k.replace(/^__wbg_|_[0-9a-f]{16}$/g, '')}: ${v}`);
  console.log(JSON.stringify({ load: show(afterLoad), queries: show(counts) }, null, 1));
}

const args = process.argv.slice(2);
if (args[0] === '--cell') {
  const [, engine, graphFile, query] = args;
  console.log(
    JSON.stringify(
      await cell(engine as 'graph' | 'graph-noclock' | 'sqlite', graphFile!, query!),
    ),
  );
  process.exit(0);
}
if (args[0] === '--audit') {
  await audit(args[1]!);
  process.exit(0);
}
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const out = resolve(opt('--out') ?? 'bench-out');
const timeoutS = Number(opt('--timeout') ?? 120);
const workloads = (opt('--workloads') ?? 'pr,hop').split(',');
const only = opt('--queries')?.split(',');
const engines = (opt('--engines') ?? 'graph,graph-noclock,sqlite').split(',') as (
  'graph' | 'graph-noclock' | 'sqlite'
)[];
const files: string[] = [];
const walk = (p: string) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (p.endsWith('evidence-graph.json')) files.push(p);
};
for (const a of args) walk(a);
mkdirSync(out, { recursive: true });
const results = join(out, 'bench-results.jsonl');
const failedAt = new Map<string, number>();
const queries = [
  ...(workloads.includes('pr') ? ['pr'] : []),
  ...(workloads.includes('hop') ? HOPS.map((h) => h.id) : []),
].filter((q) => !only || only.includes(q));
const synthetic = (f: string) => /synthetic-n\d+/.test(f);
for (const f of files)
  for (const q of queries) {
    // The PR workload is per PR: run it on real graphs only.
    if (q === 'pr' && synthetic(f)) continue;
    const answers: Record<string, unknown> = {};
    for (const engine of engines) {
      // Past a failure at a smaller k (or depth) on this graph, larger ones only fail slower.
      const fam = /^(.*?)(\d+)$/.exec(q);
      if (fam && failedAt.get(`${engine}|${f}|${fam[1]}`)! <= Number(fam[2])) {
        appendFileSync(
          results,
          JSON.stringify({
            engine,
            graph: f,
            query: q,
            skipped: `failed at a smaller ${fam[1]}`,
          }) + '\n',
        );
        continue;
      }
      const r = spawnSync(process.execPath, [import.meta.path, '--cell', engine, f, q], {
        encoding: 'utf8',
        timeout: timeoutS * 1000,
        maxBuffer: 1 << 26,
      });
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
      } catch {
        row = {
          engine,
          graph: f,
          query: q,
          error:
            r.error?.message.includes('ETIMEDOUT') || r.signal
              ? `timeout ${timeoutS}s`
              : (
                  (r.stderr || '')
                    .split('\n')
                    .find((l) => /^\w*error:/i.test(l.trim())) ??
                  (r.stderr || 'no output').slice(-200)
                ).trim(),
        };
      }
      if (row.error && fam) {
        const key = `${engine}|${f}|${fam[1]}`;
        failedAt.set(key, Math.min(failedAt.get(key) ?? Infinity, Number(fam[2])));
      }
      answers[engine] = row.result;
      appendFileSync(results, JSON.stringify(row) + '\n');
      console.log(
        `${engine.padEnd(13)} ${q.padEnd(26)} ${String(row.nodes ?? '').padStart(7)}n  load ${String(row.loadMs ?? '-').padStart(8)}  cold ${String(row.coldMs ?? row.error ?? '-').padStart(9)}  warm ${String(row.warmMedianMs ?? '-').padStart(8)}  wasm ${row.wasmBytesPeak ? Math.round(Number(row.wasmBytesPeak) / 1048576) + 'MB' : '-'}  ${f.replace(/.*\/(runs\/|bench-graphs\/)/, '')}`,
      );
    }
    const got = Object.values(answers)
      .filter((a) => a !== undefined)
      .map((a) => JSON.stringify(a));
    if (new Set(got).size > 1)
      (appendFileSync(
        results,
        JSON.stringify({ mismatch: true, graph: f, query: q, answers }) + '\n',
      ),
        console.log(`  MISMATCH ${q}: ${JSON.stringify(answers)}`));
  }
writeFileSync(
  join(out, 'README.txt'),
  `bench-engines results; rows in bench-results.jsonl (one per engine x graph x query).\n`,
);
