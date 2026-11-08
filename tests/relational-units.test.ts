/**
 * Unit tests for the relational/vector arm: embeddings, diff parsing and
 * chunking, the store's relational links, hybrid retrieval, packing and refs.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { GraphInputs } from '../src/graph/build.ts';
import type { TraceDigest, TrailEvent } from '../src/digest/build.ts';
import { evidenceLine } from '../src/correlate/correlate.ts';
import { budgetTokens, R_BUDGET_TOKENS } from '../src/relational/index.ts';
import { buildRelationalContext, initRelational } from '../src/relational/builder.ts';
import { bertWords, cosine, embeddingModel } from '../src/relational/embed.ts';
import { chunkFile, definedName, parsePatch, testTitle } from '../src/relational/diff.ts';
import { loadStore, rows } from '../src/relational/store.ts';
import {
  buildQueries,
  hybridSearch,
  inheritApprovals,
  relationalLinks,
} from '../src/relational/retrieve.ts';
import { keyLines, pack, safe, type Item } from '../src/relational/pack.ts';
import { commitSentences } from '../src/relational/text.ts';

beforeAll(async () => {
  await initRelational();
});

// ---- A small synthetic PR -------------------------------------------------

const SHA_A = 'a'.repeat(12) + '1'.repeat(28);
const SHA_B = 'b'.repeat(12) + '2'.repeat(28);

const GREET_LINES = [
  '/** Greets a person by name. */',
  'export function greet(name: string): string {',
  '  return `Hello, ${name}!`;',
  '}',
  '',
  'export function farewell(name: string): string {',
  '  return `Goodbye, ${name}.`;',
  '}',
];
const TEST_LINES = [
  "import { greet } from '../src/greet.ts';",
  "test('greet says hello by name', () => {",
  "  expect(greet('Ada')).toBe('Hello, Ada!');",
  '});',
];

function hunkAdded(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');
}

const PATCH = [
  hunkAdded('src/greet.ts', GREET_LINES),
  [
    'diff --git a/src/config.ts b/src/config.ts',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -1,4 +1,4 @@ export function timeoutMs()',
    ' export const NAME = "demo";',
    '-export const RETRY_LIMIT = 3;',
    '+export const RETRY_LIMIT = 5;',
    '--- a removed line that looks like a header',
    '+// retries raised for flaky networks',
  ].join('\n'),
  hunkAdded('tests/greet.test.ts', TEST_LINES),
  [
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,1 +1,3 @@',
    ' # demo',
    '+',
    '+Call `greet(name)` to say hello. See [H1] for details.',
  ].join('\n'),
  [
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/assets/logo.png differ',
  ].join('\n'),
].join('\n');

const norm = (ls: string[]) => ls.map(evidenceLine).filter((l): l is string => !!l);

function fixture(): GraphInputs {
  const S1 = {
    id: 'S1',
    t: '2026-01-01T10:00:00Z',
    text: 'Add a greet helper that says hello to a person by name, with a test.',
    ledToEdits: true,
  };
  const P1 = {
    id: 'P1',
    t: '2026-01-01T10:05:00Z',
    approved: true,
    excerpt:
      '# Plan\n\nRaise the retry limit in src/config.ts from 3 to 5 so flaky networks recover.\n\nKeep the timeout as it is.',
  };
  const S2 = { id: 'S2', t: '2026-01-01T10:06:00Z', text: 'yes', ledToEdits: true };
  const S3 = {
    id: 'S3',
    t: '2026-01-01T12:00:00Z',
    text: 'Unrelated: what is the weather like? [H1] is not a ref here.',
    ledToEdits: false,
  };
  const D1 = {
    id: 'D1',
    t: '2026-01-01T10:02:00Z',
    text: 'Should farewell be added too? → Yes, add farewell next to greet',
  };
  const run = {
    id: 'R1',
    t: '2026-01-01T10:10:00Z',
    cmd: 'bun test',
    kind: 'test' as const,
    outcome: 'passed' as const,
    basis: 'exit status' as const,
    summary: ['1 pass', '0 fail'],
    revision: 'no later edits seen' as const,
  };
  const events: TrailEvent[] = [
    { kind: 'prompt', fact: S1 },
    { kind: 'decision', fact: D1 },
    {
      kind: 'edit',
      t: S1.t,
      file: 'src/greet.ts',
      inPr: true,
      lines: norm(GREET_LINES),
      added: GREET_LINES.length,
      removed: 0,
    },
    {
      kind: 'edit',
      t: S1.t,
      file: 'tests/greet.test.ts',
      inPr: true,
      lines: norm(TEST_LINES),
      added: TEST_LINES.length,
      removed: 0,
    },
    { kind: 'plan', fact: P1 },
    { kind: 'prompt', fact: S2 },
    {
      kind: 'edit',
      t: S2.t,
      file: 'src/config.ts',
      inPr: true,
      lines: norm([
        'export const RETRY_LIMIT = 5;',
        '// retries raised for flaky networks',
      ]),
      added: 2,
      removed: 1,
    },
    { kind: 'run', fact: run },
    { kind: 'prompt', fact: S3 },
  ];
  const full = {
    v: 1,
    pr: {
      base: 'main',
      head: 'feature',
      mergeBase: '0'.repeat(40),
      usedWorkingTree: false,
      commits: [
        {
          sha: SHA_A,
          subject: 'feat: greet helper',
          body: 'Adds `greet()` and `farewell()` in src/greet.ts. A test checks the greeting.\n\nCo-Authored-By: Someone <x@example.com>',
          trailers: {},
          time: '2026-01-01T10:20:00Z',
        },
        {
          sha: SHA_B,
          subject: 'fix: raise the retry limit',
          body: 'RETRY_LIMIT goes from 3 to 5 because flaky networks gave up too early.\n\n- 12 tests pass',
          trailers: {},
          time: '2026-01-01T10:30:00Z',
        },
      ],
    },
    sessions: [
      {
        ref: 'h:aaaaaaaaaaaa',
        agent: 'Claude Code',
        models: [],
        span: { start: S1.t, end: S3.t },
        band: 'included',
        prompts: [S1, S2, S3],
        decisions: [D1],
        plans: [P1],
        runs: [run],
      },
    ],
    files: [],
    notes: [],
    truncated: [],
  } as unknown as TraceDigest;
  return {
    full,
    trails: [{ ref: 'h:aaaaaaaaaaaa', events }],
    patch: PATCH,
    commitFiles: new Map([
      [SHA_A, ['src/greet.ts', 'tests/greet.test.ts', 'README.md']],
      [SHA_B, ['src/config.ts']],
    ]),
    commitLines: new Map([
      [
        SHA_A,
        new Map([
          ['src/greet.ts', norm(GREET_LINES)],
          ['tests/greet.test.ts', norm(TEST_LINES)],
          ['README.md', norm(['Call `greet(name)` to say hello. See [H1] for details.'])],
        ]),
      ],
      [
        SHA_B,
        new Map([
          [
            'src/config.ts',
            [
              ...norm([
                'export const RETRY_LIMIT = 5;',
                '// retries raised for flaky networks',
              ]),
              '-export const RETRY_LIMIT = 3;',
            ],
          ],
        ]),
      ],
    ]),
  };
}

const ID = /(?<![\w:])(commit:[0-9a-f]{12}(?:#\d+)?|[SDPRVFH]\d+)(?![\w#])/g;

// ---- Embeddings -----------------------------------------------------------

describe('embeddings (potion-code-16M-v2, pure TypeScript)', () => {
  test('token ids match Model2Vec 0.6.0 exactly and vectors agree to 1e-3', () => {
    const m = embeddingModel();
    expect(m).toBeDefined();
    expect(m!.dim).toBe(256);
    // Reference: model2vec 0.6.0 StaticModel.encode / tokenize, one sentence at a time.
    expect(m!.tokenize('Add a greet helper that says hello by name')).toEqual([
      4590, 40, 16024, 29605, 1011, 1761, 6595, 1014, 1174,
    ]);
    expect(m!.tokenize('Café naïve résumé — über 東京 タワー')).toEqual([
      6671, 14746, 12749, 520, 18172, 882, 758, 712, 29265, 29268,
    ]);
    expect(
      m!.tokenize('snake_case_identifier and camelCaseIdentifier, HTTPServer2Go'),
    ).toEqual([
      6491, 38, 1556, 38, 29653, 1001, 33665, 4181, 15781, 7876, 1124, 13, 37314, 1478,
      2998,
    ]);
    const v = m!.embed('Add a greet helper that says hello by name');
    // model2vec 0.6.0: StaticModel.encode(["Add a greet helper …"])[0][:4].
    const ref = [0.24365, 0.07068, 0.08771, -0.12244];
    for (let i = 0; i < ref.length; i++)
      expect(Math.abs(v[i]! - ref[i]!)).toBeLessThan(1e-3);
  });

  test('vectors are unit length, deterministic, and related text is closer', () => {
    const m = embeddingModel()!;
    const a = m.embed('raise the retry limit for flaky network requests');
    const b = m.embed('export const RETRY_LIMIT = 5; // retries for flaky networks');
    const c = m.embed('render a comic panel with speech bubbles');
    expect(Math.abs(cosine(a, a) - 1)).toBeLessThan(1e-5);
    expect(m.embed('raise the retry limit for flaky network requests')).toEqual(a);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect([...m.embed('')].every((x) => x === 0)).toBe(true);
  });

  test('BERT pre-tokenization splits punctuation and folds accents', () => {
    expect(bertWords('Héllo, wörld!\tfoo_bar')).toEqual([
      'hello',
      ',',
      'world',
      '!',
      'foo',
      '_',
      'bar',
    ]);
  });
});

// ---- Diff parsing and chunking -------------------------------------------

describe('diff parsing and chunking', () => {
  test('files, statuses, counts and line numbers; header-like content stays content', () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => [f.path, f.status, f.role, f.binary])).toEqual([
      ['src/greet.ts', 'added', 'behavior', false],
      ['src/config.ts', 'modified', 'behavior', false],
      ['tests/greet.test.ts', 'added', 'tests', false],
      ['README.md', 'modified', 'docs', false],
      ['assets/logo.png', 'added', 'behavior', true],
    ]);
    const config = files[1]!;
    expect([config.added, config.removed]).toEqual([2, 2]);
    expect(
      config.hunks[0]!.lines.find(
        (l) => l.sign === '-' && l.text.startsWith('-- a removed'),
      ),
    ).toBeDefined();
    expect(config.hunks[0]!.lines.find((l) => l.sign === '+')!.newNo).toBe(2);
  });

  test('renames and deletions', () => {
    const files = parsePatch(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 90%',
        'rename from old.ts',
        'rename to new.ts',
        '@@ -1,1 +1,1 @@',
        '-const a = 1;',
        '+const a = 2;',
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-export function gone() {}',
        '-// bye',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.oldPath, f.status])).toEqual([
      ['new.ts', 'old.ts', 'renamed'],
      ['gone.ts', undefined, 'deleted'],
    ]);
    const [c] = chunkFile(files[1]!);
    expect(c!.removedDefs).toEqual(['gone']);
    expect([c!.start, c!.end]).toEqual([1, 2]);
  });

  test('a large hunk splits at top-level definitions; names and test titles are read', () => {
    const body: string[] = [];
    for (let i = 0; i < 6; i++)
      body.push(
        `export function step${i}(x: number): number {`,
        ...Array.from({ length: 12 }, (_, j) => `  const v${j} = x * ${j} + ${i};`),
        '  return x;',
        '}',
      );
    const [file] = parsePatch(hunkAdded('src/steps.ts', body));
    const chunks = chunkFile(file!);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.defined)).toEqual([
      'step0',
      'step1',
      'step2',
      'step3',
      'step4',
      'step5',
    ]);
    // Contiguous, non-overlapping new-file ranges.
    for (let i = 1; i < chunks.length; i++)
      expect(chunks[i]!.start).toBe(chunks[i - 1]!.end + 1);
    const [t] = chunkFile(parsePatch(hunkAdded('tests/a.test.ts', TEST_LINES))[0]!);
    expect(t!.tests).toEqual(['greet says hello by name']);
  });

  test('definitions in comments are not definitions; regexes stay linear on long lines', () => {
    expect(definedName('  // def test_example is how pytest names them')).toBeUndefined();
    expect(definedName('export const RETRY_LIMIT = 5;')).toBe('RETRY_LIMIT');
    expect(definedName('## Usage', true)).toBe('Usage');
    expect(testTitle('it.only("handles \\"quotes\\"", () => {')).toBe('handles "quotes"');
    expect(testTitle('def test_parse_ok(self):')).toBe('test_parse_ok');
    const nasty = `  /** test('${'…`x'.repeat(400)} */`;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) (testTitle(nasty), definedName(nasty));
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test('key lines pair a removed line with its replacement', () => {
    const [, config] = parsePatch(PATCH);
    const [c] = chunkFile(config!);
    const kl = keyLines(c!, 3);
    expect(kl[0]).toBe(
      '- export const RETRY_LIMIT = 3;  ⇒  + export const RETRY_LIMIT = 5;',
    );
  });
});

describe('commit sentences', () => {
  test('numbered as render numbers them; trailers dropped; list items split', () => {
    expect(
      commitSentences(
        'First line. Second sentence here.\n\n- a bullet item\n- another one\n\nSigned-off-by: A <a@b.c>',
      ),
    ).toEqual(['First line.', 'Second sentence here.', 'a bullet item', 'another one']);
  });
});

// ---- Store and retrieval -------------------------------------------------

describe('store and retrieval', () => {
  test('schema enforces foreign keys and the ETL fills every table', () => {
    const { db } = loadStore(fixture());
    try {
      const n = (t: string) => Number(db.selectValue(`SELECT count(*) FROM ${t}`));
      expect(n('session')).toBe(1);
      expect(n('fact')).toBe(5);
      expect(n('edit')).toBe(3);
      expect(n('file')).toBe(5);
      expect(n('commit_sentence')).toBe(4); // trailer dropped
      expect(n('commit_line')).toBeGreaterThan(0);
      expect(() =>
        db.exec("INSERT INTO chunk_line VALUES ('H999', 0, '+', 1, 'x', 'x')"),
      ).toThrow(/FOREIGN KEY/);
      expect(db.selectObjects('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('relational links: turn edits and commit lines meet chunk lines; approvals pass links on', () => {
    const loaded = loadStore(fixture());
    const { db } = loaded;
    try {
      relationalLinks(db);
      inheritApprovals(db);
      const links = rows(
        db,
        `SELECT l.src, f.path, l.kind FROM link l JOIN chunk c ON c.id = l.chunk_id
           JOIN file f ON f.id = c.file_id ORDER BY 1, 2, 3`,
      ).map((r) => `${r.src} ${r.path} ${r.kind}`);
      expect(links).toContain('S1 src/greet.ts edit');
      expect(links).toContain('S1 tests/greet.test.ts edit');
      // "yes" approved the plan: its turn's edit is credited to P1 too.
      expect(links).toContain('S2 src/config.ts edit');
      expect(links).toContain('P1 src/config.ts edit');
      expect(links).toContain(`commit:${SHA_A.slice(0, 12)} src/greet.ts commit`);
      expect(links).toContain(`commit:${SHA_B.slice(0, 12)} src/config.ts commit`);
      expect(links).not.toContain(`commit:${SHA_B.slice(0, 12)} src/greet.ts commit`);
    } finally {
      db.close();
    }
  });

  test('hybrid search fuses BM25, vectors and mentions with RRF, scoped to the commit', () => {
    const loaded = loadStore(fixture());
    const { db } = loaded;
    try {
      relationalLinks(db);
      const { stats } = hybridSearch(loaded, buildQueries(db));
      expect(stats.vectors).toBe(true);
      const rankers = rows(db, 'SELECT DISTINCT ranker FROM hit ORDER BY 1').map(
        (r) => r.ranker,
      );
      expect(rankers).toEqual(['bm25', 'mention', 'vec']);
      // The sentence naming greet() finds the chunk defining it, by all three rankers.
      const greet = rows(
        db,
        `SELECT f.rankers, c.defined FROM fused f JOIN chunk c ON c.id = f.chunk_id
          WHERE f.source = ? ORDER BY f.rrf DESC LIMIT 1`,
        [`commit:${SHA_A.slice(0, 12)}#1`],
      )[0]!;
      expect(JSON.parse(greet.defined)).toContain('greet');
      expect(Number(greet.rankers)).toBe(3);
      // A commit's sentences never retrieve chunks only another commit introduced.
      const leaked = rows(
        db,
        `SELECT 1 FROM hit h JOIN query q ON q.id = h.query_id
           JOIN chunk c ON c.id = h.chunk_id JOIN file f ON f.id = c.file_id
          WHERE q.source LIKE ? AND f.path = 'src/config.ts'`,
        [`commit:${SHA_A.slice(0, 12)}%`],
      );
      expect(leaked).toEqual([]);
      // The plan about the retry limit is linked to the config chunk by search.
      const plan = rows(
        db,
        `SELECT f.path FROM link l JOIN chunk c ON c.id = l.chunk_id JOIN file f ON f.id = c.file_id
          WHERE l.src = 'P1' AND l.kind = 'search'`,
      ).map((r) => r.path);
      expect(plan).toContain('src/config.ts');
    } finally {
      db.close();
    }
  });
});

// ---- Packing ---------------------------------------------------------------

describe('packing', () => {
  const item = (
    key: string,
    value: number,
    text: string,
    extra: Partial<Item> = {},
  ): Item => ({
    key,
    section: 'changes',
    order: [key],
    value,
    render: () => text,
    ...extra,
  });

  test('stays within budget, honours parents, must-haves and group decay', () => {
    const items: Item[] = [
      item('a', 10, 'a'.repeat(50), { must: true, section: 'start' }),
      item('f', 5, 'f'.repeat(40)),
      item('c1', 50, 'c'.repeat(40), { parent: 'f', group: 'g', decay: 0.1 }),
      item('c2', 50, 'd'.repeat(40), { parent: 'f', group: 'g', decay: 0.1 }),
      item('orphan', 100, 'o'.repeat(40), { parent: 'missing' }),
      item('weak', 0.5, 'w', { section: 'requests' }),
    ];
    const p = pack('HEADER', items, 400);
    expect(p.text.length).toBeLessThanOrEqual(400);
    expect(p.chosen.has('a')).toBe(true);
    expect(p.chosen.has('c1')).toBe(true);
    expect(p.chosen.has('orphan')).toBe(false); // its parent never exists
    expect(p.chosen.has('weak')).toBe(false); // under the value floor
    // A tight budget: the parent comes first, then the more valuable child.
    const tight = pack('HEADER', items, 7 + 52 + 30 + 41 + 41 + 34);
    expect(tight.text.length).toBeLessThanOrEqual(7 + 52 + 30 + 41 + 41 + 34);
    expect(tight.chosen.has('f')).toBe(true);
  });

  test('upgrades to a longer line compete for leftover budget', () => {
    const items = [
      item('x', 10, 'short', { expand: () => 'a much longer version of the line' }),
    ];
    expect(pack('H', items, 200).text).toContain('a much longer version');
    const tight = pack('H', items, 70).text;
    expect(tight).toContain('short');
    expect(tight).not.toContain('longer');
  });

  test('content never forges a ref tag', () => {
    expect(safe('see [H1] and [commit:abcdef123456#2] but not [link](x)')).toBe(
      'see (H1) and (commit:abcdef123456#2) but not [link](x)',
    );
  });
});

// ---- The whole builder -----------------------------------------------------

describe('buildRelationalContext', () => {
  test('the default budget is the fixed 2112 tokens', () => {
    expect(R_BUDGET_TOKENS).toBe(2112);
    const saved = process.env.TRACETOON_R_BUDGET;
    delete process.env.TRACETOON_R_BUDGET;
    expect(budgetTokens()).toBe(2112);
    if (saved !== undefined) process.env.TRACETOON_R_BUDGET = saved;
  });

  test('refs are exactly the ids in the text, each with its own text; the layout names each part', () => {
    const ctx = buildRelationalContext(fixture(), { budgetTokens: 2112 });
    const inText = [...new Set([...ctx.text.matchAll(ID)].map((m) => m[1]!))].sort();
    expect(ctx.refs.map((r) => r.id).sort()).toEqual(inText);
    for (const r of ctx.refs) expect(r.text.length).toBeGreaterThan(0);
    const ids = ctx.refs.map((r) => r.id);
    expect(ids).toContain('S1');
    expect(ids).toContain(`commit:${SHA_A.slice(0, 12)}`);
    expect(ids).toContain(`commit:${SHA_A.slice(0, 12)}#1`);
    expect(ids.some((id) => /^H\d+$/.test(id))).toBe(true);
    expect(ids.some((id) => /^F\d+$/.test(id))).toBe(true);
    // Runs are not restated (render writes Validation); "yes" is not shown as a request.
    expect(ids).not.toContain('R1');
    expect(ctx.text).not.toMatch(/^\[S2\]/m);
    // An unrelated aside typed after the last commit is left out (and its
    // "[H1]" could never become a tag).
    expect(ids).not.toContain('S3');
    expect(ctx.text).not.toContain('[H1] is not');
    expect(ctx.text).toContain('See (H1) for details');
    for (const title of [
      '## Why: requests',
      '## Why: commits',
      '## What changed, by file',
      '## Tests added or changed',
      '## Other changed files',
      '## Where a reviewer could start',
    ])
      expect(ctx.text).toContain(title);
    // The test file shows what its test checks; the result sentence is flagged.
    expect(ctx.text).toContain('"greet says hello by name"');
    expect(ctx.text).toContain('(a result the message reports, not a recorded run)');
    // Commit sentences point at the chunks their commit introduced.
    const line = ctx.text.split('\n').find((l) => l.includes(`#1] Adds`))!;
    expect(line).toMatch(/→ H\d+/);
    // A reviewer is pointed at a file.
    expect(ctx.text.split('## Where a reviewer could start\n')[1]).toMatch(
      /^\[F\d+\] src\//,
    );
  });

  test('fits every budget, uses most of it, and is deterministic', () => {
    for (const budget of [120, 300, 600, 2112]) {
      const ctx = buildRelationalContext(fixture(), { budgetTokens: budget });
      expect(ctx.text.length).toBeLessThanOrEqual(budget * 4);
      expect(ctx.tokens).toBe(Math.ceil(ctx.text.length / 4));
      expect(ctx.tokens).toBeLessThanOrEqual(budget);
      if (budget <= 300) expect(ctx.text.length).toBeGreaterThan(budget * 4 * 0.75);
      const again = buildRelationalContext(fixture(), { budgetTokens: budget });
      expect(again.text).toBe(ctx.text);
      expect(again.refs).toEqual(ctx.refs);
    }
  });

  test('with no sessions or commits (a working tree) it still describes the diff', () => {
    const inputs = fixture();
    inputs.full.sessions = [];
    inputs.full.pr.commits = [];
    inputs.trails = [];
    inputs.commitFiles = new Map();
    inputs.commitLines = new Map();
    const ctx = buildRelationalContext(inputs, { budgetTokens: 2112 });
    expect(ctx.text).toContain('src/greet.ts');
    expect(ctx.text).not.toContain('## Why: commits');
    const empty = buildRelationalContext(
      { ...inputs, patch: '' },
      { budgetTokens: 2112 },
    );
    expect(empty.refs).toEqual([]);
  });

  test('about 1,000 diff lines build well under two seconds', () => {
    const inputs = fixture();
    const parts: string[] = [inputs.patch];
    for (let f = 0; f < 25; f++) {
      const lines: string[] = [];
      for (let i = 0; i < 8; i++)
        lines.push(
          `export function handler${f}_${i}(req: Request): Response {`,
          `  const value = parse${i}(req.body ?? '') || fallback${f};`,
          `  if (!value) throw new Error('handler ${f}.${i} needs a body');`,
          `  return respond(value, { status: ${200 + i} });`,
          '}',
        );
      parts.push(hunkAdded(`src/handlers/h${f}.ts`, lines));
    }
    inputs.patch = parts.join('\n');
    const t0 = performance.now();
    const ctx = buildRelationalContext(inputs, { budgetTokens: 2112 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(ctx.text.length).toBeLessThanOrEqual(2112 * 4);
    expect(ctx.text).toContain('src/handlers/');
  });
});
