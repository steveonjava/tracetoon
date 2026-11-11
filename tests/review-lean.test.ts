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
  type ImportContext,
  leanToReview,
  locateQuote,
  parseFindings,
  placeholderAgentId,
  resolveEvidence,
} from '../src/contribution/leanReview.ts';
import { patchHunks } from '../src/graph/build.ts';
import { reviewLine } from '../src/contribution/review.ts';
import {
  planFromOptions,
  planGate,
  planMissing,
} from '../src/contribution/reviewPlan.ts';
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

describe('lean review packet brief rows', () => {
  test('open limits, background and process rows reach the reviewer', () => {
    const brief = [
      {
        title: 'limits',
        columns: ['ref', 'change', 'kind', 'limit'],
        rows: [
          {
            ref: 'L1',
            change: ['CH2'],
            kind: 'open',
            limit: 'No user request was recorded for CH2.',
          },
        ],
      },
      {
        title: 'requests',
        columns: ['ref', 'kind', 'text', 'truncated'],
        rows: [{ ref: 'S3', kind: 'user request', text: 'Go ahead', truncated: null }],
      },
      {
        title: 'background',
        columns: ['ref', 'kind', 'text'],
        rows: [
          {
            ref: 'S1',
            kind: "why this work started: the session's first request",
            text: 'Make greetings configurable',
          },
          {
            ref: 'P1',
            kind: 'earlier plan (not approved as written) in the session',
            text: 'Limit v1',
          },
        ],
      },
      {
        title: 'process',
        columns: ['ref', 'kind', 'fact', 'cites'],
        rows: [
          {
            ref: 'PR3',
            kind: 'test',
            fact: '2 test run(s); 1 failed (R2); last R2 failed; no passing run recorded after the last commit.',
            cites: ['R2'],
          },
        ],
      },
    ];
    const text = leanPacket({
      runId: 'r3',
      title: 'Greet',
      body: 'Greets by name.',
      patch: branchy + '\n',
      fingerprint: 'f',
      brief,
    }).text;
    expect(text).toContain('- L1 [CH2]: No user request was recorded for CH2.');
    expect(text).toContain(
      `- S1 (why this work started: the session's first request): "Make greetings configurable"`,
    );
    expect(text).toContain(
      '- P1 (earlier plan (not approved as written) in the session): "Limit v1"',
    );
    expect(text).toContain(
      '- PR3 (test): 2 test run(s); 1 failed (R2); last R2 failed; no passing run recorded after the last commit.',
    );
    // background comes after requests, process last
    expect(text.indexOf('background (')).toBeGreaterThan(text.indexOf('requests ('));
    expect(text.indexOf('process (')).toBeGreaterThan(text.indexOf('background ('));
  });

  test('a review line names the reviewer model, or says it was not recorded', () => {
    const base = {
      status: 'current' as const,
      mode: 'delegated' as const,
      issues: [],
      guidanceStatus: 'current' as const,
      assessments: [],
      requirements: [],
      sources: [],
    };
    expect(reviewLine({ ...base, reviewerModel: 'sonnet' })).toContain(
      'Reviewer model: sonnet.',
    );
    expect(reviewLine({ ...base, reviewerModel: null })).toContain(
      'Reviewer model: not recorded.',
    );
    expect(reviewLine(base)).not.toContain('Reviewer model');
  });

  test('reviewer.model in the findings file must be a name', () => {
    const f = { v: 1, reviewer: { agentId: 'a1b2c3', model: '' }, findings: [] };
    expect(() => parseFindings(f)).toThrow('"reviewer.model" must be a model name');
    expect(
      parseFindings({ ...f, reviewer: { agentId: 'a1b2c3', model: 'sonnet' } }).findings
        .reviewer.model,
    ).toBe('sonnet');
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
    // No model given: render says so.
    expect(imported.reviewerModel).toBeNull();
    expect(after.contributionReview.reviewerModel).toBeNull();
    // --reviewer-model is recorded as reviewer.model; render reports it.
    const withModel = ok(
      repo.root,
      'review',
      'import',
      '--run',
      run.id,
      '--agent-id',
      'a7c3e19f2b',
      '--reviewer-model',
      'sonnet',
    );
    expect(withModel.reviewerModel).toBe('sonnet');
    expect(readLocal<any>(join(run.dir, 'review.json'))!.reviewer).toEqual({
      mode: 'delegated',
      agentId: 'a7c3e19f2b',
      model: 'sonnet',
    });
    const modelled = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(modelled.contributionReview.status).toBe('current');
    expect(modelled.contributionReview.reviewerModel).toBe('sonnet');

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

/** A task run rendered with a change map, ready for reviewer passes. */
function renderedRun() {
  const repo = makeRepo();
  const remote = tempDir('tracetoon-plan-remote-');
  expect(git(remote, ['init', '-q', '--bare']).ok).toBe(true);
  expect(git(repo.root, ['remote', 'add', 'origin', remote]).ok).toBe(true);
  const p = { cwd: repo.root, session_id: 'review-plan' };
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
  writeFileSync(
    join(run.dir, 'body.md'),
    'The greeting always uses the given name.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
  );
  writeFileSync(join(run.dir, 'title.txt'), 'Greet by name');
  ok(repo.root, 'render', '--run', run.id, '--no-comic');
  const patch = readFileSync(join(run.dir, 'changes.patch'), 'utf8').split('\n');
  const ifLine = patch.findIndex((l) => l.includes('if (!name)')) + 1;
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
  ok(repo.root, 'render', '--run', run.id, '--no-comic');
  const claim = (quote: string) => ({
    kind: 'claim',
    quote,
    verdict: 'overstated',
    evidence: `diff:${ifLine}`,
    fix: 'Qualify it.',
  });
  const findings = (agentId: string, ...items: unknown[]) => ({
    v: 1,
    reviewer: { agentId },
    findings: items,
  });
  return { repo, run, claim, findings };
}

describe('review plan', () => {
  test('plan options parse SKILL line values', () => {
    expect(planFromOptions({})).toBeUndefined();
    expect(
      planFromOptions({
        reviewPasses: '1',
        reviewLenses: 'none.',
        reviewerModel: 'same as the main agent',
        reviewerEffort: 'default',
      }),
    ).toEqual({ v: 1, passes: 1, lenses: [] });
    expect(
      planFromOptions({
        reviewLenses: 'a, b, c.',
        reviewerEffort: 'xhigh',
        reviewerModel: 'terra',
      }),
    ).toEqual({
      v: 1,
      passes: 1,
      lenses: ['a', 'b', 'c'],
      reviewerModel: 'terra',
      reviewerEffort: 'xhigh',
    });
    expect(() => planFromOptions({ reviewLenses: 'e' })).toThrow('Unknown review lens');
    expect(() => planFromOptions({ reviewerEffort: 'turbo' })).toThrow(
      'Unknown reviewer effort',
    );
    expect(() => planFromOptions({ reviewPasses: '0' })).toThrow('Review passes');
  });

  test('missing passes, lenses, model and effort are listed', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const plan = {
      v: 1 as const,
      passes: 1,
      lenses: ['a', 'b'] as ('a' | 'b')[],
      reviewerModel: 'sonnet',
    };
    expect(planMissing({ v: 1, passes: 1, lenses: [] }, [])).toEqual([]);
    expect(planMissing(undefined, [])).toEqual([]);
    const one = [
      {
        pass: 1,
        agentId: 'r1',
        lens: 'a' as const,
        model: 'sonnet',
        findings: 0,
        importedAt: at,
      },
    ];
    const missing = planMissing(plan, one);
    expect(missing.join('\n')).toContain(
      '1 of 2 imported from distinct reviewer agent ids',
    );
    expect(missing.join('\n')).toContain('lens b');
    // The same agent for both lenses does not count twice.
    const same = [...one, { ...one[0]!, pass: 2, lens: 'b' as const }];
    expect(planMissing(plan, same).join('\n')).toContain('lens b');
    const both = [
      ...one,
      { pass: 2, agentId: 'r2', lens: 'b' as const, findings: 1, importedAt: at },
    ];
    expect(planMissing(plan, both)).toEqual([
      'reviewer model sonnet: pass 2 (not recorded) — start that reviewer with reviewer model sonnet and import it with --reviewer-model sonnet',
    ]);
    expect(planMissing(plan, [one[0]!, { ...both[1]!, model: 'sonnet' }])).toEqual([]);
  });

  test('a lens packet leads with its checklist and drops rows the lens does not use', () => {
    const patch = [branchy, testFile].join('\n') + '\n';
    const brief = [
      {
        title: 'changes',
        rows: [{ change: 'CH1', where: ['src/greet.ts (greet)'], newSymbols: ['greet'] }],
      },
      {
        title: 'requests',
        rows: [{ ref: 'S1', kind: 'prompt', text: 'make greet take a name' }],
      },
      {
        title: 'limits',
        rows: [{ ref: 'L1', kind: 'open', limit: 'no test for the empty name' }],
      },
    ] as any;
    const base = {
      runId: 'r1',
      title: 'Greet',
      body: 'Adds greet.',
      patch,
      fingerprint: 'f',
      brief,
    };
    const plain = leanPacket(base).text;
    const a = leanPacket({ ...base, lens: 'a' }).text;
    const c = leanPacket({ ...base, lens: 'c' }).text;
    expect(plain).not.toContain('checklist');
    expect(a).toContain('## Lens A: place: checklist');
    expect(a).toContain('at most 6 findings');
    expect(a).toContain('CH1 where:');
    expect(a).not.toContain('make greet take a name');
    expect(a).not.toContain('no test for the empty name');
    expect(a.length).toBeLessThan(plain.length + 800);
    expect(c).toContain('Lens C: omissions');
    expect(c).toContain('make greet take a name');
    expect(c).toContain('no test for the empty name');
  });

  test('prepare-style plan: lens passes from distinct reviewers, model and effort enforced', () => {
    const { repo, run, claim, findings } = renderedRun();
    writeLocal(join(run.dir, 'review-plan.json'), {
      v: 1,
      passes: 1,
      lenses: ['a', 'b'],
      reviewerModel: 'sonnet',
      reviewerEffort: 'xhigh',
    });
    // render --check names the plan in its next step.
    const checked = ok(repo.root, 'render', '--check', '--run', run.id, '--no-comic');
    expect(checked.reviewPlan.required).toBe(2);
    expect(checked.reviewPlan.missing.join(' ')).toContain('lens a');
    const checkText = cli(repo.root, [
      'render',
      '--check',
      '--run',
      run.id,
      '--no-comic',
    ]);
    expect(checkText.code).toBe(0);
    ok(repo.root, 'render', '--run', run.id, '--no-comic');

    // A lens packet goes to its own file.
    const packet = ok(
      repo.root,
      'review-packet',
      '--lean',
      '--lens',
      'a',
      '--run',
      run.id,
    );
    expect(packet.path).toBe(join(run.dir, 'review-packet-a.md'));
    expect(readFileSync(packet.path, 'utf8')).toContain('Lens A: place');

    writeLocal(
      join(run.dir, 'review-findings-a.json'),
      findings('agent-a1', claim('always uses the given name')),
    );
    writeLocal(
      join(run.dir, 'review-findings-b.json'),
      findings('agent-b2', claim('previously only said hello')),
    );
    const base = ['review', 'import', '--run', run.id];
    // Lenses are required by the plan; an unknown lens or a wrong model is refused.
    expect(cli(repo.root, base).json.error).toContain('--lens <a|b>');
    expect(cli(repo.root, [...base, '--lens', 'c']).json.error).toContain(
      'not in this run',
    );
    expect(
      cli(repo.root, [...base, '--lens', 'a', '--reviewer-model', 'haiku']).json.error,
    ).toContain('names reviewer model sonnet, but this reviewer ran with haiku');
    expect(
      cli(repo.root, [
        ...base,
        '--lens',
        'a',
        '--reviewer-model',
        'sonnet',
        '--reviewer-effort',
        'low',
      ]).json.error,
    ).toContain('names reviewer effort xhigh');

    // Lens a imported without effort: recorded, flagged, publish refuses.
    const a = ok(repo.root, ...base, '--lens', 'a', '--reviewer-model', 'sonnet');
    expect(a.pass).toMatchObject({
      pass: 1,
      agentId: 'agent-a1',
      lens: 'a',
      model: 'sonnet',
      findings: 1,
    });
    expect(a.warnings.join(' ')).toContain('No reviewer effort recorded');
    expect(a.planMissing.join(' ')).toContain('lens b');
    const rendered = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(rendered.reviewPlan.missing.join(' ')).toContain('reviewer effort xhigh');
    const refused = cli(repo.root, ['publish', '--run', run.id]);
    expect(refused.code).not.toBe(0);
    expect(refused.json.error).toContain('review plan');
    expect(refused.json.error).toContain('lens b');

    // Re-importing the same reviewer and lens updates its pass, not a new one.
    const a2 = ok(
      repo.root,
      ...base,
      '--lens',
      'a',
      '--reviewer-model',
      'sonnet',
      '--reviewer-effort',
      'xhigh',
    );
    expect(a2.pass.pass).toBe(1);
    expect(a2.passes).toHaveLength(1);
    // Lens b by the same agent id does not satisfy the distinct-reviewer rule.
    const twin = ok(
      repo.root,
      ...base,
      '--lens',
      'b',
      '--agent-id',
      'agent-a1',
      '--reviewer-model',
      'sonnet',
      '--reviewer-effort',
      'xhigh',
    );
    expect(twin.warnings.join(' ')).toContain('distinct reviewer agents');
    expect(twin.planMissing.join(' ')).toContain('1 of 2');
    const b = ok(
      repo.root,
      ...base,
      '--lens',
      'b',
      '--pass',
      '2',
      '--reviewer-model',
      'sonnet',
      '--reviewer-effort',
      'xhigh',
    );
    expect(b.planMissing).toEqual([]);
    const review = readLocal<any>(join(run.dir, 'review.json'))!;
    expect(
      review.passes.map((p: any) => [p.pass, p.agentId, p.lens, p.model, p.effort]),
    ).toEqual([
      [1, 'agent-a1', 'a', 'sonnet', 'xhigh'],
      [2, 'agent-b2', 'b', 'sonnet', 'xhigh'],
    ]);
    // Both passes' findings are in the body review.
    expect(review.bodyReview.claims.map((c: any) => c.quote).sort()).toEqual([
      'always uses the given name',
      'previously only said hello',
    ]);
    const met = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(met.reviewPlan.missing).toEqual([]);
    expect(met.contributionReview.status).toMatch(/current|incomplete/);
    expect(planGate(run)).toBeUndefined();

    // The correction: lens b's claim is fixed; --rebind binds review.json to the new render.
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting always uses the given name.\n\nSee src/greet.ts.\n',
    );
    const corrected = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(corrected.contributionReview.status).toBe('stale');
    const rebound = ok(repo.root, ...base, '--rebind');
    expect(rebound.pass).toBeUndefined();
    expect(rebound.warnings.join(' ')).toContain('Pass 2: 1 claim finding(s)');
    const after = readLocal<any>(join(run.dir, 'review.json'))!;
    expect(after.passes).toHaveLength(2);
    expect(after.bodyReview.claims.map((c: any) => c.quote)).toEqual([
      'always uses the given name',
    ]);
    const final = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(final.contributionReview.status).toMatch(/current|incomplete/);
    expect(final.reviewPlan.missing).toEqual([]);
  });

  test('without a plan, passes accumulate but nothing new is required', () => {
    const { repo, run, claim, findings } = renderedRun();
    writeLocal(
      join(run.dir, 'review-findings.json'),
      findings('agent-x1', claim('always uses the given name')),
    );
    const first = ok(repo.root, 'review', 'import', '--run', run.id);
    expect(first.pass.pass).toBe(1);
    expect(first.planMissing).toEqual([]);
    writeLocal(join(run.dir, 'review-findings.json'), findings('agent-x2'));
    const second = ok(repo.root, 'review', 'import', '--run', run.id);
    expect(second.pass.pass).toBe(2);
    const review = readLocal<any>(join(run.dir, 'review.json'))!;
    expect(review.reviewer.agentId).toBe('agent-x2');
    expect(review.passes.map((p: any) => p.agentId)).toEqual(['agent-x1', 'agent-x2']);
    expect(planGate(run)).toBeUndefined();
    const rendered = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(rendered.reviewPlan).toBeUndefined();
  });

  test('render notes claim flags still verbatim after the correction round', () => {
    const { repo, run, claim, findings } = renderedRun();
    writeLocal(
      join(run.dir, 'review-findings.json'),
      findings(
        'agent-c1',
        claim('always uses the given name'),
        claim('previously only said hello'),
      ),
    );
    ok(repo.root, 'review', 'import', '--run', run.id);
    // Before any correction the body is the one reviewed: nothing to note.
    expect(
      ok(repo.root, 'render', '--run', run.id, '--no-comic').reviewFlagsUnchanged,
    ).toBeUndefined();
    // The correction round fixed one flagged sentence and left the other as it was.
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting always uses the given name.\n\nWithout a name it says hello.\n\nSee src/greet.ts.\n',
    );
    const after = cli(repo.root, ['render', '--run', run.id, '--no-comic']);
    expect(
      after.json.reviewFlagsUnchanged.map((f: { quote: string }) => f.quote),
    ).toEqual(['always uses the given name']);
  });

  test('two passes without lenses need two distinct reviewers', () => {
    const { repo, run, findings } = renderedRun();
    writeLocal(join(run.dir, 'review-plan.json'), { v: 1, passes: 2, lenses: [] });
    writeLocal(join(run.dir, 'review-findings.json'), findings('agent-p1'));
    ok(repo.root, 'review', 'import', '--run', run.id);
    expect(planGate(run)).toContain('1 of 2 imported from distinct reviewer agent ids');
    const checked = cli(repo.root, ['render', '--run', run.id, '--no-comic']);
    expect(checked.json.reviewPlan.missing.join(' ')).toContain(
      '1 more fresh reviewer pass',
    );
    writeLocal(join(run.dir, 'review-findings.json'), findings('agent-p2'));
    ok(repo.root, 'review', 'import', '--run', run.id);
    expect(planGate(run)).toBeUndefined();
  });
});

describe('review import evidence', () => {
  const patch = [branchy, testFile].join('\n') + '\n';
  const lines = patch.split('\n').length;
  const body = [
    'Greets by name, or says hello when no name is given.',
    '',
    '- `bun test` passed.',
  ].join('\n');
  const ctx = (): ImportContext => ({
    title: 'Greet by name',
    body,
    patch,
    hunks: patchHunks(patch),
    brief: [
      {
        title: 'changes',
        columns: [],
        rows: [{ change: 'CH1', diff: ['diff:5-8'] }],
      },
      {
        title: 'limits',
        columns: [],
        rows: [{ ref: 'L1', change: 'CH1', limit: 'No request recorded.' }],
      },
      {
        title: 'process',
        columns: [],
        rows: [
          {
            ref: 'PR3',
            kind: 'test',
            fact: '`bun test` failed in the first run, then passed (failing to passing).',
          },
        ],
      },
      {
        title: 'commitMessages',
        columns: [],
        rows: [{ ref: 'abc1234def56#2', text: 'Tests pass.' }],
      },
    ],
    contractRef: (ref) => {
      const d = /^diff:(\d+)(?:-(\d+))?$/.exec(ref);
      if (d) return Number(d[2] ?? d[1]) <= lines;
      const b = /^body:(\d+)(?:-(\d+))?$/.exec(ref);
      if (b) return Number(b[2] ?? b[1]) <= body.split('\n').length;
      return ref === 'title' || ref === 'commit:abc1234def56';
    },
    fileExists: (p) => p === 'README.md',
    checkpoints: [{ id: 'B1.1', evidence: ['diff:6'] }],
  });

  test('brief refs, commit refs, repo lines, packet lines and quotes are kept', () => {
    const ev = resolveEvidence(
      [
        'PR3 | abc1234def56#2 | brief:CH1 | H1-H2 | README.md:4 | review-packet-a.md:371 | B1.1',
        'the brief process row says "failed in the first run, then passed"',
        'says hello when no name is given',
      ],
      ctx(),
    );
    expect(ev.invalid).toEqual([]);
    expect(ev.unparsed).toEqual([]);
    expect(ev.contract).toEqual([
      'commit:abc1234def56',
      'diff:5-8',
      'diff:4-8',
      'diff:12-17',
      'diff:6',
      'body:1',
    ]);
    expect(ev.notes).toEqual([
      'PR3',
      'abc1234def56#2',
      'README.md:4',
      'review-packet-a.md:371',
      'B1.1',
      'brief quote "failed in the first run, then passed"',
    ]);
  });

  test('only unknown refs and prose that matches nothing are left out', () => {
    const ev = resolveEvidence(
      ['CH99 | PR42 | diff:999', 'some words the reviewer made up here', 'nonsense'],
      ctx(),
    );
    expect(ev.contract).toEqual([]);
    expect(ev.invalid).toEqual(['CH99', 'PR42', 'diff:999', 'nonsense']);
    expect(ev.unparsed).toEqual(['some words the reviewer made up here']);
    // Prose around a ref keeps the ref and drops the words silently.
    const mixed = resolveEvidence('brief ref Process rows PR3 build last result', ctx());
    expect(mixed.notes).toEqual(['PR3']);
    expect(mixed.invalid).toEqual([]);
    expect(mixed.unparsed).toEqual([]);
  });

  test('an omission with brief evidence but no diff line stays in review.json', () => {
    const { review, warnings } = leanToReview(
      {
        v: 1,
        reviewer: { agentId: 'a7c3e19f2b' },
        findings: [
          {
            kind: 'omission',
            quote: 'The failing-then-passing test history',
            verdict: 'missing',
            evidence: 'PR3',
            fix: 'Say the tests failed first, then passed.',
          },
          {
            kind: 'omission',
            quote: 'Something vague',
            verdict: 'missing',
            evidence: 'words that match nothing anywhere at all',
            fix: 'x',
          },
        ],
      } as any,
      'a7c3e19f2b',
      'fp',
      ctx(),
    );
    expect(review.bodyReview!.omissions).toEqual([
      {
        behavior: 'The failing-then-passing test history',
        evidence: [`diff:1-${lines}`],
        correction: 'Say the tests failed first, then passed. [evidence: PR3]',
      },
    ]);
    expect(warnings.join(' ')).toContain('F1: omission cites no diff line');
    expect(warnings.join(' ')).toContain('F2: evidence "words that match nothing');
    expect(review.bodyReview!.transfer.reason).toContain('Something vague');
  });
});

describe('general reviewers alongside lenses', () => {
  test('a plan with more passes than lenses is met by one lens pass plus one general pass', async () => {
    const { planFromOptions, planMissing } =
      await import('../src/contribution/reviewPlan.ts');
    const plan = planFromOptions({
      reviewPasses: '2',
      reviewLenses: 'd',
      reviewerEffort: 'xhigh',
    })!;
    const pass = (agentId: string, lens?: string) =>
      ({
        pass: 1,
        agentId,
        effort: 'xhigh',
        findings: 1,
        importedAt: '',
        ...(lens ? { lens } : {}),
      }) as any;
    expect(planMissing(plan, [pass('g1')])).not.toEqual([]);
    expect(planMissing(plan, [pass('g1'), pass('d1', 'd')])).toEqual([]);
  });
});
