/** The evidence record: decisions as recorded, runs with honest outcomes, file roles. */
import { describe, expect, test } from 'bun:test';
import {
  commandRun,
  commandRuns,
  fileRole,
  runOutcome,
  verificationSegment,
} from '../src/digest/build.ts';
import { decisionQuestions } from '../src/trace/claude.ts';

describe('decisions', () => {
  const qs = [
    {
      question: 'Where should the comic go?',
      options: [{ label: 'After the description' }, { label: 'At the top' }],
    },
    {
      question: 'Ask the human?',
      options: [{ label: 'When gaps found' }, { label: 'Never' }],
    },
  ];

  test('keeps the options and the exact answer; unpicked options are only unpicked', () => {
    const d = decisionQuestions(qs, {
      answers: {
        'Where should the comic go?': 'After the description',
        'Ask the human?': "I'm not sure, research it more",
      },
    });
    expect(d[0]).toEqual({
      question: 'Where should the comic go?',
      options: ['After the description', 'At the top'],
      answer: 'After the description',
      ownWords: false,
    });
    // A free-text answer is the user's own words, not a choice of any option.
    expect(d[1]!.ownWords).toBe(true);
    expect(d[1]!.answer).toBe("I'm not sure, research it more");
  });

  test('no answers recorded: questions kept, answer unknown', () => {
    const d = decisionQuestions(qs, {});
    expect(d[0]!.answer).toBeUndefined();
    expect(d[0]!.ownWords).toBeUndefined();
  });
});

describe('verification runs', () => {
  test('recognizes checks inside chains, and their kind', () => {
    expect(
      verificationSegment('cd x && bun test tests/a.test.ts 2>&1 | tail -3')?.kind,
    ).toBe('test');
    expect(verificationSegment('bun x tsc --noEmit 2>&1 | head')?.kind).toBe('typecheck');
    expect(verificationSegment('bun x prettier --check "src/**/*.ts"')?.kind).toBe(
      'lint',
    );
    expect(verificationSegment('bun run bundle')?.kind).toBe('build');
    expect(verificationSegment('bun scripts/eval-summaries.ts')?.kind).toBe('eval');
    expect(verificationSegment('git status && ls')).toBeUndefined();
    expect(verificationSegment(`python -c "print('bun test')"`)).toBeUndefined();
  });

  test('exit status counts only when nothing after the check hides it', () => {
    expect(
      runOutcome('bun test', 'bun test', false, '96 pass\n0 fail', 'test'),
    ).toMatchObject({
      outcome: 'passed',
      basis: 'exit status',
    });
    expect(
      runOutcome('bun test && git commit -m x', 'bun test', true, '', 'test'),
    ).toMatchObject({
      outcome: 'failed',
      basis: 'exit status',
    });
  });

  test('two test commands sharing one output: both listed, outcome unknown', () => {
    const r = commandRun(
      'git stash -q; bun test tests/a.test.ts -t x 2>&1 | grep fail; git stash pop -q && bun test > out.log 2>&1; grep pass out.log',
      false,
      ' 0 pass\n 1 fail\n 147 pass\n 0 fail',
    );
    expect(r).toMatchObject({ kind: 'test', outcome: 'unknown', basis: 'none' });
    expect(r!.cmd).toContain('bun test tests/a.test.ts');
    expect(r!.cmd).toContain(' ; bun test');
    expect(commandRun('bun test', false, '96 pass\n0 fail')).toMatchObject({
      cmd: 'bun test',
      outcome: 'passed',
    });
  });

  test('every check in a chained command is its own run', () => {
    // Shape of a captured release check: bundle, tests into a log, then the eval.
    const runs = commandRuns(
      'bun run bundle 2>&1 | tail -2; bun test > /tmp/tt.log 2>&1; tail -3 /tmp/tt.log; bun scripts/eval-summaries.ts >/dev/null; grep "checks pass" report.md',
      false,
      'Bundled 4 modules\n 71 pass\n 0 fail\n**57/57 checks pass.**',
    );
    expect(runs.map((r) => r.kind)).toEqual(['build', 'test', 'eval']);
    expect(runs[1]).toMatchObject({ outcome: 'passed', summary: ['71 pass', '0 fail'] });
    expect(runs[2]).toMatchObject({
      outcome: 'passed',
      summary: ['**57/57 checks pass.**'],
    });
    // The test run no longer carries the eval's result line.
    expect(runs[1]!.summary.join(' ')).not.toContain('checks');
    const chained = commandRuns(
      'bun run bundle 2>&1 | tail -1 && bun x tsc --noEmit && bun test > /tmp/tt.log 2>&1; tail -2 /tmp/tt.log',
      false,
      'ok\n 96 pass\n 0 fail',
    );
    expect(chained.map((r) => [r.kind, r.cmd])).toEqual([
      ['build', 'bun run bundle 2>&1'],
      ['typecheck', 'bun x tsc --noEmit'],
      ['test', 'bun test > /tmp/tt.log 2>&1'],
    ]);
    // A failure in a chain of checks can't be pinned on one of them.
    expect(
      commandRuns('bun x tsc --noEmit && bun test', true, '').every(
        (r) => r.outcome === 'unknown',
      ),
    ).toBe(true);
    expect(commandRuns('bun x tsc --noEmit', true, '')[0]!.outcome).toBe('failed');
  });

  test('a silent type check with a hidden status remains unknown', () => {
    const piped = 'bun x tsc --noEmit 2>&1 | head -5';
    expect(runOutcome(piped, 'bun x tsc --noEmit', false, '', 'typecheck')).toMatchObject(
      {
        outcome: 'unknown',
      },
    );
    expect(
      runOutcome(
        piped,
        'bun x tsc --noEmit',
        false,
        "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
        'typecheck',
      ).outcome,
    ).not.toBe('passed');
  });

  test('a pipe or ; hides the status: judge by output, or admit we do not know', () => {
    const piped = 'bun test 2>&1 | tail -3';
    expect(
      runOutcome(piped, 'bun test', false, ' 95 pass\n 1 fail', 'test'),
    ).toMatchObject({
      outcome: 'failed',
      basis: 'output',
    });
    expect(
      runOutcome(piped, 'bun test', false, ' 96 pass\n 0 fail', 'test'),
    ).toMatchObject({
      outcome: 'passed',
      basis: 'output',
      summary: ['96 pass', '0 fail'],
    });
    // A later grep failing is not the test failing.
    expect(
      runOutcome('bun test > log; grep FAIL log', 'bun test > log', true, '', 'test'),
    ).toMatchObject({
      outcome: 'unknown',
      basis: 'none',
    });
    // Silence alone does not establish success when a pipe hid the exit status.
    expect(
      runOutcome(
        'bun x tsc --noEmit 2>&1 | head',
        'bun x tsc --noEmit 2>&1',
        false,
        '',
        'typecheck',
      ),
    ).toMatchObject({
      outcome: 'unknown',
      basis: 'none',
    });
  });
});

describe('file roles', () => {
  test('roles from paths', () => {
    expect(fileRole('src/util/shell.ts')).toBe('behavior');
    expect(fileRole('tests/shell.test.ts')).toBe('tests');
    expect(fileRole('plugin/skills/tracetoon/dist/tracetoon.mjs')).toBe('generated');
    expect(fileRole('README.md')).toBe('docs');
    expect(fileRole('.github/workflows/ci.yml')).toBe('config');
    expect(fileRole('plugin/skills/tracetoon/VERSION')).toBe('version');
    expect(fileRole('bun.lock')).toBe('generated');
  });
});

describe('commit detection needs a real commit line', () => {
  test('a SHA inside a printed file is not a commit, even next to git pull', async () => {
    const { commitLine } = await import('../src/correlate/correlate.ts');
    const re = commitLine('0723dbf81e1d');
    expect(re.test("    base: '0723dbf^',\n    head: '0723dbf',")).toBe(false);
    expect(re.test('[main 0723dbf] Add fast contact play')).toBe(true);
    expect(re.test('0723dbf Add fast contact play')).toBe(true);
    expect(re.test('Updating 1b2c3d4..0723dbf\nFast-forward')).toBe(true);
  });
});

describe('plans', () => {
  test('the submitted plan text wins over a stale input', async () => {
    const { ClaudeLog } = await import('./helpers.ts');
    const { parseClaudeLines } = await import('../src/trace/claude.ts');
    const log = new ClaudeLog('/repo').plan('# Old draft', true, '# Final plan');
    const s = { records: [] as any[], unknownTypes: {} } as any;
    parseClaudeLines(log.text(), s);
    expect(s.records.find((r: any) => r.kind === 'plan')?.markdown).toBe('# Final plan');
  });
});
