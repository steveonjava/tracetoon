import { createHash } from 'node:crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  beginTask,
  contentFingerprint,
  readTask,
  repository,
  saveTask,
  tasks,
  workFingerprint,
} from '../src/workflow/state.ts';
import {
  checkEnvironment,
  checkReport,
  executeCheck,
  receipts,
} from '../src/workflow/checks.ts';
import { lifecycle } from '../src/hook/lifecycle.ts';
import { publishProblem } from '../src/workflow/readiness.ts';
import { briefPathOpen, briefPathUnreviewed } from '../src/commands/publish.ts';
import { discoveryIndex } from '../src/trace/discovery.ts';
import { readLocal, writeLocal } from '../src/util/localJson.ts';
import { git } from '../src/util/exec.ts';
import { findRun, pruneRuns } from '../src/run.ts';
import { makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(180_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const binary = process.env.TRACETOON_TEST_BINARY;
const program = binary ? [binary] : [process.execPath, CLI];
let previous: string | undefined;
let config: string;
beforeEach(() => {
  previous = process.env.TRACETOON_CONFIG;
  config = join(tempDir('tracetoon-workflow-'), 'config.json');
  process.env.TRACETOON_CONFIG = config;
});
afterEach(() => {
  if (previous === undefined) delete process.env.TRACETOON_CONFIG;
  else process.env.TRACETOON_CONFIG = previous;
});
const env = () => ({ ...process.env, CI: '', TRACETOON: '1' });

function cli(root: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(program[0]!, [...program.slice(1), '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env(),
      CLAUDE_CONFIG_DIR: join(dirname(config), 'claude'),
      CODEX_HOME: join(dirname(config), 'codex'),
      GEMINI_HOME: join(dirname(config), 'gemini'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      TRACETOON_TEST_RUNNER: process.execPath,
      // The agent running these tests has its own session; tests name theirs.
      CODEX_THREAD_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      ...extra,
    },
    windowsHide: true,
  });
  let json: any;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = { error: result.stderr || result.stdout };
  }
  return { code: result.status, json, stderr: result.stderr };
}
function ok(root: string, ...args: string[]) {
  const result = cli(root, args);
  expect(result.json.error).toBeUndefined();
  expect(result.code).toBe(0);
  return result.json;
}

describe('finished task completion contract', () => {
  for (const agent of ['claude', 'codex'] as const) {
    test(`${agent}: syncing main after a published task creates no new task`, () => {
      const repo = makeRepo();
      const remote = tempDir('tracetoon-sync-remote-');
      expect(git(remote, ['init', '-q', '--bare']).ok).toBe(true);
      expect(git(repo.root, ['remote', 'add', 'origin', remote]).ok).toBe(true);
      expect(git(repo.root, ['push', '-q', 'origin', 'main']).ok).toBe(true);
      const id = `sync-${agent}`;
      const { run, task } = beginTask(repo.root, { session: id });
      const p = { cwd: repo.root, session_id: id, tool_input: { command: 'git status' } };
      lifecycle(agent, 'PreToolUse', p, env());
      repo.commit('feature.ts', 'export const featureValue = 42;\n', 'Add the feature');
      task.state = 'published';
      saveTask(run, task);
      expect(git(repo.root, ['push', '-q', 'origin', 'feature:main']).ok).toBe(true);
      expect(git(repo.root, ['switch', '-q', 'main']).ok).toBe(true);
      const sync = { ...p, tool_input: { command: 'git pull --ff-only origin main' } };
      expect(lifecycle(agent, 'PreToolUse', sync, env())).toBeUndefined();
      expect(git(repo.root, ['pull', '-q', '--ff-only', 'origin', 'main']).ok).toBe(true);
      expect(lifecycle(agent, 'PostToolUse', sync, env())).toBeUndefined();
      expect(lifecycle(agent, 'Stop', p, env())).toBeUndefined();
      expect(lifecycle(agent, 'Stop', p, env())).toBeUndefined();
      expect(
        tasks(repository(repo.root).gitDir).map((t) => [t.run.id, t.task.state]),
      ).toEqual([[run.id, 'published']]);
      expect(git(repo.root, ['status', '--porcelain']).stdout).toBe('');
    });
  }

  for (const agent of ['claude', 'codex', 'antigravity'] as const) {
    test(`${agent}: passive events and ordinary work never inject workflow instructions`, () => {
      const repo = makeRepo();
      const p = { cwd: repo.root, session_id: `passive-${agent}` };
      for (const event of ['SessionStart', 'Stop'] as const)
        expect(lifecycle(agent, event, p, env())).toBeUndefined();
      for (const command of [
        'git status',
        'bun test',
        'git switch main',
        'git push --force-with-lease',
        'gh pr edit 3 --body new',
        'gh pr checks 3 --watch',
        'gh pr merge 3 --merge',
        'gh pr create --help',
        'gh pr create --dry-run',
      ]) {
        for (const event of ['PreToolUse', 'PostToolUse'] as const)
          expect(
            lifecycle(agent, event, { ...p, tool_input: { command } }, env()),
          ).toBeUndefined();
      }
      expect(tasks(repository(repo.root).gitDir)).toHaveLength(0);
      expect(
        readLocal<any>(
          join(
            dirname(config),
            'host-sessions',
            createHash('sha256').update(p.session_id).digest('hex') + '.json',
          ),
        )?.repos,
      ).toHaveLength(1);
    });

    test(`${agent}: unfinished and legacy tasks never hold the session open`, () => {
      const repo = makeRepo();
      const p = { cwd: repo.root, session_id: `unfinished-${agent}` };
      lifecycle(
        agent,
        'PreToolUse',
        { ...p, tool_input: { command: 'gh pr create' } },
        env(),
      );
      const active = tasks(repository(repo.root).gitDir)[0]!;
      writeLocal(join(active.run.dir, 'approval.json'), {
        findings: [{ kind: 'secret', count: 1 }],
        allowFindings: false,
      });
      for (const state of [
        'working',
        'preparing',
        'blocked',
        'deferred',
        'published',
      ] as const) {
        active.task.state = state;
        active.task.recoveryGeneration = 12;
        saveTask(active.run, active.task);
        const before = readFileSync(join(active.run.dir, 'task.json'), 'utf8');
        for (let i = 0; i < 4; i++)
          expect(lifecycle(agent, 'Stop', p, env())).toBeUndefined();
        expect(readFileSync(join(active.run.dir, 'task.json'), 'utf8')).toBe(before);
      }
    });
  }

  for (const agent of ['claude', 'codex', 'antigravity'] as const) {
    test(`${agent}: connector updates, reads and generic operations pass through; only explicit creation redirects`, () => {
      const repo = makeRepo();
      git(repo.root, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git']);
      const p = { cwd: repo.root, session_id: `connector-${agent}` };
      const target = { owner: 'acme', repo: 'demo' };
      const cases: [string, object, boolean][] = [
        ['update_pull_request', target, false],
        ['edit_pull_request', target, false],
        ['merge_pull_request', target, false],
        ['pull_request_write', { ...target, method: 'update' }, false],
        ['pull_request_write', target, false],
        [
          'request',
          { method: 'PATCH', path: '/repos/acme/demo/pulls/3', body: { title: 'new' } },
          false,
        ],
        ['request', { method: 'GET', path: '/repos/acme/demo/pulls' }, false],
        ['request', { method: 'POST', path: '/repos/acme/demo/pulls/3/reviews' }, false],
        ['create_pull_request', target, true],
        ['pull_request_write', { ...target, method: 'create' }, true],
        [
          'request',
          { method: 'POST', path: '/repos/acme/demo/pulls', body: { title: 'new' } },
          true,
        ],
        [
          'request',
          {
            method: 'POST',
            path: '/graphql',
            query: 'mutation { createPullRequest(input: {}) { id } }',
          },
          true,
        ],
      ];
      for (const [tool, input, creates] of cases) {
        const result = lifecycle(
          agent,
          'PreToolUse',
          { ...p, tool_name: `mcp__github__${tool}`, tool_input: input },
          env(),
        );
        if (creates) expect(result).toContain('deny');
        else expect(result).toBeUndefined();
      }
      expect(tasks(repository(repo.root).gitDir)).toHaveLength(1);
    });
  }

  test('creation initializes one reusable run without earlier registration', () => {
    const repo = makeRepo();
    const transcript = join(dirname(config), 'session.jsonl');
    writeFileSync(transcript, '');
    const p = { cwd: repo.root, session_id: 'pr-requested', transcript_path: transcript };
    expect(lifecycle('codex', 'SessionStart', p, env())).toBeUndefined();
    expect(tasks(repository(repo.root).gitDir)).toHaveLength(0);
    const request = { ...p, tool_input: { command: 'gh pr create --draft --base main' } };
    expect(lifecycle('codex', 'PreToolUse', request, env())).toContain(
      'make this PR with the tracetoon skill',
    );
    const [active] = tasks(repository(repo.root).gitDir);
    expect(active!.task.transcript).toBe(transcript);
    expect(active!.task.prRequestedBy).toBe(p.session_id);
    const requestedAt = active!.task.prRequestedAt;
    lifecycle('codex', 'PreToolUse', request, env());
    expect(tasks(repository(repo.root).gitDir)).toHaveLength(1);
    expect(readTask(active!.run)?.prRequestedAt).toBe(requestedAt);
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    const updated = readTask(active!.run)!;
    updated.state = 'blocked';
    updated.reason = 'An earlier attempt failed.';
    saveTask(active!.run, updated);
    lifecycle('codex', 'PreToolUse', request, env());
    expect(readTask(active!.run)?.state).toBe('preparing');
    expect(readTask(active!.run)?.reason).toBeUndefined();
  });

  test('PR preparation recovers passive transcript metadata without pre-coding registration', () => {
    const repo = makeRepo();
    const transcript = join(dirname(config), 'passive.jsonl');
    writeFileSync(transcript, '');
    lifecycle(
      'claude',
      'SessionStart',
      { cwd: repo.root, session_id: 'observed', transcript_path: transcript },
      env(),
    );
    const begun = cli(repo.root, ['task', 'begin'], {
      CLAUDE_CODE_SESSION_ID: 'observed',
    });
    expect(begun.code).toBe(0);
    const task = tasks(repository(repo.root).gitDir)[0]!.task;
    expect(task.transcript).toBe(transcript);
    expect(task.session).toBe('observed');
  });

  test('parent workspace resolves the command workdir and preserves unfinished tasks beyond pruning', () => {
    const repo = makeRepo();
    const p = {
      cwd: dirname(repo.root),
      session_id: 'parent',
      tool_input: { command: 'git status', workdir: repo.root },
    };
    lifecycle('claude', 'PreToolUse', p, env());
    writeFileSync(join(repo.root, 'new.ts'), 'changed');
    expect(lifecycle('claude', 'Stop', { ...p, tool_input: {} }, env())).toBeUndefined();
    expect(
      lifecycle(
        'claude',
        'PreToolUse',
        { ...p, tool_input: { command: 'gh pr create --fill', workdir: repo.root } },
        env(),
      ),
    ).toContain('deny');
    expect(lifecycle('claude', 'Stop', { ...p, tool_input: {} }, env())).toBeUndefined();
    const { gitDir } = repository(repo.root);
    const active = tasks(gitDir)[0]!;
    pruneRuns(gitDir);
    expect(existsSync(join(active.run.dir, 'task.json'))).toBe(true);
    expect(
      lifecycle('codex', 'Stop', { ...p, permission_mode: 'plan' }, env()),
    ).toBeUndefined();
    expect(
      lifecycle('codex', 'Stop', { ...p, is_subagent: true }, env()),
    ).toBeUndefined();
    expect(
      lifecycle('antigravity', 'Stop', { ...p, fullyIdle: false }, env()),
    ).toBeUndefined();
    expect(lifecycle('codex', 'Stop', p, { ...env(), TRACETOON: '0' })).toBeUndefined();
  });

  test('connector publication is guarded while read-only GitHub requests are allowed', () => {
    const repo = makeRepo();
    beginTask(repo.root, { session: 'connector' });
    const p = {
      cwd: repo.root,
      session_id: 'connector',
      tool_name: 'mcp__github__create_pull_request',
      tool_input: {},
    };
    expect(lifecycle('codex', 'PreToolUse', p, env())).toContain('deny');
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_name: 'mcp__github__get_pull_request' },
        env(),
      ),
    ).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'git push --dry-run' } },
        env(),
      ),
    ).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'git push -n' } },
        env(),
      ),
    ).toBeUndefined();
  });

  test('pushes pass through; a missed task registration is caught at the PR; quoted examples are ordinary work', () => {
    const repo = makeRepo();
    const p = {
      cwd: repo.root,
      session_id: 'missed-registration',
      tool_input: { command: 'git status' },
    };
    lifecycle('codex', 'PreToolUse', p, env());
    repo.commit('fix.ts', 'fixed', 'Fix without registering a task');
    for (const command of [
      'git push origin feature',
      'git push -u origin HEAD',
      'git push origin v1.2.0',
      'git push --tags',
      'git push origin main',
    ])
      expect(
        lifecycle('codex', 'PreToolUse', { ...p, tool_input: { command } }, env()),
      ).toBeUndefined();
    // A push never creates a task, and finished pushed work ends normally.
    expect(tasks(repository(repo.root).gitDir)).toHaveLength(0);
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    // Writing the PR outside Tracetoon is redirected and starts the task.
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'gh pr create --fill' } },
        env(),
      ),
    ).toContain('make this PR with the tracetoon skill');
    const started = tasks(repository(repo.root).gitDir);
    expect(started).toHaveLength(1);
    expect(started[0]!.task.prRequestedAt).toBeTruthy();
    expect(started[0]!.task.session).toBe('missed-registration');
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'echo "git push origin feature"' } },
        env(),
      ),
    ).toBeUndefined();
  });

  test('publication targets the explicit repository, not another pending task in the hook cwd', () => {
    const a = makeRepo();
    const b = makeRepo();
    git(a.root, ['remote', 'add', 'origin', 'https://github.com/acme/a.git']);
    git(b.root, ['remote', 'add', 'origin', 'https://github.com/acme/b.git']);
    beginTask(a.root, { session: 'scope' });
    const deferred = beginTask(b.root, { session: 'scope' });
    deferred.task.state = 'deferred';
    deferred.task.reason = 'Explicit WIP sync.';
    saveTask(deferred.run, deferred.task);
    const p = {
      cwd: a.root,
      session_id: 'scope',
      tool_input: { command: `cd "${b.root}" && git push` },
    };
    expect(lifecycle('codex', 'PreToolUse', p, env())).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: `git -C "${b.root}" push` } },
        env(),
      ),
    ).toBeUndefined();
    // A repository that explicitly disables Tracetoon must not inherit A's pending task.
    const deferredPr = lifecycle(
      'codex',
      'PreToolUse',
      {
        cwd: a.root,
        session_id: 'scope',
        tool_name: 'mcp__github__create_pull_request',
        tool_input: { owner: 'acme', repo: 'b' },
      },
      env(),
    );
    expect(deferredPr).toContain('deny');
    expect(deferredPr).toContain(deferred.run.id);
    mkdirSync(join(b.root, '.github'));
    writeFileSync(join(b.root, '.github/tracetoon.json'), '{"enabled":false}');
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'gh api repos/acme/b/pulls -X POST' } },
        env(),
      ),
    ).toBeUndefined();
    const connector = {
      cwd: a.root,
      session_id: 'scope',
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'acme', repo: 'b' },
    };
    expect(lifecycle('codex', 'PreToolUse', connector, env())).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...connector, tool_input: { owner: 'acme', repo: 'a' } },
        env(),
      ),
    ).toContain('deny');
  });

  test('unrelated branches and worktrees keep separate tasks; a new directory is observed before its first PR write', () => {
    const repo = makeRepo();
    const first = beginTask(repo.root, { session: 'separate' });
    git(repo.root, ['checkout', '-qb', 'other']);
    const second = beginTask(repo.root, { session: 'separate' });
    expect(first.run.id).not.toBe(second.run.id);
    expect(tasks(first.gitDir)).toHaveLength(2);
    const otherWorktree = join(tempDir('tracetoon-worktree-'), 'checkout');
    expect(git(repo.root, ['worktree', 'add', '-qb', 'third', otherWorktree]).ok).toBe(
      true,
    );
    const third = beginTask(otherWorktree, { session: 'separate' });
    expect(third.gitDir).not.toBe(first.gitDir);
    expect(tasks(third.gitDir)).toHaveLength(1);
    const input = {
      cwd: dirname(repo.root),
      session_id: 'new-folder',
      tool_name: 'Write',
      tool_input: { file_path: join(repo.root, 'not-yet', 'file.ts') },
    };
    // A fresh branch, so the PR below can't attach to another session's task.
    git(repo.root, ['checkout', '-qb', 'fourth']);
    git(repo.root, ['remote', 'add', 'origin', 'https://github.com/acme/folder.git']);
    lifecycle('claude', 'PreToolUse', input, env());
    mkdirSync(join(repo.root, 'not-yet'));
    writeFileSync(input.tool_input.file_path, 'new');
    const stop = { cwd: dirname(repo.root), session_id: 'new-folder' };
    expect(lifecycle('claude', 'Stop', stop, env())).toBeUndefined();
    // The repository observed at the write is where a later connector PR resolves.
    expect(
      lifecycle(
        'claude',
        'PreToolUse',
        {
          ...stop,
          tool_name: 'mcp__github__create_pull_request',
          tool_input: { owner: 'acme', repo: 'folder' },
        },
        env(),
      ),
    ).toContain('make this PR with the tracetoon skill');
    expect(lifecycle('claude', 'Stop', stop, env())).toBeUndefined();
  });
});

describe('receipts follow tested content', () => {
  test('ignored generated artifacts are explicit validation inputs', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, '.gitignore'), 'dist/\n');
    mkdirSync(join(repo.root, 'dist'));
    writeFileSync(join(repo.root, 'dist/program.bin'), 'first build');
    const { run } = beginTask(repo.root);
    const command = [process.execPath, '-e', 'console.log("1 pass")'];
    const options = { name: 'compiled', command, input: ['dist/program.bin'] };
    const source = contentFingerprint(repo.root);
    expect(executeCheck(repo.root, run, options).outcome).toBe('passed');
    expect(executeCheck(repo.root, run, options).reused).toBe(true);
    writeFileSync(join(repo.root, 'dist/program.bin'), 'different executable');
    expect(contentFingerprint(repo.root)).toBe(source);
    expect(executeCheck(repo.root, run, options).reused).toBeUndefined();
  });
  test('reuses unchanged input, survives commits and ignores private trails; edits and environment changes invalidate', () => {
    const repo = makeRepo();
    const { run } = beginTask(repo.root);
    writeFileSync(join(repo.root, 'code.ts'), 'one');
    const command = [process.execPath, '-e', 'console.log("1 pass")'];
    const first = executeCheck(repo.root, run, { name: 'tests', command });
    expect(first.outcome).toBe('passed');
    expect(first.summary).toContain('1 pass');
    const originalCall = process.env.CODEX_TOOL_CALL_ID;
    process.env.CODEX_TOOL_CALL_ID = 'another-host-tool-invocation';
    try {
      expect(executeCheck(repo.root, run, { name: 'tests', command }).reused).toBe(true);
    } finally {
      if (originalCall === undefined) delete process.env.CODEX_TOOL_CALL_ID;
      else process.env.CODEX_TOOL_CALL_ID = originalCall;
    }
    git(repo.root, ['add', 'code.ts']);
    git(repo.root, ['commit', '-qm', 'Add code']);
    mkdirSync(join(repo.root, '.showtail'));
    writeFileSync(join(repo.root, '.showtail/private.json'), 'private');
    expect(contentFingerprint(repo.root)).toBe(first.fingerprint);
    expect(executeCheck(repo.root, run, { name: 'tests', command }).reused).toBe(true);
    writeFileSync(join(repo.root, 'code.ts'), 'two');
    expect(
      executeCheck(repo.root, run, { name: 'tests', command }).reused,
    ).toBeUndefined();
    const oldEnvironment = process.env.WORKFLOW_TEST_INPUT;
    process.env.WORKFLOW_TEST_INPUT = 'changed';
    try {
      expect(
        executeCheck(repo.root, run, { name: 'tests', command }).reused,
      ).toBeUndefined();
    } finally {
      if (oldEnvironment === undefined) delete process.env.WORKFLOW_TEST_INPUT;
      else process.env.WORKFLOW_TEST_INPUT = oldEnvironment;
    }
    expect(
      executeCheck(repo.root, run, {
        name: 'fail',
        command: [process.execPath, '-e', 'process.exit(7)'],
      }).outcome,
    ).toBe('failed');
    const skip = executeCheck(repo.root, run, {
      name: 'integration',
      command: [],
      skip: 'CI-only per contributor guide.',
    });
    expect(skip.outcome).toBe('not-run');
    expect(skip.exitCode).toBeNull();
  });
});

describe('active transcript discovery', () => {
  test('recent events in old-mtime logs are discoverable, including incremental partial-line appends and truncation', () => {
    const dir = tempDir('tracetoon-log-');
    const file = join(dir, 'rollout.jsonl');
    const query = {
      roots: [dir],
      sinceMs: Date.now() - 60_000,
      cacheDir: join(dir, 'cache'),
    };
    const old = '2020-01-01T00:00:00Z';
    writeFileSync(
      file,
      JSON.stringify({ timestamp: old, cwd: dir, padding: 'x'.repeat(900) }) + '\n',
    );
    let index = discoveryIndex(query);
    expect(index.inspect(file)?.recent).toBe(Date.parse(old));
    index.save();
    appendFileSync(file, `{"timestamp":"${new Date().toISOString().slice(0, 10)}`);
    index = discoveryIndex(query);
    index.inspect(file);
    index.save();
    appendFileSync(
      file,
      `${new Date().toISOString().slice(10)}","cwd":${JSON.stringify(dir)}}\n`,
    );
    utimesSync(file, new Date(old), new Date(old));
    index = discoveryIndex(query);
    const recent = index.inspect(file)!;
    index.save();
    expect(recent.recent).toBeGreaterThan(query.sinceMs);
    expect(recent.match).toBe(true);
    const disk = readFileSync(
      join(query.cacheDir, readdirSync(query.cacheDir)[0]!),
      'utf8',
    );
    expect(disk).not.toContain('padding');
    expect(disk).not.toContain('timestamp');
    writeFileSync(file, JSON.stringify({ timestamp: old, cwd: '/unrelated' }) + '\n');
    index = discoveryIndex(query);
    expect(index.inspect(file)?.match).toBe(false);
  });
});

describe('requested PR to publication rehearsal', () => {
  test('prepares, publishes without rerunning work, and recovers an interrupted create', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    const begun = ok(repo.root, 'task', 'begin', '--session', 'rehearsal');
    const run = findRun(repository(repo.root).gitDir, begun.run);
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    const checked = ok(
      repo.root,
      'check',
      '--run',
      run.id,
      '--name',
      'tests',
      '--',
      process.execPath,
      '-e',
      'console.log("1 pass")',
    );
    expect(checked.outcome).toBe('passed');
    // The user asks for a PR; the direct write is redirected to this task.
    const p = { cwd: repo.root, session_id: 'rehearsal' };
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: 'gh pr create --fill' } },
        env(),
      ),
    ).toContain(`tracetoon publish --run ${run.id}`);
    expect(readTask(run)?.prRequestedAt).toBeTruthy();
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    ok(repo.root, 'task', 'complete', '--run', run.id, '--checks', 'tests');
    ok(repo.root, 'digest', '--run', run.id, '--offline');
    ok(repo.root, 'context', '--run', run.id, '--offline');
    const request = readLocal<{ fingerprint: string }>(
      join(run.dir, 'guidance-request.json'),
    )!;
    writeLocal(join(run.dir, 'guidance.json'), {
      v: 1,
      requestFingerprint: request.fingerprint,
      researcher: { mode: 'inline' },
      sources: [],
      requirements: [],
      gaps: ['Isolated workflow fixture; no production compliance claim.'],
    });
    writeFileSync(
      join(run.dir, 'body.md'),
      'Adds a greeting.\n\nTesting: the smoke test passed.\n',
    );
    writeFileSync(join(run.dir, 'title.txt'), 'Add greeting');
    const first = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(existsSync(join(run.dir, 'preview.html'))).toBe(false);
    expect(first.previewHandoff).toBeUndefined();
    const log = join(dirname(config), 'gh.log');
    const state = join(dirname(config), 'gh-state.json');
    const gh = { FAKE_GH_LOG: log, FAKE_GH_STATE: state };
    // A managed task needs a current independent review before it is posted.
    expect(cli(repo.root, ['publish', '--run', run.id], gh).json.error).toContain(
      'independent review',
    );
    // ...unless it took the lean brief path, which has no separate reviewer.
    const lean = ok(repo.root, 'render', '--run', run.id, '--no-comic', '--lean');
    expect(lean.contributionReview.status).toBe('skipped');
    expect(lean.contributionReview.mode).toBe('lean');
    expect(
      publishProblem(repo.root, run, readLocal(join(run.dir, 'approval.json'))!),
    ).toBeUndefined();
    // The reviewed brief path also needs no full review; it notes whether the slim reviewer ran.
    const noNotes = ok(repo.root, 'render', '--run', run.id, '--no-comic', '--reviewed');
    expect(noNotes.contributionReview.mode).toBe('reviewed-brief');
    expect(noNotes.contributionReview.issues.join(' ')).toContain('no reviewer-notes.md');
    writeFileSync(join(run.dir, 'reviewer-notes.md'), '- OK: no findings\n');
    const reviewed = ok(repo.root, 'render', '--run', run.id, '--no-comic', '--reviewed');
    expect(reviewed.contributionReview.status).toBe('skipped');
    expect(reviewed.contributionReview.issues.join(' ')).toContain(
      'checked by one slim reviewer',
    );
    expect(
      publishProblem(repo.root, run, readLocal(join(run.dir, 'approval.json'))!),
    ).toBeUndefined();
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    expect(cli(repo.root, ['publish', '--run', run.id], gh).json.error).toContain(
      'independent review',
    );
    writeLocal(join(run.dir, 'review.json'), {
      v: 1,
      inputFingerprint: first.reviewFingerprint,
      drafter: { mode: 'inline' },
      reviewer: { mode: 'inline' },
      assessments: [],
    });
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    const exactBody = readFileSync(join(run.dir, 'final-body.md'), 'utf8');
    writeFileSync(join(run.dir, 'final-body.md'), exactBody + '\nUnreviewed change.');
    expect(cli(repo.root, ['publish', '--run', run.id], gh).json.error).toContain(
      'description changed',
    );
    writeFileSync(join(run.dir, 'final-body.md'), exactBody);
    // The render binds the remote as well as code, and unexpected new files invalidate it.
    git(repo.root, ['remote', 'set-url', 'origin', join(remote, 'different')]);
    expect(cli(repo.root, ['publish', '--run', run.id], gh).json.error).toContain(
      'remote changed',
    );
    git(repo.root, ['remote', 'set-url', 'origin', remote]);
    // A check that was interrupted has no result: it is rerun, not posted around.
    const checksPath = join(run.dir, 'checks.json');
    const checksBefore = readFileSync(checksPath, 'utf8');
    writeFileSync(
      checksPath,
      JSON.stringify([
        ...JSON.parse(checksBefore),
        { name: 'lint', outcome: 'running', command: ['lint'] },
      ]),
    );
    expect(cli(repo.root, ['publish', '--run', run.id], gh).json.error).toContain(
      'Check lint was interrupted',
    );
    writeFileSync(checksPath, checksBefore);
    writeFileSync(join(repo.root, 'unreviewed.ts'), 'not in render');
    expect(cli(repo.root, ['publish', '--run', run.id], gh).json.error).toContain(
      'content changed',
    );
    rmSync(join(repo.root, 'unreviewed.ts'));
    expect(existsSync(log)).toBe(false); // nothing reached GitHub while refused
    const before = readFileSync(join(run.dir, 'checks.json'), 'utf8');
    const firstPublish = cli(repo.root, ['publish', '--run', run.id], {
      ...gh,
      FAKE_GH_FAIL_CREATE_ONCE: '1',
    });
    expect(firstPublish.code).toBe(1);
    const retried = cli(repo.root, ['publish', '--run', run.id], gh);
    expect(retried.json.error).toBeUndefined();
    expect(retried.code).toBe(0);
    expect(retried.json.url).toBe('https://github.com/acme/demo/pull/7');
    expect(retried.json.merged).toBe(false);
    expect(retried.json.message).toContain(
      'Tracetoon created PR #7: https://github.com/acme/demo/pull/7',
    );
    expect(retried.json.message).toContain('Comic: none — left out for this PR.');
    expect(retried.json.message).toContain(
      'Comics: tracetoon config set comic off|allowed|always (now: allowed)',
    );
    expect(readFileSync(join(run.dir, 'checks.json'), 'utf8')).toBe(before);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create'),
    ).toHaveLength(1);
    expect(calls.some((c) => c.args.includes('merge') || c.args.includes('checks'))).toBe(
      false,
    );
    expect(readTask(run)?.state).toBe('published');
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    // A crash after the PR was created but before the task was updated.
    const interrupted = readTask(run)!;
    interrupted.state = 'preparing';
    saveTask(run, interrupted);
    const cached = cli(repo.root, ['publish', '--run', run.id], gh);
    expect(cached.json.reused).toBe(true);
    expect(cached.json.message).toContain('Tracetoon created PR #7');
    expect(readTask(run)?.state).toBe('published');
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined(); // don't recreate a just-published task
    expect(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => {
          const { args } = JSON.parse(line);
          return args[0] === 'pr' && args[1] === 'create';
        }),
    ).toHaveLength(1);
  });
});

describe('ordinary git and task identity', () => {
  function prepared(
    repo: ReturnType<typeof makeRepo>,
    runId: string,
    recordChecks = true,
  ) {
    const run = findRun(repository(repo.root).gitDir, runId);
    if (recordChecks)
      ok(repo.root, 'task', 'complete', '--run', run.id, '--checks', 'tests');
    ok(repo.root, 'digest', '--run', run.id, '--offline');
    ok(repo.root, 'context', '--run', run.id, '--offline');
    const request = readLocal<{ fingerprint: string }>(
      join(run.dir, 'guidance-request.json'),
    )!;
    writeLocal(join(run.dir, 'guidance.json'), {
      v: 1,
      requestFingerprint: request.fingerprint,
      researcher: { mode: 'inline' },
      sources: [],
      requirements: [],
      gaps: ['Isolated workflow fixture; no production compliance claim.'],
    });
    if (!existsSync(join(run.dir, 'body.md'))) {
      writeFileSync(join(run.dir, 'body.md'), 'Adds a greeting.\n');
      writeFileSync(join(run.dir, 'title.txt'), 'Add greeting');
    }
    const first = ok(repo.root, 'render', '--run', run.id, '--no-comic');
    writeLocal(join(run.dir, 'review.json'), {
      v: 1,
      inputFingerprint: first.reviewFingerprint,
      drafter: { mode: 'inline' },
      reviewer: { mode: 'inline' },
      assessments: [],
    });
    ok(repo.root, 'render', '--run', run.id, '--no-comic');
    return run;
  }
  const check = (root: string, run: string) =>
    ok(root, 'check', '--run', run, '--name', 'tests', '--', process.execPath, '-e', '1');
  const prCreate = ['gh', 'pr', 'create', '--fill'].join(' ');

  test('creation publishes without pre-coding registration or wrapped checks', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-passive-remote-');
    expect(git(remote, ['init', '-q', '--bare']).ok).toBe(true);
    expect(git(repo.root, ['remote', 'add', 'origin', remote]).ok).toBe(true);
    expect(git(repo.root, ['push', '-q', 'origin', 'main']).ok).toBe(true);
    const p = { cwd: repo.root, session_id: 'passive-publication' };
    expect(lifecycle('codex', 'SessionStart', p, env())).toBeUndefined();
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    expect(tasks(repository(repo.root).gitDir)).toHaveLength(0);
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: prCreate } },
        env(),
      ),
    ).toContain('deny');
    const active = tasks(repository(repo.root).gitDir)[0]!;
    const run = prepared(repo, active.run.id, false);
    const log = join(dirname(config), 'passive-gh.log');
    const result = cli(repo.root, ['publish', '--run', run.id, '--draft'], {
      FAKE_GH_LOG: log,
    });
    expect(result.code).toBe(0);
    expect(result.json.error).toBeUndefined();
    expect(result.json.url).toBe('https://github.com/acme/demo/pull/7');
    expect(existsSync(join(run.dir, 'checks.json'))).toBe(false);
    expect(existsSync(join(run.dir, 'preview.html'))).toBe(false);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const creates = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0].args).toContain('--draft');
    expect(creates[0].args).toContain('feature');
    expect(creates[0].args).toContain('main');
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();
    for (const command of [
      'gh pr checks 7 --watch',
      'gh pr edit 7 --body revised',
      'gh pr merge 7 --merge',
    ])
      expect(
        lifecycle('codex', 'PreToolUse', { ...p, tool_input: { command } }, env()),
      ).toBeUndefined();
  });

  test('PR writes stay intercepted, including inside a compound push command', () => {
    const repo = makeRepo();
    git(repo.root, ['switch', '-q', '-c', 'feature']);
    const p = { cwd: repo.root, session_id: 'intercept' };
    const run = (tool_input: object) =>
      lifecycle('codex', 'PreToolUse', { ...p, tool_input }, env());
    expect(run({ command: 'git push -u origin feature' })).toBeUndefined();
    expect(run({ command: `git push -u origin feature && ${prCreate}` })).toContain(
      'deny',
    );
    expect(
      run({ command: ['gh', 'pr', 'edit', '3', '--body', '"new"'].join(' ') }),
    ).toBeUndefined();
    expect(
      run({ command: 'gh api -X PATCH repos/acme/demo/pulls/3 -f body=new' }),
    ).toBeUndefined();
    // Other ways agents open PRs go through Tracetoon too.
    for (const command of [
      'hub pull-request -m "Fix"',
      'git pull-request',
      'git town propose',
      'curl -X POST https://api.github.com/repos/acme/demo/pulls -d @pr.json',
      'Invoke-RestMethod -Method Post -Uri https://api.github.com/repos/acme/demo/pulls',
    ])
      expect(run({ command })).toContain('deny');
    // Reads and stacking tools are not PR writes Tracetoon replaces.
    expect(
      run({ command: 'curl -s https://api.github.com/repos/acme/demo/pulls' }),
    ).toBeUndefined();
    expect(run({ command: 'gt submit --stack' })).toBeUndefined();
    // Closing a PR through the API is left alone by both hooks, like gh pr close.
    expect(
      run({ command: 'gh api -X PATCH repos/acme/demo/pulls/3 -f state=closed' }),
    ).toBeUndefined();
    // Text that only mentions a PR command is not a PR write.
    expect(run({ command: `echo "${prCreate}"` })).toBeUndefined();
    expect(
      run({ command: `cat >> notes.md <<'EOF'\nRun ${prCreate} later\nEOF` }),
    ).toBeUndefined();
    // Connector pushes are ordinary git; connector PR writes are not.
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_name: 'mcp__github__push_files', tool_input: {} },
        env(),
      ),
    ).toBeUndefined();
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_name: 'mcp__github__create_pull_request', tool_input: {} },
        env(),
      ),
    ).toContain('deny');
    const deny = JSON.parse(run({ command: prCreate })!);
    const reason = deny.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('Only PR creation is intercepted');
    expect(reason).toContain('make this PR with the tracetoon skill');
    expect(reason).toMatch(/tracetoon publish --run \S+;/);
    expect(reason).not.toMatch(/\bask\b.*approv|\bwait\b.*approv|preview/i);
    // Every intercepted write lands on one task, now marked as requested.
    const all = tasks(repository(repo.root).gitDir);
    expect(all).toHaveLength(1);
    expect(all[0]!.task.prRequestedAt).toBeTruthy();
  });

  test('defer/block/complete keep the task branch; explicit adoption refreshes target state', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    git(repo.root, ['switch', '-q', '-c', 'feat/a']);
    const begun = ok(repo.root, 'task', 'begin', '--session', 'adopt');
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    check(repo.root, begun.run);
    const p = { cwd: repo.root, session_id: 'adopt' };
    expect(
      lifecycle(
        'codex',
        'PreToolUse',
        { ...p, tool_input: { command: prCreate } },
        env(),
      ),
    ).toContain(`tracetoon publish --run ${begun.run}`);
    const run = prepared(repo, begun.run);
    expect(readTask(run)?.state).toBe('preparing');
    expect(existsSync(join(run.dir, 'preview.html'))).toBe(false);
    expect(lifecycle('codex', 'Stop', p, env())).toBeUndefined();

    // Same commit, different branch: bookkeeping commands never move the task.
    git(repo.root, ['switch', '-q', '-c', 'feat/b']);
    ok(repo.root, 'task', 'defer', '--run', run.id, '--reason', 'Waiting on the author.');
    expect(readTask(run)?.branch).toBe('feat/a');
    ok(repo.root, 'task', 'block', '--run', run.id, '--reason', 'Image route down.');
    expect(readTask(run)?.branch).toBe('feat/a');
    ok(repo.root, 'task', 'complete', '--run', run.id, '--checks', 'tests');
    expect(readTask(run)?.branch).toBe('feat/a');
    expect(readTask(run)?.state).toBe('preparing');
    expect(existsSync(join(run.dir, 'approval.json'))).toBe(true);

    // Explicit adoption moves it and clears what was bound to feat/a.
    ok(repo.root, 'task', 'begin', '--run', run.id);
    const adopted = readTask(run)!;
    expect(adopted.branch).toBe('feat/b');
    expect(adopted.state).toBe('working');
    for (const file of ['approval.json', 'submission.json', 'final-body.md'])
      expect(existsSync(join(run.dir, file))).toBe(false);
    for (const file of ['body.md', 'title.txt', 'checks.json'])
      expect(existsSync(join(run.dir, file))).toBe(true);
    // Publishing needs a fresh render on the adopted branch.
    expect(cli(repo.root, ['publish', '--run', run.id]).json.error).toBeDefined();
    // Receipts are content-bound, so the same tree reuses them.
    expect(check(repo.root, run.id).reused).toBe(true);
    // Previously `digest --run` rejected the old approval's branch.
    prepared(repo, run.id);
    const approval = readLocal<{ head: string }>(join(run.dir, 'approval.json'))!;
    expect(approval.head).toBe('feat/b');
    // Adopting across different commits is still refused.
    git(repo.root, ['switch', '-q', 'main']);
    git(repo.root, ['switch', '-q', '-c', 'feat/c']);
    repo.commit('other.ts', 'x', 'Unrelated');
    expect(cli(repo.root, ['task', 'begin', '--run', run.id]).json.error).toContain(
      'Switch to the task branch',
    );
  });

  test('a branch pushed past the rendered commit is never published as rendered', () => {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    git(repo.root, ['switch', '-q', '-c', 'feat/a']);
    const begun = ok(repo.root, 'task', 'begin', '--session', 'ahead');
    repo.commit('greet.ts', 'export const greet = () => "hello";\n', 'Add greeting');
    const rendered = git(repo.root, ['rev-parse', 'HEAD']).stdout.trim();
    check(repo.root, begun.run);
    const run = prepared(repo, begun.run);
    // Pushing is allowed now: an unreviewed commit reaches the remote branch.
    repo.commit('extra.ts', 'export const extra = 1;\n', 'Unreviewed follow-up');
    git(repo.root, ['push', '-q', '-u', 'origin', 'feat/a']);
    git(repo.root, ['reset', '-q', '--hard', rendered]);
    const log = join(dirname(config), 'gh-ahead.log');
    const published = cli(repo.root, ['publish', '--run', run.id], {
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: join(dirname(config), 'gh-ahead.json'),
    });
    expect(published.code).not.toBe(0);
    expect(published.json.error).toContain('git push failed');
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    expect(calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
    expect(readTask(run)?.state).not.toBe('published');
  });

  test('receipts ignore agent session bookkeeping but not the toolchain', () => {
    const repo = makeRepo();
    const { run } = beginTask(repo.root, { session: 'receipts' });
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { CLAUDE_EFFORT: 'medium', AI_AGENT: 'claude-code_1' });
      const receipt = executeCheck(repo.root, run, {
        name: 'tests',
        command: [process.execPath, '-e', '1'],
      });
      expect(receipt.outcome).toBe('passed');
      const current = () =>
        checkReport(repo.root, run).find((c) => c.name === 'tests')!.current;
      expect(current()).toBe(true);
      for (const [k, v] of [
        ['CLAUDE_EFFORT', 'high'],
        ['CLAUDE_CODE_SESSION_ATTENDED', '0'],
        ['AI_AGENT', 'claude-code_2'],
        ['CODEX_THREAD_ID', 'another-thread'],
        ['CODEX_TOOL_CALL_ID', 'call-2'],
        // Git Bash changes this login-shell hint between direct and scripted
        // calls; executeCheck launches the named program without a shell.
        ['SHELL', '/usr/bin/bash'],
        ['SHELL', 'C:/Program Files/Git/bin/bash.exe'],
      ] as const) {
        process.env[k] = v;
        expect(current()).toBe(true);
        expect(
          executeCheck(repo.root, run, {
            name: 'tests',
            command: [process.execPath, '-e', '1'],
          }).reused,
        ).toBe(true);
      }
      const environment = checkEnvironment();
      expect(checkEnvironment({ ...process.env, PATH: 'changed-toolchain' })).not.toBe(
        environment,
      );
      expect(
        checkEnvironment({ ...process.env, BASH_ENV: 'different-startup-script' }),
      ).not.toBe(environment);
      process.env.NODE_ENV = 'production';
      expect(current()).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

test('on a brief path, publish is blocked while the brief check lists open items', () => {
  const dir = tempDir();
  const put = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
  // Not a brief path: no gate.
  put('review-result.json', { status: 'current', mode: 'delegated' });
  put('brief-check.json', { open: 2, uncovered: ['CH1: a.ts'] });
  expect(briefPathOpen({ dir })).toBeUndefined();
  for (const mode of ['lean', 'reviewed-brief']) {
    put('review-result.json', { status: 'skipped', mode });
    put('brief-check.json', { open: 2, uncovered: ['CH1: a.ts'] });
    expect(briefPathOpen({ dir })).toContain(
      '2 sentence(s) to fix and 1 brief row(s) to cover',
    );
    put('brief-check.json', { open: 0, uncovered: [] });
    expect(briefPathOpen({ dir })).toBeUndefined();
  }
});

test('a brief-path draft that was only checked needs its slim review before publishing', () => {
  const dir = tempDir();
  const put = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
  put('review-result.json', { status: 'skipped', mode: 'lean' });
  expect(briefPathUnreviewed({ dir })).toContain(
    'only checked (render --check), not reviewed',
  );
  writeFileSync(join(dir, 'reviewer-notes.md'), '- OK: no findings\n');
  expect(briefPathUnreviewed({ dir })).toContain('run tracetoon render --reviewed');
  put('review-result.json', { status: 'skipped', mode: 'reviewed-brief' });
  expect(briefPathUnreviewed({ dir })).toBeUndefined();
  put('review-result.json', { status: 'current', mode: 'delegated' });
  expect(briefPathUnreviewed({ dir })).toBeUndefined();
});
