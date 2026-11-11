import { describe, expect, test } from 'bun:test';
import {
  mergedMarkdown,
  mergeFindings,
  nearDuplicateQuote,
} from '../src/contribution/mergeFindings.ts';
import type { LeanFinding } from '../src/contribution/leanReview.ts';

const claim = (
  quote: string,
  verdict: LeanFinding['verdict'],
  evidence: string,
  fix = 'Fix it.',
): LeanFinding => ({ kind: 'claim', quote, verdict, evidence, fix });

describe('merged findings', () => {
  test('near-duplicate quotes', () => {
    expect(nearDuplicateQuote('Adds a cache.', 'adds a  cache')).toBe(true);
    expect(
      nearDuplicateQuote(
        'the parser retries three times',
        'Now the parser retries three times on error',
      ),
    ).toBe(true);
    expect(nearDuplicateQuote('adds a cache', 'removes the old cache layer')).toBe(false);
    expect(nearDuplicateQuote('cache', 'the cache is gone')).toBe(false);
  });

  test('dedupes across passes, keeps the strongest verdict, orders claims before omissions', () => {
    const list = mergeFindings([
      {
        label: 'general',
        findings: [
          {
            kind: 'omission',
            verdict: 'missing',
            evidence: 'CH2',
            fix: 'Mention the flag.',
          },
          claim('Adds a cache.', 'unsupported', 'diff:4'),
          claim('Tests cover the retry path.', 'overstated', 'diff:20'),
        ],
      },
      {
        label: 'lens d',
        findings: [
          claim('adds a cache', 'contradicted', 'diff:4 | src/a.ts:9', 'It removes one.'),
          { kind: 'omission', verdict: 'missing', evidence: ['CH2'], fix: 'Say it.' },
        ],
      },
    ]);
    expect(list.total).toBe(5);
    expect(list.duplicates).toBe(2);
    expect(list.items.map((i) => i.verdict)).toEqual([
      'contradicted',
      'overstated',
      'missing',
    ]);
    expect(list.items[0]).toMatchObject({
      quote: 'adds a cache',
      evidence: ['diff:4', 'src/a.ts:9'],
      fix: 'It removes one.',
      passes: ['general', 'lens d'],
    });
    expect(list.items[2]!.passes).toEqual(['general', 'lens d']);
    const md = mergedMarkdown('r1', list);
    expect(md).toContain(
      '1. contradicted — "adds a cache" — diff:4 | src/a.ts:9 — fix: It removes one. — [general, lens d]',
    );
    expect(md).toContain(
      '3. missing (omission) — CH2 — fix: Mention the flag. — [general, lens d]',
    );
    expect(md).toContain('2 duplicate(s) merged');
  });

  test('caps the list and says how many were dropped; skips fixed claims', () => {
    const findings = Array.from({ length: 15 }, (_, i) =>
      claim(`distinct sentence number ${i} about thing${i}`, 'unsupported', `diff:${i}`),
    );
    const list = mergeFindings([{ label: 'general', findings }], {
      isFixed: (f) => f.quote!.includes('number 0 '),
    });
    expect(list.fixed).toBe(1);
    expect(list.items).toHaveLength(12);
    expect(list.dropped).toBe(2);
    const md = mergedMarkdown('r1', list);
    expect(md).toContain('2 more dropped over the cap of 12');
    expect(md).toContain('1 already fixed');
  });
});
