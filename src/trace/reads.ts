/**
 * Read-only shell commands as reads: `cat src/x.ts`, `sed -n 1,80p src/x.ts`,
 * `rg pattern src/`, `ls src`. Codex and Claude both read through the shell, so
 * this is agent-neutral. Only plain segments are read; anything with a
 * redirection into a file or an in-place flag is not a read.
 */
import { resolve } from 'node:path';
import type { ReadRecord } from './types.ts';

const READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'nl',
  'wc',
  'ls',
  'tree',
  'stat',
]);
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'fd', 'find']);
const PATHISH = /^(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]*)*$/;

/** Words of one segment, honoring simple quotes. */
function words(seg: string): string[] {
  return [...seg.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
}

export function shellReads(cmd: string, cwd?: string, ts?: string): ReadRecord[] {
  const out: ReadRecord[] = [];
  let dir = cwd;
  for (const raw of cmd.split(/&&|\|\||;|\|/)) {
    const seg = raw.trim();
    if (!seg) continue;
    const w = words(seg);
    const prog = w[0]?.replace(/^.*\//, '');
    const first = w[1];
    if (!prog) continue;
    if (prog === 'cd' && first) {
      dir = resolve(dir ?? '.', first);
      continue;
    }
    if (/(^|\s)>{1,2}\s*[^&\s]/.test(seg.replace(/2>&1|>\s*\/dev\/null/g, ''))) continue;
    const args = w.slice(1);
    const at = (p: string) => resolve(dir ?? '.', p);
    if (
      READERS.has(prog) ||
      (prog === 'sed' && args.includes('-n') && !args.some((a) => a.startsWith('-i')))
    ) {
      const files = args.filter(
        (a, i) =>
          !a.startsWith('-') &&
          PATHISH.test(a) &&
          !(prog === 'sed' && i === args.indexOf('-n') + 1),
      );
      for (const f of files.slice(0, 8))
        out.push({ tool: `shell:${prog}`, ts, cwd: dir, path: at(f) });
      continue;
    }
    if (SEARCHERS.has(prog)) {
      const plain = args.filter((a) => !a.startsWith('-'));
      const finder = prog === 'find' || prog === 'fd';
      const pattern = finder ? undefined : plain[0];
      const paths = finder ? plain : plain.slice(1);
      const where = paths.filter((p) => PATHISH.test(p)).slice(0, 4);
      for (const p of where.length ? where : ['.'])
        out.push({
          tool: `shell:${prog}`,
          ts,
          cwd: dir,
          path: at(p),
          ...(pattern ? { pattern } : {}),
        });
    }
  }
  return out;
}
