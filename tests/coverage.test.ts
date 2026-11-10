import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitOpsOf } from '../src/digest/gitOps.ts';
import { landingRows, scopeRows } from '../src/graph/coverage.ts';
import { withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import { briefParts, nearDuplicate, REDIRECT } from '../src/graph/queries.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(60_000);

const N = (label: any, id: string, props: Record<string, any>) => ({ label, id, props });
const R = (type: any, from: [any, string], to: [any, string], props?: any) => ({
  type,
  from: { label: from[0], id: from[1] },
  to: { label: to[0], id: to[1] },
  ...(props ? { props } : {}),
});
const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const graphOf = (nodes: any[], rels: any[] = []): EvidenceGraph => ({
  schema: GRAPH_SCHEMA,
  nodes,
  rels,
  stats: { nodes: 0, rels: 0, hunks: 0, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
});
const session = (props: Record<string, any> = {}) =>
  N('Session', 'h:abc123', {
    band: 'included',
    agent: 'Claude Code',
    score: 1,
    ...props,
  });

describe('git operations read from session commands', () => {
  test('push, branch, worktree, cherry-pick, history and staging', () => {
    const ops = (c: string) => gitOpsOf(c).map((x) => [x.kind, x.op]);
    expect(ops('git push -u origin feat/retry')).toEqual([
      ['push', 'git push origin feat/retry'],
    ]);
    expect(ops('git push --force-with-lease')).toEqual([['push', 'git push --force']]);
    expect(ops('git push --dry-run origin x')).toEqual([]);
    expect(ops('git -C ../repo checkout -b fix/a && git switch -c fix/b')).toEqual([
      ['branch', 'git checkout new branch fix/a'],
      ['branch', 'git switch new branch fix/b'],
    ]);
    expect(ops('git checkout main')).toEqual([]);
    expect(ops('git worktree add ../wt -b topic')).toEqual([
      ['worktree', 'git worktree add ../wt (new branch topic)'],
    ]);
    expect(ops('git cherry-pick abc1234 def5678')).toEqual([
      ['cherry-pick', 'git cherry-pick 2 commits'],
    ]);
    expect(ops('git cherry-pick --abort')).toEqual([]);
    expect(ops('git commit --amend --no-edit; git rebase -i main')).toEqual([
      ['history', 'git commit --amend'],
      ['history', 'git rebase -i main'],
    ]);
    expect(ops('git commit -m "fix"')).toEqual([]);
    expect(ops('git add -A && git commit -m x')).toEqual([
      ['stage', 'git add (all changes)'],
    ]);
    expect(ops('git add src/a.ts src/b.ts')).toEqual([
      ['stage', 'git add src/a.ts src/b.ts'],
    ]);
    expect(ops('gh pr checks --watch')).toEqual([['ci', 'gh pr checks']]);
    expect(ops('git status && git diff')).toEqual([]);
  });
});

describe('landing rows', () => {
  test('PR truth first, then the recorded git commands by kind', () => {
    const g = graphOf([
      session({
        gitOps: [
          'git switch new branch fix/a',
          'git add src/a.ts',
          'git commit --amend',
          'git push --force origin fix/a',
        ],
        gitKinds: ['branch', 'stage', 'history', 'push'],
        gitT: [t(1), t(2), t(3), t(4)],
      }),
      N('PrTruth', 'pr', {
        head: 'fix/a',
        base: 'main',
        usedWorkingTree: false,
        commits: 2,
      }),
    ]);
    const rows = withGraph(g, (e) => landingRows(e));
    expect(rows.map((r) => [r.ref, r.kind])).toEqual([
      ['LD1', 'pr'],
      ['LD2', 'push'],
      ['LD3', 'branch'],
      ['LD4', 'history'],
      ['LD5', 'staging'],
    ]);
    expect(rows[0]!.fact).toBe(
      'The PR proposes branch `fix/a` onto `main` with 2 commit(s).',
    );
    expect(String(rows[1]!.fact)).toContain(
      '`git push --force origin fix/a` with no error recorded',
    );
    expect(rows[1]!.cites).toEqual(['h:abc123']);
    expect(rows[4]!.fact).toBe('Only named files were staged: `git add src/a.ts`.');
  });

  test('no push in the logs is said as not recorded, never inferred', () => {
    const g = graphOf([
      session(),
      N('PrTruth', 'pr', {
        head: 'topic',
        base: 'main',
        usedWorkingTree: true,
        commits: 0,
      }),
    ]);
    const rows = withGraph(g, (e) => landingRows(e));
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.fact)).toBe(
      "The PR proposes branch `topic` onto `main` from uncommitted changes in the working tree; the session logs record no `git push`, so how the branch reached the remote isn't recorded.",
    );
    // No PR truth and no git commands: no rows (the section is left out).
    expect(withGraph(graphOf([session()]), (e) => landingRows(e))).toEqual([]);
  });
});

describe('scope limits', () => {
  const texts = (text: string) => [{ ref: 'S1', text }];
  const limits = (g: EvidenceGraph, text: string) =>
    withGraph(g, (e) => scopeRows(e, texts(text))).map((r) => String(r.limit));

  test('a platform named with no recorded run on it', () => {
    const g = graphOf([
      session(),
      N('PrTruth', 'pr', { head: 'x', base: 'main', os: 'linux' }),
    ]);
    expect(limits(g, 'Make the installer work on Windows too.')).toEqual([
      'Windows is named (per S1), but the record shows no run on it.',
    ]);
    // The host the sessions ran on is a run on it.
    expect(limits(g, 'Keep Linux paths working.')).toEqual([]);
    // A recorded command on the platform covers it.
    const ran = graphOf([session({ invoked: ['pwsh ./install.ps1'] })]);
    expect(limits(ran, 'Make the installer work on Windows too.')).toEqual([]);
    expect(limits(g, 'Run it in CI and on macOS.')).toEqual([
      'macOS, CI are named (per S1), but the record shows no run on them.',
    ]);
  });

  test('an effect claimed with no measurement, and a manual step', () => {
    const g = graphOf([session()]);
    expect(
      limits(
        g,
        'Cache the index so startup is faster. Existing users need to re-run init.',
      ),
    ).toEqual([
      'No measurement of the claimed effect is recorded: "Cache the index so startup is faster." (per S1); the effect was not measured in the record.',
      'Existing users or deployments may need a step the diff doesn\'t perform: "Existing users need to re-run init." (per S1).',
    ]);
    const measured = graphOf([session({ invoked: ['hyperfine ./bin/start'] })]);
    expect(limits(measured, 'Cache the index so startup is faster.')).toEqual([]);
    // A fix with a passing run recorded: nothing open.
    const passed = graphOf([
      session(),
      N('Run', 'R1', {
        cmd: 'bun test',
        kind: 'test',
        outcome: 'passed',
        session: 'h:abc123',
      }),
    ]);
    expect(limits(passed, 'Fixes the crash on empty input.')).toEqual([]);
    expect(limits(g, 'Fixes the crash on empty input.')).toEqual([
      'No passing run that shows the fix is recorded: "Fixes the crash on empty input." (per S1).',
    ]);
  });
});

describe('background coverage', () => {
  test('redirect cues and near-duplicate plans', () => {
    expect(REDIRECT.test("Don't touch the parser, change the caller instead")).toBe(true);
    expect(REDIRECT.test('No, use the existing helper')).toBe(true);
    expect(REDIRECT.test('Add a retry limit to fetch')).toBe(false);
    expect(
      nearDuplicate(
        '# Plan: add retry\n1. Add a limit',
        'Plan: add retry. 1. Add a limit',
      ),
    ).toBe(true);
    expect(
      nearDuplicate(
        'Add a retry limit to fetch calls',
        'Remove the cache from the index',
      ),
    ).toBe(false);
  });

  test('a correction from an earlier turn shows; a re-sent plan shows once', () => {
    const prompt = (id: string, n: number, text: string) =>
      N('Prompt', id, { t: t(n), text, pushback: false, session: 'h:abc123' });
    const plan = (id: string, n: number, approved: boolean) =>
      N('Plan', id, {
        t: t(n),
        approved,
        text: 'Retry plan',
        excerpt: 'Retry plan: add a limit to fetch and log each attempt',
        session: 'h:abc123',
      });
    const g = graphOf(
      [
        session(),
        prompt('S1', 1, 'Add retries to the fetch command'),
        prompt('S2', 2, "Don't retry on 4xx errors, only on timeouts"),
        prompt('S3', 4, 'Go ahead'),
        plan('P1', 2, false),
        plan('P2', 3, false),
        N('File', 'src/a.ts', { role: 'behavior', inPr: true, added: 1, removed: 0 }),
        N('Edit', 'E1', {
          t: t(5),
          file: 'src/a.ts',
          added: 1,
          removed: 0,
          surviving: 1,
          inPr: true,
          session: 'h:abc123',
        }),
        N('Hunk', 'H1', {
          file: 'src/a.ts',
          start: 1,
          end: 1,
          added: 1,
          removed: 0,
          diff: 'diff:1-3',
          conds: [],
          pairs: [],
        }),
        N('Change', 'CH1', {
          key: 'prompt:S3',
          files: ['src/a.ts'],
          roles: ['behavior'],
          symbols: [],
          added: 1,
          removed: 0,
          branches: 0,
        }),
      ],
      [
        ...['S1', 'S2', 'S3'].map((p) =>
          R('IN_SESSION', ['Prompt', p], ['Session', 'h:abc123']),
        ),
        R('IN_SESSION', ['Edit', 'E1'], ['Session', 'h:abc123']),
        R('IN_TURN', ['Plan', 'P1'], ['Prompt', 'S1']),
        R('IN_TURN', ['Plan', 'P2'], ['Prompt', 'S2']),
        R('IN_TURN', ['Edit', 'E1'], ['Prompt', 'S3']),
        R('SURVIVES_IN', ['Edit', 'E1'], ['Hunk', 'H1'], { lines: 1 }),
        R('OF', ['Hunk', 'H1'], ['File', 'src/a.ts']),
        R('HAS', ['Change', 'CH1'], ['Hunk', 'H1']),
        R('ASKED_BY', ['Change', 'CH1'], ['Prompt', 'S3'], {
          how: 'its edits survive here',
        }),
      ],
    );
    const rows = withGraph(g, (e) => briefParts(e)).sections.find(
      (s) => s.title === 'background',
    )!.rows;
    expect(rows.map((r) => [r.ref, r.kind])).toEqual([
      ['S1', "why this work started: the session's first request"],
      ['S2', 'user correction or redirect in an earlier turn of the session'],
      ['P2', 'earlier plan (not approved as written) in the session'],
    ]);
  });
});

describe('landing end to end', () => {
  test('a recorded push reaches the brief', () => {
    const claudeHome = tempDir('tracetoon-claude-');
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
    };
    const cli = (cwd: string, ...args: string[]) => {
      const r = spawnSync(
        process.execPath,
        [
          process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts'),
          ...args,
        ],
        { cwd, env, encoding: 'utf8', windowsHide: true },
      );
      return JSON.parse(r.stdout);
    };
    const repo = makeRepo();
    const body = 'export const limit = 3;\n';
    new ClaudeLog(repo.root)
      .prompt('Add a retry limit constant')
      .write(join(repo.root, 'src/limit.ts'), body)
      .bash('git add src/limit.ts && git commit -m "feat: limit"', '')
      .bash('git push -u origin feature', '')
      .save(claudeHome, 'landing');
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    writeFileSync(join(repo.root, 'src/limit.ts'), body);
    git(repo.root, ['add', '.']);
    git(repo.root, ['commit', '-q', '-m', 'feat: limit']);
    const d = cli(repo.root, '--json', 'digest', '--offline');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', d.run);
    const landing = b.sections.find((s: any) => s.title === 'landing').rows;
    expect(landing.map((r: any) => r.kind)).toEqual(['pr', 'push', 'staging']);
    expect(landing[1].fact).toContain('`git push origin feature`');
  });
});
