/**
 * SQLite as Tracetoon's evidence store (the `feat/evidence-sqlite` experiment arm).
 *
 * It holds the same evidence graph as cypherlite does, as typed tables (one
 * per node label) and link tables (one per relationship), and answers the
 * same named questions in SQL. Two drivers: `wasm` (the default; the official
 * SQLite WebAssembly build, like cypherlite's, so engine costs compare
 * WebAssembly to WebAssembly) and `native` (`bun:sqlite` under Bun,
 * `node:sqlite` under Node). TRACETOON_SQLITE_DRIVER picks one. The wasm
 * driver needs `await initSqlWasm()` once before use (the CLI does it).
 * Each command loads `evidence-graph.json` into an in-memory database;
 * `saveGraph` also exports it as `evidence.sqlite` for any SQLite client.
 */
import { createRequire } from 'node:module';
import { GraphError, type EvidenceDb, type Q, type QueryResult } from '../graph/db.ts';
import type { EvidenceGraph } from '../graph/model.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir } from '../util/assets.ts';
import { count, measured } from '../util/profile.ts';
import { loadEvidence, type ColumnKinds } from './load.ts';

interface Stmt {
  all(params?: Record<string, unknown>): Record<string, unknown>[];
  columns: string[];
}

interface Driver {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
  /** The database as SQLite file bytes. */
  serialize?(): Uint8Array;
  /** Bytes of WebAssembly linear memory the engine holds (wasm driver only). */
  memoryBytes?(): number;
  readonly name: string;
}

export const SQLITE_WASM_FILE = 'sqlite3.wasm';
export type SqlDriverName = 'wasm' | 'native';
export const sqlDriver = (): SqlDriverName =>
  process.env.TRACETOON_SQLITE_DRIVER === 'native' ? 'native' : 'wasm';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Process-wide, not module-wide: a bundler can emit separate instances of this
// module (see util/profile.ts), and the one that initializes must be the one read.
const wasmKey = Symbol.for('tracetoon.sqlite-wasm/v1');
const wasm = ((globalThis as any)[wasmKey] ??= {}) as {
  api?: any;
  init?: Promise<void>;
  error?: string;
};

/**
 * Load the SQLite WebAssembly module once (about 20 ms). The bytes come from
 * the skill's assets, as cypherlite.wasm's do, so the bundle and the compiled
 * binary need no file lookup of their own. Safe to call more than once.
 */
export function initSqlWasm(): Promise<void> {
  if (sqlDriver() !== 'wasm' || wasm.api) return Promise.resolve();
  return (wasm.init ??= (async () => {
    const dir = process.env.TRACETOON_SQLITE_WASM
      ? undefined
      : assetsDir(SQLITE_WASM_FILE);
    const path =
      process.env.TRACETOON_SQLITE_WASM ?? (dir && join(dir, SQLITE_WASM_FILE));
    if (!path)
      throw new GraphError(
        `${SQLITE_WASM_FILE} was not found; set TRACETOON_ASSETS to the skill's assets folder.`,
      );
    const quiet = () => {};
    (globalThis as any).sqlite3ApiConfig = {
      warn: quiet,
      error: quiet,
      log: quiet,
      debug: quiet,
    };
    const { default: init } = (await import('@sqlite.org/sqlite-wasm')) as any;
    // The generic build probes localStorage (for a storage backend we don't use);
    // Node 26 warns on that access, so hide it during init only.
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    if (saved)
      Object.defineProperty(globalThis, 'localStorage', {
        value: undefined,
        configurable: true,
      });
    try {
      wasm.api = await measured('sql.wasm-init', () =>
        init({ wasmBinary: readFileSync(path), print: quiet, printErr: quiet }),
      );
    } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    }
  })().catch((e) => {
    wasm.init = undefined;
    wasm.error = (e as Error).message;
    throw e;
  }));
}

function openWasm(): Driver {
  if (!wasm.api)
    throw new GraphError(
      wasm.error
        ? `SQLite (wasm) failed to load: ${wasm.error}`
        : 'SQLite (wasm) is not initialized: await initSqlWasm() first.',
    );
  const api = wasm.api;
  const db = new api.oo1.DB(':memory:', 'c');
  return {
    name: 'sqlite-wasm',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        all: (p) => {
          try {
            if (p)
              st.bind(
                Object.fromEntries(Object.entries(p).map(([k, v]) => [`$${k}`, v])),
              );
            const rows: Record<string, unknown>[] = [];
            while (st.step()) rows.push(st.get({}));
            return rows;
          } finally {
            st.reset(true);
          }
        },
        get columns() {
          return st.getColumnNames();
        },
      };
    },
    serialize: () => api.capi.sqlite3_js_db_export(db.pointer),
    memoryBytes: () => api.wasm.heap8u().byteLength,
    close: () => db.close(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/** Loaded synchronously; the module name is computed so no bundler resolves the other runtime's. */
function openDriver(path = ':memory:'): Driver {
  if (sqlDriver() === 'wasm') return openWasm();
  const req = createRequire(import.meta.url);
  if (isBun) {
    const { Database } = req(['bun', 'sqlite'].join(':')) as {
      Database: new (
        p: string,
        o?: { strict?: boolean },
      ) => {
        exec(sql: string): void;
        query(sql: string): {
          all(p?: Record<string, unknown>): Record<string, unknown>[];
          columnNames: string[];
        };
        close(): void;
      };
    };
    const db = new Database(path, { strict: true });
    return {
      name: 'bun:sqlite',
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const s = db.query(sql);
        return {
          all: (p) => (p ? s.all(p) : s.all()),
          get columns() {
            return s.columnNames;
          },
        };
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = req(['node', 'sqlite'].join(':')) as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        all(p?: Record<string, unknown>): Record<string, unknown>[];
        columns?(): { name: string }[];
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(path);
  return {
    name: 'node:sqlite',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const s = db.prepare(sql);
      return {
        all: (p) => (p ? s.all(p) : s.all()),
        get columns() {
          return s.columns ? s.columns().map((c) => c.name) : [];
        },
      };
    },
    close: () => db.close(),
  };
}

let available: { ok: true; driver: string } | { ok: false; reason: string } | undefined;

/** Whether SQLite can open here (for `doctor` and fail-open callers). */
export function sqlEngineAvailable():
  { ok: true; driver: string } | { ok: false; reason: string } {
  if (available) return available;
  try {
    const d = openDriver();
    d.prepare('SELECT 1').all();
    d.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    available = { ok: true, driver: d.name };
    d.close();
  } catch (e) {
    available = { ok: false, reason: `SQLite could not open: ${(e as Error).message}` };
  }
  return available;
}

const PARAM = /[$:@]([A-Za-z_]\w*)/g;

/** Param values as SQLite binds them: booleans as 0/1, lists as JSON (read with json_each). */
function bindable(sql: string, params: Record<string, unknown> = {}) {
  const used = new Set(
    [...sql.replace(/'[^']*'/g, "''").matchAll(PARAM)].map((m) => m[1]!),
  );
  if (!used.size) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of used) {
    const v = params[k];
    out[k] =
      v === undefined
        ? null
        : typeof v === 'boolean'
          ? Number(v)
          : Array.isArray(v) || (v && typeof v === 'object')
            ? JSON.stringify(v)
            : v;
  }
  return out;
}

/** One in-memory SQLite database holding one evidence graph. */
export class SqlEngine implements EvidenceDb {
  readonly dialect = 'sql' as const;
  private db: Driver;
  private kinds: ColumnKinds = {};

  private constructor(path?: string) {
    try {
      this.db = openDriver(path);
    } catch (e) {
      throw new GraphError(`SQLite could not open: ${(e as Error).message}`);
    }
  }

  static load(graph: EvidenceGraph): SqlEngine {
    const started = performance.now();
    count('evidence.loads');
    count(`evidence.engine.sqlite-${sqlDriver()}`);
    try {
      return SqlEngine.loadNow(graph);
    } finally {
      count('evidence.loadMs', Math.round(performance.now() - started));
    }
  }

  private static loadNow(graph: EvidenceGraph): SqlEngine {
    return measured('sql.load', () => {
      const engine = new SqlEngine();
      engine.kinds = loadEvidence(engine.db, graph);
      engine.db.exec('PRAGMA query_only = ON');
      return engine;
    });
  }

  /** Run a named query's SQL; a Cypher-only string here is a programming error. */
  run(q: Q, params?: Record<string, unknown>): QueryResult {
    if (typeof q === 'string')
      throw new GraphError('This query has no SQL form yet (Cypher only).');
    return this.sql(q.sql, params, q.json);
  }

  /**
   * Run SQL. List and boolean columns come back as JavaScript arrays and booleans,
   * as the graph engine returns them: by column name for stored properties, and
   * by `json` for aggregates (json_group_array).
   */
  sql(sql: string, params?: Record<string, unknown>, json: string[] = []): QueryResult {
    const started = performance.now();
    try {
      return this.sqlNow(sql, params, json);
    } finally {
      count('evidence.queries');
      count('evidence.queryMs', Math.round((performance.now() - started) * 1000) / 1000);
    }
  }

  private sqlNow(
    sql: string,
    params?: Record<string, unknown>,
    json: string[] = [],
  ): QueryResult {
    let stmt: Stmt;
    let rows: Record<string, unknown>[];
    try {
      stmt = this.db.prepare(sql);
      const p = bindable(sql, params);
      rows = p ? stmt.all(p) : stmt.all();
    } catch (e) {
      throw new GraphError((e as Error).message ?? String(e));
    }
    const columns = stmt.columns.length ? stmt.columns : Object.keys(rows[0] ?? {});
    const decode = new Map<string, 'array' | 'bool'>();
    for (const c of columns) {
      if (json.includes(c)) decode.set(c, 'array');
      else if (this.kinds[c]) decode.set(c, this.kinds[c]!);
    }
    if (decode.size)
      for (const r of rows)
        for (const [c, kind] of decode) {
          const v = r[c];
          if (kind === 'array' && typeof v === 'string' && /^\s*[[{]/.test(v)) {
            try {
              r[c] = JSON.parse(v);
            } catch {
              /* a plain string that looks like JSON: keep it */
            }
          } else if (kind === 'bool' && (v === 0 || v === 1)) r[c] = v === 1;
        }
    // Plain objects, not null-prototype rows, so deep equality and spreading behave.
    return { columns, rows: rows.map((r) => ({ ...r })) };
  }

  /** Write the database to a file (VACUUM INTO works in both runtimes). */
  exportTo(path: string): void {
    if (this.db.serialize) {
      writeFileSync(path, this.db.serialize());
      return;
    }
    this.db.exec('PRAGMA query_only = OFF');
    try {
      this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    } finally {
      this.db.exec('PRAGMA query_only = ON');
    }
  }

  /** Which driver holds this database, and its WebAssembly memory (undefined when native). */
  get driverName(): string {
    return this.db.name;
  }
  memoryBytes(): number | undefined {
    return this.db.memoryBytes?.();
  }

  close(): void {
    // WebAssembly memory, in KB, summed over loads (divide by evidence.loads); 0 when native.
    count('evidence.wasmKB', Math.round((this.db.memoryBytes?.() ?? 0) / 1024));
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Load the graph into SQLite, run `fn`, always release the database. */
export function withSql<T>(graph: EvidenceGraph, fn: (g: SqlEngine) => T): T {
  const engine = SqlEngine.load(graph);
  try {
    return fn(engine);
  } finally {
    engine.close();
  }
}
