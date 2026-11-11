import { expect, test } from 'bun:test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, tempDir } from './helpers.ts';
import { parseBodyReview } from '../src/contribution/bodyReview.ts';
import { executeCheck, checkReport } from '../src/workflow/checks.ts';
import { newRun } from '../src/run.ts';
import { repository } from '../src/workflow/state.ts';

test('shared preparation, immutable code snapshots and batch expansion preserve evidence', () => {
  const repo = makeRepo(),
    sha = repo.commit(
      'src/owner.ts',
      'export const chooseProvider = () => "local";\n',
      'Add provider choice',
    ),
    home = tempDir();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    GEMINI_HOME: join(home, 'gemini'),
    ANTIGRAVITY_HOME: join(home, 'antigravity'),
  };
  const cli = (...args: string[]) => {
    const program = process.env.TRACETOON_TEST_BINARY
      ? [process.env.TRACETOON_TEST_BINARY]
      : [
          process.execPath,
          process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts'),
        ];
    const result = spawnSync(program[0]!, [...program.slice(1), '--json', ...args], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const prepared = cli('prepare', '--offline');
  const roles = JSON.parse(readFileSync(prepared.rolePackets, 'utf8'));
  expect(roles.reviewerColdRead).toEqual(['title.txt', 'final-body.md']);
  const source = cli(
    'source',
    'src/owner.ts',
    '--run',
    prepared.run,
    '--revision',
    'head',
  );
  expect(source[0].revision).toBe(sha);
  expect(source[0].content).toContain('chooseProvider');
  // The base revision resolves to the full merge-base hash the digest records.
  const base = cli('source', 'README.md', '--run', prepared.run, '--revision', 'base');
  expect(base[0].revision).toMatch(/^[a-f0-9]{40}$/);
  expect(base[0].content).toContain('# demo');
  const expanded = cli('expand', `commit:${sha}`, `commit:${sha}`, '--run', prepared.run);
  expect(expanded).toHaveLength(2);
  expect(expanded[0].ref).toBe(`commit:${sha}`);
  const profiles = readFileSync(join(prepared.runDir, 'profiles.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(profiles.find((p) => p.stage === 'expand').counters['evidence.reads']).toBe(1);
}, 30000);
test('review v2 verifies exact clauses and accounts for every behavior checkpoint', () => {
  const body = 'The selector uses local by default, with a remote fallback.',
    review = {
      inferredChange: 'Default selection changed.',
      inferredStart: 'The selector.',
      transfer: { state: 'satisfied', reason: 'The body matches the source.' },
      claims: [
        {
          id: 'claim1',
          at: 'body:1',
          quote: 'uses local by default',
          claim: 'Local is the default.',
          kind: 'behavior',
          verdict: 'supported',
          evidence: ['diff:1'],
        },
      ],
      omissions: [],
      coverage: [{ checkpoint: 'B1.1', claims: ['claim1'] }],
    };
  expect(() =>
    parseBodyReview(review, () => true, { body, checkpoints: ['B1.1'] }),
  ).not.toThrow();
  expect(() =>
    parseBodyReview(
      { ...review, claims: [{ ...review.claims[0], quote: 'always uses remote' }] },
      () => true,
      { body, checkpoints: ['B1.1'] },
    ),
  ).toThrow('exact quote');
  expect(() =>
    parseBodyReview({ ...review, coverage: [] }, () => true, {
      body,
      checkpoints: ['B1.1'],
    }),
  ).toThrow('every behavior checkpoint');
  expect(() =>
    parseBodyReview(
      { ...review, claims: [...review.claims, ...review.claims] },
      () => true,
      { body, checkpoints: ['B1.1'] },
    ),
  ).toThrow('unique');
});
test('equivalent check aliases reuse execution and locked dependency edits invalidate receipts', () => {
  const repo = makeRepo(),
    run = newRun(repository(repo.root).gitDir);
  writeFileSync(join(repo.root, '.gitignore'), '.tracetoon-deps/\n');
  writeFileSync(
    join(repo.root, 'build-dependencies.json'),
    JSON.stringify({
      schema: 'tracetoon.build-dependencies/v1',
      showtail: { revision: 'a'.repeat(40) },
    }),
  );
  const dir = join(repo.root, '.tracetoon-deps', 'Showtail', 'packages', 'agent-traces');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'module.ts'), 'export const value = 1;');
  const command = [process.execPath, '-e', 'console.log("1 pass")'];
  const first = executeCheck(repo.root, run, { name: 'tests', command });
  expect(first.outcome).toBe('passed');
  const alias = executeCheck(repo.root, run, { name: 'full suite', command });
  expect(alias.reused).toBe(true);
  expect(alias.startedAt).toBe(first.startedAt);
  writeFileSync(join(dir, 'module.ts'), 'export const value = 2;');
  expect(checkReport(repo.root, run).every((c) => !c.current)).toBe(true);
}, 30000);
