import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  changedLines,
  extractJson,
  rolloutModel,
  sessionIdFromEvents,
} from '../src/commands/reviewRun.ts';
import {
  CODEX_MODELS,
  planFromOptions,
  planGate,
  resolveCodexModel,
} from '../src/contribution/reviewPlan.ts';
import { graphNext } from '../src/commands/digest.ts';
import { lifecycle } from '../src/hook/lifecycle.ts';
import { findRun } from '../src/run.ts';
import { git } from '../src/util/exec.ts';
import { writeLocal } from '../src/util/localJson.ts';
import { repository, tasks } from '../src/workflow/state.ts';
import { makeRepo, tempDir } from './helpers.ts';

const CLI = resolve(import.meta.dir, '../src/cli.ts');
const FAKE = resolve(import.meta.dir, 'fake-codex-review.ts');
let previous: string | undefined;
let config: string;
let codexHome: string;
let log: string;
beforeEach(() => {
  previous = process.env.TRACETOON_CONFIG;
  config = join(tempDir('tracetoon-review-run-'), 'config.json');
  codexHome = join(dirname(config), 'codex');
  log = join(dirname(config), 'codex-log.jsonl');
  process.env.TRACETOON_CONFIG = config;
});
afterEach(() => {
  if (previous === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = previous;
});
const env = () => ({ ...process.env, CI: '', TRACETOON: '1' });

function cli(root: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env(),
      CLAUDE_CONFIG_DIR: join(dirname(config), 'claude'),
      CODEX_HOME: codexHome,
      GEMINI_HOME: join(dirname(config), 'gemini'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      TRACETOON_CODEX_BIN: FAKE,
      FAKE_CODEX_LOG: log,
      CODEX_THREAD_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      ...extra,
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
function ok(root: string, args: string[], extra: Record<string, string> = {}) {
  const r = cli(root, args, extra);
  expect(r.json.error).toBeUndefined();
  expect(r.code).toBe(0);
  return r.json;
}
const calls = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { args: string[]; prompt: string })
    : [];

/** A task run rendered and ready for reviewer passes. */
function renderedRun() {
  const repo = makeRepo();
  const remote = tempDir('tracetoon-run-remote-');
  expect(git(remote, ['init', '-q', '--bare']).ok).toBe(true);
  expect(git(repo.root, ['remote', 'add', 'origin', remote]).ok).toBe(true);
  const p = { cwd: repo.root, session_id: 'review-run' };
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
  ok(repo.root, ['digest', '--run', run.id, '--offline']);
  ok(repo.root, ['context', '--run', run.id, '--offline']);
  writeFileSync(
    join(run.dir, 'body.md'),
    'The greeting always uses the given name.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
  );
  writeFileSync(join(run.dir, 'title.txt'), 'Greet by name');
  ok(repo.root, ['render', '--run', run.id, '--no-comic']);
  const patch = readFileSync(join(run.dir, 'changes.patch'), 'utf8').split('\n');
  const ifLine = patch.findIndex((l) => l.includes('if (!name)')) + 1;
  const reply = (...quotes: string[]) =>
    JSON.stringify({
      v: 1,
      reviewer: { agentId: 'codex-exec' },
      coldRead: { change: 'Greets by name.', start: 'src/greet.ts' },
      findings: quotes.map((quote) => ({
        kind: 'claim',
        quote,
        verdict: 'overstated',
        evidence: `diff:${ifLine}`,
        fix: 'Qualify it.',
      })),
    });
  const plan = (extra: Record<string, unknown>) =>
    writeLocal(join(run.dir, 'review-plan.json'), {
      v: 1,
      passes: 1,
      lenses: [],
      ...extra,
    });
  return { repo, run, reply, plan };
}

describe('review run helpers', () => {
  test('model short names map to Codex ids; full ids pass through', () => {
    expect(CODEX_MODELS.terra).toBe('gpt-6.1-terra');
    expect(resolveCodexModel('Terra')).toBe('gpt-6.1-terra');
    expect(resolveCodexModel('luna')).toBe('gpt-6-luna');
    expect(resolveCodexModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });
  test('session id, rollout model, reply JSON and changed lines', () => {
    expect(
      sessionIdFromEvents([{ type: 'x' }, { type: 'thread.started', thread_id: 'abc' }]),
    ).toBe('abc');
    expect(sessionIdFromEvents([{ type: 'session.created', session_id: 'def' }])).toBe(
      'def',
    );
    expect(sessionIdFromEvents([{ type: 'turn.completed' }])).toBeUndefined();
    const rollout = [
      { type: 'session_meta', payload: { id: 's1', model: 'meta-model' } },
      { type: 'response_item', payload: { type: 'message' } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-terra' } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(rolloutModel(rollout)).toEqual({ id: 's1', model: 'gpt-6.1-terra' });
    expect(
      rolloutModel(
        [
          { type: 'session_meta', payload: { id: 's2' } },
          {
            type: 'event_msg',
            payload: {
              type: 'thread_settings_applied',
              thread_settings: { model: 'm2' },
            },
          },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n'),
      ),
    ).toEqual({ id: 's2', model: 'm2' });
    expect(extractJson('Here:\n```json\n{"v":1}\n```')).toEqual({ v: 1 });
    expect(() => extractJson('no json')).toThrow();
    expect(changedLines('a\nb\nc', 'a\nB\nc')).toEqual([
      '+ body:2 | B',
      '- (removed) | b',
    ]);
  });
  test('the next step names review run only for runner tracetoon', () => {
    const t = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    expect(t).toContain('`tracetoon review run --all --run r1`');
    expect(t).toContain('ONE edit pass');
    expect(t).toContain('`tracetoon review run --all --recheck --run r1` once');
    expect(t).not.toContain('review-packet');
    // Review recheck: none drops the recheck; contested makes it conditional.
    const none = graphNext('r1', {
      v: 1,
      passes: 2,
      lenses: ['d'],
      reviewerModel: 'luna',
      runner: 'tracetoon',
      recheck: 'none',
    });
    expect(none).toContain('`tracetoon review run --all --run r1`');
    expect(none).toContain('lenses d plus general');
    expect(none).not.toContain('--recheck');
    expect(none).toContain('no reviewer recheck');
    const contested = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'luna',
      runner: 'tracetoon',
      recheck: 'contested',
    });
    expect(contested).toContain('only if you rejected a finding');
    const l = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: ['a', 'c'],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    expect(l).toContain('tracetoon review run --all --run r1');
    expect(l).toContain('lenses a, c');
    const agent = graphNext('r1', {
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
    });
    expect(agent).not.toContain('review run');
    expect(agent).toContain('review import');
    expect(agent).toContain('same reviewer');
    const agentLens = graphNext('r1', {
      v: 1,
      passes: 2,
      lenses: ['d'],
      reviewerModel: 'luna',
      recheck: 'none',
    });
    expect(agentLens).toContain('IN PARALLEL (all in one message)');
    expect(agentLens).toContain('`tracetoon review merge --run r1`');
    expect(agentLens).not.toContain('SendMessage');
  });
  test('the runner plan field is stored only for tracetoon', () => {
    expect(planFromOptions({ reviewerRunner: 'agent' })).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
    });
    expect(
      planFromOptions({ reviewerRunner: 'tracetoon.', reviewerModel: 'terra' }),
    ).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    expect(() => planFromOptions({ reviewerRunner: 'robot' })).toThrow(
      'Unknown reviewer runner',
    );
  });
});

describe('tracetoon review run', () => {
  test('runs codex exec pinned to the plan model, imports with provenance, rechecks by resume', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ reviewerModel: 'terra', reviewerEffort: 'xhigh', runner: 'tracetoon' });
    const first = ok(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    const [call] = calls();
    expect(call!.args.slice(0, 4)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
    ]);
    expect(call!.args).toContain('--json');
    expect(call!.args.join(' ')).toContain('-m gpt-6.1-terra');
    expect(call!.args.join(' ')).toContain('-c model_reasoning_effort="xhigh"');
    expect(call!.args).toContain('--output-schema');
    expect(call!.args).toContain('-o');
    expect(call!.args.join(' ')).toContain(`-C ${run.dir}`);
    expect(call!.args).not.toContain('--ephemeral');
    expect(call!.args.at(-1)).toBe('-');
    expect(call!.prompt).toContain('# Lean review packet');
    expect(call!.prompt).toContain('# Lean reviewer');
    expect(call!.prompt).toContain('Override for this run');
    expect(existsSync(join(run.dir, 'review-findings.schema.json'))).toBe(true);

    expect(first.sessionId).toBeTruthy();
    expect(first.verifiedModel).toBe('gpt-6.1-terra');
    expect(first.pass).toMatchObject({
      pass: 1,
      agentId: first.sessionId,
      model: 'terra',
      effort: 'xhigh',
      findings: 1,
      source: 'tracetoon-run',
      runner: 'codex-exec',
      sessionId: first.sessionId,
      verifiedModel: 'gpt-6.1-terra',
    });
    const written = JSON.parse(
      readFileSync(join(run.dir, 'review-findings.json'), 'utf8'),
    );
    expect(written.reviewer.agentId).toBe(first.sessionId);
    expect(first.planMissing).toEqual([]);
    expect(first.next).toContain('--recheck');
    expect(planGate(run)).toBeUndefined();

    // The author fixes the sentence; the recheck resumes the same session.
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting uses the given name when one is passed, else says hello.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
    );
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    const again = ok(repo.root, ['review', 'run', '--run', run.id, '--recheck'], {
      FAKE_REVIEW_OUTPUT: reply(),
    });
    const resume = calls()[1]!;
    expect(resume.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resume.args.at(-2)).toBe(first.sessionId);
    expect(resume.args.join(' ')).toContain('-m gpt-6.1-terra');
    expect(resume.args).toContain('--output-schema');
    expect(resume.prompt).toMatch(/\+ body:\d+ \| The greeting uses the given name/);
    expect(resume.prompt).not.toContain('tracetoon:meta');
    expect(resume.prompt).toContain('always uses the given name');
    expect(again.pass).toMatchObject({
      pass: 1,
      sessionId: first.sessionId,
      findings: 0,
      source: 'tracetoon-run',
      verifiedModel: 'gpt-6.1-terra',
    });
    expect(again.passes).toHaveLength(1);
    expect(planGate(run)).toBeUndefined();
  });

  test('lens runs use the lens packet and reference and record the lens', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ lenses: ['a', 'b'], reviewerModel: 'terra', runner: 'tracetoon' });
    expect(cli(repo.root, ['review', 'run', '--run', run.id]).json.error).toContain(
      '--lens <a|b>',
    );
    const a = ok(repo.root, ['review', 'run', '--run', run.id, '--lens', 'a'], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    expect(calls()[0]!.prompt).toContain('Lens A: place');
    expect(calls()[0]!.prompt).toContain('# Lens reviewer A');
    expect(a.pass).toMatchObject({ lens: 'a', source: 'tracetoon-run' });
    expect(existsSync(join(run.dir, 'review-findings-a.json'))).toBe(true);
    expect(a.planMissing.join(' ')).toContain('tracetoon review run --lens b');
    const b = ok(repo.root, ['review', 'run', '--run', run.id, '--lens', 'b']);
    expect(b.pass).toMatchObject({ pass: 2, lens: 'b' });
    expect(b.planMissing).toEqual([]);
  });

  test('without a reviewer model, or with a conflicting override, nothing runs', () => {
    const { repo, run, plan } = renderedRun();
    expect(cli(repo.root, ['review', 'run', '--run', run.id]).json.error).toContain(
      'No reviewer model configured',
    );
    plan({ reviewerModel: 'terra' });
    expect(
      cli(repo.root, ['review', 'run', '--run', run.id, '--model', 'luna']).json.error,
    ).toContain('names reviewer model terra');
    expect(calls()).toHaveLength(0);
  });

  test('failures import nothing: non-zero exit and unreadable output', () => {
    const { repo, run, plan } = renderedRun();
    plan({ reviewerModel: 'terra', runner: 'tracetoon' });
    const failed = cli(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_EXIT: '3',
    });
    expect(failed.code).not.toBe(0);
    expect(failed.json.error).toContain('exited 3');
    expect(failed.json.error).toContain('Nothing was imported');
    const bad = cli(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: 'I could not review this.',
    });
    expect(bad.json.error).toContain('could not be read as findings JSON');
    expect(existsSync(join(run.dir, 'review.json'))).toBe(false);
    expect(existsSync(join(run.dir, 'review-findings.json'))).toBe(false);
  });

  test('a rollout on another model is recorded, and the gate refuses it', () => {
    const { repo, run, plan } = renderedRun();
    plan({ reviewerModel: 'terra', runner: 'tracetoon' });
    const r = ok(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_ROLLOUT_MODEL: 'gpt-6-luna',
    });
    expect(r.verifiedModel).toBe('gpt-6-luna');
    expect(r.warnings.join(' ')).toContain('ran on gpt-6-luna, not gpt-6.1-terra');
    expect(planGate(run)).toContain('ran on gpt-6-luna, not gpt-6.1-terra');
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    const refused = cli(repo.root, ['publish', '--run', run.id]);
    expect(refused.code).not.toBe(0);
    expect(refused.json.error).toContain('tracetoon review run');
    // No rollout at all: the model is unverified, also refused.
    const none = ok(repo.root, ['review', 'run', '--run', run.id], {
      FAKE_REVIEW_NO_ROLLOUT: '1',
    });
    expect(none.verifiedModel).toBeNull();
    expect(planGate(run)).toContain('rollout shows no model');
  });

  test('runner tracetoon refuses agent-imported passes; runner agent accepts them', () => {
    const { repo, run, reply, plan } = renderedRun();
    writeFileSync(
      join(run.dir, 'review-findings.json'),
      reply('always uses the given name').replace('codex-exec', 'agent-x7k'),
    );
    plan({ reviewerModel: 'terra', runner: 'tracetoon' });
    ok(repo.root, ['review', 'import', '--run', run.id, '--reviewer-model', 'terra']);
    expect(planGate(run)).toContain('was not run by Tracetoon');
    const rendered = cli(repo.root, ['render', '--run', run.id, '--no-comic']);
    expect(rendered.json.reviewPlan.missing.join(' ')).toContain('tracetoon review run');
    const refused = cli(repo.root, ['publish', '--run', run.id]);
    expect(refused.json.error).toContain('was not run by Tracetoon');
    // Same passes with runner agent: the gate is as before.
    plan({ reviewerModel: 'terra' });
    expect(planGate(run)).toBeUndefined();
  });

  test('prepare stores the runner from the SKILL line and points at review run', () => {
    const { repo, run } = renderedRun();
    const skill = join(dirname(config), 'SKILL.md');
    writeFileSync(
      skill,
      'Reviewer model: terra.\n\nReviewer effort: default.\n\nReview passes: 1.\n\nReview lenses: none.\n\nReviewer runner: tracetoon.\n\nBrief layout: toon.\n',
    );
    const prepared = ok(repo.root, ['prepare', '--offline'], {
      TRACETOON_SKILL_MD: skill,
    });
    expect(
      JSON.parse(readFileSync(join(prepared.runDir, 'review-plan.json'), 'utf8')),
    ).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
      reviewerModel: 'terra',
      runner: 'tracetoon',
    });
    if (prepared.next) {
      expect(prepared.next).toContain(`tracetoon review run --all --run ${prepared.run}`);
      expect(prepared.next).toContain('--recheck');
    }
    // The flag wins over the SKILL line.
    const flagged = ok(
      repo.root,
      [
        'prepare',
        '--offline',
        '--run',
        run.id,
        '--reviewer-model',
        'terra',
        '--reviewer-runner',
        'agent',
      ],
      { TRACETOON_SKILL_MD: skill },
    );
    expect(
      JSON.parse(readFileSync(join(flagged.runDir, 'review-plan.json'), 'utf8')).runner,
    ).toBeUndefined();
  });
});

describe('review run --all and the merged list', () => {
  const luna = (extra: Record<string, unknown> = {}) => ({
    reviewerModel: 'luna',
    reviewerEffort: 'xhigh',
    runner: 'tracetoon',
    ...extra,
  });

  test('runs every planned pass concurrently, each with its own files, and merges them', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ passes: 3, lenses: ['d'], ...luna({ recheck: 'none' }) });
    const r = ok(repo.root, ['review', 'run', '--all', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
      FAKE_REVIEW_DELAY_MS: '600',
    });
    const log = calls() as unknown as { prompt: string; start: number; end: number }[];
    expect(log).toHaveLength(3);
    // They overlapped: every pass started before any of them finished.
    expect(Math.max(...log.map((c) => c.start))).toBeLessThan(
      Math.min(...log.map((c) => c.end)),
    );
    expect(log.filter((c) => c.prompt.includes('# Lens reviewer D'))).toHaveLength(1);
    expect(log.filter((c) => c.prompt.includes('# Lean reviewer'))).toHaveLength(2);
    expect(r.ran.map((p: any) => p.slot).sort()).toEqual(['d', 'general', 'general2']);
    expect(new Set(r.ran.map((p: any) => p.sessionId)).size).toBe(3);
    expect(new Set(r.ran.map((p: any) => p.pass)).size).toBe(3);
    for (const p of r.ran)
      expect(p).toMatchObject({
        source: 'tracetoon-run',
        verifiedModel: 'gpt-6-luna',
        model: 'luna',
        effort: 'xhigh',
      });
    for (const f of [
      'review-findings-d.json',
      'review-findings.json',
      'review-findings-g2.json',
      'review-packet-d.md',
      'review-packet.md',
      'review-packet-g2.md',
    ])
      expect(existsSync(join(run.dir, f))).toBe(true);
    // Three passes raised the same finding: one merged line naming all three.
    expect(r.merged.items).toHaveLength(1);
    expect(r.merged.duplicates).toBe(2);
    expect(r.merged.items[0].passes.sort()).toEqual(['general', 'general 2', 'lens d']);
    const md = readFileSync(join(run.dir, 'review-findings-merged.md'), 'utf8');
    expect(md).toContain('1. overstated — "always uses the given name"');
    // Pass order follows import order, which depends on which concurrent run finished first.
    const line = md.split('\n').find((l) => l.startsWith('1. overstated'))!;
    const listed = /\[([^\]]+)\]\s*$/.exec(line)![1]!.split(', ').sort();
    expect(listed).toEqual(['general', 'general 2', 'lens d']);
    expect(r.planMissing).toEqual([]);
    // Recheck none: the plan is met without any recheck, and the next step says so.
    expect(r.next).toContain('ONE edit pass');
    expect(r.next).not.toContain('--recheck');
    expect(planGate(run)).toBeUndefined();
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting uses the given name when one is passed.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
    );
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    ok(repo.root, ['review', 'import', '--run', run.id, '--rebind']);
    expect(planGate(run)).toBeUndefined();
    const merged = ok(repo.root, ['review', 'merge', '--run', run.id]);
    expect(merged.items).toHaveLength(0);
    expect(merged.fixed).toBe(3);
  });

  test('partial failure imports the passes that worked and reruns only the failed one', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ passes: 2, lenses: ['d'], ...luna() });
    const r = cli(repo.root, ['review', 'run', '--all', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
      FAKE_REVIEW_FAIL_IF: '# Lens reviewer D',
    });
    expect(r.code).not.toBe(0);
    expect(r.json.failed).toHaveLength(1);
    expect(r.json.failed[0]).toMatchObject({ slot: 'd', label: 'lens d' });
    expect(r.json.failed[0].error).toContain('exited 4');
    expect(r.json.ran.map((p: any) => p.slot)).toEqual(['general']);
    expect(r.json.rerun).toBe(`tracetoon review run --all --run ${run.id}`);
    expect(r.json.error).toContain(r.json.rerun);
    expect(r.json.planMissing.join(' ')).toContain('lens d');
    expect(existsSync(join(run.dir, 'review-findings-merged.md'))).toBe(true);
    expect(planGate(run)).toContain('lens d');
    const again = ok(repo.root, ['review', 'run', '--all', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    expect(calls()).toHaveLength(3);
    expect(again.ran.map((p: any) => p.slot)).toEqual(['d']);
    expect(again.skipped.map((p: any) => p.slot)).toEqual(['general']);
    expect(again.merged.items[0].passes.sort()).toEqual(['general', 'lens d']);
    expect(planGate(run)).toBeUndefined();
    // Recheck once (the default): every pass is resumed in one command.
    expect(again.next).toContain(`tracetoon review run --all --recheck --run ${run.id}`);
  });

  test('--all --recheck with recheck contested resumes only passes with rejected findings', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ passes: 1, lenses: [], ...luna({ recheck: 'contested' }) });
    const first = ok(repo.root, ['review', 'run', '--all', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    expect(first.next).toContain('only if you rejected a finding');
    // The author fixed the flagged sentence: nothing is contested, nothing runs.
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting uses the given name when one is passed.\n\nIt previously only said hello.\n\nSee src/greet.ts.\n',
    );
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    const none = ok(repo.root, ['review', 'run', '--all', '--recheck', '--run', run.id]);
    expect(none.ran).toHaveLength(0);
    expect(none.skipped[0].reason).toBe('no rejected finding');
    expect(calls()).toHaveLength(1);
    // The author keeps it and rejects the finding: that pass is rechecked.
    writeFileSync(
      join(run.dir, 'body.md'),
      'The greeting always uses the given name.\n\nIt previously only said hi.\n\nSee src/greet.ts.\n',
    );
    ok(repo.root, ['render', '--run', run.id, '--no-comic']);
    const re = ok(
      repo.root,
      [
        'review',
        'run',
        '--all',
        '--recheck',
        '--run',
        run.id,
        '--note',
        'diff:3 shows it',
      ],
      { FAKE_REVIEW_OUTPUT: reply() },
    );
    expect(re.ran).toHaveLength(1);
    const resume = calls()[1]!;
    expect(resume.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resume.prompt).toContain('rejects your findings');
    expect(resume.prompt).toContain('diff:3 shows it');
    expect(planGate(run)).toBeUndefined();
  });

  test('review merge works for agent-imported passes and needs one first', () => {
    const { repo, run, reply, plan } = renderedRun();
    plan({ passes: 2, lenses: ['d'], reviewerModel: 'luna' });
    expect(cli(repo.root, ['review', 'merge', '--run', run.id]).json.error).toContain(
      'No reviewer pass',
    );
    writeFileSync(
      join(run.dir, 'review-findings-d.json'),
      reply('always uses the given name').replace('codex-exec', 'agent-d1'),
    );
    ok(repo.root, [
      'review',
      'import',
      '--run',
      run.id,
      '--lens',
      'd',
      '--reviewer-model',
      'luna',
    ]);
    writeFileSync(
      join(run.dir, 'review-findings.json'),
      reply('the greeting always uses the given name.').replace('codex-exec', 'agent-g1'),
    );
    ok(repo.root, ['review', 'import', '--run', run.id, '--reviewer-model', 'luna']);
    const m = ok(repo.root, ['review', 'merge', '--run', run.id]);
    expect(m.items).toHaveLength(1);
    expect(m.items[0].passes.sort()).toEqual(['general', 'lens d']);
    expect(m.planMissing).toEqual([]);
    expect(m.next).toContain('SendMessage');
    expect(existsSync(m.path)).toBe(true);
  });

  test('the recheck setting is stored in the plan only when not once', () => {
    expect(planFromOptions({ reviewRecheck: 'once.' })).toEqual({
      v: 1,
      passes: 1,
      lenses: [],
    });
    expect(planFromOptions({ reviewRecheck: 'none' })).toMatchObject({ recheck: 'none' });
    expect(planFromOptions({ reviewRecheck: 'Contested.' })).toMatchObject({
      recheck: 'contested',
    });
    expect(() => planFromOptions({ reviewRecheck: 'twice' })).toThrow(
      'Unknown review recheck',
    );
  });

  test('prepare stores Review recheck from the SKILL line', () => {
    const { repo } = renderedRun();
    const skill = join(dirname(config), 'SKILL.md');
    writeFileSync(
      skill,
      'Reviewer model: luna.\n\nReviewer effort: xhigh.\n\nReview passes: 2.\n\nReview lenses: d.\n\nReviewer runner: tracetoon.\n\nReview recheck: none.\n\nBrief layout: toon.\n',
    );
    const prepared = ok(repo.root, ['prepare', '--offline'], {
      TRACETOON_SKILL_MD: skill,
    });
    expect(
      JSON.parse(readFileSync(join(prepared.runDir, 'review-plan.json'), 'utf8')),
    ).toEqual({
      v: 1,
      passes: 2,
      lenses: ['d'],
      reviewerModel: 'luna',
      reviewerEffort: 'xhigh',
      runner: 'tracetoon',
      recheck: 'none',
    });
    if (prepared.next) {
      expect(prepared.next).toContain(`tracetoon review run --all --run ${prepared.run}`);
      expect(prepared.next).not.toContain('--recheck');
    }
  });
});
