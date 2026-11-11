import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clausesOf, ownerRows } from '../src/graph/briefExtras.ts';
import { patchHunks } from '../src/graph/build.ts';
import {
  addCodeCells,
  directional,
  evidenceLines,
  operandChanges,
  operandsOf,
} from '../src/graph/codeEvidence.ts';
import { withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph } from '../src/graph/model.ts';
import type { Section } from '../src/graph/queries.ts';
import { leanPacket } from '../src/commands/review.ts';

const N = (label: any, id: string, props: Record<string, any>) => ({ label, id, props });
const R = (type: any, from: [any, string], to: [any, string]) => ({
  type,
  from: { label: from[0], id: from[1] },
  to: { label: to[0], id: to[1] },
});
const graphOf = (nodes: any[], rels: any[] = []): EvidenceGraph => ({
  schema: GRAPH_SCHEMA,
  nodes,
  rels,
  stats: { nodes: 0, rels: 0, hunks: 0, linkedHunks: 0, edits: 0, deadEndEdits: 0 },
});

describe('fnWords: changed lines split by the function they sit in', () => {
  test('a hunk defining two functions keeps their words apart; a doc comment goes to the function below', () => {
    const patch = [
      'diff --git a/src/range.ts b/src/range.ts',
      '--- a/src/range.ts',
      '+++ b/src/range.ts',
      '@@ -1,3 +1,12 @@',
      ' import x from "y";',
      '+/** Narrow the range to the last hour. */',
      '+export function narrowRange(r: Range) {',
      '+  return { start: r.end - hour, end: r.end };',
      '+}',
      '+export function skipStaleItems(items: Item[], cutoff: number) {',
      '+  return items.filter((i) => i.stamp >= cutoff);',
      '+}',
      ' export const z = 1;',
    ].join('\n');
    const [h] = patchHunks(patch);
    const fw = new Map(h!.fnWords.map((e) => [e.split(': ')[0], e.split(': ')[1]!]));
    expect([...fw.keys()].sort()).toEqual(['narrowRange', 'skipStaleItems']);
    expect(fw.get('narrowRange')).toContain('hour');
    expect(fw.get('narrowRange')).not.toContain('stale');
    expect(fw.get('skipStaleItems')).toContain('cutoff');
    expect(fw.get('skipStaleItems')).not.toContain('hour');
  });
});

describe('owners rows', () => {
  const hunk = (id: string, file: string, fnWords: string[]) =>
    N('Hunk', id, { file, diff: `diff:${id.slice(1)}0-${id.slice(1)}9`, fnWords });
  const graph = (extra: any[] = [], extraRels: any[] = []) =>
    graphOf(
      [
        N('File', 'src/range.ts', { role: 'behavior', inPr: true }),
        N('File', 'scripts/tool.ts', { role: 'behavior', inPr: true }),
        N('Change', 'CH1', {}),
        N('Change', 'CH2', {}),
        hunk('H1', 'src/range.ts', [
          'narrowRange: narrow range window hour end start after last commit belong next',
        ]),
        hunk('H2', 'src/range.ts', [
          'staleCutoff: stale cutoff base branch commit already merged time',
          'skipStaleItems: skip stale items filter turn finished drop',
        ]),
        hunk('H3', 'scripts/tool.ts', ['runTool: tool window range']),
        ...extra,
      ],
      [
        R('HAS', ['Change', 'CH1'], ['Hunk', 'H1']),
        R('HAS', ['Change', 'CH1'], ['Hunk', 'H2']),
        R('HAS', ['Change', 'CH2'], ['Hunk', 'H3']),
        R('OF', ['Hunk', 'H1'], ['File', 'src/range.ts']),
        R('OF', ['Hunk', 'H2'], ['File', 'src/range.ts']),
        R('OF', ['Hunk', 'H3'], ['File', 'scripts/tool.ts']),
        ...extraRels,
      ],
    );
  const ctx = {
    sentences: [
      { ref: 'abc#1', text: 'Work already in the base branch is left out: the cutoff is the last commit merged.' },
      { ref: 'abc#2', text: 'Turns that finished before it are dropped from the stale items.' },
      { ref: 'abc#3', text: 'Work after the last commit belongs to the next window.' },
      { ref: 'abc', text: 'fix: narrow the window and drop stale work' },
    ],
    links: { 'abc#3': ['H1'] } as Record<string, string[]>,
  };

  test('each sentence goes to the function whose changed lines say it, never a call relation', () => {
    const rows = withGraph(graph(), (g) => ownerRows(g, ctx));
    const by = (ref: string) => rows.filter((r) => String(r.cites).startsWith(`${ref} `));
    expect(by('abc#1').map((r) => r.function)).toContain('`staleCutoff`');
    expect(by('abc#2')[0]!.function).toBe('`skipStaleItems`');
    expect(by('abc#3')[0]!.function).toBe('`narrowRange`');
    expect(by('abc#3')[0]!.file).toBe('src/range.ts');
    expect(by('abc#3')[0]!.cites).toBe('abc#3 diff:10-19');
    // The subject sums up its sentences: no row of its own.
    expect(by('abc')).toEqual([]);
    for (const r of rows) {
      expect(String(r.behavior).length).toBeLessThanOrEqual(81);
      expect(String(r.behavior)).not.toMatch(/\bcalls?\b/);
      expect(r.change).toBe('CH1');
    }
  });

  test('no rows when one function owns everything in its unit, or nothing clearly leads', () => {
    const one = {
      sentences: [{ ref: 'abc#3', text: 'Work after the last commit belongs to the next window.' }],
      links: { 'abc#3': ['H1'] },
    };
    expect(withGraph(graph(), (g) => ownerRows(g, one))).toEqual([]);
    const vague = {
      sentences: [
        { ref: 'abc#1', text: 'Things are better now in many ways for everyone.' },
        { ref: 'abc#2', text: 'Something else was improved quite a bit too.' },
      ],
      links: {},
    };
    expect(withGraph(graph(), (g) => ownerRows(g, vague))).toEqual([]);
  });

  test('graphs without fnWords give no rows', () => {
    const old = graphOf([
      N('File', 'src/a.ts', { role: 'behavior', inPr: true }),
      N('Change', 'CH1', {}),
      N('Hunk', 'H1', { file: 'src/a.ts', diff: 'diff:1-9' }),
    ]);
    expect(withGraph(old, (g) => ownerRows(g, ctx))).toEqual([]);
  });

  test('clauses split at semicolons and at a colon with words on both sides', () => {
    expect(clausesOf('A b c d: e f g h; i j k.')).toEqual(['A b c d', 'e f g h', 'i j k']);
    expect(clausesOf('Docs: one two three.')).toEqual(['Docs: one two three']);
  });

  test('the lean review packet lists the owners rows', () => {
    const brief: Section[] = [
      {
        title: 'owners',
        columns: ['change', 'behavior', 'function', 'file', 'cites'],
        rows: [
          {
            change: 'CH1',
            behavior: 'Work after the last commit belongs to the next window',
            function: '`narrowRange`',
            file: 'src/range.ts',
            cites: 'abc#3 diff:10-19',
          },
        ],
      },
    ];
    const p = leanPacket({
      runId: 'r1',
      title: 'T',
      body: 'Body.',
      patch: '',
      fingerprint: 'f',
      brief,
    });
    expect(p.text).toContain(
      '- CH1 "Work after the last commit belongs to the next window" → `narrowRange` in src/range.ts (abc#3 diff:10-19)',
    );
  });

  test('drafting guidance points at the owners rows', () => {
    const drafting = readFileSync(
      resolve(import.meta.dir, '../plugin/skills/tracetoon/references/drafting.md'),
      'utf8',
    );
    expect(drafting).toMatch(/name where a\s+behavior lives[^.]*`owners` rows/);
  });
});

describe('code evidence direction', () => {
  const minus = [
    '    (e) =>',
    '      e.head === truth.base ||',
    '      linkedIds.includes(e.number) ||',
    '      (e.meta.groups ?? []).some((s) => groupRefs.includes(s)),',
  ];
  const plus = ['    (e) => e.head === truth.base || linkedIds.includes(e.number),'];

  test('operands split at the shallowest operator, heads and stray brackets dropped', () => {
    expect(operandsOf('if (a && (b || c)) {')).toEqual(['a', 'b || c']);
    expect(operandsOf('const ok = xs.filter((e) => e.y === 1 || z(e));')).toEqual([
      'e.y === 1',
      'z(e)',
    ]);
    expect(operandsOf('if (ready) {', true)).toEqual(['ready']);
  });

  test('a multi-line condition: dropped and kept operands, not a bare removed line', () => {
    const [o] = operandChanges(minus, plus);
    expect(o!.text).toBe(
      'condition changed, dropped: `(e.meta.groups ?? []).some((s) => groupRefs.includes(s))`; kept: `e.head === truth.base`, `linkedIds.includes(e.number)`',
    );
    const lines = evidenceLines(minus, plus, 'src/story.ts');
    expect(lines[0]).toBe(`± ${o!.text}`);
    // The kept operand's removed line is not quoted alone as if it were dropped.
    expect(lines.some((l) => l.startsWith('- ') && l.includes('linkedIds'))).toBe(false);
  });

  test('a short condition: was → now, with what was dropped and kept', () => {
    expect(
      operandChanges(["  if (r.kind === 'prompt' && !r.meta) {"], ["  if (r.kind === 'prompt') {"]),
    ).toEqual([
      {
        text: "was `r.kind === 'prompt' && !r.meta` → now `r.kind === 'prompt'`; dropped: `!r.meta`; kept: `r.kind === 'prompt'`",
        lines: ["  if (r.kind === 'prompt' && !r.meta) {", "  if (r.kind === 'prompt') {"],
      },
    ]);
    // An added operand.
    expect(operandChanges(['  if (a > 1) {'], ['  if (a > 1 || b.has(x)) {'])[0]!.text).toContain(
      'added: `b.has(x)`; kept: `a > 1`',
    );
  });

  test('a value fallback is a value change, not a condition', () => {
    expect(
      operandChanges(["  const n = git(['a', 'HEAD']) || ref;"], ["  const n = git(['a', head]) || ref;"]),
    ).toEqual([]);
  });

  test('key lines render with their direction', () => {
    expect(directional('+ const n = 30;')).toBe('added: const n = 30;');
    expect(directional('- legacy();')).toBe('removed: legacy();');
    expect(directional('- const n = 10; ⇒ + const n = 30;')).toBe(
      'was `const n = 10;` → now `const n = 30;`',
    );
    expect(directional('± dropped: `x`')).toBe('dropped: `x`');
  });

  test('code cells carry the direction, operand lines first', () => {
    const g = graphOf([
      N('Hunk', 'H1', {
        file: 'src/story.ts',
        diff: 'diff:5-19',
        keyLines: [
          '+ // Related items: stacked heads or a linked group.',
          ...evidenceLines(minus, plus, 'src/story.ts'),
          '- const keepGroups = true; ⇒ + const keepGroups = false;',
        ],
        literals: [],
      }),
    ]);
    const sections: Section[] = [
      {
        title: 'commitMessages',
        columns: ['ref', 'text', 'implementedBy'],
        rows: [{ ref: 'abc#1', text: 'Sharing a group no longer relates two items.', implementedBy: [] }],
      },
    ];
    withGraph(g, (eng) => addCodeCells(eng, sections, { 'abc#1': ['H1'] }, 2000));
    const cell = String(sections[0]!.rows[0]!.code);
    expect(cell).toContain('diff:5-19 condition changed, dropped: `(e.meta.groups');
    expect(cell).toContain('diff:5-19 added: // Related items');
    expect(cell).not.toMatch(/diff:5-19 [-+] /);
  });
});
