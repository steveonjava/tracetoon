import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reviewInput } from '../src/contribution/review.ts';
import { compactDigest, type Run, type TraceDigest } from '../src/digest/build.ts';
import { checkClaims, type ClaimInput } from '../src/digest/claims.ts';
import {
  commitSentences,
  conditionFacts,
  definedSymbol,
  patchHunks,
  testTitles,
  valuePairs,
} from '../src/graph/build.ts';
import { toToon } from '../src/graph/toon.ts';
import { deriveFromGraphJson } from '../src/graph/derive.ts';
import { GraphEngine, graphEngineAvailable, withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import {
  behaviorOf,
  briefParts,
  describedHunks,
  findQuery,
  listsSeveral,
} from '../src/graph/queries.ts';
import { applyBrief, shownCommand, validationSection } from '../src/graph/briefRender.ts';
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

  test('with no run on the final code, the brief keeps the latest run of each kind', () => {
    const { claudeHome, cli } = setup();
    const repo = makeRepo();
    new ClaudeLog(repo.root)
      .prompt('Add a greet helper that says hello by name')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .bash('bun test', '3 pass\n0 fail')
      .bash('bun test tests/greet.test.ts', '1 pass\n1 fail', true)
      .bash('bun test', '4 pass\n0 fail')
      .write(join(repo.root, 'src/farewell.ts'), FAREWELL)
      .save(claudeHome, 'graph');
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
    writeFileSync(join(repo.root, 'src/farewell.ts'), FAREWELL);
    git(repo.root, ['add', '.']);
    git(repo.root, ['commit', '-q', '-m', 'feat: greet and farewell helpers']);
    const r = cli(repo.root, '--json', 'digest', '--offline');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', r.json.run);
    const v = b.json.sections.find((x: any) => x.title === 'validation').rows;
    // `bun test` ran first and last: its last run, not the focused one, is the latest test.
    expect(v.map((x: any) => [x.cmd, x.outcome])).toEqual([['bun test', 'passed']]);
  });

  test('the brief groups changes, scopes reasons and dates checks', () => {
    const { repo, cli } = scenario();
    const r = cli(repo.root, '--json', 'digest', '--offline');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', r.json.run);
    expect(b.code).toBe(0);
    const sec = (t: string) => b.json.sections.find((x: any) => x.title === t).rows;
    expect(b.json.sections.map((x: any) => x.title)).toEqual([
      'limits',
      'doNotSay',
      'changes',
      'process',
      'requests',
      'background',
      'commitMessages',
      'tests',
      'housekeeping',
      'validation',
      'headScan',
    ]);
    const changes = sec('changes');
    const of = (file: string) =>
      changes.find((c: any) => c.where.some((w: string) => w.startsWith(file)));
    // One commit, so changes split by the request whose edits survive in them.
    expect(of('src/greet.ts').requests).toEqual(['S1']);
    expect(of('src/greet.ts').where).toEqual(['src/greet.ts (greet)']);
    expect(of('src/farewell.ts').requests).toEqual(['S2']);
    expect(of('src/farewell.ts')).not.toBe(of('src/greet.ts'));
    expect(sec('requests').map((x: any) => x.ref)).toEqual(['S1', 'S2']);
    expect(sec('requests')[0].text).toContain('greet helper');
    // The goal is this PR's own request already: no background row repeats it.
    expect(sec('background')).toEqual([]);
    // The last run of each command; it ran before farewell's final edit.
    const v = sec('validation');
    expect(v.map((x: any) => x.check)).toEqual(['R2']);
    expect(v[0].editedAfter).toEqual(['src/farewell.ts']);
    expect(v[0].when).toBe('before later edits to the files in editedAfter');
    const limits = sec('limits')
      .map((x: any) => x.limit)
      .join('\n');
    expect(limits).toContain('src/farewell.ts');
    expect(limits).not.toContain('src/greet.ts:');
    // No pass after the commit: an open point, said once (process rows drop it).
    expect(limits).toMatch(
      /No passing check run was recorded after the last commit \([0-9a-f]{12}\); the last pass \(R1, test\) came before it\./,
    );
    // Only open points: no instructions to the writer.
    expect(sec('limits').every((x: any) => x.kind === 'open')).toBe(true);
    // The hand-written file came with no request of its own turn's.
    expect(sec('process').map((x: any) => [x.ref, x.kind, x.fact])).toEqual([
      [
        'PR1',
        'session',
        "Claude Code session, edits survive; turns that produced this PR's edits or commits: S1, S2.",
      ],
      ['PR2', 'plan', 'No plan or decision was recorded.'],
      [
        'PR3',
        'test',
        "`bun test` passed in the first run, then failed (passing to failing). 2 runs in this PR's turns, in order: passed (R1), then failed (R2).",
      ],
    ]);
  });

  test('prepare stores the review plan and its next step follows it', () => {
    const { repo, cli } = scenario();
    const prepared = cli(
      repo.root,
      '--json',
      'prepare',
      '--offline',
      '--review-passes',
      '3',
      '--review-lenses',
      'a, b, c.',
      '--reviewer-model',
      'terra',
      '--reviewer-effort',
      'xhigh',
    );
    const run = prepared.json.run;
    const plan = JSON.parse(
      readFileSync(join(prepared.json.runDir, 'review-plan.json'), 'utf8'),
    );
    expect(plan).toEqual({
      v: 1,
      passes: 3,
      lenses: ['a', 'b', 'c'],
      reviewerModel: 'terra',
      reviewerEffort: 'xhigh',
      recheck: 'none', // the shipped SKILL's Review recheck line
    });
    expect(prepared.json.reviewPlan).toEqual(plan);
    expect(prepared.json.next).toContain('IN PARALLEL');
    expect(prepared.json.next).toContain(
      `tracetoon review-packet --lean --lens <lens> --run ${run}`,
    );
    expect(prepared.json.next).toContain('references/reviewer-lens-<lens>.md');
    expect(prepared.json.next).toContain(
      '--reviewer-model terra --reviewer-effort xhigh',
    );
    expect(prepared.json.next).toContain('--rebind');
    // SKILL defaults store a default plan, and the next step is the single reviewer.
    const plain = cli(
      repo.root,
      '--json',
      'prepare',
      '--offline',
      '--run',
      run,
      '--review-passes',
      '1',
      '--review-lenses',
      'none',
      '--reviewer-effort',
      'default',
      '--reviewer-model',
      'same as the main agent',
      '--reviewer-runner',
      'agent',
      '--review-recheck',
      'once',
    );
    expect(
      JSON.parse(readFileSync(join(plain.json.runDir, 'review-plan.json'), 'utf8')),
    ).toEqual({ v: 1, passes: 1, lenses: [] });
    expect(plain.json.reviewPlan).toBeUndefined();
    expect(plain.json.next).toContain('one fresh independent reviewer');
    const bad = cli(repo.root, '--json', 'prepare', '--offline', '--review-lenses', 'z');
    expect(bad.json.error).toContain('Unknown review lens');
  });

  test('lean render writes the Validation section and checks ref tags', () => {
    const { repo, cli } = scenario();
    // The single-reviewer plan (the shipped SKILL asks for more; see below).
    const prepared = cli(
      repo.root,
      '--json',
      'prepare',
      '--offline',
      ...['--review-passes', '1', '--review-lenses', 'none'],
      ...['--reviewer-model', 'same', '--reviewer-effort', 'default'],
      ...['--reviewer-runner', 'agent', '--review-recheck', 'once'],
    );
    const run = prepared.json.run;
    // With a brief, the default is the reviewed path: inline draft from
    // drafting.md, one fresh reviewer on the lean packet; quick path is opt-in.
    expect(prepared.json.next).toContain('reviewed brief path');
    expect(prepared.json.next).toContain('references/drafting.md');
    expect(prepared.json.next).toContain('no fixed section list');
    expect(prepared.json.next).toContain(`tracetoon review-packet --lean --run ${run}`);
    expect(prepared.json.next).toContain('one fresh independent reviewer');
    expect(prepared.json.next).toContain('references/reviewer-lean.md');
    expect(prepared.json.next).toContain('review-findings.json');
    expect(prepared.json.next).toContain(`tracetoon review import --run ${run}`);
    expect(prepared.json.next).toContain('same reviewer');
    expect(prepared.json.next).toContain('quick path');
    expect(prepared.json.next).not.toContain('contribution-workflow.md');
    expect(prepared.json.brief).not.toContain('branching or fallback line');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', run);
    const changes = b.json.sections.find((x: any) => x.title === 'changes').rows;
    const id = (file: string) =>
      changes.find((c: any) => c.where.some((w: string) => w.startsWith(file))).change;
    const runDir = prepared.json.runDir;
    writeFileSync(join(runDir, 'title.txt'), 'Add greet and farewell helpers');
    writeFileSync(
      join(runDir, 'body.md'),
      [
        `Adds a greet helper that says hello by name. [${id('src/greet.ts')}, S1]`,
        `Adds a farewell helper that says goodbye. [${id('src/farewell.ts')}; S2, X9]`,
        'The tests passed after every change.',
        'Reviewers can start at the farewell helper in its own file.',
        '',
        '## Testing',
        '',
        '<!-- tracetoon:validation -->',
        '',
      ].join('\n'),
    );
    const r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    const body = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(body).not.toContain('[CH');
    expect(body).not.toContain('tracetoon:validation');
    expect(body).toContain('## Validation');
    expect(body).not.toContain('## Testing');
    // The section quotes the brief's row: the failing run, before farewell's last edit.
    expect(body).toContain(
      '- `bun test`: failed (3 pass, 1 fail) in the session logs, before later edits to src/farewell.ts.',
    );
    // The unchecked file is an open point for the prose, not repeated in the section.
    expect(body).not.toContain('No recorded passing test');
    expect(r.json.briefCheck).toMatchObject({
      validationSection: true,
      tags: 5,
      unknownRefs: ['X9'],
      validationClaims: ['The tests passed after every change.'],
      untagged: [
        'The tests passed after every change.',
        'Reviewers can start at the farewell helper in its own file.',
      ],
    });
    expect(r.json.contributionReview.status).toBe('skipped');
  });

  test('hunks: symbols end with their body, imports define nothing, values and tests are read', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,8 +1,12 @@ function includesPath(hay: string): boolean {',
      " import { detect, type Interop } from './interop.ts';",
      '+import { split } from "./shell.ts";',
      '   return false;',
      ' }',
      ' ',
      '+/** The directory a command runs in. */',
      '+export function leadingCd(cmd: string) {',
      '+  return cmd;',
      '+}',
      ' function windowFor() {',
      '-  return last + 30 * 60_000;',
      '+  return last + 5 * 60_000;',
      ' }',
      '',
    ].join('\n');
    const [h] = patchHunks(patch);
    // includesPath closed before the new lines; the import line names no symbol.
    expect(h!.touched).toEqual(['leadingCd', 'windowFor']);
    expect(h!.fresh).toEqual(['leadingCd']);
    expect(h!.pairs).toEqual(['return last + 30 * 60_000; → return last + 5 * 60_000;']);
    expect(
      definedSymbol("import { detect, type Interop } from './interop.ts';"),
    ).toBeUndefined();
    expect(valuePairs(['  return items.some(x);'], ['  return items.find(x);'])).toEqual(
      [],
    );
    expect(testTitles("  test('splits chains and pipes', () => {")).toEqual([
      'splits chains and pipes',
    ]);
    expect(testTitles('def test_quiet_commits():')).toEqual(['test_quiet_commits']);
  });

  test('a commit sentence is placed at the hunks that share its rarer words', () => {
    const hunks = [
      {
        file: 'src/correlate.ts',
        symbols: ['repoRel'],
        words: ['git', 'repo', 'rel', 'path', 'files'],
      },
      {
        file: 'src/pr.ts',
        symbols: ['parseUnifiedDiff'],
        words: ['binary', 'diff', 'files', 'parse'],
      },
      { file: 'tests/a.test.ts', symbols: [], words: ['git', 'binary', 'repo', 'files'] },
    ];
    expect(describedHunks(hunks, 'Files under .git are not repo edits.')).toEqual([
      'src/correlate.ts',
    ]);
    expect(describedHunks(hunks, 'Binary changes in the diff count.')).toEqual([
      'src/pr.ts',
    ]);
    expect(describedHunks(hunks, 'Unrelated wording here.')).toEqual([]);
  });

  test('the Validation section is short: tests first, unreadable non-tests and withheld commands out', () => {
    const rows = [
      {
        check: 'R1',
        kind: 'build',
        outcome: 'unknown',
        cmd: 'bun run bundle',
        editedAfter: [],
      },
      {
        check: 'R2',
        kind: 'eval',
        outcome: 'passed',
        cmd: 'python "‹withheld›"',
        editedAfter: [],
      },
      {
        check: 'R3',
        kind: 'typecheck',
        outcome: 'passed',
        cmd: 'bun x tsc --noEmit',
        when: 'after the last edit the logs captured',
        editedAfter: [],
      },
      {
        check: 'R4',
        kind: 'test',
        outcome: 'passed',
        result: '96 pass; 0 fail',
        cmd: 'bun test',
        when: 'after the last edit the logs captured',
        editedAfter: [],
        history: '2 of 3 earlier test runs failed',
      },
    ];
    const v = validationSection({
      unchecked: [],
      sections: [{ title: 'validation', rows }],
    } as any);
    expect(v.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      // Its own result lines; a typecheck pass known only from an exit status is left out.
      '- `bun test`: passed (96 pass, 0 fail) in the session logs.',
      "- Tracetoon can't tell whether these runs saw the final commit.",
    ]);
  });

  test('a sentence listing several behaviors, or fitting two files equally, is placed nowhere', () => {
    expect(
      listsSeveral(
        'Files under .git are not repo edits; binary files count as changed, and work after the last commit belongs to the next PR.',
      ),
    ).toBe(true);
    expect(listsSeveral('Sharing a session no longer makes two PRs a saga.')).toBe(false);
    const tie = [
      { file: 'src/a.ts', symbols: [], words: ['commit', 'quiet', 'subject'] },
      { file: 'src/b.ts', symbols: [], words: ['commit', 'quiet', 'subject'] },
    ];
    expect(describedHunks(tie, 'Quiet commits are recognized by their subject.')).toEqual(
      [],
    );
    // A symbol whose name shares the sentence's words wins (commands → commandKey).
    const named = [
      {
        file: 'src/digest/build.ts',
        symbols: ['commandKey'],
        words: ['runner', 'label'],
      },
      {
        file: 'src/correlate/correlate.ts',
        symbols: ['matchSession'],
        words: ['runner', 'label'],
      },
    ];
    expect(
      describedHunks(named, 'Test commands are labeled by their test runner.'),
    ).toEqual(['src/digest/build.ts']);
  });

  test('coverage lists open limits; eval rows stay out of Validation', () => {
    const b = {
      unchecked: [],
      sections: [
        {
          title: 'limits',
          rows: [
            {
              ref: 'L1',
              kind: 'open',
              limit:
                'Only commit abc1234\'s message reports "50/50"; no captured run shows that result.',
            },
            {
              ref: 'L2',
              kind: 'instruction',
              limit: 'Before writing "always" about x, read its conditions.',
            },
          ],
        },
        {
          title: 'changes',
          rows: [
            {
              change: 'CH1',
              where: ['src/shell.ts (splitCommands)'],
              newSymbols: ['splitCommands'],
            },
          ],
        },
        {
          title: 'validation',
          rows: [
            {
              check: 'R1',
              kind: 'eval',
              outcome: 'passed',
              result: '50/50 checks pass',
              cmd: 'bun scripts/eval.ts',
              editedAfter: [],
            },
            {
              check: 'R2',
              kind: 'test',
              outcome: 'passed',
              result: '9 pass; 0 fail',
              cmd: 'bun test',
              editedAfter: [],
            },
          ],
        },
      ],
    } as any;
    const r = applyBrief(
      'The shell module changes how commands split. [CH1]\n\n<!-- tracetoon:validation -->',
      b,
    );
    expect(r.uncovered).toEqual([
      'L1 (open point): Only commit abc1234\'s message reports "50/50"; no captured run shows that result.',
    ]);
    expect(r.text).toContain(
      '- `bun test`: passed (9 pass, 0 fail) in the session logs.',
    );
    expect(r.text).not.toContain('eval.ts');
  });

  test('a brief ref left in the prose is flagged for rewording', () => {
    const b = {
      unchecked: [],
      sections: [
        {
          title: 'tests',
          rows: [{ ref: 'T1', file: 'tests/shell.test.ts', titles: ['x'] }],
        },
      ],
    } as any;
    const r = applyBrief('No test in T1 names backtick quotes yet. [T1]', b);
    expect(r.flags.map((f) => [f.severity, f.problem.slice(0, 22)])).toEqual([
      ['fix', 'T1 is a brief ref, not'],
    ]);
    expect(applyBrief('The shell tests cover chains and pipes. [T1]', b).flags).toEqual(
      [],
    );
  });

  test('a current tracetoon check receipt keeps its counts; a log run with no result lines is dropped', () => {
    const v = validationSection({
      unchecked: [],
      sections: [
        {
          title: 'validation',
          rows: [
            {
              check: 'V1',
              kind: 'test',
              outcome: 'passed',
              result: '96 pass; 0 fail',
              cmd: 'bun test',
              when: 'fresh: run on the submitted content',
              editedAfter: [],
            },
            {
              check: 'R4',
              kind: 'typecheck',
              outcome: 'passed',
              result: null,
              cmd: 'bun x tsc --noEmit',
              when: 'after the last edit the logs captured',
              editedAfter: [],
            },
          ],
        },
      ],
    } as any);
    expect(v).toContain(
      '- `bun test`: passed (96 pass, 0 fail), run by `tracetoon check` on the submitted content.',
    );
    expect(v).not.toContain('tsc');
    expect(v).not.toContain("can't tell whether");
  });

  test('every tracetoon check receipt is listed, a bundle check included', () => {
    const r = (
      check: string,
      kind: string,
      cmd: string,
      result: string | null = null,
    ) => ({
      check,
      kind,
      outcome: 'passed',
      result,
      cmd,
      when: 'fresh: run on the submitted content',
      editedAfter: [],
    });
    const v = validationSection({
      unchecked: [],
      sections: [
        {
          title: 'validation',
          rows: [
            r('V1', 'typecheck', 'bun x tsc --noEmit'),
            r('V2', 'test', 'bun test', '96 pass; 0 fail'),
            r('V3', 'build', 'bun run bundle'),
            r('V4', 'lint', 'bun x prettier --check .'),
            {
              ...r('R9', 'test', 'bun test tests/a.test.ts'),
              when: 'after the last edit the logs captured',
            },
          ],
        },
      ],
    } as any);
    const lines = v.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(4);
    expect(v).toContain(
      '- `bun run bundle`: passed, run by `tracetoon check` on the submitted content.',
    );
    expect(v).not.toContain('tests/a.test.ts');
  });

  test('shown commands drop output redirections', () => {
    expect(shownCommand('bun test > <outside-repo> 2>&1 ; bun test tests/a.ts')).toBe(
      'bun test ; bun test tests/a.ts',
    );
    expect(shownCommand('bun x tsc --noEmit 2>&1')).toBe('bun x tsc --noEmit');
    expect(shownCommand('bun scripts/eval.ts >/dev/null 2>&1')).toBe(
      'bun scripts/eval.ts',
    );
    expect(shownCommand('bun run bundle')).toBe('bun run bundle');
  });

  test('the brief check flags misplaced names, false "new" claims and uncovered rows', () => {
    const b = {
      unchecked: [],
      sections: [
        {
          title: 'changes',
          rows: [
            {
              change: 'CH1',
              where: ['src/comic/providers.ts (ImageJob, artPrompt, matchImages)'],
              newSymbols: ['matchImages'],
            },
            {
              change: 'CH2',
              where: ['src/comic/bible.ts (SeriesBible)'],
              newSymbols: [],
            },
          ],
        },
        {
          title: 'commitMessages',
          rows: [
            {
              ref: '421ce024cc68#1',
              text: 'Codex images are matched to prompts by its final reply.',
              implementedBy: ['src/comic/providers.ts (matchImages)'],
            },
            {
              ref: '421ce024cc68#2',
              text: 'This closes the gap noted in PR #8 for good.',
              implementedBy: [],
            },
          ],
        },
        {
          title: 'tests',
          rows: [{ ref: 'T1', file: 'tests/units.test.ts', titles: ['x'] }],
        },
      ],
    } as any;
    const r = applyBrief(
      [
        '`SeriesBible` matches Codex images to prompts by the final reply. [421ce02#1]',
        '`matchImages` matches Codex images to prompts by the final reply. [421ce02#1, CH1]',
        'The new `ImageJob` type carries prompts and the `previewUrl` field. [CH1]',
        'This closes the gap noted in PR #8. [421ce02#2]',
        'This sentence has no tag and states something about the code.',
      ].join('\n\n'),
      b,
    );
    // Misplaced: the cited sentence's code is in providers.ts, and SeriesBible lives elsewhere.
    expect(r.unbackedNames).toEqual([
      {
        sentence: '`SeriesBible` matches Codex images to prompts by the final reply.',
        names: ['SeriesBible'],
      },
    ]);
    expect(r.flags.map((f) => [f.severity, f.problem.slice(0, 30)])).toEqual([
      ['fix', '`ImageJob` already existed (no'],
      ['fix', 'only a commit message says thi'],
    ]);
    expect(r.untagged).toEqual([
      'This sentence has no tag and states something about the code.',
    ]);
    expect(r.unknownRefs).toEqual([]);
    expect(r.uncovered).toEqual([
      'CH2: src/comic/bible.ts (SeriesBible)',
      'T1: tests/units.test.ts',
    ]);
  });

  test('with several commits, changes follow commits and messages stay with their commit', () => {
    const { claudeHome, cli } = setup();
    const repo = makeRepo();
    new ClaudeLog(repo.root)
      .prompt('Add greet and a limit')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .write(join(repo.root, 'src/limit.ts'), MANUAL)
      .save(claudeHome, 'commits');
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
    git(repo.root, ['add', '.']);
    git(repo.root, [
      'commit',
      '-q',
      '-m',
      'feat: greet',
      '-m',
      'Found while dogfooding. The eval now shows 12/12 checks pass.',
    ]);
    writeFileSync(join(repo.root, 'src/limit.ts'), MANUAL);
    git(repo.root, ['add', '.']);
    git(repo.root, [
      'commit',
      '-q',
      '-m',
      'feat: limit',
      '-m',
      'Requested by a reviewer.',
    ]);
    const r = cli(repo.root, '--json', 'digest', '--offline');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', r.json.run);
    const sec = (t: string) => b.json.sections.find((x: any) => x.title === t).rows;
    const changes = sec('changes');
    expect(changes).toHaveLength(2);
    expect(
      changes.every((c: any) => c.groupedBy === 'commit' && c.commits.length === 1),
    ).toBe(true);
    const msgs = sec('commitMessages');
    const dogfood = msgs.find((m: any) => m.text === 'Found while dogfooding.');
    const greetCommit = changes.find((c: any) => c.where[0].startsWith('src/greet.ts'))
      .commits[0];
    // Each sentence is its commit's; the subject is a row of its own, ref'd by the sha.
    expect(dogfood.ref).toBe(`${greetCommit}#1`);
    expect(msgs.find((m: any) => m.ref === greetCommit).text).toBe('feat: greet');
    expect(msgs.some((m: any) => String(m.ref).startsWith('commit:'))).toBe(false);
    // A result reported only in the message is listed as asserted, not run.
    const asserted = sec('validation').find((v: any) => v.kind === 'commit message');
    expect(asserted).toMatchObject({
      outcome: 'asserted',
      cmd: 'The eval now shows 12/12 checks pass.',
    });
    expect(msgs.some((m: any) => m.text.includes('12/12'))).toBe(false);
  });

  test('commit messages split into attributable sentences; result claims are marked', () => {
    expect(
      commitSentences(
        'Found while dogfooding this PR.\n\nTwo causes:\n- A turn kept old prompts. Now only edits count.\n- Commits in output counted.\n\nCo-Authored-By: Someone <a@b.c>',
      ),
    ).toEqual([
      'Found while dogfooding this PR.',
      'Two causes:',
      'A turn kept old prompts.',
      'Now only edits count.',
      'Commits in output counted.',
    ]);
  });

  test('changed lines are credited to the definition they sit in, not the one git names', () => {
    const patch = [
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -10,6 +10,7 @@ export function testOutputFailed(out: string) {',
      ' }',
      ' ',
      ' export function testSegment(cmd: string) {',
      '-  return cmd;',
      '+  const c = cmd.trim();',
      '+  return c;',
      ' }',
    ].join('\n');
    const [h] = patchHunks(patch);
    expect(h!.scope).toBe('testOutputFailed');
    expect(h!.touched).toEqual(['testSegment']);
  });

  test('symbols are read from definitions in common languages', () => {
    expect(definedSymbol('export function chooseProvider(opts) {')).toBe(
      'chooseProvider',
    );
    expect(definedSymbol('export const leadingCd = (cmd: string) => {')).toBe(
      'leadingCd',
    );
    expect(definedSymbol('  async renderCmd(run: Run): Promise<void> {')).toBe(
      'renderCmd',
    );
    expect(definedSymbol('def parse_lines(text):')).toBe('parse_lines');
    expect(definedSymbol('func (s *Server) Handle(w http.ResponseWriter) {')).toBe(
      'Handle',
    );
    expect(definedSymbol('  if (x) {')).toBeUndefined();
    expect(definedSymbol('  return foo(bar);')).toBeUndefined();
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
      TRACETOON_RELATE_WASM: join(tempDir(), 'missing.wasm'),
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
    // The first thing a drafter reads points it at the brief.
    expect(notes.split('\n').slice(0, 4).join('\n')).toContain(
      'Draft from the evidence brief below (`tracetoon query brief`)',
    );
    expect(notes).toContain('## Where each change came from (evidence graph)');
    const prepared = cli(repo.root, '--json', 'prepare', '--offline');
    expect(Object.keys(prepared.json).slice(0, 3)).toEqual(['run', 'next', 'brief']);
    // The brief itself is embedded, so a drafter that never queries still sees it.
    expect(prepared.json.brief).toContain('changes[');
    expect(prepared.json.brief).toContain('src/greet.ts (greet)');
    expect(prepared.json.brief).not.toContain('avoid[');
    expect(prepared.json.brief).toContain('process[');
    expect(notes).toContain('## Evidence brief (`tracetoon query brief`)');
    expect(prepared.json.next).toContain(
      `tracetoon query brief --run ${prepared.json.run}`,
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

describe('the brief states recorded process and behavior', () => {
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
  const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
  const run = (id: string, n: number, kind: string, outcome: string, revision: string) =>
    N('Run', id, {
      t: t(n),
      cmd: kind === 'test' ? 'bun test' : 'bun x tsc --noEmit',
      kind,
      outcome,
      revision,
      summary:
        kind === 'test'
          ? outcome === 'failed'
            ? ['2 pass', '1 fail']
            : ['3 pass', '0 fail']
          : [],
      when: revision,
      session: 'h:s',
    });
  const file = (id: string) =>
    N('File', id, { role: 'behavior', inPr: true, added: 2, removed: 1, unmatched: 0 });
  const hunk = (id: string, f: string, diff: string, conds: string[]) =>
    N('Hunk', id, {
      file: f,
      start: 1,
      end: 2,
      added: 2,
      removed: 1,
      diff,
      context: null,
      touched: [],
      branches: conds.length,
      fresh: [],
      pairs: [],
      conds,
      tests: [],
      words: [],
    });
  /**
   * S1 is an earlier PR's turn (a dead-end edit, a decision); S2 sets up the
   * work (a plan sent back); S3 makes it (a second plan approved, a decision
   * whose recorded answer is cut off, a surviving edit), then a commit and a
   * passing test after it. A typecheck receipt replaces the typecheck log run.
   */
  const graph: EvidenceGraph = {
    schema: GRAPH_SCHEMA,
    nodes: [
      N('Session', 'h:s', {
        band: 'included',
        agent: 'Claude Code',
        score: 1,
        title: null,
        failedCommands: 2,
        failedCommand: 'git push',
      }),
      N('Prompt', 'S1', {
        t: t(1),
        text: 'Earlier work',
        pushback: false,
        session: 'h:s',
      }),
      N('Prompt', 'S2', {
        t: t(2),
        text: 'Plan the limit',
        pushback: false,
        session: 'h:s',
      }),
      N('Prompt', 'S3', { t: t(3), text: 'Go ahead', pushback: false, session: 'h:s' }),
      N('Decision', 'D0', { t: t(1), text: 'Old question', session: 'h:s' }),
      N('Decision', 'D1', {
        t: t(3),
        text: 'Which limit? = "12, unless the…"',
        answers: 'Which limit? = "12, unless the…"',
        truncated: true,
        session: 'h:s',
      }),
      N('Plan', 'P1', {
        t: t(2),
        approved: false,
        text: 'Limit v1',
        excerpt: 'Limit v1',
        session: 'h:s',
      }),
      N('Plan', 'P2', {
        t: t(3),
        approved: true,
        text: 'Limit v2',
        excerpt: 'Limit v2',
        session: 'h:s',
      }),
      file('src/a.ts'),
      file('src/b.ts'),
      hunk('H1', 'src/a.ts', 'diff:5-9', [
        '+ if (!cmd) return;',
        'if (n >= 10) → if (n >= 12)',
        '- if (legacy)',
      ]),
      hunk('H2', 'src/b.ts', 'diff:12-14', []),
      N('Edit', 'E0', {
        t: t(1),
        file: 'src/old.ts',
        added: 1,
        removed: 0,
        surviving: 0,
        inPr: false,
        via: null,
        session: 'h:s',
      }),
      N('Edit', 'E1', {
        t: t(3),
        file: 'src/a.ts',
        added: 2,
        removed: 1,
        surviving: 2,
        inPr: true,
        via: null,
        session: 'h:s',
      }),
      N('Commit', 'abc123def456', { subject: 'feat: limit', body: null, t: t(4) }),
      run('R1', 3, 'test', 'failed', 'before later edits'),
      run('R2', 5, 'test', 'passed', 'no later edits seen'),
      run('R3', 5, 'typecheck', 'passed', 'no later edits seen'),
      N('Receipt', 'V1', {
        cmd: 'bun x tsc --noEmit',
        kind: 'typecheck',
        outcome: 'passed',
        summary: [],
        when: 'fresh: run on the submitted content',
      }),
      N('Change', 'CH1', {
        key: 'prompt:S3',
        files: ['src/a.ts'],
        roles: ['behavior'],
        symbols: [],
        added: 2,
        removed: 1,
        branches: 2,
      }),
      N('Change', 'CH2', {
        key: 'dir:src',
        files: ['src/b.ts'],
        roles: ['behavior'],
        symbols: [],
        added: 2,
        removed: 1,
        branches: 0,
      }),
    ],
    rels: [
      ...['S1', 'S2', 'S3'].map((p) =>
        R('IN_SESSION', ['Prompt', p], ['Session', 'h:s']),
      ),
      ...['E0', 'E1'].map((e) => R('IN_SESSION', ['Edit', e], ['Session', 'h:s'])),
      ...['R1', 'R2', 'R3'].map((r) => R('IN_SESSION', ['Run', r], ['Session', 'h:s'])),
      R('IN_TURN', ['Edit', 'E0'], ['Prompt', 'S1']),
      R('IN_TURN', ['Decision', 'D0'], ['Prompt', 'S1']),
      R('IN_TURN', ['Plan', 'P1'], ['Prompt', 'S2']),
      R('IN_TURN', ['Plan', 'P2'], ['Prompt', 'S3']),
      R('IN_TURN', ['Decision', 'D1'], ['Prompt', 'S3']),
      R('IN_TURN', ['Edit', 'E1'], ['Prompt', 'S3']),
      R('IN_TURN', ['Run', 'R1'], ['Prompt', 'S3']),
      R('IN_TURN', ['Run', 'R2'], ['Prompt', 'S3']),
      R('IN_TURN', ['Run', 'R3'], ['Prompt', 'S3']),
      R('MADE', ['Session', 'h:s'], ['Commit', 'abc123def456']),
      R('EDITS', ['Edit', 'E1'], ['File', 'src/a.ts']),
      R('TOUCHES', ['Commit', 'abc123def456'], ['File', 'src/b.ts']),
      R('OF', ['Hunk', 'H1'], ['File', 'src/a.ts']),
      R('OF', ['Hunk', 'H2'], ['File', 'src/b.ts']),
      R('SURVIVES_IN', ['Edit', 'E1'], ['Hunk', 'H1'], { lines: 2 }),
      R('HAS', ['Change', 'CH1'], ['Hunk', 'H1']),
      R('HAS', ['Change', 'CH2'], ['Hunk', 'H2']),
      R('ASKED_BY', ['Change', 'CH1'], ['Prompt', 'S3'], {
        how: 'its edits survive here',
      }),
    ],
    stats: { nodes: 0, rels: 0, hunks: 2, linkedHunks: 1, edits: 2, deadEndEdits: 1 },
  };
  const b = withGraph(graph, (g) => briefParts(g));
  const sec = (title: string) => b.sections.find((s) => s.title === title)!.rows;

  test('no avoid rules and no instructions: only open limits, one for unrequested changes', () => {
    expect(b.sections.map((s) => s.title)).toEqual([
      'limits',
      'doNotSay',
      'changes',
      'process',
      'requests',
      'background',
      'commitMessages',
      'tests',
      'housekeeping',
      'validation',
      'headScan',
    ]);
    expect(sec('limits').map((l) => [l.kind, l.change, l.limit])).toEqual([
      ['open', ['CH2'], 'No user request was recorded for CH2.'],
      // A failed push is an open point: what reached the remote isn't recorded.
      [
        'open',
        null,
        "`git push` failed in the Claude Code session; whether or how the work was then published or pushed isn't recorded.",
      ],
    ]);
  });

  test('a check passed on the submitted content retires "no pass after the last commit"', () => {
    // Every logged pass before the commit, no receipt: the limit holds.
    const stale: EvidenceGraph = structuredClone(graph);
    for (const id of ['R2', 'R3']) stale.nodes.find((n) => n.id === id)!.props.t = t(3);
    stale.nodes = stale.nodes.filter((n) => n.id !== 'V1');
    const limitText = (p: { sections: { title: string; rows: any[] }[] }) =>
      p.sections.find((s) => s.title === 'limits')!.rows.map((l) => String(l.limit));
    const factText = (p: { sections: { title: string; rows: any[] }[] }) =>
      p.sections
        .find((s) => s.title === 'process')!
        .rows.map((r) => String(r.fact))
        .join('\n');
    const before = withGraph(stale, (g) => briefParts(g));
    expect(before.freshPass).toBe(false);
    expect(limitText(before).some((l) => l.startsWith('No passing check run'))).toBe(
      true,
    );
    // A receipt in the run folder (read when the brief is read) drops the row
    // and any process clause saying the same.
    const fresh = withGraph(stale, (g) => briefParts(g, { freshPass: true }));
    expect(fresh.freshPass).toBe(true);
    expect(limitText(fresh).some((l) => /No passing check run/.test(l))).toBe(false);
    expect(factText(fresh)).not.toMatch(
      /no pass(ing run recorded)? after the last commit/,
    );
    // So does a passing receipt already in the graph.
    const withReceipt: EvidenceGraph = structuredClone(stale);
    withReceipt.nodes.push(graph.nodes.find((n) => n.id === 'V1')!);
    const receipted = withGraph(withReceipt, (g) => briefParts(g));
    expect(receipted.freshPass).toBe(true);
    expect(limitText(receipted).some((l) => /No passing check run/.test(l))).toBe(false);
    // Render flags a copied limit next to the fresh passes.
    const r = applyBrief(
      'No passing check run was recorded after the last commit. [CH1]',
      fresh,
    );
    expect(r.flags.map((f) => [f.severity, f.problem])).toContainEqual([
      'fix',
      'the Validation section shows fresh passing checks run by `tracetoon check` on the submitted content; drop or narrow this sentence.',
    ]);
    // Without a fresh pass the sentence is the open point, not a flag.
    expect(
      applyBrief(
        'No passing check run was recorded after the last commit. [CH1]',
        before,
      ).flags.filter((f) => /fresh passing checks/.test(f.problem)),
    ).toEqual([]);
  });

  test("requests are this PR's turns only; a cut-off record is marked", () => {
    expect(sec('requests').map((r) => [r.ref, r.truncated])).toEqual([
      ['S3', null],
      ['D1', true],
      ['P2', null],
    ]);
    expect(sec('requests')[2]!.kind).toBe('plan (approved) in the turn of S3');
  });

  test('background: the session goal and earlier plans and decisions, outside requests', () => {
    expect(sec('background').map((r) => [r.ref, r.kind, r.text])).toEqual([
      ['S1', "why this work started: the session's first request", 'Earlier work'],
      // At most the goal and one plan: a decision gives way to the plan.
      ['P1', 'earlier plan (not approved as written) in the session', 'Limit v1'],
    ]);
    // Optional context: refs render accepts, never required for coverage.
    const r = applyBrief(
      'The limit is now 12. [CH1]\n\nIt started from earlier work. [S1]',
      b,
    );
    expect(r.unknownRefs).toEqual([]);
    expect(r.uncovered.filter((u) => /^(S1|D0|P1)\b/.test(u))).toEqual([]);
    expect(
      applyBrief('The limit is now 12. [CH1]', b).uncovered.filter((u) =>
        /^(S1|D0|P1)\b/.test(u),
      ),
    ).toEqual([]);
  });

  test('background: at most two rows, clipped text, acknowledgments are no goal', () => {
    const more: EvidenceGraph = structuredClone(graph);
    more.nodes.find((n) => n.id === 'S1')!.props.text = 'go ahead';
    more.nodes.find((n) => n.id === 'S2')!.props.text =
      `Plan the limit ${'x'.repeat(700)}`;
    for (const i of [5, 6, 7, 8]) {
      more.nodes.push(
        N('Decision', `D${i}`, {
          t: t(2),
          text: `Q${i} ${'y'.repeat(500)}`,
          session: 'h:s',
        }),
      );
      more.rels.push(R('IN_TURN', ['Decision', `D${i}`], ['Prompt', 'S2']));
    }
    const rows = withGraph(more, (g) => briefParts(g)).sections.find(
      (s) => s.title === 'background',
    )!.rows;
    expect(rows.map((r) => r.ref)).toEqual(['S2', 'P1']);
    expect(String(rows[0]!.text).length).toBe(600);
    expect(String(rows[0]!.text).endsWith('…')).toBe(true);
    // With no earlier plan, the latest decision, clipped.
    more.nodes = more.nodes.filter((n) => n.id !== 'P1');
    more.rels = more.rels.filter((r) => r.from.id !== 'P1');
    const noPlan = withGraph(more, (g) => briefParts(g)).sections.find(
      (s) => s.title === 'background',
    )!.rows;
    expect(noPlan.map((r) => r.ref)).toEqual(['S2', 'D8']);
    expect(String(noPlan[1]!.text).length).toBe(400);
  });

  test('background: plans and decisions of a session with no captured prompt still show', () => {
    // The session's opening prompt is missing from the log (cut off or
    // redacted): its plan and decision have no turn, but they were recorded.
    const cut: EvidenceGraph = structuredClone(graph);
    cut.nodes = cut.nodes.filter((n) => n.label !== 'Prompt');
    cut.rels = cut.rels.filter(
      (r) => r.to.label !== 'Prompt' && r.from.label !== 'Prompt',
    );
    cut.nodes.push(
      N('Session', 'h:other', { band: 'ambiguous', agent: 'a', score: 0.2, title: null }),
      N('Plan', 'P9', { t: t(4), approved: true, text: 'Other', session: 'h:other' }),
    );
    const parts = withGraph(cut, (g) => briefParts(g)).sections;
    const rows = parts.find((s) => s.title === 'background')!.rows;
    // No goal: the two latest plans (decisions give way to plans).
    expect(rows.map((r) => [r.ref, r.kind])).toEqual([
      [
        'P1',
        "plan (not approved as written) in the session (the prompt before it wasn't captured)",
      ],
      ['P2', "plan (approved) in the session (the prompt before it wasn't captured)"],
    ]);
    const plan = parts
      .find((s) => s.title === 'process')!
      .rows.find((r) => r.kind === 'plan')!;
    expect(plan.fact).toBe(
      "No plan or decision in this PR's own turns; the session recorded P1 (plan not approved as written), P2 (approved plan) outside them: see background.",
    );
    expect(plan.cites).toEqual(['P1', 'P2']);
    expect(
      parts
        .find((s) => s.title === 'doNotSay')!
        .rows.find((r) => r.kind === 'recorded requests')?.text,
    ).toBe("Plans were recorded (P1, P2): don't say none was recorded.");
    // Before a captured prompt, a turnless plan is the tail of earlier work.
    const tail: EvidenceGraph = structuredClone(graph);
    tail.nodes.push(
      N('Plan', 'P8', { t: t(0), approved: true, text: 'Old', session: 'h:s' }),
    );
    tail.rels.push(R('IN_SESSION', ['Plan', 'P8'], ['Session', 'h:s']));
    const tailParts = withGraph(tail, (g) => briefParts(g)).sections;
    expect(
      tailParts.find((s) => s.title === 'background')!.rows.map((r) => r.ref),
    ).not.toContain('P8');
  });

  test('process rows: session role, plan history, test trajectory, failed commands', () => {
    expect(sec('process').map((r) => [r.ref, r.kind, r.fact])).toEqual([
      [
        'PR1',
        'session',
        "Claude Code session, made commits (abc123def456); turns that produced this PR's edits or commits: S3.",
      ],
      [
        'PR2',
        'plan',
        'Plans, in order: P1 "Limit v1" not approved as written → P2 "Limit v2" approved.',
      ],
      [
        'PR3',
        'decision',
        '1 question(s) answered by the user: D1 (turn S3), record cut off.',
      ],
      [
        'PR4',
        'test',
        "`bun test` failed in the first run, then passed (failing to passing). 2 runs in this PR's turns, in order: failed (R1), then passed (R2); a passing run came after the last commit (R2).",
      ],
      [
        'PR5',
        // Kinds that never failed share one row.
        'checks',
        'No failures: typecheck (1 run(s), last R3 passed, passed after the last commit (R3)).',
      ],
      [
        'PR6',
        'commands',
        '2 failed non-check command(s) recorded in the Claude Code session, e.g. `git push`.',
      ],
    ]);
  });

  test('a receipt replaces log runs of its kind; the behavior line quotes conditions', () => {
    expect(sec('validation').map((r) => r.check)).toEqual(['V1', 'R2']);
    expect(sec('changes')[0]!.behavior).toEqual([
      'a.ts: if (n >= 10) → if (n >= 12)',
      'a.ts: + if (!cmd) return;',
      'a.ts: - if (legacy)',
    ]);
    expect(sec('commitMessages')).toEqual([]);
    expect(b.branchy).toEqual(['src/a.ts']);
  });

  test('render flags universal words about branching code without instruction rows', () => {
    const r = applyBrief('The `src/a.ts` guard always returns early. [CH1]', b);
    expect(r.flags.map((f) => f.severity)).toEqual(['check']);
  });
});

test('condition facts: changed conditions, added branches and fallbacks, removed conditions', () => {
  expect(
    conditionFacts(
      ['  if (n >= 10) return;', '  if (legacy) x();', '  if (a) run(1);'],
      [
        '  if (n >= 12) return;',
        '  const k = opts.limit ?? 20;',
        '  if (a) run(1, 2);',
        '  } catch {',
        '    return undefined;',
        '  const s = `${ok ? "yes" : "no"}`;',
      ],
    ),
  ).toEqual([
    'if (n >= 10) return; → if (n >= 12) return;',
    '+ const k = opts.limit ?? 20;',
    '+ } catch { return undefined;',
    '- if (legacy) x();',
  ]);
  // Comparison values `pairs` already show aren't repeated; prose files have none.
  expect(
    conditionFacts(
      ['if (n >= 10) {'],
      ['if (n >= 12) {'],
      ['if (n >= 10) { → if (n >= 12) {'],
    ),
  ).toEqual([]);
  const [md] = patchHunks(
    [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1 +1 @@',
      '-x',
      '+if (the user asks) say so',
      '',
    ].join('\n'),
  );
  expect(md!.conds).toEqual([]);
  expect(
    behaviorOf([
      { file: 'src/x.ts', diff: 'diff:9', conds: ['- if (a)', '+ if (b)'] },
      {
        file: 'src/y.ts',
        diff: 'diff:3',
        conds: ['+ const n = o.n ?? 5;', 'if (c) → if (d)'],
      },
    ]),
  ).toEqual([
    'y.ts: if (c) → if (d)',
    'y.ts: + const n = o.n ?? 5;',
    'x.ts: + if (b)',
    'x.ts: - if (a)',
  ]);
});

test('a commit sentence naming one of its files is placed there; weak or test-only matches nowhere', () => {
  const hunks = [
    { file: 'src/util/shell.ts', symbols: ['splitCommands'], words: ['quote', 'split'] },
    { file: 'src/digest/build.ts', symbols: ['commandKey'], words: ['key', 'group'] },
    { file: 'tests/shell.test.ts', symbols: [], words: ['heredoc', 'splitter', 'quote'] },
  ];
  expect(
    describedHunks(
      hunks,
      'A new splitter (src/util/shell.ts) feeds detection, grouping and commits.',
    ),
  ).toEqual(['src/util/shell.ts']);
  // Two shared words out of many is a weak match.
  expect(
    describedHunks(
      hunks,
      'Quote and split handling changed for heredoc bodies in long pasted scripts.',
    ),
  ).toEqual([]);
  // Only the test file matches, and the sentence isn't about tests.
  expect(describedHunks(hunks, 'Heredoc splitter quote handling.')).toEqual([]);
});
