import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import { SqlEngine, sqlEngineAvailable } from '../src/sql/engine.ts';
import { compareEngines } from '../src/sql/parity.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [process.env.TRACETOON_TEST_BINARY]
  : [process.execPath, CLI];
setDefaultTimeout(60_000);

function setup() {
  const claudeHome = tempDir('tracetoon-claude-');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: tempDir('tracetoon-codex-'),
    ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
    GEMINI_HOME: tempDir('tracetoon-gemini-'),
    TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
  };
  const cli = (cwd: string, ...args: string[]) => {
    const r = spawnSync(PROGRAM[0]!, [...PROGRAM.slice(1), ...args], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      json = undefined;
    }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  return { claudeHome, cli };
}

const GREET =
  'export function greet(name: string): string {\n  if (!name) return "Hello!";\n  return `Hello, ${name}!`;\n}\n';
const FAREWELL =
  'export function farewell(name: string): string {\n  return `Goodbye, ${name}.`;\n}\n';
const TEST =
  'test("greets by name", () => {\n  expect(greet("a")).toBe("Hello, a!");\n});\n';

/** Two prompts, a plan, a failing then passing test run, a dead end, a pushback, two commits. */
function graphFromScenario(): EvidenceGraph {
  const { claudeHome, cli } = setup();
  const repo = makeRepo();
  new ClaudeLog(repo.root)
    .prompt('Add a greet helper that says hello by name')
    .plan('# Plan\n\n1. greet in src/greet.ts\n2. a test')
    .write(join(repo.root, 'src/greet.ts'), GREET)
    .write(join(repo.root, 'tests/greet.test.ts'), TEST)
    .bash('bun test', '0 pass\n1 fail', true)
    .write(join(repo.root, 'src/scratch.ts'), 'export const tryingSomething = 1;\n')
    .bash('bun test', '1 pass\n0 fail')
    .prompt('Now add farewell too')
    .write(join(repo.root, 'src/farewell.ts'), FAREWELL)
    .save(claudeHome, 'sql');
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  mkdirSync(join(repo.root, 'tests'), { recursive: true });
  writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
  writeFileSync(join(repo.root, 'tests/greet.test.ts'), TEST);
  git(repo.root, ['add', '.']);
  git(repo.root, ['commit', '-q', '-m', 'feat: greet', '-m', 'All tests pass.']);
  writeFileSync(join(repo.root, 'src/farewell.ts'), FAREWELL);
  git(repo.root, ['add', '.']);
  git(repo.root, ['commit', '-q', '-m', 'feat: farewell', '-m', 'Asked for in review.']);
  const r = cli(repo.root, '--json', 'digest', '--offline');
  expect(r.code).toBe(0);
  return JSON.parse(readFileSync(join(r.json.runDir, 'evidence-graph.json'), 'utf8'));
}

const N = (label: any, id: string, props: Record<string, any>) => ({ label, id, props });
const R = (type: any, from: [any, string], to: [any, string], props?: any) => ({
  type,
  from: { label: from[0], id: from[1] },
  to: { label: to[0], id: to[1] },
  ...(props ? { props } : {}),
});

describe('sqlite evidence store', () => {
  test('SQLite opens in this runtime, with FTS5', () => {
    expect(sqlEngineAvailable()).toMatchObject({ ok: true });
  });

  test('typed tables decode lists and booleans; writes are refused', () => {
    const graph: EvidenceGraph = {
      schema: GRAPH_SCHEMA,
      nodes: [
        N('Session', 'h:a', { band: 'included', agent: 'claude', score: 1, title: null }),
        N('Prompt', 'S1', {
          t: '1',
          text: '[not json',
          pushback: true,
          ledToEdits: 1,
          session: 'h:a',
        }),
        N('Change', 'CH1', {
          key: 'dir:src',
          files: ['src/a.ts'],
          roles: ['behavior'],
          symbols: [],
          added: 1,
          removed: 0,
          branches: 0,
        }),
      ],
      rels: [R('IN_SESSION', ['Prompt', 'S1'], ['Session', 'h:a'])],
      stats: { nodes: 3, rels: 1, hunks: 0, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
    };
    const db = SqlEngine.load(graph);
    try {
      expect(db.sql('SELECT id, text, pushback FROM prompts').rows).toEqual([
        { id: 'S1', text: '[not json', pushback: true },
      ]);
      expect(db.sql('SELECT files, symbols FROM changes').rows).toEqual([
        { files: ['src/a.ts'], symbols: [] },
      ]);
      expect(
        db.sql('SELECT j.value AS f FROM changes c, json_each(c.files) j').rows,
      ).toEqual([{ f: 'src/a.ts' }]);
      expect(db.sql('SELECT kind, id, session FROM in_session').rows).toEqual([
        { kind: 'Prompt', id: 'S1', session: 'h:a' },
      ]);
      expect(() => db.sql('DELETE FROM prompts')).toThrow(/readonly/);
    } finally {
      db.close();
    }
  });

  test('a property the schema lacks fails loudly instead of being dropped', () => {
    const graph = {
      schema: GRAPH_SCHEMA,
      nodes: [N('Session', 'h:a', { band: 'included', novel: 1 })],
      rels: [],
      stats: { nodes: 1, rels: 0, hunks: 0, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
    } as EvidenceGraph;
    expect(() => SqlEngine.load(graph)).toThrow(/novel/);
  });

  test('both engines answer every named question the same way', () => {
    const graph = graphFromScenario();
    expect(graph.nodes.some((n) => n.label === 'Change')).toBe(true);
    expect(graph.nodes.some((n) => n.label === 'Plan')).toBe(true);
    expect(compareEngines(graph)).toEqual([]);
  });
});
