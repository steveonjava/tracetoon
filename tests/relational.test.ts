import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [process.env.TRACETOON_TEST_BINARY]
  : [process.execPath, CLI];
setDefaultTimeout(60_000);

const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';

describe('shape test: relational/vector arm interface', () => {
  test('prepare prints the relational context in the brief place; lookups are refused; render keeps Validation', () => {
    const claudeHome = tempDir('tracetoon-claude-');
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
      TRACETOON_EVIDENCE_MODE: 'relational-vector',
    };
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
    expect(existsSync(join(runDir, 'relational-context.json'))).toBe(true);
    expect(existsSync(join(runDir, 'graph-review.json'))).toBe(false);
    // Lookups: only the brief (the same context).
    expect(cli(repo.root, 'query', 'outline', '--run', run).code).toBe(1);
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', run);
    expect(b.json.text).toBe(prepared.json.brief);
    // The digest is not annotated from the graph.
    const digest = JSON.parse(readFileSync(prepared.json.digestPath, 'utf8'));
    expect(digest.files.every((f: any) => !f.facts)).toBe(true);
    const refs = JSON.parse(
      readFileSync(join(runDir, 'relational-context.json'), 'utf8'),
    ).refs;
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
