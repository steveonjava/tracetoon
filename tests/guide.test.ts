import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { keyCodeLines } from '../src/graph/build.ts';
import { coverageRows, coverLine } from '../src/graph/guide.ts';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.TRACETOON_BRIEF_GUIDE;
  process.env.TRACETOON_BRIEF_GUIDE = 'on';
});
afterEach(() => {
  if (saved === undefined) delete process.env.TRACETOON_BRIEF_GUIDE;
  else process.env.TRACETOON_BRIEF_GUIDE = saved;
});

const sections = [
  {
    title: 'limits',
    columns: ['ref', 'change', 'kind', 'limit'],
    rows: [{ ref: 'L1', change: null, kind: 'open', limit: 'x' }],
  },
  { title: 'changes', columns: ['change'], rows: [{ change: 'CH1' }, { change: 'CH2' }] },
  {
    title: 'requests',
    columns: ['ref', 'kind', 'text'],
    rows: [{ ref: 'S1', kind: 'goal: the first request', text: 'Do it.' }],
  },
  {
    title: 'commitMessages',
    columns: ['ref', 'text', 'implementedBy'],
    rows: [
      { ref: 'abc123def456', text: 'fix: thing', implementedBy: [] },
      {
        ref: 'abc123def456#1',
        text: 'Splitting now respects quoted scripts.',
        implementedBy: [],
      },
    ],
  },
  {
    title: 'tests',
    columns: ['ref', 'file', 'titles'],
    rows: [{ ref: 'T1', file: 'tests/a.test.ts', titles: [] }],
  },
  {
    title: 'housekeeping',
    columns: ['ref', 'what', 'files'],
    rows: [
      { ref: 'HK1', what: 'v', files: [] },
      { ref: 'HK2', what: 'g', files: [] },
    ],
  },
];
const hunks = [
  { change: 'CH1', hunk: 'H1', file: 'src/a.ts' },
  { change: 'CH2', hunk: 'H2', file: 'tests/a.test.ts' },
];

describe('coverage aids', () => {
  test('the cover line names every required row and says how to group', () => {
    const line = coverLine(sections as any)!;
    expect(line).toContain('CH1 CH2');
    expect(line).toContain('abc123def456 #1');
    expect(line).toContain('L1 (open points)');
    expect(line).toContain('S1 (the goal)');
    expect(line).toContain('grouped sentences');
  });
  test('coverage rows: a sentence by its hunks, a change by its hunks, tests by their file, housekeeping by each other', () => {
    const rows = coverageRows(sections as any, hunks, { 'abc123def456#1': ['H1'] });
    const by = Object.fromEntries(rows.map((r) => [r.ref, r.coveredBy]));
    expect(by['abc123def456#1']).toEqual(['H1']);
    expect(by.CH1).toEqual(['H1']);
    expect(by.T1).toEqual(['H2']);
    expect(by.HK1).toEqual(['HK2']);
  });
});

describe('key lines keep why-comments', () => {
  test('an explanatory added comment ranks with definitions', () => {
    const lines = keyCodeLines(
      [],
      [
        ...Array.from({ length: 30 }, (_, i) => `  const x${i} = ${i};`),
        '  // The releases API sorts rc.10 before rc.2, so take the latest by date instead',
      ],
    );
    expect(lines.some((l) => l.includes('releases API sorts'))).toBe(true);
  });
  test('off: comments are dropped as before', () => {
    process.env.TRACETOON_BRIEF_GUIDE = 'off';
    const lines = keyCodeLines(
      [],
      [
        ...Array.from({ length: 30 }, (_, i) => `  const x${i} = ${i};`),
        '  // The releases API sorts rc.10 before rc.2, so take the latest by date instead',
      ],
    );
    expect(lines.some((l) => l.includes('releases API sorts'))).toBe(false);
  });
});
