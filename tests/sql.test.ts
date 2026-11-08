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
    // This branch's default; set explicitly so it holds whatever else ran in this process.
    TRACETOON_EVIDENCE_MODE: 'relational',
  };
  const cli = (cwd: string, ...args: string[]) => cliWith({}, cwd, ...args);
  const cliWith = (extra: Record<string, string>, cwd: string, ...args: string[]) => {
    const r = spawnSync(PROGRAM[0]!, [...PROGRAM.slice(1), ...args], {
      cwd,
      env: { ...env, ...extra },
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
  return { claudeHome, cli, cliWith };
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
    // The wasm driver is the default (WebAssembly vs WebAssembly against cypherlite).
    expect(sqlEngineAvailable()).toMatchObject({
      ok: true,
      driver:
        process.env.TRACETOON_SQLITE_DRIVER === 'native'
          ? expect.any(String)
          : 'sqlite-wasm',
    });
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

  test("rows come back in the graph engine's order where the brief keeps it", () => {
    // Relationships are walked newest first by cypherlite; symbol lists in limits,
    // implementedBy ties and a commit's sessions keep that order.
    const H = (id: string, file: string, sym: string, diff: string) =>
      N('Hunk', id, {
        file,
        start: 1,
        end: 2,
        added: 2,
        removed: 0,
        diff,
        context: null,
        scope: null,
        symbols: [sym],
        touched: [sym],
        branches: 1,
        fresh: [],
        pairs: [],
        tests: [],
        words: ['shared', 'word', sym.toLowerCase()],
      });
    const F = (id: string) =>
      N('File', id, { role: 'behavior', inPr: true, added: 2, removed: 0, unmatched: 0 });
    const graph: EvidenceGraph = {
      schema: GRAPH_SCHEMA,
      nodes: [
        F('src/a.ts'),
        F('src/b.ts'),
        H('H1', 'src/a.ts', 'Alpha', 'diff:1-3'),
        H('H2', 'src/b.ts', 'Beta', 'diff:5-7'),
        N('Session', 'h:1', { band: 'included', agent: 'a', score: 1, title: null }),
        N('Session', 'h:2', { band: 'included', agent: 'a', score: 1, title: null }),
        N('Commit', 'abcdef123456', {
          subject: 'shared word change',
          body: 'Shared word here.',
          t: '5',
        }),
        N('CommitClaim', 'abcdef123456#1', {
          commit: 'abcdef123456',
          text: 'Shared word here.',
          assertsResult: false,
        }),
        N('Change', 'CH1', {
          key: 'dir:src',
          files: ['src/a.ts', 'src/b.ts'],
          roles: ['behavior'],
          symbols: ['Alpha', 'Beta'],
          added: 4,
          removed: 0,
          branches: 2,
        }),
      ],
      rels: [
        R('OF', ['Hunk', 'H1'], ['File', 'src/a.ts']),
        R('OF', ['Hunk', 'H2'], ['File', 'src/b.ts']),
        R('TOUCHES', ['Commit', 'abcdef123456'], ['File', 'src/a.ts']),
        R('TOUCHES', ['Commit', 'abcdef123456'], ['File', 'src/b.ts']),
        R('INTRODUCED', ['Commit', 'abcdef123456'], ['Hunk', 'H1'], { lines: 2 }),
        R('INTRODUCED', ['Commit', 'abcdef123456'], ['Hunk', 'H2'], { lines: 2 }),
        R('SAYS', ['Commit', 'abcdef123456'], ['CommitClaim', 'abcdef123456#1']),
        R('MADE', ['Session', 'h:1'], ['Commit', 'abcdef123456']),
        R('MADE', ['Session', 'h:2'], ['Commit', 'abcdef123456']),
        R('HAS', ['Change', 'CH1'], ['Hunk', 'H1']),
        R('HAS', ['Change', 'CH1'], ['Hunk', 'H2']),
        R('EXPLAINED_BY', ['Change', 'CH1'], ['Commit', 'abcdef123456']),
      ],
      stats: { nodes: 9, rels: 12, hunks: 2, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
    };
    expect(compareEngines(graph)).toEqual([]);
  });

  test('both engines answer every named question the same way', () => {
    const graph = graphFromScenario();
    expect(graph.nodes.some((n) => n.label === 'Change')).toBe(true);
    expect(graph.nodes.some((n) => n.label === 'Plan')).toBe(true);
    expect(compareEngines(graph)).toEqual([]);
  });

  test('extras: reads, fail-to-pass fixes, effort and search, shown only with the flag', () => {
    const { claudeHome, cli, cliWith } = setup();
    const repo = makeRepo();
    new ClaudeLog(repo.root)
      .prompt('Add a greet helper that says hello by name')
      .read(join(repo.root, 'src/util.ts'))
      .grep('formatName', join(repo.root, 'src'))
      .bash('cat README.md && sed -n 1,20p src/names.ts', 'readme')
      .write(join(repo.root, 'src/greet.ts'), 'export const greet = 1;\n')
      .bash('bun test', '0 pass\n1 fail', true)
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .bash('bun test', '1 pass\n0 fail')
      .reply('Done: greet says hello.')
      .save(claudeHome, 'extras');
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
    git(repo.root, ['add', '.']);
    git(repo.root, ['commit', '-q', '-m', 'feat: greet']);
    const r = cli(repo.root, '--json', 'digest', '--offline');
    expect(r.code).toBe(0);
    const graph: EvidenceGraph = JSON.parse(
      readFileSync(join(r.json.runDir, 'evidence-graph.json'), 'utf8'),
    );
    expect(graph.extras?.reads.map((x) => [x.tool, x.file, x.pattern])).toEqual([
      ['Read', 'src/util.ts', null],
      ['Grep', 'src', 'formatName'],
      ['shell:cat', 'README.md', null],
      ['shell:sed', 'src/names.ts', null],
    ]);
    expect(graph.extras?.reads.every((x) => x.prompt === 'S1')).toBe(true);
    // Extras never change what both engines answer.
    expect(compareEngines(graph)).toEqual([]);

    const titles = (b: any) => b.json.sections.map((x: any) => x.title);
    // On by default in this build; =0 gives the graph arm's brief.
    const off = { TRACETOON_SQLITE_EXTRAS: '0' };
    const plain = cliWith(
      off,
      repo.root,
      '--json',
      'query',
      'brief',
      '--run',
      r.json.run,
    );
    expect(titles(plain)).not.toContain('context');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', r.json.run);
    const sec = (t: string) => b.json.sections.find((x: any) => x.title === t)?.rows;
    expect(sec('context')).toEqual([
      {
        ref: 'X1',
        for: 'CH1',
        read: ['README.md', 'src/names.ts', 'src/util.ts'],
        searched: ['formatName (in src)'],
        beforeEdits: [expect.stringMatching(/^E\d+$/)],
      },
    ]);
    expect(sec('fixes')).toMatchObject([
      { ref: 'F1', cmd: 'bun test', failed: 'R1', passed: 'R2', files: ['src/greet.ts'] },
    ]);
    expect(sec('fixes')[0].fixedBy).toHaveLength(1);
    expect(sec('effort')).toMatchObject([
      { change: 'CH1', turns: 1, deadEnds: 1, runs: 2 },
    ]);
    expect(sec('avoid').some((x: any) => x.rule.startsWith('context rows (X#)'))).toBe(
      true,
    );

    const found = cli(
      repo.root,
      '--json',
      'query',
      'search',
      'hello',
      '--run',
      r.json.run,
    );
    expect(found.json.sections[0].rows[0]).toMatchObject({ id: 'S1', kind: 'Prompt' });
    const cycles = cli(
      repo.root,
      '--json',
      'query',
      '--sql',
      'SELECT failed_run, passed_run FROM run_cycles',
      '--run',
      r.json.run,
    );
    expect(cycles.json.sections[0].rows).toEqual([
      { failed_run: 'R1', passed_run: 'R2' },
    ]);
  });
});

describe('shell reads', () => {
  const { shellReads } =
    require('../src/trace/reads.ts') as typeof import('../src/trace/reads.ts');
  const of = (cmd: string) =>
    shellReads(cmd, '/r').map((r) => [r.tool, r.path, r.pattern ?? null]);
  test('read-only commands become reads; writes and in-place edits do not', () => {
    expect(of('cd sub && cat a.ts | head -5')).toEqual([
      ['shell:cat', '/r/sub/a.ts', null],
    ]);
    expect(of('sed -n 10,20p src/x.ts')).toEqual([['shell:sed', '/r/src/x.ts', null]]);
    expect(of("rg -n 'foo bar' src tests")).toEqual([
      ['shell:rg', '/r/src', 'foo bar'],
      ['shell:rg', '/r/tests', 'foo bar'],
    ]);
    expect(of('grep -r needle')).toEqual([['shell:grep', '/r', 'needle']]);
    expect(of('sed -i s/a/b/ x.ts')).toEqual([]);
    expect(of('cat a.ts > b.ts')).toEqual([]);
    expect(of('bun test 2>&1')).toEqual([]);
    expect(of('tail -n 600 $D/log.txt')).toEqual([]);
    expect(of('cat <<EOF')).toEqual([]);
    expect(of('bun test 2>&1 | grep -E "^\\(fail\\)|error"')).toEqual([]);
    expect(of('rg "\\bload\\b" src')).toEqual([['shell:rg', '/r/src', '\\bload\\b']]);
    expect(of("rg 'parse|load' src | head -20")).toEqual([
      ['shell:rg', '/r/src', 'parse|load'],
    ]);
    expect(of('ls src docs')).toEqual([]);
    expect(of('head -40 README.md')).toEqual([['shell:head', '/r/README.md', null]]);
    expect(of('rg -n "\\"Hunk\\(" src')).toEqual([['shell:rg', '/r/src', '"Hunk\\(']]);
  });
});

describe('relational arm (no brief)', () => {
  test('prepare gives the database guide; render writes Validation and checks ids and commits', () => {
    const { claudeHome, cli } = setup();
    const repo = makeRepo();
    new ClaudeLog(repo.root)
      .prompt('Add a greet helper that says hello by name')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .bash('bun test', '1 pass\n0 fail')
      .prompt('Now add farewell too')
      .write(join(repo.root, 'src/farewell.ts'), FAREWELL)
      .save(claudeHome, 'relational');
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
    writeFileSync(join(repo.root, 'src/farewell.ts'), FAREWELL);
    git(repo.root, ['add', '.']);
    git(repo.root, [
      'commit',
      '-q',
      '-m',
      'feat: farewell',
      '-m',
      'Says goodbye in a friendly way.',
    ]);
    const prepared = cli(repo.root, '--json', 'prepare', '--offline');
    expect(prepared.code).toBe(0);
    const run = prepared.json.run;
    expect(prepared.json.brief).toBeUndefined();
    expect(prepared.json.evidenceGuide).toContain('tracetoon query --sql');
    expect(prepared.json.evidenceGuide).toContain('Starter queries:');
    expect(prepared.json.next).toContain('evidence database');
    const sql = (q: string) =>
      cli(repo.root, '--json', 'query', '--sql', q, '--run', run).json.sections[0].rows;
    const greet = sql(
      `SELECT ch.change AS id FROM change_hunk ch JOIN hunks h ON h.id = ch.hunk WHERE h.file = 'src/greet.ts'`,
    )[0].id;
    const commits = sql('SELECT id, subject FROM commits ORDER BY t');
    const greetCommit = commits.find((c: any) => c.subject === 'feat: greet').id;
    // Search reaches prompts and changed-line words.
    const found = cli(repo.root, '--json', 'query', 'search', 'greet', '--run', run);
    expect(found.json.sections[0].rows.map((r: any) => r.kind)).toContain('Prompt');
    const runDir = prepared.json.runDir;
    writeFileSync(join(runDir, 'title.txt'), 'Add greet and farewell helpers');
    writeFileSync(
      join(runDir, 'body.md'),
      [
        `Adds a greet helper that says hello by name. [${greet}, S1, commit:${greetCommit}]`,
        'Adds a farewell helper too. [Z9]',
        '',
        '<!-- tracetoon:validation -->',
        '',
      ].join('\n'),
    );
    const r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    const body = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(body).toContain('## Validation');
    expect(body).not.toContain('[S1');
    expect(r.json.briefCheck.unknownRefs).toEqual(['Z9']);
    // Every commit-message sentence should be covered; the farewell commit's is not.
    expect(r.json.briefCheck.uncovered.join(' ')).toContain(
      'Says goodbye in a friendly way.',
    );
    expect(r.json.briefCheck.uncovered.join(' ')).not.toContain('Greets people');
  });
});
