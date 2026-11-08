/**
 * SQLite (the official WebAssembly build, with FTS5 and JSON) for the
 * relational/vector arm. The CLI awaits `initSqlWasm()` once before commands
 * that read evidence; after that `openDb()` is synchronous. It's the same
 * driver approach as the SQLite evidence store on `feat/evidence-sqlite-extras`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir } from '../util/assets.ts';

export const SQLITE_WASM_FILE = 'sqlite3.wasm';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Process-wide, not module-wide: a bundler can emit separate instances of this
// module, and the one that initializes must be the one read.
const key = Symbol.for('tracetoon.relational-sqlite-wasm/v1');
const state = ((globalThis as any)[key] ??= {}) as {
  api?: any;
  init?: Promise<void>;
  error?: string;
};

/** Load the SQLite WebAssembly module once (about 20 ms). Safe to call more than once. */
export function initSqlWasm(): Promise<void> {
  if (state.api) return Promise.resolve();
  return (state.init ??= (async () => {
    const dir = process.env.TRACETOON_SQLITE_WASM
      ? undefined
      : assetsDir(SQLITE_WASM_FILE);
    const path =
      process.env.TRACETOON_SQLITE_WASM ?? (dir && join(dir, SQLITE_WASM_FILE));
    if (!path)
      throw new Error(
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
    // The generic build probes localStorage; Node 26 warns on that access, so hide it during init.
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    if (saved)
      Object.defineProperty(globalThis, 'localStorage', {
        value: undefined,
        configurable: true,
      });
    try {
      state.api = await init({
        wasmBinary: readFileSync(path),
        print: quiet,
        printErr: quiet,
      });
    } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    }
  })().catch((e) => {
    state.init = undefined;
    state.error = (e as Error).message;
    throw e;
  }));
}

/**
 * A new in-memory database (the sqlite3 `oo1.DB` API: `exec`, `prepare`,
 * `selectObjects`, …). Throws if `initSqlWasm()` has not completed.
 */
export function openDb(): any {
  if (!state.api)
    throw new Error(
      state.error
        ? `SQLite (wasm) failed to load: ${state.error}`
        : 'SQLite (wasm) is not initialized: await initSqlWasm() first.',
    );
  return new state.api.oo1.DB(':memory:', 'c');
}

/** The sqlite3 module itself (capi, wasm), for anything `openDb` doesn't cover. */
export function sqlite3(): any {
  return state.api;
}
