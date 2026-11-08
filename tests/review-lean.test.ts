import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { leanPacket, WHOLE_DIFF_CHARS } from '../src/commands/review.ts';
import {
  locateQuote,
  parseFindings,
  placeholderAgentId,
} from '../src/contribution/leanReview.ts';
import { lifecycle } from '../src/hook/lifecycle.ts';
import { publishProblem } from '../src/workflow/readiness.ts';
import { repository, tasks } from '../src/workflow/state.ts';
import { readLocal, writeLocal } from '../src/util/localJson.ts';
import { git } from '../src/util/exec.ts';
import { findRun } from '../src/run.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(180_000);

/** A patch file section with one hunk of the given new-file lines (all added). */
function section(file: string, start: number, added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},0 +${start},${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join('\n');
}

const testFile = section('tests/greet.test.ts', 1, [
  "import { greet } from '../src/greet.ts';",
  "test('greets by name', () => {",
  "  const name = 'Ada';",
  '  expect(greet(name)).toBe("hello Ada");',
  '});',
]);
const branchy = section('src/greet.ts', 1, [
  'export function greet(name?: string) {',
  "  if (!name) return 'hello';",
  '  return `hello ${name}`;',
  '}',
]);
const lock = section('bun.lock', 1, ['{ "lockfileVersion": 1 }']);

describe('lean review packet', () => {
  test('a small diff is shown whole, numbered, with tests reduced to assertions', () => {
    const patch = [branchy, testFile, lock].join('\n') + '\n';
    const body = [
      'Greets by name, or says hello when no name is given.',
      '',
      '## Validation',
      '',
      '- `bun test` passed.',
      '',
      '## Notes',
      '',
      'Nothing else.',
    ].join('\n');
    const input = {
      runId: 'r1',
      title: 'Greet by name',
      body,
      patch,
      fingerprint: 'abc123',
    };
    const packet = leanPacket(input);
    expect(packet.mode).toBe('whole');
    expect(leanPacket(input).text).toBe(packet.text); // deterministic
    const text = packet.text;
    expect(text).toContain('review-input fingerprint: abc123');
    expect(text).toContain('\n1 | Greets by name, or says hello when no name is given.');
    expect(text).toContain('\n9 | Nothing else.');
    expect(text).toContain('lines 3-6: generated Validation section, skipped');
    expect(text).not.toContain('`bun test` passed');
    // diff lines keep their changes.patch line numbers
    const lines = patch.split('\n');
    const ifLine = lines.findIndex((l) => l.includes('if (!name)')) + 1;
    expect(text).toContain(`${String(ifLine).padStart(2)} +  if (!name) return 'hello';`);
    expect(text).toContain('expect(greet(name)).toBe("hello Ada");');
    expect(text).not.toContain("const name = 'Ada'");
    expect(text).not.toContain('lockfileVersion');
    expect(text).toContain('Omitted files (generated, lock or version): bun.lock');
    expect(text).toMatch(
      /- H1 src\/greet\.ts diff:4-8 \| greet \| new: greet \| branches: 1/,
    );
    expect(text).toContain('(No evidence graph for this run');
  });

  test('a large diff keeps cited hunks, branching hunks and test assertions only', () => {
    const filler = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `export const value${i} = ${i}; // padding text`,
      );
    const quiet = section('src/quiet.ts', 1, filler(400));
    const named = section('src/named.ts', 1, ['export const named = 1;']);
    const patch = [quiet, branchy, named, testFile].join('\n') + '\n';
    expect(patch.length).toBeGreaterThan(WHOLE_DIFF_CHARS);
    const packet = leanPacket({
      runId: 'r2',
      title: 'Greet',
      body: 'Adds named.ts and a greeting.',
      patch,
      fingerprint: 'f',
    });
    expect(packet.mode).toBe('selected');
    expect(packet.diffChars).toBeGreaterThan(WHOLE_DIFF_CHARS);
    expect(packet.shownHunks.sort()).toEqual(['H2', 'H3', 'H4']);
    expect(packet.text).not.toContain('value399');
    expect(packet.text).toContain("if (!name) return 'hello';");
    expect(packet.text).toContain('export const named = 1;');
    expect(packet.text).toContain('toBe("hello Ada")');
    expect(packet.text).toMatch(/- H1 src\/quiet\.ts diff:\S+ .*\| no$/m);
  });
});

describe('lean review findings', () => {
  test('validation lists everything to fix', () => {
    let message = '';
    try {
      parseFindings({
        v: 1,
        reviewer: { agentId: 'a1' },
        findings: [
          { kind: 'claim', quote: 'x', verdict: 'wrong', evidence: 'diff:1', fix: 'y' },
          { kind: 'omission', verdict: 'missing', fix: 'z' },
          { kind: 'claim', verdict: 'overstated', evidence: 'CH1', fix: 'z' },
        ],
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('review-findings.json needs fixing');
    expect(message).toContain('findings[0].verdict "wrong" must be one of');
    expect(message).toContain('findings[1].evidence is missing');
    expect(message).toContain('findings[2].quote is required');
    expect(
      parseFindings({ v: 1, reviewer: { agentId: 'a1' }, findings: [] }).warnings,
    ).toEqual([]);
  });

  test('placeholder agent ids are recognized', () => {
    for (const id of [
      '',
      '<id>',
      'unknown',
      'reviewer',
      '<real id>',
      'agent-id',
      'Reviewer 1',
    ])
      expect(placeholderAgentId(id)).toBe(true);
    for (const id of ['a7c3e19f2b', '019a6e2c-7d4b-7f10-9c55-2b3f9d1e8a40', 'agent_8f2'])
      expect(placeholderAgentId(id)).toBe(false);
  });

  test('quotes are located exactly or loosely', () => {
    const body = 'First line.\nThe `greet` helper **always** says hello.\n';
    expect(locateQuote('always', 'T', body)).toEqual({ at: 'body:2', quote: 'always' });
    expect(locateQuote('greet helper always says hello', 'T', body)).toEqual({
      at: 'body:2',
      quote: 'The `greet` helper **always** says hello.',
    });
    expect(locateQuote('nowhere', 'T', body)).toBeUndefined();
  });
});

// End to end: render, packet, findings, import, render reports the review, publish allowed.
const CLI = resolve(import.meta.dir, '../src/cli.ts');
let previous: string | undefined;
let config: string;
beforeEach(() => {
  previous = process.env.TRACETOON_CONFIG;
  config = join(tempDir('tracetoon-lean-review-'), 'config.json');
  process.env.TRACETOON_CONFIG = config;
});
afterEach(() => {
  if (previous === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = previous;
});
const env = () => ({ ...process.env, CI: '', TRACETOON: '1' });
function cli(root: string, args: string[]) {
  const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env(),
      CLAUDE_CONFIG_DIR: join(dirname(config), 'claude'),
      CODEX_HOME: join(dirname(config), 'codex'),
      GEMINI_HOME: join(dirname(config), 'gemini'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      CODEX_THREAD_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
    },
  });
  let json: any;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = { error: result.stderr || result.stdout };
  }
  return { code: result.status, json };
}
function ok(root: string, ...args: string[]) {
  const r = cli(root, args);
  expect(r.json.error).toBeUndefined();
  expect(r.code).toBe(0);
  return r.json;
}

describe('lean review import', () => {
  test('review import writes a current review.json that lets publish proceed', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-lean-remote-');
    expect(git(remote, ['init', '-q', '--bare']).ok).toBe(true);
    expect(git(repo.root, ['remote', 'add', 'origin', remote]).ok).toBe(true);
    const p = { cwd: repo.root, session_id: 'lean-review' };
    lifecycle('codex', 'SessionStart', p, env());
    repo.commit(
      'src/greet.ts',
      "export function greet(name?: string) {\n  if (!name) return 'hello';\n  return `hello ${name}`;\n}\n",
      'Greet by name',
    );
    lifecycle(
      'codex',
      'PreToolUse',
      { ...p, tool_input: { command: 'gh pr create --fill' } },
      env(),
    );
    const run = findRun(
      repository(repo.root).gitDir,
      tasks(repository(repo.root).gitDir)[0]!.run.id,
    );
    ok(repo.root, 'digest', '--run', run.id, '--offline');
    ok(repo.root, 'context', '--run', run.id, '--offline');
    const request = readLocal<{
      fingerprint: string;
      sourceSeeds: { location: string; scope: string; sha256: string }[];
    }>(join(run.dir, 'guidance-request.json'))!;
    // Complete guidance (every seed collected, no gaps), so nothing but the review decides the status.
    writeLocal(join(run.dir, 'guidance.json'), {
      v: 1,
      requestFingerprint: request.fingerprint,
      researcher: { mode: 'inline' },
      sources: request.sourceSeeds.map((seed, i) => ({
        id: `src${i + 1}`,
        kind: 'repository',
        location: seed.location,
        scope: seed.scope,
        content: readFileSync(join(repo.root, seed.location), 'utf8'),
        sha256: seed.sha256,
        retrievedAt: '2026-01-01T00:00:00.000Z',
      })),
      requirements: [],
      gaps: [],
    });
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting always uses the given name.\n\nSee src/greet.ts.\n',
    );
    writeFileSync(join(run.dir, 'title.txt'), 'Greet by name');
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    const patch = readFileSync(join(run.dir, 'changes.patch'), 'utf8').split('\n');
    const ifLine = patch.findIndex((l) => l.includes('if (!name)')) + 1;
    expect(ifLine).toBeGreaterThan(0);
    writeLocal(join(run.dir, 'change-map.json'), {
      groups: [
        {
          idea: 'Greeting',
          behavior: 'Greets by name, else hello.',
          kind: 'behavior',
          paths: ['src/greet.ts'],
          behaviorChecks: [{ behavior: 'No name: hello', evidence: [`diff:${ifLine}`] }],
        },
      ],
    });
    const rendered = ok(repo.root, 'render', '--run', run.id, '--no-comic');

    const packet = ok(repo.root, 'review-packet', '--lean', '--run', run.id);
    expect(packet.path).toBe(join(run.dir, 'review-packet.md'));
    const text = readFileSync(packet.path, 'utf8');
    if (process.env.SHOW_PACKET) console.log(text);
    expect(packet.chars).toBe(text.length);
    expect(text).toContain(`review-input fingerprint: ${rendered.reviewFingerprint}`);
    expect(text).toMatch(/\d+ \| The greeting always uses the given name\./);
    expect(text).toContain("if (!name) return 'hello';");

    const findings = {
      v: 1,
      reviewer: { agentId: 'reviewer' },
      coldRead: { change: 'greet uses a name', start: 'src/greet.ts' },
      findings: [
        {
          kind: 'claim',
          quote: 'always uses the given name',
          verdict: 'overstated',
          evidence: `diff:${ifLine}`,
          fix: 'Say it falls back to "hello" when no name is given.',
        },
        {
          kind: 'omission',
          quote: 'The no-name fallback',
          verdict: 'missing',
          evidence: `src/greet.ts:2 | CH99`,
          fix: 'Mention the fallback.',
        },
      ],
    };
    writeLocal(join(run.dir, 'review-findings.json'), findings);
    // A placeholder id is refused, from the file or the flag.
    const refused = cli(repo.root, ['review', 'import', '--run', run.id]);
    expect(refused.code).not.toBe(0);
    expect(refused.json.error).toContain('not a real reviewer agent id');
    expect(
      cli(repo.root, ['review', 'import', '--run', run.id, '--agent-id', '<id>']).json
        .error,
    ).toContain('not a real reviewer agent id');
    // Invalid findings are refused with what to fix.
    writeLocal(join(run.dir, 'bad.json'), {
      ...findings,
      findings: [{ kind: 'claim', quote: 'x', verdict: 'nope', fix: 'y' }],
    });
    const bad = cli(repo.root, [
      'review',
      'import',
      '--run',
      run.id,
      '--findings',
      join(run.dir, 'bad.json'),
      '--agent-id',
      'a7c3e19f2b',
    ]);
    expect(bad.json.error).toContain('findings[0].verdict "nope"');
    expect(bad.json.error).toContain('findings[0].evidence is missing');

    const imported = ok(
      repo.root,
      'review',
      'import',
      '--run',
      run.id,
      '--agent-id',
      'a7c3e19f2b',
    );
    expect(imported.warnings.join(' ')).toContain('unknown evidence CH99');
    expect(imported.incomplete).toEqual([]);
    const review = readLocal<any>(join(run.dir, 'review.json'))!;
    expect(review.v).toBe(2);
    expect(review.inputFingerprint).toBe(rendered.reviewFingerprint);
    expect(review.drafter).toEqual({ mode: 'inline' });
    expect(review.reviewer).toEqual({ mode: 'delegated', agentId: 'a7c3e19f2b' });
    expect(review.bodyReview.claims[0]).toMatchObject({
      verdict: 'overstated',
      quote: 'always uses the given name',
      evidence: [`diff:${ifLine}`],
    });
    expect(review.bodyReview.omissions[0].evidence[0]).toMatch(/^diff:/);
    expect(review.bodyReview.coverage).toEqual([{ checkpoint: 'B1.1', claims: ['F1'] }]);

    const after = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(after.contributionReview.issues).toEqual([
      'Inline fallback: drafting or review was performed without three independent host agents.',
    ]);
    expect(after.contributionReview.status).toBe('current');
    expect(after.contributionReview.bodyReview.claims).toHaveLength(1);
    expect(
      publishProblem(repo.root, run, readLocal(join(run.dir, 'approval.json'))!),
    ).toBeUndefined();

    // A body that no longer holds the quoted claim is refused, naming the quote.
    writeFileSync(join(run.dir, 'body.md'), 'Greets people.\n\nSee src/greet.ts.\n');
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    const stale = cli(repo.root, [
      'review',
      'import',
      '--run',
      run.id,
      '--agent-id',
      'a7c3e19f2b',
    ]);
    expect(stale.json.error).toContain(
      '"always uses the given name" is not in the reviewed',
    );

    // Without contributor guidance (the reviewed brief path's usual state) the
    // imported review is incomplete, which still lets publish proceed.
    rmSync(join(run.dir, 'guidance.json'));
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting always uses the given name.\n\nSee src/greet.ts.\n',
    );
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    const again = ok(
      repo.root,
      'review',
      'import',
      '--run',
      run.id,
      '--agent-id',
      'a7c3e19f2b',
    );
    expect(again.incomplete.join(' ')).toContain('no guidance.json');
    const last = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(last.contributionReview.status).toBe('incomplete');
    expect(
      publishProblem(repo.root, run, readLocal(join(run.dir, 'approval.json'))!),
    ).toBeUndefined();
  });
});
