import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';
import { patchHunks } from '../src/graph/build.ts';
import {
  evidenceLines,
  numberConflict,
  orderConflict,
  stateConflict,
} from '../src/graph/codeEvidence.ts';
import { withGraph } from '../src/graph/engine.ts';
import { GRAPH_SCHEMA, type EvidenceGraph, type GraphNode } from '../src/graph/model.ts';
import { briefParts, type Section } from '../src/graph/queries.ts';
import {
  addSearchLinks,
  DEFAULT_GRAPH_SEARCH,
  paragraphs,
  parseGraphSearch,
  stemmedTokens,
} from '../src/graph/search.ts';
import { porterStem } from '../src/graph/porter.ts';
import { toToon } from '../src/graph/toon.ts';
import { parseSkillSettings } from '../src/contribution/skillSettings.ts';

setDefaultTimeout(60_000);

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

const PATCH = [
  'diff --git a/src/release.ts b/src/release.ts',
  '--- a/src/release.ts',
  '+++ b/src/release.ts',
  '@@ -1,2 +1,7 @@',
  ' import type { Release } from "./types";',
  '+// The API sorts by tag name (so rc.10 lands before rc.2): pick the newest',
  '+// published release by its date instead.',
  '+export function pickLatest(releases: Release[]): Release | undefined {',
  '+  const perPage = 30; // 30 releases per page',
  '+  return releases.filter((r) => !r.draft).sort(byDate)[0];',
  '+}',
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  '@@ -3,1 +3,2 @@',
  ' # Previews',
  '+Pass the preview link to the user exactly as printed, never as a relative path.',
  'diff --git a/scripts/pin.ts b/scripts/pin.ts',
  '--- a/scripts/pin.ts',
  '+++ b/scripts/pin.ts',
  '@@ -8,2 +8,3 @@',
  '   name: "first case",',
  "-  base: 'main',",
  '+  // Pinned to the merge commit, so the harness case stops drifting.',
  "+  base: 'c62818f^1',",
  'diff --git a/src/other.ts b/src/other.ts',
  '--- a/src/other.ts',
  '+++ b/src/other.ts',
  '@@ -1,1 +1,2 @@',
  ' export const a = 1;',
  '+export const otherLimit = 5;',
].join('\n');

const SENTENCES_A = [
  'The releases API sorts by tag name, so rc.10 came after rc.2.',
  'Agents are told to pass the link on exactly as printed.',
  'The eval harness pins its cases so they stop drifting.',
  'Found while testing.',
];

const N = (
  label: GraphNode['label'],
  id: string,
  props: GraphNode['props'],
): GraphNode => ({
  label,
  id,
  props,
});
const R = (type: any, from: [any, string], to: [any, string], props?: any) => ({
  type,
  from: { label: from[0], id: from[1] },
  to: { label: to[0], id: to[1] },
  ...(props ? { props } : {}),
});

/** Commit A makes the first three files, commit B the fourth; one change each. */
function graph(): EvidenceGraph {
  const hunks = patchHunks(PATCH);
  const role = (f: string) => (f.endsWith('.md') ? 'docs' : 'behavior');
  const nodes: GraphNode[] = [
    ...[...new Set(hunks.map((h) => h.file))].map((f) =>
      N('File', f, { role: role(f), inPr: true, added: 1, removed: 0, unmatched: 0 }),
    ),
    ...hunks.map((h) =>
      N('Hunk', h.id, {
        file: h.file,
        start: h.start,
        end: h.end,
        added: h.added,
        removed: h.removed,
        diff: h.diff,
        context: null,
        scope: null,
        symbols: h.symbols,
        touched: h.touched,
        branches: h.branches,
        fresh: h.fresh,
        pairs: h.pairs,
        dropped: h.dropped,
        conds: h.conds,
        tests: h.tests,
        words: h.words,
        code: h.code,
      }),
    ),
    N('Commit', A, { subject: 'fix: pick the newest release', body: null, t: null }),
    N('Commit', B, { subject: 'feat: another limit', body: null, t: null }),
    ...SENTENCES_A.map((text, i) =>
      N('CommitClaim', `${A}#${i + 1}`, { commit: A, text, assertsResult: false }),
    ),
    N('CommitClaim', `${B}#1`, {
      commit: B,
      text: '`pickLatest` gets a sibling.',
      assertsResult: false,
    }),
    N('Session', 'h:s', { band: 'included', agent: 'Claude Code', score: 1 }),
    N('Prompt', 'S1', {
      t: null,
      text: 'Please make pickLatest choose the newest release by date',
      pushback: false,
      session: 'h:s',
    }),
    N('Change', 'CH1', {
      key: `commit:${A}`,
      files: ['src/release.ts', 'docs/guide.md', 'scripts/pin.ts'],
      roles: ['behavior', 'docs'],
      symbols: ['pickLatest'],
      added: 6,
      removed: 1,
      branches: 0,
    }),
    N('Change', 'CH2', {
      key: `commit:${B}`,
      files: ['src/other.ts'],
      roles: ['behavior'],
      symbols: [],
      added: 1,
      removed: 0,
      branches: 0,
    }),
  ];
  const rels = [
    ...hunks.map((h) => R('OF', ['Hunk', h.id], ['File', h.file])),
    ...hunks
      .slice(0, 3)
      .flatMap((h) => [
        R('INTRODUCED', ['Commit', A], ['Hunk', h.id], { lines: 1 }),
        R('HAS', ['Change', 'CH1'], ['Hunk', h.id]),
      ]),
    R('INTRODUCED', ['Commit', B], ['Hunk', 'H4'], { lines: 1 }),
    R('HAS', ['Change', 'CH2'], ['Hunk', 'H4']),
    R('EXPLAINED_BY', ['Change', 'CH1'], ['Commit', A]),
    R('EXPLAINED_BY', ['Change', 'CH2'], ['Commit', B]),
    ...SENTENCES_A.map((_, i) =>
      R('SAYS', ['Commit', A], ['CommitClaim', `${A}#${i + 1}`]),
    ),
    R('SAYS', ['Commit', B], ['CommitClaim', `${B}#1`]),
    R('IN_SESSION', ['Prompt', 'S1'], ['Session', 'h:s']),
  ];
  return {
    schema: GRAPH_SCHEMA,
    nodes,
    rels,
    stats: {
      nodes: nodes.length,
      rels: rels.length,
      hunks: 4,
      linkedHunks: 0,
      edits: 0,
      deadEndEdits: 0,
    },
  };
}

const tied = (g: EvidenceGraph) =>
  g.rels
    .filter((r) => r.type === 'TIED_TO')
    .map((r) => `${r.from.id}->${r.to.id}`)
    .sort();

const prompts = [
  { id: 'S1', text: 'Please make pickLatest choose the newest release by date' },
];

describe('graph search settings', () => {
  test('Graph search values parse; anything else is refused', () => {
    expect(parseGraphSearch('fulltext')).toBe('fulltext');
    expect(parseGraphSearch('BM25')).toBe('fulltext'); // the SQLite-era name
    expect(parseGraphSearch('none')).toBe('none');
    expect(parseGraphSearch(undefined)).toBeUndefined();
    expect(() => parseGraphSearch('fuzzy')).toThrow(/Unknown graph search/);
    expect(() => parseGraphSearch('bm25+vector')).toThrow(/Unknown graph search/);
    expect(DEFAULT_GRAPH_SEARCH).toBe('fulltext');
  });
  test('the SKILL line is a variant line', () => {
    expect(parseSkillSettings('Graph search: fulltext.\n').graphSearch).toBe('fulltext');
  });
  test('indexed text and query words are Porter-stemmed alike', () => {
    expect(
      ['running', 'pinned', 'pins', 'releases', 'connection'].map(porterStem),
    ).toEqual(['run', 'pin', 'pin', 'releas', 'connect']);
    expect(porterStem('v2')).toBe('v2');
    expect(stemmedTokens('pickLatest sorts_by Tags')).toEqual([
      'picklatest',
      'sort',
      'by',
      'tag',
    ]);
  });
  test('long prose is searched paragraph by paragraph', () => {
    expect(
      paragraphs(
        '# Plan\n\nFirst we change the parser so quotes are kept intact.\n\nok\n\nThen the grouping key drops heredoc tokens entirely.',
      ),
    ).toEqual([
      'First we change the parser so quotes are kept intact.',
      'Then the grouping key drops heredoc tokens entirely.',
    ]);
  });
});

describe('key lines', () => {
  test('added comments first (joined), then literal values, then conditions', () => {
    const lines = evidenceLines(
      ['  const n = 10;'],
      [
        '  // Keep the newest first: the API sorts',
        '  // by tag name, not by date.',
        '  const n = 30;',
        '  if (!release.draft) keep(release);',
        '  doSomething();',
      ],
      'src/a.ts',
    );
    expect(lines[0]).toBe(
      '+ // Keep the newest first: the API sorts by tag name, not by date.',
    );
    expect(lines[1]).toContain('const n = 10;');
    expect(lines[1]).toContain('const n = 30;');
    expect(lines.indexOf('+ if (!release.draft) keep(release);')).toBeGreaterThan(1);
  });
  test('prose files quote their added lines', () => {
    expect(
      evidenceLines([], ['Pass the link on exactly as printed.', '', 'ok'], 'README.md'),
    ).toEqual(['+ Pass the link on exactly as printed.']);
  });
});

describe('commit vs code conflicts', () => {
  test('opposite ordering words about the same two anchors', () => {
    const s =
      'The API sorts by tag name, so v1.0.0-rc.10 came after rc.2 and installs broke.';
    expect(
      orderConflict(s, '# The API sorts by tag name (so rc.10 lands before rc.2)'),
    ).toBe(true);
    // Swapped anchors with the same word say the same thing the other way round.
    expect(orderConflict(s, '# so rc.2 sorts after rc.10')).toBe(true);
    // Agreement, other anchors, or no ordering word: no conflict.
    expect(orderConflict(s, '# rc.10 sorts after rc.2')).toBe(false);
    expect(orderConflict(s, '# rc.11 lands before rc.3')).toBe(false);
    expect(orderConflict(s, '# pick the newest by date')).toBe(false);
  });
  test('a state the code gives the opposite way', () => {
    expect(
      stateConflict(
        '`strictMode` is now enabled by default.',
        'strictMode: false,',
        true,
      ),
    ).toBe(true);
    expect(
      stateConflict('`strictMode` is now enabled by default.', 'strictMode: true,', true),
    ).toBe(false);
    expect(stateConflict('Retries are enabled.', 'retries: false', true)).toBe(false); // no code-shaped name
  });
  test('a number next to the same noun, never in the hunk', () => {
    expect(
      numberConflict(
        'Installers now fetch 50 releases.',
        'const perPage = 30; // 30 releases',
        ['30'],
      ),
    ).toBe(true);
    expect(
      numberConflict(
        'Installers now fetch 30 releases.',
        'const perPage = 30; // 30 releases',
        ['30'],
      ),
    ).toBe(false);
    // The old value, said as such, is no conflict.
    expect(
      numberConflict(
        'Was 50 releases, now fewer.',
        'const perPage = 30; // 30 releases',
        ['30'],
      ),
    ).toBe(false);
    // A version the hunk never mentions while it carries exactly one other.
    expect(
      numberConflict('Version 1.0.0-rc.9.', "export const V = '1.0.0-rc.8';", [
        '1.0.0-rc.8',
        '1.0.0-rc.7',
      ]),
    ).toBe(false);
    expect(
      numberConflict('Version 1.0.0-rc.9.', "export const V = '1.0.0-rc.8';", [
        '1.0.0-rc.8',
      ]),
    ).toBe(true);
  });
});

describe('search links', () => {
  test('mode none adds nothing: the graph is as without search', () => {
    const g = graph();
    expect(
      addSearchLinks({ graph: g, patch: PATCH, mode: 'none', prompts }),
    ).toBeUndefined();
    expect(g).toEqual(graph());
  });

  test('every other mode stores key lines on the hunks', () => {
    const g = graph();
    addSearchLinks({ graph: g, patch: PATCH, mode: 'fulltext', prompts });
    const h1 = g.nodes.find((n) => n.label === 'Hunk' && n.id === 'H1')!;
    expect(String((h1.props.keyLines as string[])[0])).toContain(
      'rc.10 lands before rc.2',
    );
    expect(h1.props.literals).toContain('30');
  });

  test('BM25 and mentions tie text to hunks, a commit only to its own', () => {
    const g = graph();
    const stats = addSearchLinks({ graph: g, patch: PATCH, mode: 'fulltext', prompts })!;
    expect(stats.links).toBeGreaterThan(0);
    const links = tied(g);
    expect(links).toContain(`${A}#1->H1`); // shares releases, API, sorts, tag, name
    expect(links).toContain(`${A}#2->H2`); // a docs hunk: link, exactly, printed
    expect(links).toContain(`${A}#3->H3`); // a scripts hunk: harness, case, drifting
    expect(links.filter((l) => l.startsWith(`${A}#4->`))).toEqual([]); // nothing to go on
    // B names pickLatest, but pickLatest is A's: B's sentence only sees B's hunks.
    expect(links.filter((l) => l.startsWith(`${B}#1->`) && l !== `${B}#1->H4`)).toEqual(
      [],
    );
    expect(links).toContain('S1->H1'); // the request names pickLatest
    const rel = g.rels.find((r) => r.type === 'TIED_TO' && r.from.id === 'S1')!;
    expect(rel.props!.rankers).toContain('mention');
  });

  test('the brief fills empty implementedBy (~), shows code lines and the conflict', () => {
    const g = graph();
    const before = withGraph(graph(), (e) => briefParts(e, { layout: 'toon' }));
    addSearchLinks({ graph: g, patch: PATCH, mode: 'fulltext', prompts });
    const after = withGraph(g, (e) => briefParts(e, { layout: 'toon' }));
    const rows = (s: Section[]) => s.find((x) => x.title === 'commitMessages')!.rows;
    const row = (s: Section[], ref: string) => rows(s).find((r) => r.ref === ref)!;
    // Structural placements stay; search only fills empty cells.
    for (const r of rows(before.sections))
      if ((r.implementedBy as string[]).length)
        expect(row(after.sections, String(r.ref)).implementedBy).toEqual(r.implementedBy);
    expect(row(before.sections, `${A}#2`).implementedBy).toEqual([]);
    expect(row(after.sections, `${A}#2`).implementedBy).toEqual(['docs/guide.md~']);
    expect(after.hunkLinks[`${A}#2`]).toEqual(['H2']);
    // Code lines, cited by diff ref.
    const code = String(row(after.sections, `${A}#1`).code);
    expect(code).toMatch(/^diff:\d+-\d+ added: \/\/ The API sorts by tag name/);
    // The comment contradicts the sentence's ordering: a doNotSay row says so.
    const dns = after.sections.find((s) => s.title === 'doNotSay')!.rows;
    const conflict = dns.find((r) => r.kind === 'commit vs code')!;
    expect(String(conflict.text)).toContain('came after rc.2');
    expect(String(conflict.text)).toContain('rc.10 lands before rc.2');
    expect(String(conflict.cites)).toStartWith(`${A}#1 diff:`);
    // No conflict for sentences the code agrees with.
    expect(dns.filter((r) => r.kind === 'commit vs code')).toHaveLength(1);
    // The extras stay within a small share of the brief.
    const grow = toToon(after.sections).length / toToon(before.sections).length;
    expect(grow).toBeLessThan(1.6); // tiny synthetic brief; real briefs grow ≤ ~15%
  });

  test('the neighborhood layout gets links but no code column', () => {
    const g = graph();
    addSearchLinks({ graph: g, patch: PATCH, mode: 'fulltext', prompts });
    const parts = withGraph(g, (e) => briefParts(e, { layout: 'neighborhood' }));
    const cm = parts.sections.find((s) => s.title === 'commitMessages')!;
    expect(cm.columns).not.toContain('code');
    expect(parts.hunkLinks[`${A}#2`]).toEqual(['H2']);
  });
});

// End to end: prepare --graph-search is stored and kept by refreshes.
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [process.env.TRACETOON_TEST_BINARY]
  : [process.execPath, CLI];

function scenario() {
  const claudeHome = tempDir('tracetoon-claude-');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: tempDir('tracetoon-codex-'),
    ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
    GEMINI_HOME: tempDir('tracetoon-gemini-'),
    TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
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
  const GUIDE =
    '# Guide\n\nPass the preview link to the user exactly as printed, never as a relative path.\n';
  const CODE =
    'export function previewUrl(path: string): string {\n  return `file://${path}`;\n}\n';
  new ClaudeLog(repo.root)
    .prompt('Print the preview as a link')
    .write(join(repo.root, 'src/preview.ts'), CODE)
    .save(claudeHome, 'search');
  mkdirSync(join(repo.root, 'src'), { recursive: true });
  mkdirSync(join(repo.root, 'docs'), { recursive: true });
  writeFileSync(join(repo.root, 'src/preview.ts'), CODE);
  writeFileSync(join(repo.root, 'docs/guide.md'), GUIDE);
  git(repo.root, ['add', '.']);
  git(repo.root, [
    'commit',
    '-q',
    '-m',
    'fix: print the preview as a link\n\nAgents are told to pass the link on exactly as printed.',
  ]);
  return { repo, cli };
}

const tiedIn = (runDir: string) =>
  tied(JSON.parse(readFileSync(join(runDir, 'evidence-graph.json'), 'utf8')));

describe('prepare --graph-search', () => {
  test('stored like the layout; none builds no search links; refreshes keep it', () => {
    const { repo, cli } = scenario();
    expect(
      cli(repo.root, '--json', 'prepare', '--offline', '--graph-search', 'fuzzy').code,
    ).toBe(1);
    const on = cli(repo.root, '--json', 'prepare', '--offline', '--graph-search', 'bm25');
    expect(on.code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(on.json.runDir, 'graph-search.json'), 'utf8')),
    ).toEqual({
      search: 'fulltext', // bm25 is an alias
    });
    expect(tiedIn(on.json.runDir).some((l) => /#1->H\d/.test(l))).toBe(true);
    const brief = cli(repo.root, 'query', 'brief', '--run', on.json.run).stdout;
    expect(brief).toContain('docs/guide.md~');
    const off = cli(
      repo.root,
      '--json',
      'prepare',
      '--offline',
      '--graph-search',
      'none',
    );
    expect(off.code).toBe(0);
    expect(tiedIn(off.json.runDir)).toEqual([]);
    const again = cli(repo.root, '--json', 'prepare', '--offline', '--run', off.json.run);
    expect(again.code).toBe(0);
    expect(tiedIn(again.json.runDir)).toEqual([]);
  });
});
