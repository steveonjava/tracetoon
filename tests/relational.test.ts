import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { R_BUDGET_TOKENS } from '../src/relational/index.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

// Paths given relative to where the test runs (the CLI itself runs in a temp repo).
const CLI = process.env.TRACETOON_TEST_CLI
  ? resolve(process.env.TRACETOON_TEST_CLI)
  : resolve(import.meta.dir, '../src/cli.ts');
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [resolve(process.env.TRACETOON_TEST_BINARY)]
  : [process.execPath, CLI];
setDefaultTimeout(60_000);

const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';

describe('relational evidence mode (shape test arm)', () => {
  test('prepare prints the relational context in the brief place; lookups are refused; render keeps Validation', () => {
    const claudeHome = tempDir('tracetoon-claude-');
    const skillMd = join(tempDir('tracetoon-skill-'), 'SKILL.md');
    writeFileSync(skillMd, 'Brief layout: toon.\n\nEvidence mode: relational.\n');
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
      // The arm comes from the skill's variant line alone, as in a benchmark sandbox.
      TRACETOON_SKILL_MD: skillMd,
    };
    delete (env as Record<string, string | undefined>).TRACETOON_EVIDENCE_MODE;
    const cli = (cwd: string, ...args: string[]) => {
      const r = spawnSync(PROGRAM[0]!, [...PROGRAM.slice(1), ...args], {
        cwd,
        env,
        encoding: 'utf8',
      });
      let json: any;
      try {
        json = JSON.parse(r.stdout);
      } catch {}
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    };
    const repo = makeRepo();
    new ClaudeLog(repo.root)
      .prompt('Add a greet helper that says hello by name')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .bash('bun test', '1 pass\n0 fail')
      .save(claudeHome, 'shape');
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
    git(repo.root, ['add', '.']);
    git(repo.root, [
      'commit',
      '-q',
      '-m',
      'feat: greet',
      '-m',
      'Greets people by their name.',
    ]);
    const prepared = cli(repo.root, '--json', 'prepare', '--offline');
    expect(prepared.code).toBe(0);
    const run = prepared.json.run;
    expect(prepared.json.brief).toContain('Rules:');
    expect(prepared.json.brief).not.toContain('changes[');
    const runDir = prepared.json.runDir;
    expect(JSON.parse(readFileSync(join(runDir, 'evidence-mode.json'), 'utf8'))).toEqual({
      mode: 'relational',
    });
    expect(existsSync(join(runDir, 'relational-context.json'))).toBe(true);
    expect(existsSync(join(runDir, 'graph-review.json'))).toBe(false);
    // Lookups: only the brief (the same context).
    expect(cli(repo.root, 'query', 'outline', '--run', run).code).toBe(1);
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', run);
    expect(b.json.text).toBe(prepared.json.brief);
    // The digest is not annotated from the graph.
    const digest = JSON.parse(readFileSync(prepared.json.digestPath, 'utf8'));
    expect(digest.files.every((f: any) => !f.facts)).toBe(true);
    const context = JSON.parse(
      readFileSync(join(runDir, 'relational-context.json'), 'utf8'),
    );
    const refs = context.refs;
    // The builder ran with SQLite and the bundled embedding model in this runtime.
    expect(context.stats.retrieval.model).toBe('minishlab/potion-code-16M-v2');
    expect(context.stats.retrieval.vectors).toBe(true);
    expect(context.tokens).toBeLessThanOrEqual(R_BUDGET_TOKENS);
    expect(context.text.length).toBeLessThanOrEqual(R_BUDGET_TOKENS * 4);
    // Every id in the text is a ref with its own text, and only those.
    const ids = [
      ...new Set(
        [
          ...context.text.matchAll(
            /(?<![\w:])(commit:[0-9a-f]{12}(?:#\d+)?|[SDPRVFH]\d+)(?![\w#])/g,
          ),
        ].map((m: RegExpMatchArray) => m[1]),
      ),
    ].sort();
    expect(refs.map((r: { id: string }) => r.id).sort()).toEqual(ids);
    expect(ids).toContain('S1');
    expect(ids.some((id) => /^commit:[0-9a-f]{12}#1$/.test(id as string))).toBe(true);
    expect(ids.some((id) => /^H\d+$/.test(id as string))).toBe(true);
    // The brief is the context plus the rules; it names the parts of the change.
    expect(prepared.json.brief).toContain('## What changed, by file');
    expect(prepared.json.brief).toContain('src/greet.ts');
    expect(prepared.json.brief).toContain('Add a greet helper that says hello by name');
    writeFileSync(join(runDir, 'title.txt'), 'Add a greet helper');
    writeFileSync(
      join(runDir, 'body.md'),
      [
        `Adds a greet helper. [${refs[0].id}]`,
        'Something else. [Z9]',
        '',
        '<!-- tracetoon:validation -->',
        '',
      ].join('\n'),
    );
    const r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    expect(readFileSync(join(runDir, 'final-body.md'), 'utf8')).toContain(
      '## Validation',
    );
    expect(r.json.briefCheck.unknownRefs).toEqual(['Z9']);
    expect(r.json.briefCheck.uncovered.join(' ')).toContain(
      'Greets people by their name.',
    );
  });
});
