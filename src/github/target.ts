/**
 * The one GitHub repository a run targets. `context`, `doctor` and `publish`
 * all ask here, and every `gh` call that reads or writes PRs passes the answer
 * with `--repo`, so no command can drift to gh's own default repo.
 *
 * Choice: gh's default repo when it is one of this clone's remotes (a fork
 * clone with `gh repo set-default upstream` means "open the PR upstream"),
 * else origin. A default that matches no remote is stale and ignored.
 */
import { gh, git } from '../util/exec.ts';

export interface Target {
  /** `owner/name` every gh call is pointed at. */
  repo: string;
  /** origin's repo, where the branch is pushed. */
  origin?: string;
  /** What `gh repo view` reports without `--repo`, when it reports one. */
  ghDefault?: string;
}

const SLUG = /^[^/\s]+\/[^/\s]+$/;

export function parseGithubRemote(
  url: string,
): { owner: string; name: string } | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

const slug = (r: { owner: string; name: string } | undefined) =>
  r ? `${r.owner}/${r.name}` : undefined;

/** The target repo, or undefined when there is neither a GitHub origin nor a gh default. */
export function resolveTarget(
  cwd: string,
  opts: { offline?: boolean } = {},
): Target | undefined {
  const origin = slug(
    parseGithubRemote(git(cwd, ['remote', 'get-url', 'origin']).stdout),
  );
  let ghDefault: string | undefined;
  if (!opts.offline) {
    const r = gh(cwd, [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ]);
    const name = r.ok ? r.stdout.trim() : '';
    if (SLUG.test(name)) ghDefault = name;
  }
  let repo = origin;
  if (ghDefault) {
    const remotes = new Set(
      git(cwd, ['remote', '-v'])
        .stdout.split(/\r?\n/)
        .map((l) => slug(parseGithubRemote(l.split(/\s+/)[1] ?? ''))?.toLowerCase())
        .filter(Boolean),
    );
    if (remotes.has(ghDefault.toLowerCase()) || !origin) repo = ghDefault;
  }
  return repo ? { repo, origin, ghDefault } : undefined;
}

/** `--repo <target>` for a gh call, or nothing when no target is known. */
export function repoArgs(repo: string | undefined): string[] {
  return repo ? ['--repo', repo] : [];
}

/**
 * The `--head` for `gh pr create`/`pr view`: `owner:branch` when origin is a
 * fork of the target repo, else the bare branch. Without the owner, GitHub
 * looks for the branch in the target repository and refuses.
 */
export function prHead(
  branch: string,
  originOwner: string | undefined,
  baseRepo: string | undefined,
): string {
  const baseOwner = baseRepo?.split('/')[0];
  return originOwner && baseOwner && originOwner.toLowerCase() !== baseOwner.toLowerCase()
    ? `${originOwner}:${branch}`
    : branch;
}

/** One line telling the user where the PR goes, and why that may surprise them. */
export function targetLine(t: Target | undefined): string {
  if (!t) return 'PR target: unknown (no GitHub remote and no gh default repo).';
  const notes: string[] = [];
  if (t.origin && t.origin.toLowerCase() !== t.repo.toLowerCase())
    notes.push(`branch is pushed to ${t.origin}, a different repository`);
  if (t.ghDefault && t.ghDefault.toLowerCase() !== t.repo.toLowerCase())
    notes.push(`gh's default repo ${t.ghDefault} is not a remote of this clone, ignored`);
  return `PR target: ${t.repo}${notes.length ? ` (${notes.join('; ')})` : ''}.`;
}
