import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { decodeMeta, regionContent } from '../src/github/body.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

// Set TRACETOON_TEST_CLI to run these against the bundled build instead of the source.
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');

let claudeHome: string;
let codexHome: string;
let geminiHome: string;
let env: NodeJS.ProcessEnv;
let ghLog: string;

beforeEach(() => {
  claudeHome = tempDir('tracetoon-claude-');
  codexHome = tempDir('tracetoon-codex-');
  geminiHome = tempDir('tracetoon-gemini-');
  const scratch = tempDir('tracetoon-env-');
  ghLog = join(scratch, 'gh.log');
  env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    ANTIGRAVITY_HOME: geminiHome,
    GEMINI_HOME: geminiHome,
    TRACETOON_CONFIG: join(scratch, 'config.json'),
    TRACETOON_GH_SCRIPT: FAKE_GH,
    FAKE_GH_LOG: ghLog,
  };
});

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';

setDefaultTimeout(60_000);

describe('digest', () => {
  test('unavailable internal timing logs do not block evidence preparation', () => {
    const repo = makeRepo();
    const task = cli(repo.root, 'task', 'begin');
    expect(task.code).toBe(0);
    mkdirSync(join(task.json.runDir, 'timings.json'));
    const result = cli(repo.root, 'digest', '--offline', '--run', task.json.run);
    expect(result.code).toBe(0);
    expect(existsSync(result.json.digestPath)).toBe(true);
  });
  test('an invalid explicit context run never creates a replacement', () => {
    const repo = makeRepo();
    const r = cli(repo.root, 'context', '--offline', '--run', '20990101-000000');
    expect(r.code).toBe(1);
    expect(r.json.error).toContain('No Tracetoon run');
    const folder = join(repo.root, '.git', 'tracetoon', 'runs');
    expect(existsSync(folder)).toBe(false);
  });
  test('preparation refuses a registered run owned by another branch', () => {
    const repo = makeRepo();
    const task = cli(repo.root, 'task', 'begin');
    expect(task.code).toBe(0);
    const file = join(task.json.runDir, 'task.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...metadata, branch: 'other-feature' }));
    expect(
      cli(repo.root, 'digest', '--offline', '--run', task.json.run).json.error,
    ).toContain('another worktree or branch');
    expect(cli(repo.root, 'render', '--run', task.json.run).json.error).toContain(
      'another worktree or branch',
    );
  });
  test('expands complete redacted facts with stable ids and commit explanations', () => {
    const repo = makeRepo();
    const prompt =
      'Explain why this fixes empty exports. ' +
      'context '.repeat(100) +
      repo.root +
      ' ghp_abcdefghijklmnopqrstuvwxyz0123456789 END-REQUEST';
    const log = new ClaudeLog(repo.root)
      .prompt(prompt)
      .plan('# Plan\n' + 'Preserve the empty case. '.repeat(100) + 'END-PLAN')
      .write(join(repo.root, 'src/greet.ts'), GREET);
    for (let i = 0; i < 30; i++)
      log.bash(`bun test tests/check-${i}.test.ts`, '1 pass\n0 fail');
    log.save(claudeHome, 'evidence');
    const sha = repo.commit(
      'src/greet.ts',
      GREET,
      'fix: empty exports\n\nA blank output was reported during review; see #42.',
    );
    const r = cli(repo.root, 'digest', '--offline', '--budget', '1000');
    expect(r.code).toBe(0);
    const compact = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    const full = JSON.parse(
      readFileSync(join(r.json.runDir, 'digest-full.json'), 'utf8'),
    );
    expect(compact.sessions[0].runs.length).toBeLessThan(full.sessions[0].runs.length);
    for (const fact of compact.sessions[0].runs)
      expect(full.sessions[0].runs.find((f: any) => f.id === fact.id)?.cmd).toBe(
        fact.cmd,
      );
    expect(cli(repo.root, 'expand', 'S1', '--run', r.json.run).json.text).toContain(
      'END-REQUEST',
    );
    expect(
      cli(repo.root, 'expand', 'digest:P1', '--run', r.json.run).json.excerpt,
    ).toContain('END-PLAN');
    expect(cli(repo.root, 'expand', 'R1', '--run', r.json.run).json.cmd).toBe(
      'bun test tests/check-0.test.ts',
    );
    expect(
      cli(repo.root, 'expand', `commit:${sha}`, '--run', r.json.run).json.body,
    ).toContain('#42');
    expect(cli(repo.root, 'expand', 'R999', '--run', r.json.run).code).not.toBe(0);
    expect(JSON.stringify(full)).not.toContain(repo.root);
    expect(JSON.stringify(full)).not.toContain('ghp_');
    expect(compact.pr.commits[0].body).toContain('blank output');
    expect(compact.linkedPrs).toEqual([]); // A reference is not automatically a saga.
    expect(readFileSync(r.json.evidenceNotesPath, 'utf8')).toContain('Historical checks');
  });

  test('matches the session that wrote the code and drops other repos', () => {
    const repo = makeRepo();
    const other = tempDir('tracetoon-other-');
    new ClaudeLog(repo.root)
      .prompt('Please add a greeting helper for the CLI')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .bash('bun test', '3 pass')
      .at(other)
      .prompt('PRIVATE-OTHER-REPO-PROMPT about another project')
      .write(join(other, 'notes.md'), 'unrelated private notes line\n')
      .save(claudeHome, 'sess-main');
    new ClaudeLog(other)
      .prompt('SECRET-PROJECT-PLANS')
      .write(join(other, 'x.ts'), 'secret code here\n')
      .save(claudeHome, 'sess-other', 'other');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');

    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toHaveLength(1);
    expect(r.json.sessions[0].band).toBe('included');
    const digestText = readFileSync(r.json.digestPath, 'utf8');
    const digest = JSON.parse(digestText);
    expect(digest.stats.agentMatchedPct).toBe(100);
    expect(digest.sessions[0].prompts.map((p: any) => p.text)).toEqual([
      'Please add a greeting helper for the CLI',
    ]);
    expect(digest.sessions[0].milestones).toContain('edited 1 file(s)');
    expect(digest.files[0].path).toBe('src/greet.ts');
    for (const leak of [
      'PRIVATE-OTHER-REPO-PROMPT',
      'SECRET-PROJECT-PLANS',
      'unrelated private notes',
      other,
      repo.root,
    ]) {
      expect(digestText).not.toContain(leak);
    }
    expect(digest.privacy.droppedForeignRecords).toBeGreaterThan(0);
  });

  test('credits a session that committed from a since-deleted worktree', () => {
    const repo = makeRepo();
    const sha = repo.commit(
      'src/a.ts',
      'export const answer = computeTheAnswer();\n',
      'feat: answer',
    );
    const goneWorktree = join(tempDir('tracetoon-gone-'), 'wt');
    new ClaudeLog(goneWorktree)
      .prompt('implement the answer in a worktree')
      .bash(
        'git commit -q -m "feat: answer" && git log --oneline -1',
        `${sha.slice(0, 7)} feat: answer`,
      )
      .save(claudeHome, 'sess-wt', 'wt');
    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toHaveLength(1);
    expect(r.json.sessions[0].score).toBe(0.9);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.stats.commitsMadeInSessions).toBe(1);
    expect(digest.sessions[0].prompts[0].text).toBe('implement the answer in a worktree');
  });
});

describe('other agents', () => {
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  test('matches a Codex session that worked from the home folder', () => {
    const repo = makeRepo();
    const start = Date.now() - 30 * 60_000;
    const t = (n: number) => new Date(start + n * 1000).toISOString();
    const dir = join(codexHome, 'sessions', '2026', '10', '23');
    mkdirSync(dir, { recursive: true });
    const id = '019ef1c4-1899-7a90-bb9f-b09bca10e91c';
    writeFileSync(
      join(dir, `rollout-2026-10-23T10-00-00-${id}.jsonl`),
      jsonl([
        {
          timestamp: t(0),
          type: 'session_meta',
          payload: { id, cwd: tempDir('tracetoon-home-') },
        },
        { timestamp: t(1), type: 'turn_context', payload: { model: 'gpt-test' } },
        {
          timestamp: t(2),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'UserMessage',
              content: [{ type: 'text', text: 'Add the greeting helper please' }],
            },
          },
        },
        {
          timestamp: t(3),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'FileChange',
              status: 'completed',
              changes: {
                [join(repo.root, 'src/greet.ts')]: { type: 'add', content: GREET },
              },
            },
          },
        },
      ]),
    );
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      jsonl([{ id, thread_name: 'Greeting helper' }]),
    );
    repo.commit('src/greet.ts', GREET, 'feat: greeting');
    // An open Windows writer may retain an old mtime while recent events append.
    utimesSync(
      join(dir, `rollout-2026-10-23T10-00-00-${id}.jsonl`),
      new Date('2020-01-01'),
      new Date('2020-01-01'),
    );
    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toMatchObject([
      { agent: 'Codex', title: 'Greeting helper', band: 'included' },
    ]);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.stats.agentMatchedPct).toBe(100);
    expect(digest.disclosure.suggestedTrailers).toEqual(['Assisted-by: Codex:gpt-test']);
  });

  test('matches an Antigravity conversation and includes its walkthrough', () => {
    const repo = makeRepo();
    const start = Date.now() - 30 * 60_000;
    const t = (n: number) => new Date(start + n * 1000).toISOString();
    const brain = join(geminiHome, 'antigravity-ide', 'brain', 'conv-1');
    mkdirSync(join(brain, '.system_generated', 'logs'), { recursive: true });
    const target = JSON.stringify(join(repo.root, 'src/greet.ts'));
    writeFileSync(
      join(brain, '.system_generated', 'logs', 'transcript.jsonl'),
      jsonl([
        {
          step_index: 0,
          type: 'USER_INPUT',
          created_at: t(0),
          content: '<USER_REQUEST>Write a greeting helper</USER_REQUEST>',
        },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: t(1),
          source: 'MODEL',
          tool_calls: [
            {
              name: 'write_to_file',
              args: { TargetFile: target, CodeContent: JSON.stringify(GREET) },
            },
          ],
        },
        { step_index: 2, type: 'CODE_ACTION', status: 'DONE', created_at: t(2) },
      ]),
    );
    writeFileSync(
      join(brain, 'walkthrough.md'),
      '# Walkthrough\nAdded greet() and verified it in the browser.\n',
    );
    writeFileSync(
      join(brain, 'walkthrough.md.metadata.json'),
      JSON.stringify({ summary: 'Added greet()', updatedAt: t(3) }),
    );
    repo.commit('src/greet.ts', GREET, 'feat: greeting');
    const r = cli(repo.root, 'digest', '--offline');
    expect(r.code).toBe(0);
    expect(r.json.sessions).toMatchObject([{ agent: 'Antigravity', band: 'included' }]);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.sessions[0].artifacts).toMatchObject([
      { name: 'walkthrough', summary: 'Added greet()' },
    ]);
    expect(digest.sessions[0].prompts[0].text).toBe('Write a greeting helper');
  });

  test('reports Entire checkpoints found in commit trailers', () => {
    const repo = makeRepo();
    repo.commit(
      'a.txt',
      'hello world line\n',
      'feat: a\n\nEntire-Checkpoint: 01JABCDEFGHJKMNPQRSTVWXYZ0',
    );
    const r = cli(repo.root, 'digest', '--offline');
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    expect(digest.interop.entire).toMatchObject({
      checkpoints: ['01JABCDEFGHJKMNPQRSTVWXYZ0'],
      commitsWithCheckpoint: 1,
    });
  });
});

describe('render and publish', () => {
  setDefaultTimeout(60_000);
  function prepared(contributing?: string) {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    if (contributing)
      repo.commit('CONTRIBUTING.md', contributing, 'docs: contribution rules');
    new ClaudeLog(repo.root)
      .prompt('Add greeting')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(claudeHome, 's1');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');
    const d = cli(repo.root, 'digest', '--offline');
    expect(d.code).toBe(0);
    expect(cli(repo.root, 'context', '--offline').code).toBe(0);
    const runDir = d.json.runDir as string;
    writeFileSync(
      join(runDir, 'body.md'),
      '## Summary\nAdds a greeting helper. Thanks @octocat!\n',
    );
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting helper\n');
    return { repo, runDir, run: d.json.run as string };
  }

  const ghCalls = () =>
    readFileSync(ghLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  test('publish creates the PR from the exact render without a code', () => {
    const { repo, runDir, run } = prepared();
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.findings).toEqual([]);
    expect(r.json.previewHandoff).toBeUndefined();
    expect(existsSync(join(runDir, 'preview.html'))).toBe(false);
    const finalBody = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(finalBody).toContain('<!-- tracetoon:start -->');
    expect(finalBody).toContain('@​octocat');
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    });
    expect(text.status).toBe(0);
    expect(text.stdout.trimEnd()).toEndWith(`Next: tracetoon publish --run ${run}`);

    const notPushed = cli(repo.root, 'publish', '--no-push');
    expect(notPushed.json.error).toContain('not on GitHub yet');
    expect(existsSync(ghLog)).toBe(false);

    const ok = cli(repo.root, 'publish', '--push');
    expect(ok.code).toBe(0);
    expect(ok.json.url).toBe('https://github.com/acme/demo/pull/7');
    expect(ok.json.message).toStartWith(
      'Tracetoon created PR #7: https://github.com/acme/demo/pull/7\n',
    );
    expect(ok.json.message).toMatch(/^Comic: (included|none — .+)\.$/m);
    expect(ok.json.message).toContain(
      'Comics: tracetoon config set comic off|allowed|always (now: ',
    );
    const create = ghCalls().find((c) => c.args[1] === 'create');
    expect(create.args).toContain('Add greeting helper');
    expect(create.body).toBe(readFileSync(join(runDir, 'posted-body.md'), 'utf8'));
    expect(regionContent(create.body)).toBe(regionContent(finalBody));
    const approval = JSON.parse(readFileSync(join(runDir, 'approval.json'), 'utf8'));
    expect(decodeMeta(create.body)?.submission).toBe(approval.code);
  });

  test("every gh call names the one target repo, not gh's default (issue 52)", () => {
    const { repo, runDir } = prepared();
    git(repo.root, ['remote', 'add', 'upstream', 'https://github.com/upstream/demo.git']);
    env.FAKE_GH_REPO = 'upstream/demo';
    expect(cli(repo.root, 'context').json.repo).toBe('upstream/demo');
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.repo).toBe('upstream/demo');
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toContain('PR target: upstream/demo');
    expect(cli(repo.root, 'publish', '--push').code).toBe(0);
    const approval = JSON.parse(readFileSync(join(runDir, 'approval.json'), 'utf8'));
    expect(approval.repo).toBe('upstream/demo');
    // Every call that reads or writes PRs or repo metadata carries the same repo.
    const writes = ghCalls().filter(
      (c) =>
        c.args[0] === 'pr' ||
        (c.args[0] === 'repo' && c.args[1] === 'view' && !c.args.includes('-q')) ||
        (c.args[0] === 'repo' && c.args.includes('visibility')),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const c of writes) {
      const at = c.args.indexOf('--repo');
      const positional = c.args[0] === 'repo' ? c.args[2] : undefined;
      expect(at >= 0 ? c.args[at + 1] : positional).toBe('upstream/demo');
    }
    expect(ghCalls().some((c) => c.args[1] === 'create')).toBe(true);
  });

  test('publish refuses when the target repo changed since the render', () => {
    const { repo } = prepared();
    git(repo.root, ['remote', 'add', 'upstream', 'https://github.com/upstream/demo.git']);
    env.FAKE_GH_REPO = 'upstream/demo';
    expect(cli(repo.root, 'context').code).toBe(0);
    expect(cli(repo.root, 'render').code).toBe(0);
    env.FAKE_GH_REPO = 'elsewhere/stale'; // gh's default now points at an unrelated repo
    const r = cli(repo.root, 'publish', '--push');
    expect(r.code).not.toBe(0);
    expect(r.json.error).toMatch(/rendered for upstream\/demo/);
    expect(ghCalls().some((c) => c.args[1] === 'create')).toBe(false);
  });

  test('a body edited after render must be rendered again', () => {
    const { repo, runDir } = prepared();
    git(repo.root, ['push', '-q', 'origin', 'feature']);
    expect(cli(repo.root, 'render').code).toBe(0);
    const finalBody = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    writeFileSync(join(runDir, 'final-body.md'), finalBody + '\nsneaky edit\n');
    expect(cli(repo.root, 'publish').json.error).toContain('description changed');
    expect(existsSync(ghLog)).toBe(false);
    expect(cli(repo.root, 'render').code).toBe(0);
    const r = cli(repo.root, 'publish');
    expect(r.code).toBe(0);
    expect(r.json.url).toContain('/pull/7');
  });

  test('render refuses to post a body with a leaked secret', () => {
    const { repo, runDir } = prepared();
    git(repo.root, ['push', '-q', 'origin', 'feature']);
    writeFileSync(
      join(runDir, 'body.md'),
      'Config: api_key = sk-live-abcdefghijklmnop1234567890\n',
    );
    const r = cli(repo.root, 'render');
    expect(r.json.findings.length).toBeGreaterThan(0);
    // The finding is located, so the user can act on it; its value is never echoed.
    expect(r.json.findingAt.some((at: string) => /^final-body\.md:\d+$/.test(at))).toBe(
      true,
    );
    // Agents read render --json: the notice is there, ready to relay first.
    expect(r.json.leakNotice).toStartWith('PR NOT CREATED');
    expect(r.json.leakNotice).not.toContain('sk-live');
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toStartWith('PR NOT CREATED');
    expect(text).not.toContain('sk-live');
    const refused = cli(repo.root, 'publish').json.error;
    expect(refused).toStartWith('PR NOT CREATED: the leak scan found a possible secret');
    expect(refused).toContain('final-body.md:');
    expect(refused).toContain('Tell the user this first');
    expect(refused).not.toContain('sk-live');
    expect(existsSync(ghLog)).toBe(false);
    expect(cli(repo.root, 'render', '--allow-findings').code).toBe(0);
    const posted = cli(repo.root, 'publish');
    expect(posted.code).toBe(0);
    expect(posted.json.url).toContain('/pull/7');
  });

  test('repo bans on AI PRs do not block a requested PR', () => {
    const { repo, runDir, run } = prepared(
      '# Contributing\n\nWe do not accept AI-generated contributions.\n',
    );
    git(repo.root, ['push', '-q', 'origin', 'feature']);
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('appears to prohibit AI-written contributions');
    expect(text.stdout.trimEnd()).toEndWith(`Next: tracetoon publish --run ${run}`);
    expect(JSON.parse(readFileSync(join(runDir, 'approval.json'), 'utf8')).policy).toBe(
      'prohibited',
    );
    const r = cli(repo.root, 'publish');
    expect(r.code).toBe(0);
    expect(r.json.url).toBe('https://github.com/acme/demo/pull/7');
    expect(ghCalls().some((c) => c.args[1] === 'create')).toBe(true);
  });
});
