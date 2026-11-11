/**
 * Ground truth for a PR from git: which repo, which branches, which commits, and
 * exactly which lines the PR adds. Everything else is matched against this.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gh, git } from '../util/exec.ts';
import {
  parseGithubRemote as parseRemote,
  prHead,
  repoArgs,
  resolveTarget,
  type Target,
} from '../github/target.ts';
import { privateRepoPath, readSubmittedFile, repoPath } from '../util/repoFiles.ts';

export interface Commit {
  sha: string;
  subject: string;
  /** Commit-only explanations are attributed source material, not observed behavior. */
  body?: string;
  authorTime: number;
  commitTime: number;
  trailers: Record<string, string[]>;
}

export interface FileChange {
  /** Repo-relative, forward slashes. */
  path: string;
  added: string[];
  removed: string[];
  /** Line number (in the new file) of each entry in `added`, when known. */
  addedAt?: number[];
}

export interface ExistingPr {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  state: string;
}

export interface PrTruth {
  /** Resolved once with repository identity, so repeated reads describe one commit. */
  headSha?: string;
  toplevel: string;
  gitDir: string;
  /** The checkout plus every worktree of the same repo. */
  roots: string[];
  head: string;
  base: string;
  mergeBase: string;
  /** Commit time of the merge base (ms), when it resolves to a commit. */
  mergeBaseTime?: number;
  /** Recent commits already in the base branch (newest first), to recognize earlier work. */
  baseCommits?: { sha: string; subject: string }[];
  commits: Commit[];
  files: FileChange[];
  /** True when there were no commits ahead of base and the working tree was used. */
  usedWorkingTree: boolean;
  dirty: boolean;
  remote?: { owner: string; name: string; url: string };
  /** The repository every gh call targets; set unless gh was skipped (`noGh`). */
  target?: Target;
  pr?: ExistingPr;
}

function must(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (!r.ok)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.code}`);
  return r.stdout.trim();
}

export function worktreeRoots(cwd: string): string[] {
  const r = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length)));
}

/**
 * Top level, git dir and branch in one git process (each costs ~0.1s on
 * Windows, and every command asks). An unborn branch reports "HEAD" with a
 * failing exit, exactly like `rev-parse --abbrev-ref HEAD` alone; `ok` keeps
 * that distinction for callers that require a commit.
 */
export function gitIdentity(
  cwd: string,
):
  | { toplevel: string; gitDir: string; branch: string; headSha?: string; ok: boolean }
  | undefined {
  const r = git(cwd, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    'HEAD',
    '--abbrev-ref',
    'HEAD',
  ]);
  const [toplevel, gitDir, headSha, branch] = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim());
  if (!toplevel || !gitDir) return undefined;
  return {
    toplevel: resolve(toplevel),
    gitDir: resolve(gitDir),
    branch: branch || 'HEAD',
    ...(/^[a-f0-9]{40,64}$/.test(headSha ?? '') ? { headSha } : {}),
    ok: r.ok,
  };
}

const BASE_CANDIDATES = ['main', 'master', 'trunk', 'develop'];

/** One `for-each-ref` for origin/HEAD and every base candidate, local and remote. */
function baseRefs(cwd: string, extra: string[] = []) {
  const names = [
    'refs/remotes/origin/HEAD',
    ...[...new Set([...BASE_CANDIDATES, ...extra])].flatMap((b) => [
      `refs/heads/${b}`,
      `refs/remotes/origin/${b}`,
    ]),
  ];
  const r = git(cwd, ['for-each-ref', '--format=%(refname)%09%(symref)', ...names]);
  const present = new Map<string, string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const [ref, symref] = line.split('\t');
    if (ref) present.set(ref, symref ?? '');
  }
  return present;
}

function chooseBase(refs: Map<string, string>): string {
  const sym = refs.get('refs/remotes/origin/HEAD');
  if (sym?.startsWith('refs/remotes/origin/'))
    return sym.slice('refs/remotes/origin/'.length);
  return BASE_CANDIDATES.find((b) => refs.has(`refs/heads/${b}`)) ?? 'main';
}

/** The branch PRs normally target: origin/HEAD, else main, else master. */
export function defaultBase(cwd: string): string {
  return chooseBase(baseRefs(cwd));
}

/** The ref to diff against: the remote-tracking base when it exists, else the local one. */
function baseRef(refs: Map<string, string>, base: string): string {
  return refs.has(`refs/remotes/origin/${base}`) ? `origin/${base}` : base;
}

export function existingPr(
  cwd: string,
  head: string,
  repo?: string,
  originOwner?: string,
): ExistingPr | undefined {
  const r = gh(cwd, [
    'pr',
    'view',
    // From a fork, the PR's head lives under the fork's owner.
    prHead(head, originOwner, repo),
    ...repoArgs(repo),
    '--json',
    'number,url,title,body,baseRefName,headRefName,state',
  ]);
  if (!r.ok) return undefined;
  try {
    const pr = JSON.parse(r.stdout) as ExistingPr;
    return pr.state === 'OPEN' || pr.state === 'DRAFT' ? pr : undefined;
  } catch {
    return undefined;
  }
}

function parseTrailers(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    (out[m[1]!] ??= []).push(m[2]!.trim());
  }
  return out;
}

export function commitsBetween(cwd: string, from: string, to: string): Commit[] {
  const r = git(cwd, [
    'log',
    '--reverse',
    '--no-merges', // merging the base in isn't part of the PR's own work
    '--format=%H%x1f%s%x1f%at%x1f%ct%x1f%(trailers:unfold,only)%x1f%b%x1e',
    `${from}..${to}`,
  ]);
  if (!r.ok) return [];
  return r.stdout
    .split('\x1e')
    .map((rec) => rec.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, at, ct, trailers, body] = rec.split('\x1f');
      return {
        sha: sha!,
        subject: subject ?? '',
        ...(body?.trim() ? { body: body.trim() } : {}),
        authorTime: Number(at) * 1000,
        commitTime: Number(ct) * 1000,
        trailers: parseTrailers(trailers ?? ''),
      };
    });
}

/** Parse `git diff -U0` output into per-file added/removed lines. */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | undefined;
  let oldPath: string | undefined;
  let inHunk = false;
  let newLine = 0;
  const hunkStart = (l: string) => Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      cur = undefined;
      oldPath = undefined;
      inHunk = false;
      continue;
    }
    // Binary files have no hunks; still count them as changed.
    const bin =
      /^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+?)|\/dev\/null) differ$/.exec(
        line,
      );
    if (bin) {
      const path = bin[2] ?? bin[1];
      if (path) files.push({ path, added: [], removed: [], addedAt: [] });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        oldPath = p === '/dev/null' ? undefined : p.replace(/^a\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        // A deleted file has `+++ /dev/null`: record it under its old path.
        const path = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
        if (path) {
          cur = { path, added: [], removed: [], addedAt: [] };
          files.push(cur);
        }
      } else if (line.startsWith('@@')) {
        inHunk = true;
        newLine = hunkStart(line);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      newLine = hunkStart(line);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) {
      cur.added.push(line.slice(1));
      cur.addedAt?.push(newLine++);
    } else if (line.startsWith('-')) cur.removed.push(line.slice(1));
    else if (line.startsWith(' ')) newLine++;
  }
  return files;
}

function untrackedAsAdded(cwd: string): FileChange[] {
  const r = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!r.ok) return [];
  const out: FileChange[] = [];
  for (const p of r.stdout.split('\0').filter(Boolean)) {
    if (!repoPath(p)) continue;
    try {
      const data = readSubmittedFile(cwd, p);
      const text = data.toString('utf8');
      out.push({
        path: p,
        added:
          data.includes(0) || !Buffer.from(text, 'utf8').equals(data)
            ? []
            : text.split(/\r?\n/),
        removed: [],
      });
    } catch {
      /* unreadable */
    }
  }
  return out;
}

export interface TruthOptions {
  base?: string;
  /** Skip the `gh pr view` lookup (tests, offline). */
  noGh?: boolean;
  /** Describe this commit or branch instead of the checkout (evaluations, past PRs). */
  head?: string;
}

export function prTruth(cwd: string, opts: TruthOptions = {}): PrTruth {
  const id = gitIdentity(cwd);
  if (!id) must(cwd, ['rev-parse', '--show-toplevel']); // throws the git error
  const { toplevel, gitDir } = id!;
  const headRef = opts.head
    ? must(toplevel, ['rev-parse', opts.head])
    : (id!.headSha ?? 'HEAD');
  if (!opts.head && !id!.ok) must(toplevel, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = opts.head ?? id!.branch;
  const target = opts.noGh ? undefined : resolveTarget(toplevel);
  const originOwner = parseRemote(
    git(toplevel, ['remote', 'get-url', 'origin']).stdout,
  )?.owner;
  const pr = opts.noGh
    ? undefined
    : existingPr(toplevel, head, target?.repo, originOwner);
  const known = opts.base ?? pr?.baseRefName;
  const refs = baseRefs(toplevel, known ? [known] : []);
  const base = known ?? chooseBase(refs);
  const ref = baseRef(refs, base);
  const mergeBase = git(toplevel, ['merge-base', ref, headRef]).stdout.trim() || ref;
  const commits = commitsBetween(toplevel, mergeBase, headRef);
  // The log starts at the merge base itself, so its first entry also gives the
  // merge base's commit time (one git process instead of two).
  const baseLog = git(toplevel, [
    'log',
    '-n',
    '200',
    '--format=%H%x1f%ct%x1f%s',
    mergeBase,
  ])
    .stdout.split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, ct, ...subject] = l.split('\x1f');
      return { sha: sha!, ct: Number(ct), subject: subject.join('\x1f') };
    });
  const mbt = baseLog[0]?.ct ?? NaN;
  const mergeBaseTime = Number.isFinite(mbt) && mbt > 0 ? mbt * 1000 : undefined;
  const baseCommits = baseLog.map(({ sha, subject }) => ({ sha, subject }));
  const dirty = opts.head
    ? false
    : git(toplevel, ['status', '--porcelain', '--untracked-files=no']).stdout.trim()
        .length > 0;
  const usedWorkingTree = commits.length === 0 && !opts.head;
  const diffArgs = usedWorkingTree
    ? ['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase]
    : ['diff', '-U0', '--no-color', '--no-ext-diff', mergeBase, headRef];
  let files = parseUnifiedDiff(git(toplevel, diffArgs).stdout);
  if (usedWorkingTree) files = files.concat(untrackedAsAdded(toplevel));
  files = files.filter((f) => !privateRepoPath(f.path));
  const roots = [...new Set([toplevel, ...worktreeRoots(toplevel)])];
  const url = git(toplevel, ['remote', 'get-url', 'origin']).stdout.trim();
  const parsed = url ? parseRemote(url) : undefined;
  return {
    toplevel,
    gitDir,
    roots,
    head,
    headSha: headRef,
    base,
    mergeBase,
    mergeBaseTime,
    baseCommits,
    commits,
    files,
    usedWorkingTree,
    dirty,
    remote: parsed ? { ...parsed, url } : undefined,
    target,
    pr,
  };
}

export function hasFile(toplevel: string, rel: string): boolean {
  return existsSync(join(toplevel, rel));
}
