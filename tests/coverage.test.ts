import { describe, expect, test } from 'bun:test';
import { applyBrief } from '../src/graph/briefRender.ts';

const sections = [
  {
    title: 'commitMessages',
    columns: ['ref', 'about', 'text', 'implementedBy'],
    rows: [
      {
        ref: 'abc1234def56#1',
        about: 'commit abc1234def56 only',
        text: 'Splitting now respects quoted scripts.',
        implementedBy: [],
      },
      {
        ref: 'abc1234def56#2',
        about: 'commit abc1234def56 only',
        text: 'Grouping keys drop redirection tokens.',
        implementedBy: [],
      },
    ],
  },
  {
    title: 'context',
    columns: ['ref', 'text'],
    rows: [
      { ref: 'H9', text: 'src/util/shell.ts' },
      { ref: 'H4', text: 'src/digest/build.ts' },
    ],
  },
  {
    title: 'coverage',
    columns: ['ref', 'coveredBy'],
    rows: [{ ref: 'abc1234def56#1', coveredBy: ['H9'] }],
  },
];

describe('coverage by related refs', () => {
  test('citing the hunk a commit sentence points to covers the sentence', () => {
    const b = applyBrief(
      'The splitter in `src/util/shell.ts` keeps quoted scripts whole [H9].\n',
      { sections, unchecked: [] },
    );
    expect(b.uncovered.some((u) => u.startsWith('abc1234def56#1'))).toBe(false);
    expect(b.uncovered.some((u) => u.startsWith('abc1234def56#2'))).toBe(true);
  });
  test('a row with no coverage entry still needs its own ref', () => {
    const b = applyBrief('Grouping keys change [H4].\n', { sections, unchecked: [] });
    expect(b.uncovered.some((u) => u.startsWith('abc1234def56#2'))).toBe(true);
  });
});
