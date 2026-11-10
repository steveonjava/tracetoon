/**
 * Git commands a session ran that say how the work landed: a push, a new
 * branch or worktree, a cherry-pick, a rewritten history (amend, rebase,
 * revert, reset) and what was staged. Read from the command text only; a
 * command the log records with an error is left out (failed pushes are a
 * `limits` row of their own). Only the evidence graph reads these.
 */
import { splitCommands } from '../util/shell.ts';

export type GitOpKind =
  'push' | 'branch' | 'worktree' | 'cherry-pick' | 'history' | 'stage' | 'ci';

export interface GitOp {
  t?: string;
  kind: GitOpKind;
  /** Plain words, e.g. `git push origin feat/x`, `git add src/a.ts src/b.ts`. */
  op: string;
}

const ENV_PREFIX = /^([A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/;
/** Global options before the subcommand: `-C <dir>`, `-c k=v`, `--no-pager`. */
const GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree']);

/** Words of a git segment after `git` and its global options, quotes stripped. */
function gitWords(seg: string): string[] | undefined {
  const toks: string[] = [];
  for (const tok of seg.replace(ENV_PREFIX, '').trim().split(/\s+/)) {
    if (/^\d?[<>|&;]/.test(tok)) break; // redirections and what follows
    toks.push(tok.replace(/^["']|["']$/g, ''));
  }
  if (toks[0] !== 'git') return undefined;
  let i = 1;
  while (i < toks.length && toks[i]!.startsWith('-')) {
    i += GLOBAL_WITH_ARG.has(toks[i]!) ? 2 : 1;
  }
  return toks.slice(i);
}

const plain = (ws: string[]) => ws.filter((w) => w && !w.startsWith('-'));
/** A word safe to show: no shell syntax, no long opaque token (a key or id). */
const shown = (w: string) =>
  !/[=<>|&;"'`$(){}\\]/.test(w) &&
  !(w.length >= 20 && /\d/.test(w) && /[A-Za-z]/.test(w) && !/[./]/.test(w));
/** Options of `-b`-like flags whose next word is the value. */
function valueOf(ws: string[], flags: string[]): string | undefined {
  const i = ws.findIndex((w) => flags.includes(w));
  return i >= 0 ? ws[i + 1] : undefined;
}

/** The landing-relevant git operations of one shell command, in order. */
export function gitOpsOf(cmd: string): Omit<GitOp, 't'>[] {
  const out: Omit<GitOp, 't'>[] = [];
  for (const seg of splitCommands(cmd)) {
    // CI looked at from the session: `gh run watch`, `gh pr checks`.
    const ci =
      /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*gh\s+(run\s+(?:watch|view|list|rerun)|pr\s+checks)\b/.exec(
        seg.trim(),
      );
    if (ci) {
      out.push({ kind: 'ci', op: `gh ${ci[1]!.replace(/\s+/g, ' ')}` });
      continue;
    }
    const ws = gitWords(seg);
    if (!ws?.length) continue;
    const [sub, ...rest] = ws;
    const args = plain(rest).filter(shown);
    const has = (...f: string[]) => rest.some((w) => f.includes(w));
    switch (sub) {
      case 'push': {
        // `git push --delete` or a dry run is no landing.
        if (has('--dry-run', '-n', '--delete', '-d')) break;
        const force =
          has('--force', '-f', '--force-with-lease') ||
          rest.some((w) => w.startsWith('--force-with-lease='));
        out.push({
          kind: 'push',
          op: `git push${force ? ' --force' : ''}${args.length ? ` ${args.slice(0, 2).join(' ')}` : ''}`,
        });
        break;
      }
      case 'checkout':
      case 'switch': {
        const b = valueOf(
          rest,
          sub === 'checkout' ? ['-b', '-B'] : ['-c', '-C', '--create'],
        );
        if (b && shown(b)) out.push({ kind: 'branch', op: `git ${sub} new branch ${b}` });
        break;
      }
      case 'worktree': {
        if (args[0] !== 'add') break;
        const b = valueOf(rest, ['-b', '-B']);
        const path = plain(
          rest.filter((w, i) => !['-b', '-B'].includes(rest[i - 1] ?? '')),
        )
          .filter(shown)
          .slice(1, 2);
        out.push({
          kind: 'worktree',
          op: `git worktree add${path.length ? ` ${path[0]}` : ''}${b && shown(b) ? ` (new branch ${b})` : ''}`,
        });
        break;
      }
      case 'cherry-pick': {
        if (has('--abort', '--quit', '--skip')) break;
        if (has('--continue')) {
          out.push({ kind: 'cherry-pick', op: 'git cherry-pick --continue' });
          break;
        }
        const n = args.length;
        out.push({
          kind: 'cherry-pick',
          op: `git cherry-pick ${n === 1 ? args[0]!.slice(0, 12) : `${n} commits`}`,
        });
        break;
      }
      case 'commit':
        if (has('--amend')) out.push({ kind: 'history', op: 'git commit --amend' });
        else if (rest.some((w) => w.startsWith('--fixup')))
          out.push({ kind: 'history', op: 'git commit --fixup' });
        break;
      case 'rebase':
        if (has('--abort', '--quit')) break;
        out.push({
          kind: 'history',
          op: has('--continue')
            ? 'git rebase --continue'
            : `git rebase${has('-i', '--interactive') ? ' -i' : ''}${args.length ? ` ${args[0]}` : ''}`,
        });
        break;
      case 'revert':
        if (has('--abort', '--quit')) break;
        out.push({
          kind: 'history',
          op: `git revert${args.length ? ` ${args[0]!.slice(0, 12)}` : ''}`,
        });
        break;
      case 'reset':
        if (has('--hard', '--soft', '--mixed') && args.length)
          out.push({
            kind: 'history',
            op: `git reset ${rest.find((w) => ['--hard', '--soft', '--mixed'].includes(w))} ${args[0]}`,
          });
        break;
      case 'add': {
        const all =
          has('-A', '--all', '-u', '--update') ||
          args.includes('.') ||
          args.includes('*');
        if (all) out.push({ kind: 'stage', op: 'git add (all changes)' });
        else if (args.length)
          out.push({
            kind: 'stage',
            op: `git add ${args.slice(0, 4).join(' ')}${args.length > 4 ? ` (+${args.length - 4} more)` : ''}`,
          });
        break;
      }
    }
  }
  return out;
}
