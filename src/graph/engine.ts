/**
 * Relate, compiled to WebAssembly, as Tracetoon's in-process graph engine.
 * Like resvg it needs no native module: the .wasm ships in the skill's assets
 * and works in Bun, Node and the compiled binary. Each run's graph is small
 * (hundreds to a few thousand nodes) and is loaded into memory from
 * `evidence-graph.json` per command, so there is no database file to manage.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RelateDb, initSync } from './vendor/relate.js';
import { assetsDir } from '../util/assets.ts';
import { measured } from '../util/profile.ts';
import type { EvidenceGraph, NodeLabel, Value } from './model.ts';

export const WASM_FILE = 'relate.wasm';

/** An explicit engine module path; the pre-Relate variable name still works (deprecated). */
function wasmOverride(): string | undefined {
  return (
    process.env.TRACETOON_RELATE_WASM ||
    process.env.TRACETOON_CYPHERLITE_WASM ||
    undefined
  );
}

export class GraphError extends Error {}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

interface Envelope {
  columns?: string[];
  rows?: Record<string, unknown>[];
  error?: { message?: string; code?: string } | string | null;
}

let initialized: true | Error | undefined;

function init(): void {
  if (initialized === true) return;
  if (initialized) throw initialized;
  const override = wasmOverride();
  const dir = override ? undefined : assetsDir(WASM_FILE);
  const path = override ?? (dir && join(dir, WASM_FILE));
  if (!path || !existsSync(path)) {
    initialized = new GraphError(
      `The graph engine (${WASM_FILE}) was not found; set TRACETOON_ASSETS to the skill's assets folder.`,
    );
    throw initialized;
  }
  try {
    initSync({ module: readFileSync(path) });
    initialized = true;
  } catch (e) {
    initialized = new GraphError(
      `The graph engine could not start: ${(e as Error).message}`,
    );
    throw initialized;
  }
}

/** Whether the engine can start here (for `doctor` and fail-open callers). */
export function graphEngineAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    init();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

const BATCH = 500;
const LABEL = /^[A-Z][A-Za-z]*$/;

/** One in-memory database holding one evidence graph. */
export class GraphEngine {
  private db: RelateDb;
  private dead?: GraphError;

  private constructor() {
    init();
    this.db = new RelateDb();
  }

  static open(): GraphEngine {
    return new GraphEngine();
  }

  /** Load a graph: one batched statement per label and relationship shape. */
  static load(graph: EvidenceGraph): GraphEngine {
    return measured('graph.load', () => {
      const engine = new GraphEngine();
      const byLabel = new Map<NodeLabel, Record<string, Value>[]>();
      for (const n of graph.nodes)
        byLabel.set(n.label, [...(byLabel.get(n.label) ?? []), { ...n.props, id: n.id }]);
      for (const [label, rows] of byLabel) {
        if (!LABEL.test(label)) throw new GraphError(`Bad label ${label}`);
        engine.run(
          `CREATE INDEX ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) ON (n.id)`,
        );
        for (let i = 0; i < rows.length; i += BATCH)
          engine.run(`UNWIND $rows AS r CREATE (n:${label}) SET n += r`, {
            rows: rows.slice(i, i + BATCH),
          });
      }
      const shapes = new Map<
        string,
        { from: string; to: string; id: string; props: Record<string, Value> }[]
      >();
      for (const r of graph.rels) {
        const key = `${r.from.label}|${r.type}|${r.to.label}`;
        shapes.set(key, [
          ...(shapes.get(key) ?? []),
          { from: r.from.id, to: r.to.id, id: '', props: r.props ?? {} },
        ]);
      }
      for (const [key, rows] of shapes) {
        const [from, type, to] = key.split('|') as [string, string, string];
        if (![from, type.replace(/_/g, ''), to].every((x) => /^[A-Za-z]+$/.test(x)))
          throw new GraphError(`Bad relationship ${key}`);
        for (let i = 0; i < rows.length; i += BATCH)
          engine.run(
            `UNWIND $rows AS r MATCH (a:${from} {id: r.from}), (b:${to} {id: r.to}) CREATE (a)-[x:${type}]->(b) SET x += r.props`,
            { rows: rows.slice(i, i + BATCH) },
          );
      }
      return engine;
    });
  }

  /** Run one statement. Errors carry the engine's own message. */
  run(cypher: string, params?: Record<string, unknown>): QueryResult {
    if (this.dead) throw this.dead;
    let raw: string;
    try {
      raw = this.db.execute(cypher, params ? JSON.stringify(params) : null);
    } catch (e) {
      // A Rust panic traps the WebAssembly instance; it cannot be used again.
      if (e instanceof WebAssembly.RuntimeError) {
        this.dead = new GraphError(`The graph engine stopped: ${e.message}`);
        throw this.dead;
      }
      throw new GraphError((e as Error).message ?? String(e));
    }
    const env = JSON.parse(raw) as Envelope;
    if (env.error) {
      const message =
        typeof env.error === 'string'
          ? env.error
          : (env.error.message ?? JSON.stringify(env.error));
      throw new GraphError(message);
    }
    const columns = env.columns ?? [];
    return { columns, rows: env.rows ?? [] };
  }

  close(): void {
    try {
      this.db.free();
    } catch {
      /* already freed or trapped */
    }
  }
}

/** Load the graph, run `fn`, always release the database. */
export function withGraph<T>(graph: EvidenceGraph, fn: (g: GraphEngine) => T): T {
  const engine = GraphEngine.load(graph);
  try {
    return fn(engine);
  } finally {
    engine.close();
  }
}
