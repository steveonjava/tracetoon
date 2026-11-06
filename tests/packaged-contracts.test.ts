import { expect, test } from 'bun:test';
import {
  BUNDLE_CONTRACTS,
  contractPattern,
  missingContracts,
} from '../scripts/packaged-contracts.ts';
const sample = [
  {
    id: 'boundary',
    file: 'tests/boundary.test.ts',
    pattern: 'a & b (exact)',
    minimum: 1,
  },
];
const xml = (content: string, name = 'a &amp; b (exact)') =>
  `<testsuites><testcase name="${name}" classname="public boundary" file="tests\\boundary.test.ts">${content}</testcase></testsuites>`;
test('package selection fails closed on missing, skipped, failed and renamed contracts', () => {
  expect(missingContracts(xml(''), sample)).toEqual([]);
  expect(
    missingContracts(
      '<testsuites><testcase name="a &amp; b (exact)" file="tests/boundary.test.ts" />' +
        xml('<skipped />', 'filtered') +
        '</testsuites>',
      sample,
    ),
  ).toEqual([]);
  for (const value of [
    '',
    xml('<skipped />'),
    xml('<failure message="bad" />'),
    xml('', 'renamed'),
  ])
    expect(missingContracts(value, sample)).toEqual(['boundary']);
  expect(new RegExp(contractPattern(sample)).test('a & b (exact)')).toBe(true);
  expect(new RegExp(contractPattern(sample)).test('a & b exact')).toBe(false);
});
test('package contracts are unique and keep the important runtime boundaries', () => {
  expect(new Set(BUNDLE_CONTRACTS.map((c) => c.id)).size).toBe(BUNDLE_CONTRACTS.length);
  for (const id of [
    'pr-creation-publication',
    'exact-render-publication',
    'comic-assets-and-body',
    'research-review-handoff',
    'runtime-selection',
    'hook-protocol',
    'code-freshness',
    'evidence-graph-engine',
  ])
    expect(BUNDLE_CONTRACTS.some((c) => c.id === id)).toBe(true);
});
