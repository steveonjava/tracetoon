/**
 * The skill's `assets/` folder, wherever Tracetoon is running from: the source
 * tree, the single-file bundle in `dist/`, or a compiled binary in `bin/`.
 * WebAssembly modules (resvg, cypherlite) and fonts ship there, so no runtime
 * needs native modules.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assetsDir(marker = 'resvg.wasm'): string | undefined {
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  const candidates = [
    process.env.TRACETOON_ASSETS,
    join(here, '..', 'assets'), // dist/tracetoon.mjs → assets
    join(dirname(process.execPath), '..', 'assets'), // compiled binary in bin/
    join(dirname(process.execPath), 'assets'),
    join(dirname(process.execPath), '..', 'plugin', 'skills', 'tracetoon', 'assets'), // repo dist/ binary
    join(here, '..', '..', 'plugin', 'skills', 'tracetoon', 'assets'), // src/<dir> → repo
    join(process.argv[1] ? dirname(resolve(process.argv[1])) : here, '..', 'assets'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(join(p, marker)));
}
