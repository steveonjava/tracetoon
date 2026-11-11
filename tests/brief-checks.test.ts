import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../src/digest/build.ts';
import { checkClaims, type ClaimInput } from '../src/digest/claims.ts';
import {
  applyBrief,
  logRunStatable,
  validationSection,
} from '../src/graph/briefRender.ts';
import { doNotSayRows, housekeepingOverclaim } from '../src/graph/doNotSay.ts';
import {
  grepTree,
  headRefNodes,
  oldValues,
  parseGrep,
  scanTerms,
} from '../src/graph/headScan.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import { renderNeighborhood } from '../src/graph/neighborhood.ts';
import {
  earlierFailure,
  runHistory,
  selectValidationRuns,
} from '../src/graph/runHistory.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo } from './helpers.ts';

const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const run = (
  id: string,
  n: number,
  kind: string,
  cmd: string,
  outcome: string,
  summary: string[] = [],
  revision = 'no later edits seen',
) => ({ id, t: t(n), kind, cmd, outcome, summary, revision, later: [] as string[] });

describe('session-log validation rows', () => {
  test('an earlier pass superseded by a rerun with no result is not stated (pr11 tsc)', () => {
    const runs = [
      run('R1', 1, 'typecheck', 'bun x tsc --noEmit', 'passed'),
      run('R2', 1, 'test', 'bun test tests/pages.test.ts 2>&1', 'passed', [
        '13 pass',
        '0 fail',
      ]),
      run('R3', 5, 'typecheck', 'bun x tsc --noEmit', 'unknown'),
      run(
        'R5',
        5,
        'test',
        'bun test > <outside-repo> 2>&1 ; bun test tests/a.test.ts',
        'unknown',
      ),
    ];
    const chosen = selectValidationRuns(runs);
    // The typecheck keeps only its honest "no result" row; the focused test keeps its pass.
    expect(chosen.map((r) => [r.id, r.outcome])).toEqual([
      ['R3', 'unknown'],
      ['R2', 'passed'],
    ]);
  });

  test('passes known only from an exit status, merged outputs and contradicted runs are dropped', () => {
    expect(
      selectValidationRuns([run('R1', 1, 'typecheck', 'bun x tsc --noEmit', 'passed')]),
    ).toEqual([]);
    expect(
      selectValidationRuns([
        run('R1', 1, 'test', 'bun test ; bun test tests/a.ts', 'passed', [
          '3 pass',
          '0 fail',
        ]),
      ]),
    ).toEqual([]);
    // A later run of the kind failed: the earlier pass would contradict it.
    expect(
      selectValidationRuns([
        run('R1', 1, 'test', 'bun test', 'passed', ['9 pass', '0 fail']),
        run('R2', 2, 'test', 'bun test tests/a.test.ts', 'failed', ['1 pass', '1 fail']),
      ]).map((r) => r.id),
    ).toEqual(['R2']);
    expect(
      logRunStatable({ outcome: 'passed', result: null, cmd: 'bun x tsc --noEmit' }),
    ).toBe(false);
  });

  test('a rendered log row is one the claim check observes; the dropped kind was not established', () => {
    const digestRun = (r: ReturnType<typeof run>): Run => ({
      id: r.id,
      t: r.t,
      cmd: r.cmd,
      kind: r.kind as Run['kind'],
      outcome: r.outcome as Run['outcome'],
      basis: r.summary.length ? 'output' : 'exit status',
      summary: r.summary,
      revision: 'no later edits seen',
    });
    const runs = [
      run('R1', 1, 'typecheck', 'bun x tsc --noEmit', 'passed'),
      run('R2', 1, 'test', 'bun test tests/pages.test.ts 2>&1', 'passed', [
        '13 pass',
        '0 fail',
      ]),
      run('R3', 5, 'typecheck', 'bun x tsc --noEmit', 'unknown'),
    ];
    const rows = selectValidationRuns(runs).map((r) => ({
      check: r.id,
      kind: r.kind,
      outcome: r.outcome,
      result: (r.summary as string[]).join('; ') || null,
      when: 'after the last edit the logs captured',
      editedAfter: [],
      cmd: r.cmd,
    }));
    const section = validationSection({
      unchecked: [],
      sections: [{ title: 'validation', columns: [], rows }],
    });
    const lines = section.split('\n').filter((l) => l.startsWith('- `'));
    expect(lines).toEqual([
      '- `bun test tests/pages.test.ts`: passed (13 pass, 0 fail) in the session logs.',
    ]);
    const input = (body: string): ClaimInput => ({
      title: 'x',
      body,
      digest: {
        sessions: [{ band: 'included', runs: runs.map(digestRun) }] as any,
        files: [],
        pr: { base: 'main', head: 'h', mergeBase: 'm', usedWorkingTree: false } as any,
      },
    });
    expect(checkClaims(input(lines[0]!)).map((f) => f.state)).toEqual(['observed']);
    // The row the old renderer wrote for pr11.
    expect(
      checkClaims(input('- `bun x tsc --noEmit`: passed in the session logs.')).map(
        (f) => f.state,
      ),
    ).toEqual(['not established']);
  });
});

describe('validation run selection: the broadest run, and an earlier failure', () => {
  const stale = (r: ReturnType<typeof run>, later: string[]) => ({
    ...r,
    revision: 'before later edits',
    later,
  });
  const minor = (r: Record<string, unknown>) =>
    ((r.later as string[]) ?? []).length > 0 &&
    ((r.later as string[]) ?? []).every((f) => /VERSION|version\.ts|\.json$/.test(f));

  test('the full suite beats a later focused rerun of other files (pr12)', () => {
    const runs = [
      run('R9', 1, 'test', 'bun test tests/shell.test.ts 2>&1', 'failed', [
        '4 pass',
        '1 fail',
      ]),
      stale(
        run('R11', 2, 'test', 'bun test > <outside-repo> 2>&1', 'passed', [
          '96 pass',
          '0 fail',
        ]),
        ['package.json', 'src/version.ts'],
      ),
      run(
        'R15',
        3,
        'test',
        'bun test tests/comic.test.ts tests/flow.test.ts 2>&1',
        'passed',
        ['22 pass', '0 fail'],
      ),
    ];
    const chosen = selectValidationRuns(runs, { minorLater: minor });
    expect(chosen.map((r) => r.id)).toEqual(['R11']);
    expect(earlierFailure(runs, chosen[0]!)?.id).toBe('R9');
    // Later code edits make the full suite stale: the run on the final code wins.
    const code = runs.map((r) =>
      r.id === 'R11' ? { ...r, later: ['src/util/shell.ts'] } : r,
    );
    expect(selectValidationRuns(code, { minorLater: minor }).map((r) => r.id)).toEqual([
      'R15',
    ]);
  });

  test('on the final code, the run with the most passes beats a narrower one', () => {
    const runs = [
      run('R1', 1, 'test', 'bun test tests', 'passed', ['80 pass', '0 fail']),
      run('R2', 2, 'test', 'bun test tests/a.test.ts', 'passed', ['5 pass', '0 fail']),
    ];
    expect(selectValidationRuns(runs).map((r) => r.id)).toEqual(['R1']);
    // A whole-suite command with flags only still counts as the whole suite.
    const flags = [
      run('R1', 1, 'test', 'bun test --bail', 'passed', ['8 pass', '0 fail']),
      run('R2', 2, 'test', 'bun test tests/a.test.ts', 'passed', ['9 pass', '0 fail']),
    ];
    expect(selectValidationRuns(flags).map((r) => r.id)).toEqual(['R1']);
  });

  test('a failure then a pass: the pass is shown with one clause on the failure', () => {
    const runs = [
      run('R1', 1, 'test', 'bun test', 'failed', ['8 pass', '1 fail']),
      run('R2', 2, 'test', 'bun test', 'passed', ['9 pass', '0 fail']),
    ];
    // R1 is superseded by R2 (same command), but is still the earlier failure.
    const chosen = selectValidationRuns(runs);
    expect(chosen.map((r) => r.id)).toEqual(['R2']);
    expect(earlierFailure(runs, chosen[0]!)?.id).toBe('R1');
    expect(earlierFailure(runs, runs[0]!)).toBeUndefined();
    const section = validationSection({
      unchecked: [],
      sections: [
        {
          title: 'validation',
          columns: [],
          rows: [
            {
              check: 'R2',
              kind: 'test',
              outcome: 'passed',
              result: '9 pass; 0 fail',
              when: 'after the last edit the logs captured',
              editedAfter: [],
              cmd: 'bun test',
              earlier: '`bun test` failed (8 pass, 1 fail)',
            },
          ],
        },
      ],
    });
    const line = section.split('\n').find((l) => l.startsWith('- `'))!;
    expect(line).toBe(
      '- `bun test`: passed (9 pass, 0 fail) in the session logs. An earlier run of `bun test` failed (8 pass, 1 fail).',
    );
    // Both sentences are ones the claim check observes.
    const digestRuns = runs.map((r) => ({
      id: r.id,
      t: r.t,
      cmd: r.cmd,
      kind: 'test' as Run['kind'],
      outcome: r.outcome as Run['outcome'],
      basis: 'output' as Run['basis'],
      summary: r.summary,
      revision: 'no later edits seen' as Run['revision'],
    }));
    expect(
      checkClaims({
        title: 'x',
        body: line,
        digest: {
          sessions: [{ band: 'included', runs: digestRuns }] as any,
          files: [],
          pr: { base: 'main', head: 'h', mergeBase: 'm', usedWorkingTree: false } as any,
        },
      }).map((f) => f.state),
    ).toEqual(['observed', 'observed']);
    // A later run failing stays the stated result: a pass never hides it.
    const later = [
      run('R1', 1, 'test', 'bun test', 'passed', ['9 pass', '0 fail']),
      run('R2', 2, 'test', 'bun test tests/a.test.ts', 'failed', ['1 pass', '1 fail']),
    ];
    expect(selectValidationRuns(later).map((r) => r.id)).toEqual(['R2']);
  });
});

describe('run history', () => {
  test('a kind that went from failing to passing reads in order', () => {
    const h = runHistory([
      run('R9', 1, 'test', 'bun test tests/shell.test.ts', 'failed', [
        '4 pass',
        '1 fail',
      ]),
      run('R11', 2, 'test', 'bun test', 'passed', ['96 pass', '0 fail']),
      run('R15', 3, 'test', 'bun test tests/a.test.ts', 'passed', ['22 pass', '0 fail']),
    ]);
    expect(h?.text).toBe(
      "Tests failed in the first run, then passed (failing to passing). 3 test runs in this PR's turns (3 commands), in order: failed (R9 `bun test tests/shell.test.ts`), then passed twice (R11, R15)",
    );
    const same = runHistory([
      run('R1', 1, 'test', 'bun test', 'failed', ['1 fail']),
      run('R2', 2, 'test', 'bun test 2>&1', 'failed', ['1 fail']),
      run('R3', 3, 'test', 'bun test', 'passed', ['3 pass']),
    ]);
    expect(same?.text).toBe(
      "`bun test` failed in the first 2 runs, then passed (failing to passing). 3 runs in this PR's turns, in order: failed twice (R1, R2), then passed (R3)",
    );
    // A pass, then a rerun with no result (pr11's typecheck).
    expect(
      runHistory([
        run('R1', 1, 'typecheck', 'bun x tsc --noEmit', 'passed'),
        run('R3', 2, 'typecheck', 'bun x tsc --noEmit', 'unknown'),
      ])?.text,
    ).toBe(
      "`bun x tsc --noEmit`: 2 runs in this PR's turns, in order: passed (R1), then the last run (R3) has no captured result",
    );
    // Many alternations: the failures, then how it ended; unknown runs counted.
    const many = [
      'passed',
      'failed',
      'passed',
      'failed',
      'unknown',
      'passed',
      'passed',
    ].map((o, i) =>
      run(`R${i + 1}`, i, 'test', 'bun test', o, o === 'unknown' ? [] : ['x']),
    );
    expect(runHistory(many)?.text).toBe(
      "`bun test`: 7 runs in this PR's turns, 2 failed (R2, R4); after the last failure: passed twice (R6, R7); 1 other run(s) with no captured result",
    );
    // Passing, then failing: the opposite trend, said the same way.
    expect(
      runHistory([
        run('R1', 1, 'build', 'bun run build', 'passed', ['ok']),
        run('R2', 2, 'build', 'bun run build', 'failed', ['error']),
        run('R3', 3, 'build', 'bun run build', 'failed', ['error']),
      ])?.text,
    ).toBe(
      "`bun run build` passed in the first run, then failed (passing to failing). 3 runs in this PR's turns, in order: passed (R1), then failed twice (R2, R3)",
    );
    // All alike, or a single run: the counts say it already.
    expect(
      runHistory([run('R1', 1, 'test', 'bun test', 'passed', ['1 pass'])]),
    ).toBeUndefined();
    expect(
      runHistory([
        run('R1', 1, 'test', 'bun test', 'passed', ['1 pass']),
        run('R2', 2, 'test', 'bun test', 'passed', ['1 pass']),
      ]),
    ).toBeUndefined();
  });
});

const sections = (extra: Record<string, unknown>[] = []) => [
  {
    title: 'changes',
    columns: [],
    rows: [
      {
        change: 'CH1',
        where: ['src/a.ts (load, parseLimit)', 'install.sh'],
        newSymbols: ['parseLimit'],
        behavior: ['a.ts: + if (!cfg) return;'],
        removed: 3,
      },
      {
        change: 'CH2',
        where: ['src/version.ts', 'package.json'],
        newSymbols: [],
        removed: 1,
      },
    ],
  },
  {
    title: 'housekeeping',
    columns: [],
    rows: [
      { ref: 'HK1', what: 'version 1.0.0 → 1.0.1', files: ['src/version.ts'] },
      {
        ref: 'HK2',
        what: 'generated files changed (not hand-edited)',
        files: ['dist/app.mjs'],
      },
    ],
  },
  {
    title: 'validation',
    columns: [],
    rows: [
      {
        check: 'abc1234#2',
        kind: 'commit message',
        outcome: 'asserted',
        cmd: 'The eval now shows 12/12 checks pass.',
      },
      ...extra,
    ],
  },
];

describe('do not say', () => {
  test('rows: existing names, conditional code, commit-only results, old behavior, the files', () => {
    const rows = doNotSayRows(sections(), ['load']);
    expect(rows.map((r) => r.kind)).toEqual([
      'existed before this PR',
      'conditional code',
      'commit message only',
      'old behavior',
      'files in this diff',
    ]);
    expect(rows[0]!.text).toBe('`load`: changed, not "new" or "added".');
    expect(String(rows[1]!.text)).toContain('(a.ts: + if (!cfg) return;)');
    expect(String(rows[2]!.text)).toContain("commit abc1234's claim, not a run");
    expect(rows[4]!.text).toBe(
      '5: a.ts, install.sh, version.ts, package.json, app.mjs. 3 are beyond the version bump: never "housekeeping only", "version bump only" or "no logic changes".',
    );
  });

  test('recorded requests, plans and decisions: never "none was recorded"', () => {
    const withRecords = [
      ...sections(),
      { title: 'requests', columns: [], rows: [{ ref: 'S2', kind: 'asked', text: 'x' }] },
      {
        title: 'background',
        columns: [],
        rows: [
          { ref: 'D1', kind: 'decision', text: 'q' },
          { ref: 'P1', kind: 'plan (approved)', text: 'p' },
        ],
      },
      {
        title: 'process',
        columns: [],
        rows: [{ ref: 'PR2', kind: 'plan', fact: 'Plan: P3', cites: ['P3'] }],
      },
    ];
    const row = doNotSayRows(withRecords).find((r) => r.kind === 'recorded requests');
    expect(row).toEqual({
      kind: 'recorded requests',
      text: "Requests/plans/decisions were recorded (S2, D1, P1, P3): don't say none was recorded.",
      cites: ['S2', 'D1', 'P1', 'P3'],
    });
    const plansOnly = doNotSayRows([
      ...sections(),
      {
        title: 'background',
        columns: [],
        rows: [{ ref: 'P1', kind: 'plan', text: 'p' }],
      },
    ]);
    expect(plansOnly.find((r) => r.kind === 'recorded requests')?.text).toBe(
      "Plans were recorded (P1): don't say none was recorded.",
    );
    // None recorded: no hint row (the limits rows say it).
    expect(doNotSayRows(sections()).some((r) => r.kind === 'recorded requests')).toBe(
      false,
    );
  });

  test('render flags "version bump only" when the diff changes more, and only then', () => {
    const b = { unchecked: [], sections: sections() };
    expect(housekeepingOverclaim('Housekeeping: version bump only.', b.sections)).toEqual(
      ['src/a.ts', 'install.sh', 'dist/app.mjs'],
    );
    expect(
      housekeepingOverclaim('There are no logic changes in src/a.ts.', b.sections),
    ).toEqual(['install.sh', 'dist/app.mjs']);
    expect(
      housekeepingOverclaim('The version moves to 1.0.1.', b.sections),
    ).toBeUndefined();
    const r = applyBrief('This is only a version bump. [HK1]', b);
    expect(r.flags.map((f) => [f.severity, f.problem.slice(0, 30)])).toEqual([
      ['fix', 'the diff also changes src/a.ts'],
    ]);
    const versionOnly = {
      unchecked: [],
      sections: [
        {
          title: 'changes',
          columns: [],
          rows: [{ change: 'CH1', where: ['src/version.ts'] }],
        },
        {
          title: 'housekeeping',
          columns: [],
          rows: [
            { ref: 'HK1', what: 'version 1.0.0 → 1.0.1', files: ['src/version.ts'] },
          ],
        },
      ],
    };
    expect(applyBrief('Version bump only. [HK1]', versionOnly).flags).toEqual([]);
  });

  test('the neighborhood layout shows the rows after the open points', () => {
    const all = [
      {
        title: 'limits',
        columns: ['ref', 'kind', 'limit'],
        rows: [{ ref: 'L1', kind: 'open', limit: 'x' }],
      },
      {
        title: 'doNotSay',
        columns: ['kind', 'text', 'cites'],
        rows: doNotSayRows(sections()),
      },
      ...sections().map((s) => ({ ...s, columns: Object.keys(s.rows[0] ?? {}) })),
      {
        title: 'headScan',
        columns: ['ref', 'kind', 'text', 'change'],
        rows: [
          {
            ref: 'HS1',
            kind: 'still mentions',
            text: 'removed name `oldName` is still in README.md:3',
            change: 'CH1',
          },
        ],
      },
    ];
    const text = renderNeighborhood(all, { budgetTokens: 1500 });
    expect(text.indexOf('doNotSay[')).toBeGreaterThan(text.indexOf('limits['));
    expect(text).toContain('## Head tree (git grep at the head commit)');
    expect(text).toContain(
      '[HS1] still mentions · removed name `oldName` is still in README.md:3 · CH1',
    );
    // With no budget the optional head-tree lines are left out.
    expect(renderNeighborhood(all, { budgetTokens: 0 })).not.toContain('## Head tree');
  });
});

describe('head-tree scan', () => {
  const graph = (): EvidenceGraph => ({
    schema: GRAPH_SCHEMA,
    nodes: [
      { label: 'File', id: 'src/a.ts', props: { role: 'behavior' } },
      { label: 'File', id: 'docs/guide.md', props: { role: 'docs' } },
      {
        label: 'Hunk',
        id: 'H1',
        props: {
          file: 'src/a.ts',
          dropped: ['legacyLoader'],
          fresh: ['parseLimit'],
          touched: ['parseLimit', 'loadConfig'],
          pairs: ["const MODE = 'classic-mode'; → const MODE = 'modern';"],
        },
      },
    ],
    rels: [],
    stats: { nodes: 3, rels: 0, hunks: 1, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
  });

  test('terms: removed names and old values; distinctive changed symbols', () => {
    expect(oldValues("const MODE = 'classic-mode'; → const MODE = 'modern';")).toEqual([
      'classic-mode',
    ]);
    const terms = scanTerms(graph());
    expect(terms.removed.map((x) => [x.term, x.kind])).toEqual([
      ['legacyLoader', 'symbol'],
      ['classic-mode', 'value'],
    ]);
    expect(terms.changed.map((x) => [x.term, x.fresh])).toEqual([
      ['parseLimit', true],
      ['loadConfig', false],
    ]);
  });

  test('git grep at the head commit: stale doc mentions and callers, by file:line only', () => {
    const repo = makeRepo();
    mkdirSync(join(repo.root, 'docs'), { recursive: true });
    writeFileSync(
      join(repo.root, 'docs/guide.md'),
      '# Guide\n\nCall legacyLoader first.\n',
    );
    writeFileSync(join(repo.root, 'CHANGELOG.md'), '- removed legacyLoader\n');
    writeFileSync(join(repo.root, 'src.ts'), 'parseLimit(1);\nparseLimit(2);\n');
    mkdirSync(join(repo.root, 'lib'), { recursive: true });
    writeFileSync(
      join(repo.root, 'lib/b.ts'),
      'import { parseLimit } from "../src/a";\n',
    );
    git(repo.root, ['add', '.']);
    git(repo.root, ['commit', '-q', '-m', 'docs']);
    const head = git(repo.root, ['rev-parse', 'HEAD']).stdout.trim();
    const terms = scanTerms(graph());
    const hits = grepTree(repo.root, head, [
      ...terms.removed.map((x) => x.term),
      ...terms.changed.map((x) => x.term),
    ]);
    expect(hits).toBeDefined();
    const nodes = headRefNodes(terms, hits!);
    expect(
      nodes.map((n) => [n.props.kind, n.props.term, n.props.refs, n.props.count]),
    ).toEqual([
      ['still mentions', 'legacyLoader', ['docs/guide.md:3'], 1],
      ['most referenced', 'parseLimit', ['lib/b.ts', 'src.ts'], 3],
    ]);
    // A bad revision fails open.
    expect(grepTree(repo.root, 'f'.repeat(40), ['parseLimit'])).toBeUndefined();
    expect(parseGrep(`${head}:a b.md\x003\x00term\n`, head)).toEqual([
      { file: 'a b.md', line: 3, term: 'term' },
    ]);
  });
});

describe('receipts in the Validation section', () => {
  const receipt = (
    check: string,
    kind: string,
    cmd: string,
    result: string | null = null,
  ) => ({
    check,
    kind,
    outcome: 'passed',
    result,
    when: 'fresh: run on the submitted content',
    editedAfter: [],
    cmd,
  });
  test('every receipt is listed once, and the claim check observes the lines', () => {
    const rows = [
      receipt('V1', 'typecheck', 'bun run typecheck'),
      receipt('V2', 'build', 'bun run bundle'),
      receipt('V3', 'build', 'bun run build:check'),
      receipt('V4', 'build', 'bun run build:reproduce'),
      receipt('V5', 'test', 'bun test', '2 pass; 0 fail'),
      receipt('V6', 'test', 'bun test', '697 pass; 0 fail'),
      receipt('V7', 'lint', 'bun x prettier --check src'),
    ];
    const lines = validationSection({
      unchecked: [],
      sections: [{ title: 'validation', columns: [], rows }],
    })
      .split('\n')
      .filter((l) => l.startsWith('- `'));
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => l.startsWith('- `bun test`'))).toEqual([
      '- `bun test`: passed (697 pass, 0 fail), run by `tracetoon check` on the submitted content.',
    ]);
    const verification = rows.map((r, i) => ({
      id: r.check,
      t: `2026-11-10T07:0${i}:00Z`,
      cmd: r.cmd,
      kind: r.kind,
      outcome: 'passed',
      basis: 'exit status',
      summary: r.result ? r.result.split('; ') : [],
      revision: 'no later edits seen',
      verificationBasis: 'exact-content-receipt',
    }));
    const states = checkClaims({
      title: 'x',
      body: lines.join('\n'),
      digest: {
        sessions: [],
        verification,
        files: [],
        pr: { base: 'main', head: 'h', mergeBase: 'm', usedWorkingTree: false } as any,
      } as any,
    }).map((f) => f.state);
    expect(states).toEqual(lines.map(() => 'observed'));
  });
});
