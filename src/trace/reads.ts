/**
 * Read-only shell commands as reads: `cat src/x.ts`, `sed -n 1,80p src/x.ts`,
 * `rg pattern src/`. Codex and Claude both read through the shell, so this is
 * agent-neutral. Only plain segments count: a redirection into a file, a
 * heredoc or an in-place flag means it is not a read, and only words shaped
 * like paths (no shell expansion, not a flag's value) are kept.
 */
import { resolve } from 'node:path';
import type { ReadRecord } from './types.ts';
import { shellSegments } from '../util/shell.ts';

const READERS = new Set(['cat', 'head', 'tail', 'less', 'nl', 'wc', 'stat', 'bat']);
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'fd', 'find']);

/** Per program, flags whose next word is a value, not a path or pattern. */
const VALUED: Record<string, RegExp> = {
  head: /^-[nc]$/,
  tail: /^-[nc]$/,
  sed: /^-[ef]$/,
  rg: /^(-[egtTmABCfM]|--(glob|type|max-count|context|after-context|before-context|file))$/,
  grep: /^(-[efmABC]|--(max-count|context|after-context|before-context|file))$/,
  ag: /^(-[GmABC]|--(file-search-regex|max-count|context))$/,
  fd: /^(-[etdE]|--(extension|type|max-depth|exclude))$/,
};

const PATHISH = /^(?:\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]*)*$/;
const EXPANDS = /[$`*?<>{}]/;
/** A path argument: no shell expansion, not a bare number. */
const pathArg = (a: string) => !EXPANDS.test(a) && !/^\d+$/.test(a) && PATHISH.test(a);
/** A file argument: a path with a slash or an extension. */
const fileArg = (a: string) => pathArg(a) && /\/|\.\w+$/.test(a);

/** Words of one segment, honoring quotes; inside double quotes only \\ $ ` " are escapes, as in sh. */
function words(seg: string): string[] {
  return [...seg.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
    m[2] !== undefined ? m[2].replace(/\\([$`"\\])/g, '$1') : (m[1] ?? m[3]!),
  );
}

const positional = (args: string[]) => args.filter((a) => !a.startsWith('-'));

export function shellReads(cmd: string, cwd?: string, ts?: string): ReadRecord[] {
  const out: ReadRecord[] = [];
  let dir = cwd;
  for (const { command: seg, before } of shellSegments(cmd)) {
    const w = words(seg);
    const prog = w[0]?.replace(/^.*\//, '');
    if (!prog) continue;
    const first = w[1];
    if (prog === 'cd' && first) {
      dir = resolve(dir ?? '.', first);
      continue;
    }
    if (seg.includes('<<')) continue;
    if (/(^|\s)>{1,2}\s*[^&\s]/.test(seg.replace(/2>&1|>\s*\/dev\/null/g, ''))) continue;
    const valued = VALUED[prog];
    // Drop the values flags take; flags themselves are dropped by `positional`.
    let args = w.slice(1).filter((_, i, all) => !valued?.test(all[i - 1] ?? ''));
    const at = (p: string) => resolve(dir ?? '.', p);
    const push = (path: string, pattern?: string) =>
      out.push({
        tool: `shell:${prog}`,
        ts,
        cwd: dir,
        path: at(path),
        ...(pattern ? { pattern } : {}),
      });

    if (prog === 'sed') {
      if (!args.includes('-n') || args.some((a) => a.startsWith('-i'))) continue;
      // The first positional word is the script unless -e gave it.
      const pos = positional(args);
      for (const f of (w.includes('-e') ? pos : pos.slice(1)).filter(fileArg).slice(0, 8))
        push(f);
      continue;
    }
    if (READERS.has(prog)) {
      for (const f of positional(args).filter(fileArg).slice(0, 8)) push(f);
      continue;
    }
    if (!SEARCHERS.has(prog)) continue;
    if (prog === 'find') {
      // Paths come before find's first test (-name, -type, …).
      const k = args.findIndex((a) => a.startsWith('-'));
      if (k >= 0) args = args.slice(0, k);
    }
    const finder = prog === 'find' || prog === 'fd';
    const pos = positional(args);
    const pattern = finder ? undefined : pos[0];
    if (!finder && !pattern) continue;
    const where = (finder ? pos : pos.slice(1)).filter(pathArg).slice(0, 4);
    // After a pipe with no path, a search filters the previous command's output.
    if (before === '|' && !where.length) continue;
    for (const p of where.length ? where : ['.']) push(p, pattern);
  }
  return out;
}
