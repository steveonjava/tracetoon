import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keyCodeLines } from '../src/graph/build.ts';
import { briefRefs } from '../src/graph/briefRender.ts';
import { renderNeighborhood } from '../src/graph/neighborhood.ts';
import { linkedHunks, type Section } from '../src/graph/queries.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(120_000);

describe('key code lines', () => {
  test('pairs a changed value, keeps definitions, drops braces and imports', () => {
    const lines = keyCodeLines(
      ['  endMs: last + 30 * 60_000,', "import { x } from './x.ts';"],
      [
        '  endMs: last + 5 * 60_000,',
        'export function windowFor(t: number) {',
        '}',
        "import { y } from './y.ts';",
      ],
    );
    expect(lines[0]).toBe('- endMs: last + 30 * 60_000,  ⇒  + endMs: last + 5 * 60_000,');
    expect(lines).toContain('+ export function windowFor(t: number) {');
    expect(lines.some((l) => /import|^\+ \}$/.test(l))).toBe(false);
  });

  test('clips long lines and caps the count', () => {
    const long = `const s = '${'x'.repeat(400)}';`;
    const lines = keyCodeLines(
      [],
      Array.from({ length: 40 }, (_, i) => `${long} // ${i}`),
    );
    expect(lines.length).toBe(24);
    expect(lines.every((l) => l.length <= 162)).toBe(true);
  });
});

describe('sentence → hunk links', () => {
  const hunks = [
    {
      id: 'H1',
      file: 'src/util/shell.ts',
      symbols: ['splitCommands'],
      words: ['split', 'quote', 'heredoc', 'command'],
    },
    {
      id: 'H2',
      file: 'src/digest/build.ts',
      symbols: ['commandKey'],
      words: ['group', 'key', 'redirect', 'token'],
    },
    { id: 'H3', file: 'tests/shell.test.ts', symbols: [], words: ['split', 'quote'] },
  ];
  test('a file the sentence names', () => {
    expect(
      linkedHunks(
        hunks,
        'A new splitter (src/util/shell.ts) now feeds test detection, grouping and commits.',
      ),
    ).toEqual(['H1']);
  });
  test('the hunk whose words fit', () => {
    expect(linkedHunks(hunks, 'Grouping keys also drop redirection tokens.')).toEqual([
      'H2',
    ]);
  });
  test('nothing for a sentence that fits no hunk', () => {
    expect(linkedHunks(hunks, 'Found in the live run for this PR.')).toEqual([]);
  });
  test('a weak match links nothing', () => {
    expect(
      linkedHunks(
        hunks,
        'Grouping keys changed while reviewing several unrelated behaviors here today.',
      ),
    ).toEqual([]);
  });
  test('two files that fit equally: neither', () => {
    const tie = [
      { id: 'H1', file: 'src/a.ts', symbols: [], words: ['quiet', 'commit', 'subject'] },
      { id: 'H2', file: 'src/b.ts', symbols: [], words: ['quiet', 'commit', 'subject'] },
    ];
    expect(linkedHunks(tie, 'Quiet commits are recognized by their subject.')).toEqual(
      [],
    );
  });
  test('a single code hunk links only a sentence that shares its words', () => {
    const one = [
      {
        id: 'H7',
        file: 'src/comic/providers.ts',
        symbols: ['pickImages'],
        words: ['codex', 'image', 'reply', 'prompt'],
      },
    ];
    expect(linkedHunks(one, 'Match Codex images to prompts by the final reply.')).toEqual(
      ['H7'],
    );
    expect(linkedHunks(one, 'Found in the live run for this comic.')).toEqual([]);
  });
});

const SHA = 'abc123abc123';
const sections = (codeLines: number, extra: Section[] = []): Section[] => [
  {
    title: 'limits',
    columns: ['ref', 'change', 'kind', 'limit'],
    rows: [{ ref: 'L1', change: 'CH1', kind: 'open', limit: 'No recorded run.' }],
  },
  {
    title: 'changes',
    columns: [
      'change',
      'groupedBy',
      'where',
      'newSymbols',
      'was',
      'behavior',
      'added',
      'removed',
      'diff',
      'commits',
      'requests',
    ],
    rows: [
      {
        change: 'CH1',
        groupedBy: 'prompt',
        where: ['src/a.ts (f)'],
        newSymbols: ['f'],
        was: [],
        behavior: ['a.ts: + if (cached) return cached;'],
        added: 10,
        removed: 2,
        diff: [],
        commits: [SHA],
        requests: ['S1'],
      },
      {
        change: 'CH2',
        groupedBy: 'commit',
        where: ['docs/x.md'],
        newSymbols: [],
        was: [],
        behavior: [],
        added: 3,
        removed: 0,
        diff: [],
        commits: [],
        requests: [],
      },
    ],
  },
  {
    title: 'process',
    columns: ['ref', 'kind', 'fact', 'cites'],
    rows: [{ ref: 'PR1', kind: 'session', fact: 'Claude session, main.', cites: ['S1'] }],
  },
  {
    title: 'requests',
    columns: ['ref', 'kind', 'text', 'truncated'],
    rows: [{ ref: 'S1', kind: 'user request', text: 'Make f faster.' }],
  },
  ...extra,
  {
    title: 'commitMessages',
    columns: ['ref', 'text', 'implementedBy'],
    rows: [
      { ref: SHA, text: 'perf: faster f', implementedBy: ['src/a.ts'] },
      { ref: `${SHA}#1`, text: 'f caches its result.', implementedBy: [] },
    ],
  },
  {
    title: 'hunks',
    columns: [
      'ref',
      'change',
      'file',
      'lines',
      'scope',
      'code',
      'why',
      'sentences',
      'weight',
      'role',
    ],
    rows: [
      {
        ref: 'H1',
        change: 'CH1',
        file: 'src/a.ts',
        lines: 'L1-40',
        scope: ['f'],
        code: Array.from(
          { length: codeLines },
          (_, i) => `+ const cache${i} = new Map();`,
        ),
        why: ['S1'],
        sentences: [`${SHA}#1`],
        weight: 12,
        role: 'behavior',
      },
      {
        ref: 'H2',
        change: 'CH2',
        file: 'docs/x.md',
        lines: 'L3-5',
        scope: [],
        code: ['+ Faster f.'],
        why: [],
        sentences: [],
        weight: 0,
        role: 'docs',
      },
    ],
  },
  {
    title: 'validation',
    columns: ['check', 'kind', 'outcome', 'result', 'when', 'editedAfter', 'cmd'],
    rows: [],
  },
];

const evidence = (text: string) => text.slice(text.indexOf('Evidence by change'));

describe('neighborhood brief', () => {
  test('every change gets a block, with behavior, why, commit sentences, hunks and code', () => {
    const text = renderNeighborhood(sections(3), { budgetTokens: 1500 });
    expect(text.startsWith('limits[1]{ref,change,kind,limit}:')).toBe(true);
    expect(text).toContain('## CH1 ');
    expect(text).toContain('## CH2 ');
    expect(text).toContain('  behavior: a.ts: + if (cached) return cached;');
    expect(text).toContain('why: [S1] (user request) Make f faster.');
    // The subject row is the bare sha: printed as such, never as commit:<sha>.
    expect(text).toContain(`commit [${SHA}] perf: faster f (implementedBy src/a.ts)`);
    expect(text).not.toContain('commit:');
    expect(text).toContain(`[${SHA}#1] f caches its result. → H1`);
    expect(text).toContain('src/a.ts: [H1] L1-40 (f; told by #1) · why S1');
    expect(text).toContain('H1  + const cache0 = new Map();');
    // How the work went stays a table after the blocks.
    expect(text).toContain('process[1]{ref,kind,fact,cites}:');
    expect(text.indexOf('process[1]')).toBeGreaterThan(text.indexOf('## CH2 '));
  });

  test('a background section shows as a Session background block', () => {
    const text = renderNeighborhood(
      sections(1, [
        {
          title: 'background',
          columns: ['ref', 'kind', 'text'],
          rows: [
            { ref: 'S0', kind: 'earlier turn', text: 'We first tried a cache file.' },
          ],
        },
      ]),
      { budgetTokens: 1500 },
    );
    expect(text).toContain(
      '## Session background\n  [S0] earlier turn · We first tried a cache file.',
    );
    expect(text.indexOf('## Session background')).toBeLessThan(text.indexOf('## CH1 '));
  });

  test('code lines are packed to the evidence budget', () => {
    const budget = 200;
    const text = renderNeighborhood(sections(400), { budgetTokens: budget });
    expect(
      evidence(text).replace(/\nprocess\[1\][\s\S]*$/, '').length,
    ).toBeLessThanOrEqual(budget * 4 + 1);
    expect(text).toContain('## CH2 ');
    expect(text).toContain('cache0');
    expect(text).not.toContain('cache399');
  });

  test('a target size caps the whole brief (the TOON brief of the same run)', () => {
    const text = renderNeighborhood(sections(400), {
      budgetTokens: 1500,
      targetChars: 1500,
    });
    expect(text.length).toBeLessThanOrEqual(1500 + 1);
    expect(text).toContain('cache0');
    expect(
      renderNeighborhood(sections(400), { budgetTokens: 1500 }).length,
    ).toBeGreaterThan(5000);
  });

  test('render accepts the hunk refs', () => {
    const refs = briefRefs({ sections: sections(1), unchecked: [] });
    expect(refs.has('H2')).toBe(true);
    expect(refs.has('PR1')).toBe(true);
  });
});

// End to end: prepare --layout, query brief --layout, render and the review packet.
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [process.env.TRACETOON_TEST_BINARY]
  : [process.execPath, CLI];

const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';
const FAREWELL =
  'export function farewell(name: string): string {\n  return `Goodbye, ${name}. See you soon!`;\n}\n';

function scenario() {
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
  const repo = makeRepo();
  new ClaudeLog(repo.root)
    .prompt('Add a greet helper that says hello by name')
    .write(join(repo.root, 'src/greet.ts'), GREET)
    .prompt('Now add farewell too, keep it friendly')
    .write(join(repo.root, 'src/farewell.ts'), FAREWELL)
    .save(claudeHome, 'nbhd');
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
  writeFileSync(join(repo.root, 'src/farewell.ts'), FAREWELL);
  git(repo.root, ['add', '.']);
  git(repo.root, [
    'commit',
    '-q',
    '-m',
    'feat: greet and farewell helpers\n\nThe farewell helper says goodbye and see you soon.',
  ]);
  return { repo, cli };
}

const farewellHunk = (sections: Section[]) =>
  String(
    sections
      .find((s) => s.title === 'hunks')!
      .rows.find((r) => r.file === 'src/farewell.ts')!.ref,
  );

describe('brief layout selection', () => {
  test('prepare --layout neighborhood is kept for query brief, render and the packet', () => {
    const { repo, cli } = scenario();
    const bad = cli(repo.root, '--json', 'prepare', '--offline', '--layout', 'grid');
    expect(bad.code).toBe(1);
    const prepared = cli(
      repo.root,
      '--json',
      'prepare',
      '--offline',
      '--layout',
      'neighborhood',
    );
    expect(prepared.code).toBe(0);
    const run = prepared.json.run;
    const runDir = prepared.json.runDir;
    expect(JSON.parse(readFileSync(join(runDir, 'brief-layout.json'), 'utf8'))).toEqual({
      layout: 'neighborhood',
    });
    expect(prepared.json.brief).toContain('Evidence by change');
    expect(prepared.json.brief).toMatch(/\[H\d+\]/);
    expect(prepared.json.brief).toContain('process[');
    // query brief reads the run's layout; --layout overrides it.
    const nb = cli(repo.root, '--json', 'query', 'brief', '--run', run);
    expect(nb.json.layout).toBe('neighborhood');
    const h = farewellHunk(nb.json.sections);
    const sentence = nb.json.sections
      .find((s: Section) => s.title === 'commitMessages')
      .rows.find((r: any) => String(r.ref).endsWith('#1'));
    expect(sentence.text).toContain('farewell helper says goodbye');
    const text = cli(repo.root, 'query', 'brief', '--run', run).stdout;
    expect(text).toContain(
      `[${sentence.ref}] The farewell helper says goodbye and see you soon. → ${h}`,
    );
    const toon = cli(
      repo.root,
      '--json',
      'query',
      'brief',
      '--run',
      run,
      '--layout',
      'toon',
    );
    expect(toon.json.layout).toBe('toon');
    expect(toon.json.sections.some((s: Section) => s.title === 'hunks')).toBe(false);
    expect(
      cli(repo.root, 'query', 'outline', '--run', run, '--layout', 'toon').code,
    ).toBe(1);
    // A refresh without --layout keeps the run's layout.
    const again = cli(repo.root, '--json', 'prepare', '--offline', '--run', run);
    expect(again.json.brief).toContain('Evidence by change');

    // render knows the hunk refs.
    writeFileSync(join(runDir, 'title.txt'), 'Add greet and farewell helpers');
    writeFileSync(
      join(runDir, 'body.md'),
      [
        `Adds a farewell helper that says goodbye. [${h}, ${sentence.ref}]`,
        '',
        '<!-- tracetoon:validation -->',
        '',
      ].join('\n'),
    );
    const r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    expect(r.json.briefCheck.unknownRefs).toEqual([]);
  });

  test('the default is toon; the review packet links commit sentences to hunks anyway', () => {
    const { repo, cli } = scenario();
    const prepared = cli(repo.root, '--json', 'prepare', '--offline');
    const run = prepared.json.run;
    const runDir = prepared.json.runDir;
    // The shipped SKILL.md says `Brief layout: toon.`, which prepare now stores.
    const stored = join(runDir, 'brief-layout.json');
    if (existsSync(stored))
      expect(JSON.parse(readFileSync(stored, 'utf8')).layout).toBe('toon');
    expect(prepared.json.brief).not.toContain('Evidence by change');
    expect(prepared.json.brief).toContain('commitMessages[');
    const b = cli(repo.root, '--json', 'query', 'brief', '--run', run);
    expect(b.json.layout).toBe('toon');
    expect(b.json.sections.some((s: Section) => s.title === 'hunks')).toBe(false);
    const nb = cli(
      repo.root,
      '--json',
      'query',
      'brief',
      '--run',
      run,
      '--layout',
      'neighborhood',
    );
    const h = farewellHunk(nb.json.sections);
    // An H# tag is unknown to a toon run's render.
    writeFileSync(join(runDir, 'title.txt'), 'Add greet and farewell helpers');
    writeFileSync(
      join(runDir, 'body.md'),
      [
        `Adds a farewell helper that says goodbye. [${h}]`,
        '',
        '<!-- tracetoon:validation -->',
        '',
      ].join('\n'),
    );
    const r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    expect(r.json.briefCheck.unknownRefs).toEqual([h]);
    expect(cli(repo.root, '--json', 'render', '--run', run).code).toBe(0);
    const packet = cli(repo.root, '--json', 'review-packet', '--lean', '--run', run);
    expect(packet.code).toBe(0);
    const md = readFileSync(packet.json.path, 'utf8');
    expect(md).toMatch(
      new RegExp(
        `#1: "The farewell helper says goodbye and see you soon\\." \\| implementedBy: src/farewell\\.ts → ${h}\\n`,
      ),
    );
  });
});

describe('neighborhood-wide layout', () => {
  test('packs to the fixed budget instead of the TOON size', async () => {
    const { briefBudget, isNeighborhood, parseLayout } =
      await import('../src/graph/layout.ts');
    expect(parseLayout('neighborhood-wide')).toBe('neighborhood-wide');
    expect(isNeighborhood('neighborhood-wide')).toBe(true);
    expect(isNeighborhood('toon')).toBe(false);
    const saved = process.env.TRACETOON_BRIEF_BUDGET;
    delete process.env.TRACETOON_BRIEF_BUDGET;
    try {
      expect(briefBudget('neighborhood').matchToon).toBe(true);
      expect(briefBudget('neighborhood-wide')).toEqual({
        tokens: 1500,
        matchToon: false,
      });
    } finally {
      if (saved !== undefined) process.env.TRACETOON_BRIEF_BUDGET = saved;
    }
  });
});
