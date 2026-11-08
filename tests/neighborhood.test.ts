import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { keyCodeLines } from '../src/graph/build.ts';
import { briefRefs } from '../src/graph/briefRender.ts';
import { renderNeighborhood } from '../src/graph/neighborhood.ts';
import { linkedHunks, type Section } from '../src/graph/queries.ts';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.TRACETOON_BRIEF_LAYOUT;
  process.env.TRACETOON_BRIEF_LAYOUT = 'neighborhood';
});
afterEach(() => {
  if (saved === undefined) delete process.env.TRACETOON_BRIEF_LAYOUT;
  else process.env.TRACETOON_BRIEF_LAYOUT = saved;
});

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

const sections = (codeLines: number): Section[] => [
  { title: 'avoid', columns: ['rule'], rows: [{ rule: 'Rule one.' }] },
  {
    title: 'changes',
    columns: [
      'change',
      'groupedBy',
      'where',
      'newSymbols',
      'was',
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
        added: 10,
        removed: 2,
        diff: [],
        commits: ['abc123abc123'],
        requests: ['S1'],
      },
      {
        change: 'CH2',
        groupedBy: 'commit',
        where: ['docs/x.md'],
        newSymbols: [],
        was: [],
        added: 3,
        removed: 0,
        diff: [],
        commits: [],
        requests: [],
      },
    ],
  },
  {
    title: 'requests',
    columns: ['ref', 'kind', 'text'],
    rows: [{ ref: 'S1', kind: 'user request', text: 'Make f faster.' }],
  },
  {
    title: 'commitMessages',
    columns: ['ref', 'about', 'text', 'implementedBy'],
    rows: [
      {
        ref: 'commit:abc123abc123',
        about: 'src/a.ts',
        text: 'perf: faster f',
        implementedBy: ['src/a.ts'],
      },
      {
        ref: 'abc123abc123#1',
        about: 'commit abc123abc123 only',
        text: 'f caches its result.',
        implementedBy: [],
      },
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
        sentences: ['abc123abc123#1'],
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
  test('every change gets a block, with its why, commit sentences, hunks and code', () => {
    const text = renderNeighborhood(sections(3), { budgetTokens: 2112 });
    expect(text).toContain('## CH1 ');
    expect(text).toContain('## CH2 ');
    expect(text).toContain('why: [S1] (user request) Make f faster.');
    expect(text).toContain('[abc123abc123#1] f caches its result. → H1');
    expect(text).toContain('src/a.ts: [H1] L1-40 (f; told by #1) · why S1');
    expect(text).toContain('H1  + const cache0 = new Map();');
    expect(text.startsWith('avoid[1]{rule}:')).toBe(true);
  });

  test('code lines are packed to the evidence budget', () => {
    const budget = 200;
    const text = renderNeighborhood(sections(400), { budgetTokens: budget });
    expect(
      evidence(text).replace(/\nvalidation\[0\][\s\S]*$/, '').length,
    ).toBeLessThanOrEqual(budget * 4 + 1);
    expect(text).toContain('## CH2 ');
    expect(text).toContain('cache0');
    expect(text).not.toContain('cache399');
  });

  test('render accepts the hunk refs', () => {
    expect(briefRefs({ sections: sections(1), unchecked: [] }).has('H2')).toBe(true);
  });
});
