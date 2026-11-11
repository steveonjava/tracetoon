import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prHead } from '../src/commands/publish.ts';
import { checkEnvironment, checkSummary } from '../src/workflow/checks.ts';
import { makeRepo, tempDir } from './helpers.ts';

const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');

describe('PR head from a fork', () => {
  test('a fork names its owner; the base repo itself uses the bare branch', () => {
    expect(prHead('feat/x', 'octo', 'acme/demo')).toBe('octo:feat/x');
    expect(prHead('feat/x', 'Acme', 'acme/demo')).toBe('feat/x');
    // Unknown origin or base repo: no guess.
    expect(prHead('feat/x', undefined, 'acme/demo')).toBe('feat/x');
    expect(prHead('feat/x', 'octo', undefined)).toBe('feat/x');
  });
});

describe('check summaries', () => {
  test("a wrapper's total on stdout beats the last child's per-file lines on stderr", () => {
    const stderr =
      ' 5 pass\n 0 fail\nRan 5 tests across 1 file.\n 2 pass\n 0 fail\nRan 2 tests across 1 file.\n';
    const stdout = 'Source test files: 46 passed, 0 failed.\n';
    expect(checkSummary(stdout, stderr).at(-1)).toBe(
      'Source test files: 46 passed, 0 failed.',
    );
  });
  test('one stream keeps its last three result lines', () => {
    expect(
      checkSummary(
        '',
        ' 697 pass\n 0 fail\n 3384 expect() calls\nRan 697 tests across 46 files.\n',
      ),
    ).toEqual([' 697 pass', ' 0 fail', 'Ran 697 tests across 46 files.']);
    expect(checkSummary('12 passed, 1 failed\n', '')).toEqual(['12 passed, 1 failed']);
  });
});

describe('check environment identity', () => {
  test('temp-directory and terminal variables do not change it; PATH does', () => {
    const base = { PATH: '/usr/bin', HOME: '/home/u' };
    expect(
      checkEnvironment({ ...base, TMPDIR: '/var/tmp/a', TERM: 'xterm', COLUMNS: '80' }),
    ).toBe(checkEnvironment({ ...base, TMPDIR: '/tmp', TERM: 'tmux-256color' }));
    expect(checkEnvironment({ ...base, PATH: '/opt/bin:/usr/bin' })).not.toBe(
      checkEnvironment(base),
    );
  });
});

describe('receipts without task bookkeeping', () => {
  test('digest reads tracetoon check receipts for a run started by digest alone', () => {
    const repo = makeRepo();
    const scratch = tempDir('tracetoon-env-');
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: tempDir('tracetoon-claude-'),
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(scratch, 'config.json'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
    };
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
        cwd: repo.root,
        env,
        encoding: 'utf8',
      });
      return { code: r.status, json: JSON.parse(r.stdout || 'null'), stderr: r.stderr };
    };
    const first = cli('digest');
    expect(first.code).toBe(0);
    const run = first.json.run as string;
    const check = cli(
      'check',
      '--run',
      run,
      '--name',
      'unit',
      '--',
      process.execPath,
      '-e',
      'console.log("3 pass")',
    );
    expect(check.code).toBe(0);
    const again = cli('digest', '--run', run);
    expect(again.code).toBe(0);
    const digest = JSON.parse(
      readFileSync(join(again.json.runDir ?? first.json.runDir, 'digest.json'), 'utf8'),
    );
    expect(digest.verification).toEqual([
      expect.objectContaining({ id: 'V1', outcome: 'passed', summary: ['3 pass'] }),
    ]);
  });
});
