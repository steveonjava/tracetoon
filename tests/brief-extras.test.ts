import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyBrief,
  misattributedTests,
  misplacedFocus,
  staleNoPass,
} from '../src/graph/briefRender.ts';
import {
  bundleRow,
  capLimits,
  entryRow,
  failedPublishRows,
  functionProfiles,
  noPassAfterCommitRow,
  remotePathRows,
  type LiveEvidence,
} from '../src/graph/briefExtras.ts';
import { invocationsOf } from '../src/digest/build.ts';
import { splitScriptUnits, unitRole, type PatchHunk } from '../src/graph/build.ts';
import { withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import { briefParts } from '../src/graph/queries.ts';

const N = (label: any, id: string, props: Record<string, any>) => ({ label, id, props });
const R = (type: any, from: [any, string], to: [any, string], props?: any) => ({
  type,
  from: { label: from[0], id: from[1] },
  to: { label: to[0], id: to[1] },
  ...(props ? { props } : {}),
});
const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const graphOf = (nodes: any[], rels: any[] = []): EvidenceGraph => ({
  schema: GRAPH_SCHEMA,
  nodes,
  rels,
  stats: { nodes: 0, rels: 0, hunks: 0, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
});
const hunkNode = (id: string, file: string, props: Record<string, any> = {}) =>
  N('Hunk', id, {
    file,
    start: 1,
    end: 9,
    added: 5,
    removed: 1,
    diff: `diff:${id.slice(1)}0-${id.slice(1)}9`,
    scope: null,
    symbols: [],
    touched: [],
    fresh: [],
    branches: 0,
    pairs: [],
    conds: [],
    tests: [],
    words: [],
    code: [],
    ...props,
  });
const fileNode = (id: string, role = 'behavior') =>
  N('File', id, { role, inPr: true, added: 5, removed: 1, unmatched: 0 });

describe('open points promoted into limits', () => {
  test('no pass after the last commit: a limit when every pass came before it', () => {
    // An edit of a PR file after the last pass and before the commit.
    const edited = (at: number) => [
      N('Session', 'h:a', { band: 'included' }),
      fileNode('src/a.ts'),
      N('Edit', 'E1', { t: t(at), file: 'src/a.ts', inPr: true }),
    ];
    const editRels = [
      R('EDITS', ['Edit', 'E1'], ['File', 'src/a.ts']),
      R('IN_SESSION', ['Edit', 'E1'], ['Session', 'h:a']),
    ];
    const commit = N('Commit', 'abc123def4567', { subject: 's', body: null, t: t(5) });
    const g = graphOf([commit, ...edited(4)], editRels);
    const runs = [
      { id: 'R1', kind: 'test', outcome: 'passed', t: t(3) },
      { id: 'R2', kind: 'lint', outcome: 'passed', t: t(3) },
    ];
    expect(withGraph(g, (e) => noPassAfterCommitRow(e, runs))).toEqual({
      change: null,
      kind: 'open',
      limit:
        'No passing check run was recorded after the last commit (abc123def456); the last pass (R1, test) came before it, and src/a.ts changed between them.',
    });
    // A pass with no captured edit between it and the commit covers it:
    // no open point (an edit before the pass doesn't reopen it).
    expect(
      withGraph(graphOf([commit]), (e) => noPassAfterCommitRow(e, runs)),
    ).toBeUndefined();
    expect(
      withGraph(graphOf([commit, ...edited(2)], editRels), (e) =>
        noPassAfterCommitRow(e, runs),
      ),
    ).toBeUndefined();
    // A pass after the commit closes it; no runs or no commit say nothing.
    expect(
      withGraph(g, (e) =>
        noPassAfterCommitRow(e, [
          ...runs,
          { id: 'R3', kind: 'test', outcome: 'passed', t: t(6) },
        ]),
      ),
    ).toBeUndefined();
    expect(withGraph(g, (e) => noPassAfterCommitRow(e, []))).toBeUndefined();
    expect(withGraph(graphOf([]), (e) => noPassAfterCommitRow(e, runs))).toBeUndefined();
  });

  test('a failed publishing command is an open point; other failures are not', () => {
    const g = graphOf([
      N('Session', 'h:a', {
        band: 'included',
        agent: 'Claude Code',
        failedCommands: 4,
        failedCommand: 'python',
        failedCmds: [
          'python (failed 2 of 5)',
          'gh pr (failed 1 of 1)',
          'git push (failed 1 of 3)',
          'gh auth (failed 1 of 1)',
        ],
      }),
      N('Session', 'h:b', {
        band: 'ambiguous',
        agent: 'Codex',
        failedCmds: ['npm publish (failed 1 of 1)'],
      }),
    ]);
    expect(withGraph(g, (e) => failedPublishRows(e)).map((r) => r.limit)).toEqual([
      "`gh pr` failed in the Claude Code session; whether or how the work was then published or pushed isn't recorded.",
      "`git push` failed 1 of 3 times in the Claude Code session; which attempt published or pushed what isn't recorded.",
    ]);
    // Older graphs carry only the most frequent failure.
    const old = graphOf([
      N('Session', 'h:a', {
        band: 'included',
        agent: 'Codex',
        failedCommand: 'git push',
      }),
    ]);
    expect(withGraph(old, (e) => failedPublishRows(e))).toHaveLength(1);
  });

  test('added branches in remote-call code no run names are open; local code is not', () => {
    const roles = new Map([
      ['src/net/providers.ts', 'behavior'],
      ['src/util/shell.ts', 'behavior'],
      ['scripts/upload.ts', 'behavior'],
    ]);
    const hunks = [
      {
        change: 'CH1',
        file: 'src/net/providers.ts',
        branches: 3,
        symbols: ['callOpenai', 'run'],
        words: ['fetch', 'json', 'openai'],
      },
      // Branches but no remote call.
      {
        change: 'CH2',
        file: 'src/util/shell.ts',
        branches: 4,
        symbols: ['splitCommands'],
        words: ['quote'],
      },
      // A script, not shipped source.
      {
        change: 'CH3',
        file: 'scripts/upload.ts',
        branches: 2,
        symbols: [],
        words: ['fetch'],
      },
    ];
    expect(remotePathRows(hunks, roles, [])).toEqual([
      {
        change: 'CH1',
        kind: 'open',
        limit:
          'src/net/providers.ts adds branches that call a remote service (`callOpenai`); no recorded check run shows those paths running against the real service.',
      },
    ]);
    // A run whose command names the file covers it.
    expect(
      remotePathRows(hunks, roles, [{ cmd: 'bun test tests/providers.test.ts' }]),
    ).toEqual([]);
  });

  test('at most six limits: remote rows, then the no-request row give way first', () => {
    const row = (limit: string) => ({ change: null, kind: 'open', limit });
    const existing = [1, 2, 3, 4].map((i) => row(`existing ${i}`));
    existing.splice(2, 0, row('No user request was recorded for CH2.'));
    const extra = [row('no pass'), row('gh failed')];
    const remote = [row('remote')];
    const out = capLimits(existing, extra, remote);
    expect(out.map((r) => r.limit)).toEqual([
      'existing 1',
      'existing 2',
      'existing 3',
      'existing 4',
      'no pass',
      'gh failed',
    ]);
    expect(capLimits([row('a')], [row('b')], remote)).toHaveLength(3);
  });
});

describe('the entry point', () => {
  const files = [
    fileNode('src/commands/comic.ts'),
    fileNode('src/comic/providers.ts'),
    fileNode('tests/comic.test.ts', 'tests'),
  ];
  const hunks = [
    hunkNode('H1', 'src/comic/providers.ts', {
      symbols: ['providerInfo', 'providerAvailable', 'generateImages', 'ProviderId'],
      fresh: ['providerInfo', 'generateImages'],
      touched: ['providerInfo', 'providerAvailable', 'generateImages'],
      code: ['+ export function providerInfo(id: ProviderId) {', '+ return castLine(x);'],
      branches: 9,
    }),
    hunkNode('H2', 'src/commands/comic.ts', {
      scope: 'chooseProvider',
      touched: ['castRefs'],
      code: [
        '+ const ready = PROVIDERS.filter(providerAvailable).map(providerInfo);',
        '- if (!providerAvailable(x))',
        '+ const id: ProviderId = pick(ready);',
      ],
      branches: 3,
    }),
    hunkNode('H3', 'tests/comic.test.ts', {
      code: ['+ providerInfo(a); providerAvailable(b); generateImages(c);'],
    }),
  ];
  const rels = [
    ...hunks.map((h) => R('OF', ['Hunk', h.id], ['File', String(h.props.file)])),
    ...hunks.map((h) =>
      R('HAS', ['Change', h.id === 'H2' ? 'CH2' : 'CH1'], ['Hunk', h.id]),
    ),
  ];
  const changes = [
    N('Change', 'CH1', {
      key: 'dir:src',
      files: [],
      roles: [],
      symbols: [],
      added: 1,
      removed: 0,
      branches: 0,
    }),
    N('Change', 'CH2', {
      key: 'dir:cmd',
      files: [],
      roles: [],
      symbols: [],
      added: 1,
      removed: 0,
      branches: 0,
    }),
  ];
  const headRef = N('HeadRef', 'HR1', {
    kind: 'most referenced',
    term: 'providerInfo',
    fresh: true,
    definedIn: ['src/comic/providers.ts'],
    refs: ['src/commands/comic.ts', 'src/commands/doctor.ts'],
    files: 2,
    count: 6,
  });

  test("the source function calling other files' changed functions, not the most referenced helper", () => {
    const row = withGraph(graphOf([...files, ...hunks, ...changes, headRef], rels), (g) =>
      entryRow(g),
    );
    // Types (`ProviderId`), constants and removed lines are not calls; tests are not entries.
    expect(row).toEqual({
      kind: 'entry',
      fact: 'Start at `chooseProvider` in src/commands/comic.ts.',
      cites: ['CH2', 'diff:20-29'],
    });
  });

  test('moved lines are said as moved in `was`, not as a changed value', () => {
    const moved = hunks.map((h) =>
      h.id === 'H2' ? { ...h, props: { ...h.props, moved: 3 } } : h,
    );
    const p = withGraph(graphOf([...files, ...moved, ...changes], rels), (g) =>
      briefParts(g),
    );
    const was = p.sections
      .find((x) => x.title === 'changes')!
      .rows.flatMap((r) => (r.was as string[]) ?? []);
    expect(was).toEqual([
      'src/commands/comic.ts: 3 line(s) moved or reflowed, text unchanged',
    ]);
  });

  test('every changed test file gets a tests row, titles or not; fixtures do not', () => {
    const extra = [
      fileNode('tests/helpers.ts', 'tests'),
      fileNode('tests/fixtures/sample.json', 'tests'),
      hunkNode('H5', 'tests/helpers.ts', { tests: [] }),
    ];
    const titled = hunks.map((h) =>
      h.id === 'H3'
        ? { ...h, props: { ...h.props, tests: ['picks a ready provider'] } }
        : h,
    );
    const p = withGraph(
      graphOf(
        [...files, ...titled, ...extra, ...changes],
        [
          ...rels,
          R('OF', ['Hunk', 'H5'], ['File', 'tests/helpers.ts']),
          R('HAS', ['Change', 'CH1'], ['Hunk', 'H5']),
        ],
      ),
      (g) => briefParts(g),
    );
    expect(p.sections.find((x) => x.title === 'tests')!.rows).toEqual([
      { ref: 'T1', file: 'tests/comic.test.ts', titles: ['picks a ready provider'] },
      { ref: 'T2', file: 'tests/helpers.ts', titles: [] },
    ]);
  });

  test('with no function calling across files, the most-referenced source symbol that owns added lines', () => {
    const lone = hunks.filter((h) => h.id !== 'H2');
    const row = withGraph(
      graphOf(
        [...files, ...lone, ...changes, headRef],
        rels.filter((r) => !JSON.stringify(r).includes('"H2"')),
      ),
      (g) => entryRow(g),
    );
    expect(row?.fact).toBe('Start at `providerInfo` in src/comic/providers.ts.');
  });

  test('a most-referenced helper that owns little of the added code is no entry', () => {
    const lone = hunks.filter((h) => h.id !== 'H2');
    // The helper's hunk is small beside another source hunk it doesn't own.
    const big = hunkNode('H4', 'src/comic/render.ts', {
      scope: 'renderStrip',
      touched: ['renderStrip'],
      added: 90,
    });
    const row = withGraph(
      graphOf(
        [...files, fileNode('src/comic/render.ts'), ...lone, big, ...changes, headRef],
        [
          ...rels.filter((r) => !JSON.stringify(r).includes('"H2"')),
          R('OF', ['Hunk', 'H4'], ['File', 'src/comic/render.ts']),
          R('HAS', ['Change', 'CH1'], ['Hunk', 'H4']),
        ],
      ),
      (g) => entryRow(g),
    );
    expect(row).toBeUndefined();
  });

  test('the brief carries it as a process row and the head scan stops calling itself the place to start', () => {
    const b = withGraph(graphOf([...files, ...hunks, ...changes, headRef], rels), (g) =>
      briefParts(g),
    );
    const process = b.sections.find((s) => s.title === 'process')!.rows;
    expect(process.find((r) => r.kind === 'entry')?.fact).toContain('`chooseProvider`');
    expect(b.sections.find((s) => s.title === 'headScan')!.rows[0]!.kind).toBe(
      'most referenced',
    );
  });
});

describe('change units split by file role', () => {
  const h = (id: string, file: string, p: Partial<PatchHunk> = {}): PatchHunk => ({
    id,
    file,
    start: 1,
    end: 2,
    added: 2,
    removed: 0,
    diff: `diff:${id}`,
    symbols: [],
    touched: [],
    branches: 0,
    fresh: [],
    pairs: [],
    dropped: [],
    conds: [],
    tests: [],
    fnWords: [],
    words: [],
    code: [],
    lines: new Set(),
    gone: new Set(),
    ...p,
  });
  const role = (f: string) =>
    f.startsWith('tests/') ? 'tests' : f.endsWith('.json') ? 'config' : 'behavior';

  test('roles: shipped source, scripts, tests, other', () => {
    expect(unitRole('src/a.ts', 'behavior')).toBe('src');
    expect(unitRole('scripts/eval.ts', 'behavior')).toBe('scripts');
    expect(unitRole('tests/a.test.ts', 'tests')).toBe('tests');
    expect(unitRole('README.md', 'docs')).toBe('other');
  });

  test('an unrelated script leaves the unit; each test goes with the code it names', () => {
    const groups = new Map([
      [
        'commit:abc',
        [
          h('H1', 'src/correlate.ts', {
            touched: ['makesCommit', 'commitMoments'],
            lines: new Set(['return makesCommit(cmd)']),
          }),
          h('H2', 'scripts/eval-summaries.ts', {
            lines: new Set(["base: 'c62818f^1',"]),
            words: ['base', 'head'],
          }),
          h('H3', 'tests/units.test.ts', {
            tests: ['commit detection'],
            words: ['commit', 'moments', 'detection'],
          }),
          h('H4', 'tests/eval.test.ts', {
            tests: ['eval summaries pin cases'],
            words: ['eval', 'summaries'],
          }),
          h('H5', 'tests/other.test.ts', { words: ['report', 'html'] }),
          h('H6', 'package.json'),
        ],
      ],
    ]);
    splitScriptUnits(groups, role);
    expect([...groups.keys()]).toEqual(['commit:abc', 'commit:abc|scripts']);
    expect(groups.get('commit:abc')!.map((x) => x.file)).toEqual([
      'src/correlate.ts',
      'tests/units.test.ts',
      'tests/other.test.ts', // a tie stays with the source
      'package.json',
    ]);
    expect(groups.get('commit:abc|scripts')!.map((x) => x.file)).toEqual([
      'scripts/eval-summaries.ts',
      'tests/eval.test.ts',
    ]);
  });

  test('a script that calls the changed source stays in the unit', () => {
    const groups = new Map([
      [
        'prompt:S1',
        [
          h('H1', 'src/shell.ts', { fresh: ['splitCommands'] }),
          h('H2', 'scripts/check.ts', {
            lines: new Set(['const parts = splitCommands(line);']),
          }),
        ],
      ],
    ]);
    splitScriptUnits(groups, role);
    expect([...groups.keys()]).toEqual(['prompt:S1']);
  });
});

describe('published bodies carry no brief refs', () => {
  const b = {
    sections: [
      { title: 'changes', columns: ['change'], rows: [{ change: 'CH1', where: [] }] },
      {
        title: 'requests',
        columns: ['ref'],
        rows: [{ ref: 'S2', kind: 'user request' }],
      },
    ],
  } as any;
  test('diff ranges, sessions, space-separated and single refs are stripped', () => {
    const body = [
      'Commands are split before matching. [CH1, diff:660-684]',
      'The user asked for it. [S2]',
      'Both rows say so. [CH1 S2]',
      'A session ref too. [S2; h:9b263cce4191]',
      'A [link](https://example.com) stays, as does [a note].',
    ].join('\n');
    const r = applyBrief(body, b);
    expect(r.text).not.toMatch(/\[(CH1|S2|diff:|h:)/);
    expect(r.text).toContain('Commands are split before matching.\n');
    expect(r.text).toContain('[link](https://example.com)');
    expect(r.text).toContain('[a note]');
    // Patch ranges and session ids are citable, not unknown refs.
    expect(r.unknownRefs).toEqual([]);
  });
  test('without a brief, tags are still stripped', () => {
    expect(applyBrief('It works. [CH1, diff:1-2]\n', undefined).text).toBe('It works.\n');
  });
});

test('drafting guidance: word target, how this came about, the entry row', () => {
  const drafting = readFileSync(
    resolve(import.meta.dir, '../plugin/skills/tracetoon/references/drafting.md'),
    'utf8',
  );
  expect(drafting).toContain('250–400 words for a typical PR');
  expect(drafting).toMatch(/60 more words per unit beyond six, up to about 900/);
  // One old → new problem sentence and at least one consequences clause.
  expect(drafting).toMatch(/one sentence on the\s+problem, old → new/);
  expect(drafting).toMatch(
    /\*\*Consequences\*\* worth a reviewer's attention, at least one clause/,
  );
  // A scope limit allows "the effect was not measured", tagged.
  expect(drafting).toMatch(/"the\s+effect was not measured"[\s\S]{0,120}tagged/);
  // Limits keep their scope; prompt and skill text is behavior; no meta text.
  expect(drafting).toMatch(/never widen it: not to "no\s+tests were run"/);
  // Environment scope is allowed only with a citation.
  expect(drafting).toMatch(/environment-scope statement[\s\S]{0,200}with that tag/);
  // A quiet pass before the commit covers it: no historical-run wording.
  expect(drafting).not.toMatch(/historical session runs|not proven to cover/);
  expect(drafting).toMatch(/could not\s+run here/);
  expect(drafting).toMatch(
    /agent-instruction text that changes what users or agents are told/,
  );
  expect(drafting).toMatch(/No meta text in the body/);
  expect(drafting).not.toMatch(/one motive sentence at most/);
  expect(drafting).toMatch(
    /\*\*How this came about\*\*[\s\S]{0,200}attributed to the record/,
  );
  expect(drafting).toMatch(/Never a list or timeline of session events/);
  expect(drafting).toMatch(/`landing`, when present/);
  expect(drafting).toMatch(/`entry` process row names/);
});

describe('remote paths a recorded live run reached', () => {
  const roles = new Map([
    ['src/net/providers.ts', 'behavior'],
    ['src/commands/draw.ts', 'behavior'],
  ]);
  const remote = {
    change: 'CH1',
    file: 'src/net/providers.ts',
    branches: 4,
    symbols: ['generateImages', 'callGemini'],
    words: ['fetch', 'provider'],
    conds: [
      "+ if (id === 'codex') return codexBatch(jobs);",
      "+ if (id === 'gemini') return callGemini(job);",
      "+ case 'openai':",
    ],
  };
  const hunks = [remote];
  const liveOf = (invocations: LiveEvidence['invocations']): LiveEvidence => ({
    invocations,
    hunks: [
      {
        file: 'src/net/providers.ts',
        scope: null,
        touched: ['generateImages'],
        symbols: ['generateImages'],
        fresh: [],
        code: [],
      },
      {
        file: 'src/commands/draw.ts',
        scope: 'drawArtCmd',
        touched: ['drawArtCmd'],
        symbols: [],
        fresh: [],
        code: ['+ const out = await generateImages(jobs, choice.id);'],
      },
    ],
  });
  const limit = (live?: LiveEvidence) =>
    remotePathRows(hunks, roles, [], live).map((r) => r.limit);

  test('no live run: the open point stands', () => {
    expect(limit(liveOf([]))).toEqual([
      'src/net/providers.ts adds branches that call a remote service (`generateImages`, `callGemini`); no recorded check run shows those paths running against the real service.',
    ]);
    // A formatter given the handler's file runs none of it.
    expect(
      limit(liveOf([{ cmd: 'bun x prettier src/commands/draw.ts', out: [] }])),
    ).toHaveLength(1);
  });

  test("a run of the handler's subcommand naming its route leaves only the other routes open", () => {
    expect(
      limit(liveOf([{ cmd: 'bun src/cli.ts draw art 20261023 codex', out: [] }])),
    ).toEqual([
      'src/net/providers.ts adds branches that call a remote service; the recorded run of `bun src/cli.ts draw art 20261023 codex` used `codex`, and no recorded run shows `gemini`, `openai` running against the real service.',
    ]);
    // The route can come from the run's output.
    expect(
      limit(liveOf([{ cmd: 'mytool draw art', out: ['panel', 'gemini'] }]))[0],
    ).toContain('used `gemini`, and no recorded run shows `codex`, `openai`');
  });

  test('a live run whose route is unknown, or that used every route, drops the row', () => {
    expect(limit(liveOf([{ cmd: 'bun src/cli.ts draw art', out: [] }]))).toEqual([]);
    expect(
      limit(
        liveOf([
          { cmd: 'bun src/cli.ts draw art codex', out: [] },
          { cmd: 'bun src/cli.ts draw art', out: [] },
        ]),
      ),
    ).toEqual([]);
    expect(
      limit(liveOf([{ cmd: 'bun src/cli.ts draw art codex gemini openai', out: [] }])),
    ).toEqual([]);
    // A file with no route values: any live run drops it.
    expect(
      remotePathRows(
        [{ ...remote, conds: [] }],
        roles,
        [],
        liveOf([{ cmd: 'bun src/cli.ts draw art codex', out: [] }]),
      ),
    ).toEqual([]);
  });

  test('invocations: plain words of non-check commands, no flags, assignments or redirections', () => {
    const scrub = { text: (x: string) => x, redactions: 0 } as never;
    const prWords = new Set(['codex', 'panel']);
    expect(
      invocationsOf(
        'cd repo && TOKEN=abc (time bun src/cli.ts draw art --run 20261023 --provider codex) 2>&1 | tail -12; bun test; grep -n x src/a.ts',
        'Panel 1 drawn by Codex in 30s',
        prWords,
        scrub,
      ),
    ).toEqual([
      { cmd: 'bun src/cli.ts draw art 20261023 codex', out: ['panel', 'codex'] },
    ]);
    // Checks, utilities and long key-like tokens are not kept.
    expect(invocationsOf('bun x tsc --noEmit && git status', '', prWords, scrub)).toEqual(
      [],
    );
    expect(
      invocationsOf('mytool login sk0123456789abcdefghijklmn', '', prWords, scrub),
    ).toEqual([{ cmd: 'mytool login', out: [] }]);
  });
});

describe('the entry row says what each function owns', () => {
  const files = [
    fileNode('src/trace/pathMatch.ts'),
    fileNode('src/correlate/correlate.ts'),
  ];
  const hunks = [
    hunkNode('H1', 'src/trace/pathMatch.ts', {
      scope: 'includesPath',
      symbols: ['leadingCd'],
      touched: ['leadingCd'],
      words: ['directory', 'command', 'leading', 'cwd'],
      code: ['+ export function leadingCd(cmd: string, cwd?: string) {'],
      branches: 3,
    }),
    hunkNode('H2', 'src/correlate/correlate.ts', {
      scope: 'belongs',
      touched: ['belongs'],
      words: ['under', 'root', 'mentions', 'match', 'fallback'],
      conds: [
        '+ if (dir) return underAnyRoot(dir, roots) || mentionsAnyRoot(r.cmd, roots);',
      ],
      code: ['+ const dir = leadingCd(r.cmd, r.cwd);'],
      branches: 2,
    }),
  ];
  const rels = [
    ...hunks.map((h) => R('OF', ['Hunk', h.id], ['File', String(h.props.file)])),
    ...hunks.map((h) => R('HAS', ['Change', 'CH1'], ['Hunk', h.id])),
  ];
  const change = N('Change', 'CH1', {
    key: 'commit:abc',
    files: [],
    roles: [],
    symbols: [],
    added: 1,
    removed: 0,
    branches: 0,
  });
  const headRef = N('HeadRef', 'HR1', {
    kind: 'most referenced',
    term: 'leadingCd',
    fresh: true,
    definedIn: ['src/trace/pathMatch.ts'],
    refs: [],
    files: 2,
    count: 3,
  });
  const ctx = {
    sentences: [
      {
        ref: 'abc1234#1',
        text: 'Commands that start with cd are judged by the directory they move to.',
      },
      { ref: 'abc1234#2', text: 'Found while dogfooding.' },
    ],
    links: { 'abc1234#1': ['H1'] },
  };
  const graph = () => graphOf([...files, ...hunks, change, headRef], rels);

  test("the entry's own sentence, and its caller with the branch tied to it", () => {
    const row = withGraph(graph(), (g) => entryRow(g, ctx));
    expect(row?.fact).toBe(
      'Start at `leadingCd` in src/trace/pathMatch.ts; tied to it: Commands that start with cd are judged by the directory they… (abc1234#1). Not in `leadingCd`: `belongs` (src/correlate/correlate.ts): `if (dir) return underAnyRoot(dir, roots)…`.',
    );
    expect(row?.cites).toContain('abc1234#1');
    expect(String(row?.fact).length).toBeLessThanOrEqual(320);
  });

  test('profiles: a sentence goes to the one function its hunk defines, branches to their hunk', () => {
    const p = withGraph(graph(), (g) => functionProfiles(g, ctx));
    expect(p.get('leadingCd')?.sentences.map((x) => x.ref)).toEqual(['abc1234#1']);
    // `includesPath` is only where the hunk starts: nothing is tied to it.
    expect(p.get('includesPath')?.sentences).toEqual([]);
    expect(p.get('belongs')?.conds[0]).toContain('mentionsAnyRoot');
    expect(p.get('belongs')?.words).toContain('fallback');
  });

  test('render flags "start at `fn`, especially <behavior>" tied to another function', () => {
    const owners = withGraph(graph(), (g) => [...functionProfiles(g, ctx).values()]);
    const flag = misplacedFocus(
      'Start review at `leadingCd`, especially the root matching fallback.',
      owners,
    );
    expect(flag?.severity).toBe('check');
    expect(flag?.problem).toContain(
      '`belongs` (src/correlate/correlate.ts), not to `leadingCd`',
    );
    // The behavior tied to the named function, no focus clause, or no pointer: nothing.
    expect(
      misplacedFocus(
        'Start at `leadingCd`, especially the directory a command moves to.',
        owners,
      ),
    ).toBeUndefined();
    expect(
      misplacedFocus('Start at `leadingCd` in pathMatch.ts.', owners),
    ).toBeUndefined();
    expect(
      misplacedFocus(
        '`leadingCd` changed, especially the root matching fallback.',
        owners,
      ),
    ).toBeUndefined();
    // Through applyBrief, as a soft flag.
    const r = applyBrief(
      'Start review at `leadingCd`, especially the root matching fallback. [CH1]\n',
      {
        sections: [],
        unchecked: [],
        owners,
      },
    );
    expect(r.flags.map((f) => f.severity)).toEqual(['check']);
  });
});

describe('stale "no passing run after the last commit"', () => {
  test('matches the limit and its rewordings, not other sentences', () => {
    for (const s of [
      'No passing check run was recorded after the last commit (abc123def456).',
      'There was no successful test run after the last edit.',
      'No check passed after the final commit.',
    ])
      expect(staleNoPass(s)).toBe(true);
    for (const s of [
      'A passing test run came after the last commit.',
      'No user request was recorded for this change.',
      'The suite has no passing run for Windows.',
    ])
      expect(staleNoPass(s)).toBe(false);
  });
  test('flagged only when a receipt passed on the submitted content', () => {
    const body = 'No passing test run was recorded after the last commit.';
    const receipt = {
      sections: [
        {
          title: 'validation',
          columns: ['check'],
          rows: [{ check: 'V1', kind: 'test', outcome: 'passed', cmd: 'bun test' }],
        },
      ],
    } as any;
    expect(applyBrief(body, receipt).flags.map((f) => f.severity)).toEqual(['fix']);
    const failed = structuredClone(receipt);
    failed.sections[0].rows[0].outcome = 'failed';
    expect(applyBrief(body, failed).flags).toEqual([]);
    expect(
      applyBrief(body, { sections: [], unchecked: [], freshPass: true }).flags,
    ).toHaveLength(1);
  });
});

describe('tested behaviors attributed to the file whose titles show them', () => {
  const tests = [
    {
      ref: 'T1',
      file: 'tests/alpha-fix.test.ts',
      titles: ['keeps quoted arguments intact', 'stops at the earlier-work cutoff'],
    },
    {
      ref: 'T2',
      file: 'tests/render.test.ts',
      titles: ['marks binary changes in the summary', 'draws shared-session panels'],
    },
  ];
  test('a behavior from another file grouped under the named one is flagged', () => {
    const flag = misattributedTests(
      'The alpha-fix tests cover quoted arguments, binary changes and the earlier-work cutoff; the render tests also check shared-session panels.',
      tests,
    );
    expect(flag?.severity).toBe('check');
    expect(flag?.problem).toContain('"binary changes"');
    expect(flag?.problem).toContain('tests/render.test.ts');
    expect(flag?.problem).toContain("not tests/alpha-fix.test.ts's");
    // By path, too.
    expect(
      misattributedTests(
        '`tests/alpha-fix.test.ts` covers binary changes in the summary.',
        tests,
      )?.problem,
    ).toContain('tests/render.test.ts');
  });
  test('correct attributions, weak matches and unnamed files are not flagged', () => {
    for (const s of [
      'The alpha-fix tests cover quoted arguments and the earlier-work cutoff; the render tests check binary changes and shared-session panels.',
      // One shared word is no clear margin.
      'The alpha-fix tests cover binary arguments.',
      // No test file named.
      'Binary changes are marked in the summary.',
      // Named, but no cover/check verb outside the name.
      'See the alpha-fix tests for binary changes.',
    ])
      expect(misattributedTests(s, tests)).toBeUndefined();
  });
  test("applyBrief reports it from the brief's tests rows", () => {
    const b = { sections: [{ title: 'tests', columns: ['ref'], rows: tests }] } as any;
    const r = applyBrief(
      'The alpha-fix tests cover binary changes and the earlier-work cutoff. [T1]',
      b,
    );
    expect(r.flags.map((f) => f.severity)).toEqual(['check']);
  });
});

describe('built output beside its changed source', () => {
  const roles = new Map([
    ['src/a.ts', 'behavior'],
    ['dist/app.mjs', 'generated'],
    ['bun.lock', 'generated'],
  ]);
  const session = N('Session', 'h:a', { band: 'included' });
  const edit = (id: string, file: string, at: number) => [
    N('Edit', id, { t: t(at), file, inPr: true }),
  ];
  const editRels = (id: string, file: string) => [
    R('EDITS', ['Edit', id], ['File', file]),
    R('IN_SESSION', ['Edit', id], ['Session', 'h:a']),
  ];
  const build = (id: string, at: number) =>
    N('Run', id, { t: t(at), kind: 'build', outcome: 'passed', cmd: 'bun run bundle' });
  const files = [fileNode('src/a.ts'), fileNode('dist/app.mjs', 'generated')];

  test('a build after the last source edit: rebuilt; a source edit after it: stale', () => {
    const fresh = withGraph(
      graphOf(
        [session, ...files, ...edit('E1', 'src/a.ts', 2), build('R1', 3)],
        [
          ...editRels('E1', 'src/a.ts'),
          R('IN_SESSION', ['Run', 'R1'], ['Session', 'h:a']),
        ],
      ),
      (g) => bundleRow(g, roles),
    );
    expect(fresh).toEqual({
      fact: 'dist/app.mjs is built or vendored output, and the PR also changes its source; a build run (R1) came after the last captured source edit (src/a.ts), so it was regenerated after the source changes.',
      cites: ['R1'],
      stale: false,
      files: ['dist/app.mjs'],
    });
    const stale = withGraph(
      graphOf(
        [session, ...files, ...edit('E1', 'src/a.ts', 4), build('R1', 3)],
        [
          ...editRels('E1', 'src/a.ts'),
          R('IN_SESSION', ['Run', 'R1'], ['Session', 'h:a']),
        ],
      ),
      (g) => bundleRow(g, roles),
    );
    expect(stale?.stale).toBe(true);
    expect(stale?.fact).toContain(
      'src/a.ts was edited after the last build run (R1), so the committed output may not include that edit.',
    );
  });

  test('the brief: a bundle process row and an open point, not housekeeping', () => {
    const p = withGraph(
      graphOf(
        [
          session,
          ...files,
          fileNode('bun.lock', 'generated'),
          ...edit('E1', 'src/a.ts', 4),
          build('R1', 3),
        ],
        [
          ...editRels('E1', 'src/a.ts'),
          R('IN_SESSION', ['Run', 'R1'], ['Session', 'h:a']),
        ],
      ),
      (g) => briefParts(g),
    );
    const rows = (title: string) => p.sections.find((x) => x.title === title)?.rows ?? [];
    expect(rows('housekeeping').flatMap((r) => r.files as string[])).toEqual([
      'bun.lock',
    ]);
    const bundle = rows('process').find((r) => r.kind === 'bundle')!;
    expect(bundle.cites).toEqual(['dist/app.mjs', 'R1']);
    expect(rows('limits').map((r) => String(r.limit))).toContainEqual(
      expect.stringContaining('the committed output may not include that edit'),
    );
  });

  test('without session evidence the commits decide; with no source change there is no row', () => {
    const commits = (bundleAt: number, srcAt: number) =>
      withGraph(
        graphOf(
          [
            ...files,
            N('Commit', 'aaaaaaaaaaaa1', { subject: 's', body: null, t: t(bundleAt) }),
            N('Commit', 'bbbbbbbbbbbb2', { subject: 's', body: null, t: t(srcAt) }),
          ],
          [
            R('TOUCHES', ['Commit', 'aaaaaaaaaaaa1'], ['File', 'dist/app.mjs']),
            R('TOUCHES', ['Commit', 'bbbbbbbbbbbb2'], ['File', 'src/a.ts']),
          ],
        ),
        (g) => bundleRow(g, roles),
      );
    expect(commits(5, 3)?.stale).toBe(false);
    expect(commits(3, 5)?.stale).toBe(true);
    const noSource = withGraph(graphOf(files), (g) =>
      bundleRow(g, new Map([['dist/app.mjs', 'generated']])),
    );
    expect(noSource).toBeUndefined();
    // A lockfile alone is housekeeping, not built output.
    expect(
      withGraph(graphOf(files), (g) =>
        bundleRow(
          g,
          new Map([
            ['src/a.ts', 'behavior'],
            ['bun.lock', 'generated'],
          ]),
        ),
      ),
    ).toBeUndefined();
  });
});
