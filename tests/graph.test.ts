import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reviewInput } from '../src/contribution/review.ts';
import { compactDigest, type Run, type TraceDigest } from '../src/digest/build.ts';
import { checkClaims, type ClaimInput } from '../src/digest/claims.ts';
import { patchHunks } from '../src/graph/build.ts';
import { toToon } from '../src/graph/toon.ts';
import { deriveFromGraphJson } from '../src/graph/derive.ts';
import { GraphEngine, graphEngineAvailable, withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import { findQuery } from '../src/graph/queries.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
/** The source, the bundle (TRACETOON_TEST_CLI) or a compiled binary (TRACETOON_TEST_BINARY). */
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [process.env.TRACETOON_TEST_BINARY]
  : [process.execPath, CLI];
setDefaultTimeout(60_000);

function setup() {
  const claudeHome = tempDir('tracetoon-claude-');
  const scratch = tempDir('tracetoon-env-');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: tempDir('tracetoon-codex-'),
    ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
    GEMINI_HOME: tempDir('tracetoon-gemini-'),
    TRACETOON_CONFIG: join(scratch, 'config.json'),
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
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';
const FAREWELL_V1 =
  'export function farewell(name: string): string {\n  return `Bye ${name}`;\n}\n';
const FAREWELL =
  'export function farewell(name: string): string {\n  return `Goodbye, ${name}. See you soon!`;\n}\n';
const MANUAL = 'export const handWrittenLimit = 42; // tuned by hand after review\n';

/**
 * S1 asks for greet; the agent writes it and the tests pass (R1).
 * S2 asks for farewell; a scratch file is written and dropped (dead end), the
 * tests fail (R2), farewell is rewritten and no check runs again.
 * A hand-written file arrives only in the commit.
 */
function scenario() {
  const { claudeHome, cli } = setup();
  const repo = makeRepo();
  const log = new ClaudeLog(repo.root)
    .prompt('Add a greet helper that says hello by name')
    .write(join(repo.root, 'src/greet.ts'), GREET)
    .bash('bun test', '3 pass\n0 fail')
    .prompt('Now add farewell too, keep it friendly')
    .write(
      join(repo.root, 'src/scratch.ts'),
      'export const scratchPadValueForTrying = 1;\n',
    )
    .write(join(repo.root, 'src/farewell.ts'), FAREWELL_V1)
    .bash('bun test', '3 pass\n1 fail', true)
    .write(join(repo.root, 'src/farewell.ts'), FAREWELL);
  log.save(claudeHome, 'graph');
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
  writeFileSync(join(repo.root, 'src/farewell.ts'), FAREWELL);
  writeFileSync(join(repo.root, 'src/manual.ts'), MANUAL);
  git(repo.root, ['add', '.']);
  git(repo.root, ['commit', '-q', '-m', 'feat: greet and farewell helpers']);
  return { repo, cli };
}

describe('evidence graph', () => {
  test('the engine loads in this runtime', () => {
    expect(graphEngineAvailable()).toEqual({ ok: true });
    const g = GraphEngine.open();
    expect(g.run('RETURN 1 + 1 AS x').rows).toEqual([{ x: 2 }]);
    expect(() => g.run('MATCH (n RETURN n')).toThrow();
    g.close();
  });

  test('digest links files to prompts and checks, and names later edits', () => {
    const { repo, cli } = scenario();
    const r = cli(repo.root, '--json', 'digest', '--offline');
    expect(r.code).toBe(0);
    const run = r.json.run as string;
    const runDir = r.json.runDir as string;
    expect(existsSync(join(runDir, 'evidence-graph.json'))).toBe(true);
    const digest = JSON.parse(readFileSync(r.json.digestPath, 'utf8'));
    const file = (p: string) => digest.files.find((f: any) => f.path === p);
    expect(file('src/greet.ts').facts).toEqual(['S1']);
    expect(file('src/farewell.ts').facts).toEqual(['S2']);
    // greet's last edit came before both runs; farewell was rewritten after R2.
    expect(file('src/greet.ts').checksAfterLastEdit).toEqual(['R2:failed', 'R1:passed']);
    expect(file('src/farewell.ts').checksAfterLastEdit).toBeUndefined();
    const runs = digest.sessions[0].runs;
    expect(runs.find((x: any) => x.id === 'R1').laterEdits).toEqual(['src/farewell.ts']);
    expect(runs.find((x: any) => x.id === 'R2').laterEdits).toEqual(['src/farewell.ts']);
    expect(digest.graph.hunks).toBe(3);
    expect(digest.graph.linkedHunks).toBe(2);
    expect(digest.graph.deadEndEdits).toBe(1); // scratch.ts; farewell v1 still has a surviving line

    const review = JSON.parse(readFileSync(join(runDir, 'graph-review.json'), 'utf8'));
    expect(review.unverified.map((u: any) => u.file).sort()).toEqual([
      'src/farewell.ts',
      'src/manual.ts',
    ]);
    expect(review.unexplained.map((u: any) => u.file)).toEqual(['src/manual.ts']);
    expect(review.unexplained[0].diff).toMatch(/^diff:\d+(-\d+)?$/);

    // Named queries over the stored graph, printed as TOON by default.
    const why = cli(repo.root, 'query', 'why', 'src/farewell.ts', '--run', run);
    expect(why.code).toBe(0);
    expect(why.stdout).toContain(
      'turns[1]{prompt,pushback,edits,survivingLines,deadEndEdits,diff,facts,text}:',
    );
    expect(why.stdout).toMatch(/S2,null,2,\d+,0,diff:\d+/);
    // Every hunk is listed, including one no captured edit explains.
    const manual = cli(
      repo.root,
      '--json',
      'query',
      'why',
      'src/manual.ts',
      '--run',
      run,
    );
    const hunks = manual.json.sections.find((x: any) => x.title === 'hunks').rows;
    expect(hunks).toHaveLength(1);
    expect(hunks[0].explained).toBe('no captured edit; read the patch');
    expect(hunks[0].diff).toMatch(/^diff:\d+/);
    const outlined = cli(repo.root, '--json', 'query', 'outline', '--run', run);
    expect(outlined.json.sections.map((x: any) => x.title)).toEqual(['files', 'commits']);
    const unverified = cli(repo.root, '--json', 'query', 'unverified', '--run', run);
    expect(unverified.json.sections[0].rows.map((x: any) => x.file)).toEqual([
      'src/farewell.ts',
      'src/manual.ts',
    ]);
    const turn = cli(repo.root, '--json', 'query', 'turn', 'S2', '--run', run);
    const files = turn.json.sections[1].rows;
    expect(files.find((f: any) => f.file === 'src/scratch.ts')).toMatchObject({
      surviving: 0,
      deadEnds: 1,
    });
    expect(turn.json.sections[2].rows.map((f: any) => f.id)).toEqual(['R2']);
    const stale = cli(repo.root, '--json', 'query', 'stale', 'R1', '--run', run);
    expect(stale.json.sections[1].rows).toEqual([
      { file: 'src/farewell.ts', role: 'behavior' },
    ]);
    const byLine = cli(
      repo.root,
      '--json',
      'query',
      'why',
      'src/greet.ts:2',
      '--run',
      run,
    );
    expect(byLine.json.sections[0].rows[0].prompt).toBe('S1');
    const cypher = cli(
      repo.root,
      '--json',
      'query',
      '--cypher',
      'MATCH (p:Prompt) RETURN p.id AS id ORDER BY id',
      '--run',
      run,
    );
    expect(cypher.json.sections[0].rows).toEqual([{ id: 'S1' }, { id: 'S2' }]);
    const write = cli(
      repo.root,
      'query',
      '--cypher',
      'MATCH (p:Prompt) DETACH DELETE p',
      '--run',
      run,
    );
    expect(write.code).toBe(1);
    expect(write.stderr).toContain('read queries');
    expect(cli(repo.root, 'query', 'nope', '--run', run).code).toBe(1);
    const outline = cli(repo.root, 'query', 'outline', '--run', run);
    expect(outline.stdout).toContain('files[3]{');
    expect(outline.stdout).toMatch(
      /\n  src\/farewell\.ts,behavior,3,0,1,0,S2,[0-9a-f]{12},none\n/,
    );
    expect(outline.stdout).toMatch(
      /\n  src\/greet\.ts,behavior,3,0,1,0,S1,[0-9a-f]{12},R2:failed R1:passed\n/,
    );
    expect(outline.stdout).toMatch(
      /\n  src\/manual\.ts,behavior,1,0,1,1,"",[0-9a-f]{12},no captured edit\n/,
    );
  });

  test('graph construction is deterministic', () => {
    const { repo, cli } = scenario();
    const a = cli(repo.root, '--json', 'digest', '--offline');
    const b = cli(repo.root, '--json', 'digest', '--offline');
    expect(readFileSync(join(a.json.runDir, 'evidence-graph.json'), 'utf8')).toBe(
      readFileSync(join(b.json.runDir, 'evidence-graph.json'), 'utf8'),
    );
  });

  test('a missing engine leaves the digest intact and says so', () => {
    const { repo, cli } = scenario();
    const env = {
      ...process.env,
      TRACETOON_CYPHERLITE_WASM: join(tempDir(), 'missing.wasm'),
    };
    const r = spawnSync(
      PROGRAM[0]!,
      [...PROGRAM.slice(1), '--json', 'digest', '--offline'],
      {
        cwd: repo.root,
        env: { ...env, CLAUDE_CONFIG_DIR: tempDir() },
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.notes.join(' ')).toContain('Evidence graph unavailable');
    expect(existsSync(join(out.runDir, 'evidence-graph.json'))).toBe(false);
    const q = cli(repo.root, 'query', 'outline', '--run', out.run);
    expect(q.code).toBe(1);
    expect(q.stderr).toContain('no evidence graph');
  });
});

describe('patch hunks', () => {
  test('reads hunk bodies by header counts and records patch line ranges', () => {
    const patch = [
      'diff --git a/a.sql b/a.sql',
      'index 1..2 100644',
      '--- a/a.sql',
      '+++ b/a.sql',
      '@@ -1,3 +1,3 @@ CREATE TABLE t',
      ' keep',
      '--- removed comment line',
      '+++ added line that looks like a header',
      ' tail',
      '@@ -10 +10,2 @@',
      '-old',
      '+new one',
      '+new two',
      '\\ No newline at end of file',
      'diff --git a/b.ts b/b.ts',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1 @@',
      '+export const b = 1;',
      '',
    ].join('\n');
    const hunks = patchHunks(patch);
    expect(
      hunks.map((h) => [h.id, h.file, h.diff, h.start, h.end, h.added, h.removed]),
    ).toEqual([
      ['H1', 'a.sql', 'diff:5-9', 1, 3, 1, 1],
      ['H2', 'a.sql', 'diff:10-14', 10, 11, 2, 1],
      ['H3', 'b.ts', 'diff:18-19', 1, 1, 1, 0],
    ]);
    expect(hunks[0]!.context).toBe('CREATE TABLE t');
    expect([...hunks[0]!.lines]).toEqual(['++ added line that looks like a header']);
  });
});

describe('toon', () => {
  test('quotes only what could be misread', () => {
    expect(
      toToon([
        {
          title: 'rows',
          columns: ['a', 'b', 'c', 'd'],
          rows: [
            { a: 'plain', b: ['S1', 'D2'], c: 'x, y: "z"', d: 12 },
            { a: '42', b: [], c: null, d: true },
          ],
        },
      ]),
    ).toBe('rows[2]{a,b,c,d}:\n  plain,S1 D2,"x, y: \\"z\\"",12\n  "42","",null,true\n');
    const many = {
      title: 'r',
      columns: ['n'],
      rows: Array.from({ length: 5 }, (_, n) => ({ n })),
    };
    expect(toToon([many], { rowCap: 2 })).toContain('# 3 more rows not shown');
  });
});

describe('graph-derived evidence in checks, budgets, notes and review', () => {
  const run = (over: Partial<Run>): Run => ({
    id: 'R1',
    t: '2026-10-24T01:00:00Z',
    cmd: 'bun test',
    kind: 'test',
    outcome: 'passed',
    basis: 'exit status',
    summary: ['9 pass', '0 fail'],
    revision: 'before later edits',
    ...over,
  });
  const claimDigest = (runs: Run[]): ClaimInput['digest'] => ({
    pr: {
      base: 'main',
      head: 'feature',
      mergeBase: 'abc',
      usedWorkingTree: false,
      commits: [],
    },
    files: [
      {
        path: 'src/a.ts',
        role: 'behavior',
        added: 3,
        removed: 0,
        sessions: [],
        unmatchedLines: 0,
      },
      {
        path: 'README.md',
        role: 'docs',
        added: 1,
        removed: 0,
        sessions: [],
        unmatchedLines: 0,
      },
    ],
    sessions: [
      {
        ref: 'h:1',
        agent: 'Claude Code',
        models: [],
        span: {},
        usage: null,
        score: 1,
        band: 'included',
        reasons: [],
        prompts: [],
        delegations: [],
        commitsMade: [],
        plans: [],
        artifacts: [],
        decisions: [],
        commands: [],
        runs,
        milestones: [],
        filesEdited: [],
        discardedEdits: 0,
        unknownRecordTypes: {},
      },
    ],
  });

  test('a stale run names the files it did not see', () => {
    const [docs] = checkClaims({
      title: 't',
      body: 'The tests pass.',
      digest: claimDigest([run({ laterEdits: ['README.md'] })]),
    });
    expect(docs!.state).toBe('not established');
    expect(docs!.detail).toBe(
      'R1 passed, but README.md changed afterwards (documentation only); qualify it as a result from before that edit, or cite a later run.',
    );
    const [code] = checkClaims({
      title: 't',
      body: 'The tests pass.',
      digest: claimDigest([run({ laterEdits: ['README.md', 'src/a.ts'] })]),
    });
    expect(code!.detail).toContain('README.md, src/a.ts changed afterwards; qualify');
    const [legacy] = checkClaims({
      title: 't',
      body: 'The tests pass.',
      digest: claimDigest([run({})]),
    });
    expect(legacy!.detail).toContain('files in the PR changed afterwards');
  });

  test('relevance keeps the facts that explain the PR and the runs that matter', () => {
    const { repo, cli } = scenario();
    const r = cli(repo.root, '--json', 'digest', '--offline');
    const full = JSON.parse(
      readFileSync(join(r.json.runDir, 'digest-full.json'), 'utf8'),
    );
    // Pad an unrelated chatter prompt and many unrelated runs to force trimming.
    const s = full.sessions[0];
    s.prompts.push({ id: 'S9', text: 'chatter '.repeat(400), ledToEdits: false });
    s.prompts.forEach((p: any) => (p.text = p.text + ' detail'.repeat(60)));
    // Thirty later, unrelated runs: recency alone would push R1 and R2 out.
    for (let i = 0; i < 30; i++)
      s.runs.push({
        ...s.runs[0],
        id: `R${100 + i}`,
        cmd: `bun test tests/x${i}.ts`,
        t: '2099-01-01T00:00:00Z',
      });
    const relevance = { S1: 6, S2: 6, S9: 0, R1: 4, R2: 6 } as Record<string, number>;
    const fixed = compactDigest(full, 900);
    const ranked = compactDigest(full, 900, relevance);
    const ids = (d: TraceDigest) => d.sessions[0]!.runs.map((x) => x.id);
    expect(ids(fixed)).not.toContain('R1');
    expect(ids(fixed)).not.toContain('R2');
    expect(ids(ranked)).toEqual(expect.arrayContaining(['R1', 'R2']));
    const text = (d: TraceDigest, id: string) =>
      d.sessions[0]!.prompts.find((p) => p.id === id)?.text.length ?? 0;
    expect(text(ranked, 'S1')).toBeGreaterThan(text(fixed, 'S1'));
    expect(ranked.truncated.join(' ')).toContain('most relevant');
  });

  test('evidence notes and the review packet carry graph provenance', () => {
    const { repo, cli } = scenario();
    const r = cli(repo.root, '--json', 'digest', '--offline');
    const notes = readFileSync(join(r.json.runDir, 'evidence-notes.md'), 'utf8');
    // The first thing a drafter reads points it at the graph.
    expect(notes.split('\n').slice(0, 4).join('\n')).toContain(
      'Start with the evidence graph: `tracetoon query outline`',
    );
    expect(notes).toContain('## Where each change came from (evidence graph)');
    const prepared = cli(repo.root, '--json', 'prepare', '--offline');
    expect(Object.keys(prepared.json).slice(0, 3)).toEqual([
      'run',
      'next',
      'graphOutline',
    ]);
    // The outline itself is embedded, so a drafter that never queries still sees it.
    expect(prepared.json.graphOutline).toContain('files[');
    expect(prepared.json.graphOutline).toContain('src/greet.ts');
    expect(notes).toContain('## Evidence graph outline (`tracetoon query outline`)');
    expect(prepared.json.next).toContain(
      `tracetoon query outline --run ${prepared.json.run}`,
    );
    expect(notes).toContain(
      '- src/greet.ts: S1; checks after its last captured edit: R2:failed, R1:passed',
    );
    expect(notes).toContain(
      '- src/farewell.ts: S2; no check captured after its last edit',
    );
    const leads = JSON.parse(
      readFileSync(join(r.json.runDir, 'graph-review.json'), 'utf8'),
    );
    const base = {
      title: 't',
      body: 'b',
      guidance: { sha256: 'g', status: 'complete', issues: [] } as any,
      digest: JSON.parse(readFileSync(r.json.digestPath, 'utf8')),
      diffSha256: 'd',
      headSha: 'h',
    };
    const without = reviewInput(base);
    const withLeads = reviewInput({ ...base, graphLeads: leads });
    expect(withLeads.fingerprint).not.toBe(without.fingerprint);
    expect(withLeads.graphLeads!.unexplained[0]!.file).toBe('src/manual.ts');
    expect(withLeads.artifacts).toContain('evidence-graph.json');
  });
});

describe('ambiguous sessions', () => {
  test('never supply provenance or explain hunks', () => {
    const N = (label: any, id: string, props: Record<string, any>) => ({
      label,
      id,
      props,
    });
    const R = (type: any, from: [any, string], to: [any, string], props?: any) => ({
      type,
      from: { label: from[0], id: from[1] },
      to: { label: to[0], id: to[1] },
      ...(props ? { props } : {}),
    });
    const graph: EvidenceGraph = {
      schema: GRAPH_SCHEMA,
      nodes: [
        N('Session', 'h:in', { band: 'included', agent: 'a', score: 1, title: null }),
        N('Session', 'h:amb', { band: 'ambiguous', agent: 'a', score: 0.3, title: null }),
        N('Prompt', 'S1', {
          t: '1',
          text: 'ours',
          pushback: false,
          ledToEdits: true,
          session: 'h:in',
        }),
        N('Prompt', 'S2', {
          t: '2',
          text: 'other work',
          pushback: false,
          ledToEdits: true,
          session: 'h:amb',
        }),
        N('File', 'src/a.ts', {
          role: 'behavior',
          inPr: true,
          added: 2,
          removed: 0,
          unmatched: 0,
        }),
        N('File', 'src/b.ts', {
          role: 'behavior',
          inPr: true,
          added: 1,
          removed: 0,
          unmatched: 0,
        }),
        N('Hunk', 'H1', {
          file: 'src/a.ts',
          start: 1,
          end: 2,
          added: 2,
          removed: 0,
          diff: 'diff:5-7',
          context: null,
        }),
        N('Hunk', 'H2', {
          file: 'src/b.ts',
          start: 1,
          end: 1,
          added: 1,
          removed: 0,
          diff: 'diff:12-13',
          context: null,
        }),
        N('Edit', 'E1', {
          t: '1',
          file: 'src/a.ts',
          added: 2,
          removed: 0,
          surviving: 2,
          inPr: true,
          via: null,
          session: 'h:in',
        }),
        N('Edit', 'E2', {
          t: '2',
          file: 'src/b.ts',
          added: 1,
          removed: 0,
          surviving: 1,
          inPr: true,
          via: null,
          session: 'h:amb',
        }),
      ],
      rels: [
        R('IN_SESSION', ['Prompt', 'S1'], ['Session', 'h:in']),
        R('IN_SESSION', ['Prompt', 'S2'], ['Session', 'h:amb']),
        R('IN_SESSION', ['Edit', 'E1'], ['Session', 'h:in']),
        R('IN_SESSION', ['Edit', 'E2'], ['Session', 'h:amb']),
        R('IN_TURN', ['Edit', 'E1'], ['Prompt', 'S1']),
        R('IN_TURN', ['Edit', 'E2'], ['Prompt', 'S2']),
        R('EDITS', ['Edit', 'E1'], ['File', 'src/a.ts']),
        R('EDITS', ['Edit', 'E2'], ['File', 'src/b.ts']),
        R('OF', ['Hunk', 'H1'], ['File', 'src/a.ts']),
        R('OF', ['Hunk', 'H2'], ['File', 'src/b.ts']),
        R('SURVIVES_IN', ['Edit', 'E1'], ['Hunk', 'H1'], { lines: 2 }),
        R('SURVIVES_IN', ['Edit', 'E2'], ['Hunk', 'H2'], { lines: 1 }),
      ],
      stats: { nodes: 10, rels: 12, hunks: 2, linkedHunks: 2, edits: 2, deadEndEdits: 0 },
    };
    const derived = deriveFromGraphJson(graph);
    expect(derived.fileFacts).toEqual({ 'src/a.ts': ['S1'] });
    expect(derived.review.unexplained.map((h) => h.diff)).toEqual(['diff:12-13']);
    const why = withGraph(graph, (g) => findQuery('why')!.run(g, ['src/b.ts']));
    expect(why[0]!.rows).toEqual([]);
    // An edit from an ambiguous session doesn't explain its hunk.
    expect(why[1]).toMatchObject({
      title: 'hunks',
      rows: [{ hunk: 'H2', explained: 'no captured edit; read the patch' }],
    });
  });
});
