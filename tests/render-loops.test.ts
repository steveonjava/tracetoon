import { describe, expect, test } from 'bun:test';
import {
  applyBrief,
  demoteRepeats,
  type BriefApplied,
} from '../src/graph/briefRender.ts';

const parts = {
  sections: [
    {
      title: 'commitMessages',
      columns: ['ref', 'about', 'text', 'implementedBy'],
      rows: [
        {
          ref: 'abc1234def56#1',
          about: 'commit abc1234def56 only',
          text: 'A test run was miscounted.',
          implementedBy: [],
        },
      ],
    },
  ],
  unchecked: [],
};

describe('render loops', () => {
  test('a result attributed to the commit message is not a run claim', () => {
    const b = applyBrief(
      'The commit message says embedded `bun test` text was counted as a test run [abc1234def56#1].\n\nAll 96 tests passed after the change [abc1234def56#1].\n\nAll 96 tests passed.\n',
      parts,
    );
    expect(b.validationClaims).toEqual(['All 96 tests passed.']);
  });

  test('a finding reported once stops blocking on the next render', () => {
    const finding = (): BriefApplied =>
      ({
        text: '',
        validation: false,
        tags: 1,
        unknownRefs: ['R10'],
        untagged: ['A sentence with no tag at all here.'],
        validationClaims: [],
        unbackedNames: [],
        uncovered: ['S1 (the goal): Can you dogfood this?'],
        flags: [],
      }) as unknown as BriefApplied;
    const first = finding();
    const seen = demoteRepeats(first, []);
    expect(first.uncovered.length).toBe(1);
    expect(first.repeated).toEqual([]);
    const second = finding();
    second.untagged.push('A new untagged sentence written later.');
    demoteRepeats(second, seen);
    expect(second.uncovered).toEqual([]);
    expect(second.unknownRefs).toEqual([]);
    expect(second.untagged).toEqual(['A new untagged sentence written later.']);
    expect(second.repeated?.length).toBe(3);
  });
});
