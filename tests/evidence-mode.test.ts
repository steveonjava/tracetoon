import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { lifecycle } from '../src/hook/lifecycle.ts';
import {
  EVIDENCE_MODE_FILE,
  parseEvidenceMode,
  runEvidenceMode,
  saveRunEvidenceMode,
} from '../src/relational/mode.ts';
import { R_RULES } from '../src/relational/index.ts';
import { findRun } from '../src/run.ts';
import { writeLocal } from '../src/util/localJson.ts';
import { repository, tasks } from '../src/workflow/state.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(120_000);

const CLI = resolve(import.meta.dir, '../src/cli.ts');
const FAKE = resolve(import.meta.dir, 'fake-codex-review.ts');
let config: string;
let log: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['TRACETOON_CONFIG', 'TRACETOON_EVIDENCE_MODE']) saved[k] = process.env[k];
  config = join(tempDir('tracetoon-evmode-'), 'config.json');
  log = join(dirname(config), 'codex-log.jsonl');
  process.env.TRACETOON_CONFIG = config;
  // The mode must come from the run folder (prepare's flag or the SKILL line), never env.
  delete process.env.TRACETOON_EVIDENCE_MODE;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});
const env = () => ({ ...process.env, CI: '', TRACETOON: '1' });

function cli(root: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env(),
      CLAUDE_CONFIG_DIR: join(dirname(config), 'claude'),
      CODEX_HOME: join(dirname(config), 'codex'),
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

/** A task run prepared in the given mode (by flag, or by the SKILL line) and rendered. */
function renderedRun(how: { flag?: string; skillLine?: string } = {}) {
  const repo = makeRepo();
  const p = { cwd: repo.root, session_id: 'evidence-mode' };
  lifecycle('codex', 'SessionStart', p, env());
  repo.commit(
    'src/greet.ts',
    "export function greet(name?: string) {\n  if (!name) return 'hello';\n  return `hello ${name}`;\n}\n",
    'Greet by name\n\nGreets people by the name they pass.',
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
  const skill = join(dirname(config), 'SKILL.md');
  writeFileSync(
    skill,
    `Review passes: 1.\n\nBrief layout: toon.\n\n${how.skillLine ?? ''}\n`,
  );
  const prepared = ok(
    repo.root,
    [
      'prepare',
      '--offline',
      '--run',
      run.id,
      ...(how.flag ? ['--evidence-mode', how.flag] : []),
    ],
    { TRACETOON_SKILL_MD: skill },
  );
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
        evidence: `diff:${ifLine} | H1`,
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
  return { repo, run, prepared, skill, reply, plan };
}

describe('evidence mode', () => {
  test('values are checked; the run file decides; env still overrides', () => {
    expect(parseEvidenceMode(undefined)).toBeUndefined();
    expect(parseEvidenceMode('Relational')).toBe('relational');
    expect(parseEvidenceMode('graph')).toBe('graph');
    expect(() => parseEvidenceMode('vector')).toThrow('graph or relational');
    const run = { id: 'x', dir: tempDir('tracetoon-evmode-run-') } as never;
    expect(runEvidenceMode(run)).toBe('graph');
    saveRunEvidenceMode(run, 'relational');
    expect(runEvidenceMode(run)).toBe('relational');
    process.env.TRACETOON_EVIDENCE_MODE = 'graph';
    expect(runEvidenceMode(run)).toBe('graph');
  });

  test('the relational rules defer to drafting.md instead of restating it', () => {
    expect(R_RULES[0]).toContain('references/drafting.md');
    expect(R_RULES.join(' ')).toContain('<!-- tracetoon:validation -->');
    expect(R_RULES.length).toBeLessThanOrEqual(6);
  });

  test('graph mode by default: the graph brief and the graph packet, as before', () => {
    const { repo, run, prepared } = renderedRun();
    expect(existsSync(join(run.dir, EVIDENCE_MODE_FILE))).toBe(false);
    expect(existsSync(join(run.dir, 'relational-context.json'))).toBe(false);
    expect(prepared.brief).toContain('changes[');
    const brief = ok(repo.root, ['query', 'brief', '--run', run.id]);
    expect(brief.sections.some((s: any) => s.title === 'changes')).toBe(true);
    ok(repo.root, ['review-packet', '--lean', '--lens', 'd', '--run', run.id]);
    const packet = readFileSync(join(run.dir, 'review-packet-d.md'), 'utf8');
    expect(packet).toContain('## Brief rows');
    expect(packet).toContain('## Hunks and owning symbols');
    expect(packet).not.toContain('relational evidence mode');
  });

  test('the SKILL line chooses relational without env; prepare stores it and keeps it', () => {
    const { repo, run, prepared, skill } = renderedRun({
      skillLine: 'Evidence mode: relational.',
    });
    expect(JSON.parse(readFileSync(join(run.dir, EVIDENCE_MODE_FILE), 'utf8'))).toEqual({
      mode: 'relational',
    });
    expect(prepared.brief).toContain('PR evidence from the session logs');
    expect(prepared.brief).toContain('references/drafting.md');
    expect(prepared.brief).not.toContain('changes[');
    const brief = ok(repo.root, ['query', 'brief', '--run', run.id]);
    expect(brief.evidenceMode).toBe('relational');
    expect(brief.text).toBe(prepared.brief);
    expect(cli(repo.root, ['query', 'outline', '--run', run.id]).code).toBe(1);
    // A later prepare of the same run keeps its stored mode, whatever the skill says now.
    writeFileSync(skill, 'Evidence mode: graph.\n');
    const again = ok(repo.root, ['prepare', '--offline', '--run', run.id], {
      TRACETOON_SKILL_MD: skill,
    });
    expect(again.brief).toContain('PR evidence from the session logs');
    // The flag wins over the SKILL line.
    const flipped = ok(
      repo.root,
      ['prepare', '--offline', '--run', run.id, '--evidence-mode', 'graph'],
      { TRACETOON_SKILL_MD: skill },
    );
    expect(flipped.brief).toContain('changes[');
    expect(existsSync(join(run.dir, 'relational-context.json'))).toBe(false);
  });

  test('relational: agent-runner packets (general and lens d) and their imports use the relational evidence', () => {
    const { repo, run, reply } = renderedRun({ flag: 'relational' });
    ok(repo.root, ['review-packet', '--lean', '--lens', 'd', '--run', run.id]);
    const d = readFileSync(join(run.dir, 'review-packet-d.md'), 'utf8');
    expect(d).toContain('(Lens D: completeness)');
    expect(d).toContain('## Lens D: completeness: checklist');
    expect(d).toContain('every commit-message sentence');
    expect(d).toContain('## Files and chunks');
    expect(d).toContain('## Commit messages');
    expect(d).toContain('relational evidence mode');
    expect(d).not.toContain('## Brief rows');
    expect(d).not.toContain('## Hunks and owning symbols');
    ok(repo.root, ['review-packet', '--lean', '--run', run.id]);
    const general = readFileSync(join(run.dir, 'review-packet.md'), 'utf8');
    expect(general).toContain('## Files and chunks');
    expect(general).not.toContain('checklist');
    // A lens import resolves the store's H# chunk refs.
    writeFileSync(
      join(run.dir, 'review-findings-d.json'),
      reply('always uses the given name'),
    );
    const imported = ok(repo.root, [
      'review',
      'import',
      '--run',
      run.id,
      '--lens',
      'd',
      '--agent-id',
      'lens-d-agent',
    ]);
    expect(JSON.stringify(imported)).not.toContain('H1: ');
    const merged = ok(repo.root, ['review', 'merge', '--run', run.id]);
    expect(merged.items).toHaveLength(1);
  });

  test('relational: review run --all (tracetoon runner) gives every pass the relational packet', () => {
    const { repo, run, reply, plan } = renderedRun({ flag: 'relational' });
    plan({
      passes: 2,
      lenses: ['d'],
      reviewerModel: 'luna',
      reviewerEffort: 'xhigh',
      runner: 'tracetoon',
      recheck: 'none',
    });
    const r = ok(repo.root, ['review', 'run', '--all', '--run', run.id], {
      FAKE_REVIEW_OUTPUT: reply('always uses the given name'),
    });
    const prompts = calls().map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).toContain('## Files and chunks');
      expect(p).not.toContain('## Brief rows');
    }
    expect(prompts.filter((p) => p.includes('## Lens D: completeness: checklist'))).toHaveLength(1);
    expect(r.ran.map((p: any) => p.slot).sort()).toEqual(['d', 'general']);
    expect(r.merged.items).toHaveLength(1);
    expect(r.planMissing).toEqual([]);
  });
});
