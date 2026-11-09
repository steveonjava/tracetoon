import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { leanPacket, WHOLE_DIFF_CHARS } from '../src/commands/review.ts';
import {
  buildPacketEvidence,
  LEGEND,
  refsByBodyLine,
  relationalPacket,
} from '../src/packet/evidence.ts';
import { chunkPatch, parsePatch } from '../src/relational/diff.ts';
import { sentenceCoverage } from '../src/relational/coverage.ts';
import type { RelationalContext, StoreLinks } from '../src/relational/index.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';

setDefaultTimeout(120_000);

const CLI = process.env.TRACETOON_TEST_CLI
  ? resolve(process.env.TRACETOON_TEST_CLI)
  : resolve(import.meta.dir, '../src/cli.ts');
const PROGRAM = process.env.TRACETOON_TEST_BINARY
  ? [resolve(process.env.TRACETOON_TEST_BINARY)]
  : [process.execPath, CLI];

let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env.TRACETOON_EVIDENCE_MODE;
  process.env.TRACETOON_EVIDENCE_MODE = 'relational';
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.TRACETOON_EVIDENCE_MODE;
  else process.env.TRACETOON_EVIDENCE_MODE = savedMode;
});

/** A patch file section with one hunk of the given new-file lines (all added). */
function section(file: string, start: number, added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start},0 +${start},${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join('\n');
}

const modified = [
  'diff --git a/src/limit.ts b/src/limit.ts',
  '--- a/src/limit.ts',
  '+++ b/src/limit.ts',
  '@@ -1,5 +1,6 @@ export function limit(n: number) {',
  ' export function limit(n: number) {',
  '-  return Math.min(n, 30);',
  '+  if (n < 0) return 0;',
  '+  return Math.min(n, 5);',
  ' }',
  ' ',
  ' export const unit = "minutes";',
].join('\n');
const branchy = section('src/greet.ts', 1, [
  'export function greet(name?: string) {',
  "  if (!name) return 'hello';",
  '  return `hello ${name}`;',
  '}',
]);
const testFile = section('tests/greet.test.ts', 1, [
  "import { greet } from '../src/greet.ts';",
  "test('greets by name', () => {",
  "  const name = 'Ada';",
  '  expect(greet(name)).toBe("hello Ada");',
  '});',
]);
const lock = section('bun.lock', 1, ['{ "lockfileVersion": 1 }']);

/** Links as the builder would store them, for a patch's own chunks. */
function linksOf(patch: string, extra: Partial<StoreLinks> = {}): StoreLinks {
  return {
    v: 1,
    chunks: chunkPatch(patch).chunks.map((c) => ({
      id: c.id,
      file: c.file,
      start: c.start,
      end: c.end,
      why: [],
      uses: [],
    })),
    commits: [],
    sentences: [],
    facts: [],
    ...extra,
  };
}

const SHA = 'abcdef123456';

function context(patch: string, extra: Partial<StoreLinks> = {}): RelationalContext {
  return {
    text: '',
    tokens: 0,
    refs: [
      { id: 'S1', text: 'Make greet say hello by name, and cap limits at 5.' },
      { id: 'H1', text: 'src/greet.ts' },
      { id: `commit:${SHA}`, text: 'feat: greet' },
      { id: `commit:${SHA}#1`, text: 'Greets people by name.' },
    ],
    links: linksOf(patch, extra),
  };
}

describe('relational review packet', () => {
  test('diff lines carry their changes.patch line numbers', () => {
    const patch = [branchy, modified].join('\n') + '\n';
    const lines = patch.split('\n');
    for (const f of parsePatch(patch))
      for (const h of f.hunks) {
        expect(lines[h.patchNo! - 1]!.startsWith('@@')).toBe(true);
        for (const l of h.lines)
          expect(lines[l.patchNo! - 1]).toBe(`${l.sign === ' ' ? ' ' : l.sign}${l.text}`);
      }
  });

  test('a small patch: whole diff, chunk table, commit ties, requests, refs per line', () => {
    const patch = [branchy, modified, testFile, lock].join('\n') + '\n';
    const { chunks } = chunkPatch(patch);
    const greet = chunks.find((c) => c.file === 'src/greet.ts')!;
    const limit = chunks.find((c) => c.file === 'src/limit.ts')!;
    const ctx = context(patch, {
      commits: [
        { id: `commit:${SHA}`, subject: 'feat: greet', chunks: chunks.map((c) => c.id) },
      ],
      sentences: [
        {
          id: `commit:${SHA}#1`,
          text: 'Greets people by name.',
          result: false,
          chunks: [greet.id],
        },
        { id: `commit:${SHA}#2`, text: 'All 12 tests pass.', result: true, chunks: [] },
      ],
      facts: [
        {
          id: 'S1',
          kind: 'prompt',
          labels: ['opening request'],
          text: 'Make greet say hello by name, and cap limits at 5.',
        },
      ],
    });
    const draft = [
      'Greets people by name, and always caps limits at 5. [H1, S1]',
      '',
      'Untagged claim about something else entirely here.',
      '',
      '<!-- tracetoon:validation -->',
    ].join('\n');
    const body = draft
      .replace(/\s?\[[^\]]+\]/g, '')
      .replace('<!-- tracetoon:validation -->', '## Validation\n\n- ok');
    const run = { id: 'r1', dir: tempDir() };
    writeFileSync(
      join(run.dir, 'brief-check.json'),
      JSON.stringify({
        untagged: ['Untagged claim about something else entirely here.'],
      }),
    );
    const input = { run, title: 'Greet and cap', body, draft, patch };
    const ev = relationalPacket(input, ctx);
    expect(relationalPacket(input, ctx)).toEqual(ev); // deterministic
    expect(ev.mode).toBe('whole');
    expect(ev.legend).toBe(LEGEND);
    const text = ev.lines.join('\n');
    // refs per body line
    expect(text).toContain('body:1 ← H1, S1');
    // requests verbatim, with labels
    expect(text).toContain(
      'S1 (opening request) [cited]: "Make greet say hello by name, and cap limits at 5."',
    );
    // commit sentences: tied code, result label, cited state
    expect(text).toContain(`commit:${SHA} "feat: greet"`);
    expect(text).toMatch(
      /#1 "Greets people by name\." → H1 greet\.ts \| covered by its code/,
    );
    expect(text).toContain(
      '#2 "All 12 tests pass." (reports a result: not a recorded run) → nothing tied',
    );
    // chunk table: new names, branches, owning symbol, diff ranges
    const lines = patch.split('\n');
    const greetLines = greet.lines.map((l) => l.patchNo!);
    expect(text).toContain(
      `${greet.id} L1-4 diff:${Math.min(...greetLines)}-${Math.max(...greetLines)} +4/−0 | new: greet | branches 1 | cited | shown`,
    );
    expect(text).toMatch(
      new RegExp(`${limit.id} L2-3 diff:\\d+-\\d+ \\+2/−1 \\| in limit \\| branches 1`),
    );
    expect(text).toContain('tests: "greets by name"');
    expect(text).toMatch(
      /F\d bun\.lock \(new, generated|bun\.lock \([^)]*\): diff not shown/,
    );
    // coverage leads
    expect(text).toContain('untagged sentences (render): body:3');
    expect(text).toMatch(
      /files the body neither names nor cites: .*tests\/greet\.test\.ts/,
    );
    // diff numbered by changes.patch lines; tests reduced to titles and assertions
    const w = String(lines.length).length;
    const ifLine = lines.findIndex((l) => l.includes('if (!name)')) + 1;
    expect(text).toContain(`${String(ifLine).padStart(w)} +  if (!name) return 'hello';`);
    const ctxLine = lines.findIndex((l) => l === ' export const unit = "minutes";') + 1;
    expect(text).toContain(
      `${String(ctxLine).padStart(w)}  export const unit = "minutes";`,
    );
    expect(text).toContain('expect(greet(name)).toBe("hello Ada");');
    expect(text).not.toContain("const name = 'Ada'");
    expect(text).not.toContain('lockfileVersion');
    // the shared packet wraps it without the graph's sections
    const packet = leanPacket({
      runId: 'r1',
      title: input.title,
      body,
      draft,
      patch,
      fingerprint: 'f',
      evidence: ev,
    });
    expect(packet.text).toContain(LEGEND);
    expect(packet.text).not.toContain('Hunks and owning symbols');
    expect(packet.text).not.toContain('## Brief rows');
  });

  test('a large patch keeps cited chunks, assertions and branching code within the budget', () => {
    const filler = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `export const value${i} = ${i}; // padding text`,
      );
    const quiet = section('src/quiet.ts', 1, filler(400));
    const named = section('src/named.ts', 1, ['export const named = 1;']);
    const patch = [quiet, branchy, named, testFile].join('\n') + '\n';
    expect(patch.length).toBeGreaterThan(WHOLE_DIFF_CHARS);
    const ev = relationalPacket(
      {
        run: { id: 'r2', dir: tempDir() },
        title: 'Greet',
        body: 'Adds named.ts and a greeting.',
        patch,
      },
      context(patch),
    );
    expect(ev.mode).toBe('selected');
    expect(ev.diffChars).toBeLessThanOrEqual(WHOLE_DIFF_CHARS);
    const text = ev.lines.join('\n');
    expect(text).toContain("if (!name) return 'hello';");
    expect(text).toContain('export const named = 1;');
    expect(text).toContain('expect(greet(name)).toBe("hello Ada");');
    const { chunks } = chunkPatch(patch);
    const ids = (f: string) => chunks.filter((c) => c.file === f).map((c) => c.id);
    for (const id of [
      ...ids('src/greet.ts'),
      ...ids('src/named.ts'),
      ...ids('tests/greet.test.ts'),
    ])
      expect(ev.shownHunks).toContain(id);
    // quiet.ts chunks add names, so some fit; the rest are still listed with diff ranges
    expect(text).toMatch(/H\d+ L\d+-\d+ diff:\d+-\d+/);
  });

  test('stale links (a different patch) are ignored, not misattributed', () => {
    const patch = [branchy, modified].join('\n') + '\n';
    const ctx = context(section('src/other.ts', 1, ['x']), {
      sentences: [{ id: `commit:${SHA}#1`, text: 'x', result: false, chunks: ['H1'] }],
    });
    const ev = relationalPacket(
      { run: { id: 'r3', dir: tempDir() }, title: 't', body: 'b', patch },
      ctx,
    );
    const text = ev.lines.join('\n');
    expect(text).toContain("the store's links were not available");
    expect(text).toContain(`commit:${SHA}#1 "Greets people by name."`);
  });

  test('graph mode, or no relational context: no evidence (the graph packet applies)', () => {
    const run = { id: 'r4', dir: tempDir() };
    const input = { run, title: 't', body: 'b', patch: branchy + '\n' };
    expect(buildPacketEvidence(input)).toBeUndefined();
    writeFileSync(
      join(run.dir, 'relational-context.json'),
      JSON.stringify(context(branchy + '\n')),
    );
    expect(buildPacketEvidence(input)?.mode).toBe('whole');
    process.env.TRACETOON_EVIDENCE_MODE = 'graph';
    expect(buildPacketEvidence(input)).toBeUndefined();
  });

  test('refs per body line follow body.md to the rendered body', () => {
    const draft = [
      '# Title',
      '',
      '- Adds `greet`. [H1, S1]',
      'Plain.',
      'Caps at 5. [H2]',
    ].join('\n');
    const body = ['# Title', '', '- Adds `greet`.', 'Plain.', 'Caps at 5.'].join('\n');
    expect([...refsByBodyLine(body, draft)]).toEqual([
      [3, ['H1', 'S1']],
      [5, ['H2']],
    ]);
  });

  test('sentence coverage: search ties, small-commit fallback, render row refs', () => {
    const links: StoreLinks = {
      v: 1,
      chunks: [],
      commits: [
        { id: `commit:${SHA}`, subject: 's', chunks: ['H1', 'H2'] },
        { id: 'commit:999999999999', subject: 'big', chunks: ['H3', 'H4', 'H5', 'H6'] },
      ],
      sentences: [
        { id: `commit:${SHA}#1`, text: 'a', result: false, chunks: ['H2'] },
        { id: `commit:${SHA}#2`, text: 'b', result: false, chunks: [] },
        { id: 'commit:999999999999#1', text: 'c', result: false, chunks: [] },
      ],
      facts: [],
    };
    expect(sentenceCoverage(links, [`commit:${SHA.slice(0, 7)}#1`])).toEqual([
      { ref: `commit:${SHA.slice(0, 7)}#1`, coveredBy: ['H2'] },
      { ref: `commit:${SHA}#2`, coveredBy: ['H1', 'H2'] },
    ]);
  });
});

describe('relational review packet, end to end', () => {
  test('prepare stores links; render counts a sentence covered by its chunk; the packet uses the relational evidence', () => {
    const claudeHome = tempDir('tracetoon-claude-');
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(tempDir('tracetoon-env-'), 'config.json'),
      TRACETOON_EVIDENCE_MODE: 'relational',
    };
    const cli = (cwd: string, ...args: string[]) => {
      const r = spawnSync(PROGRAM[0]!, [...PROGRAM.slice(1), ...args], {
        cwd,
        env,
        encoding: 'utf8',
      });
      let json: any;
      try {
        json = JSON.parse(r.stdout);
      } catch {}
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    };
    const GREET =
      'export function greetByName(name?: string): string {\n  if (!name) return "Hello!";\n  return `Hello, ${name}!`;\n}\n';
    const repo = makeRepo();
    new ClaudeLog(repo.root)
      .prompt('Add a greet helper that says hello by name')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(claudeHome, 'shape');
    mkdirSync(join(repo.root, 'src'), { recursive: true });
    writeFileSync(join(repo.root, 'src/greet.ts'), GREET);
    git(repo.root, ['add', '.']);
    git(repo.root, [
      'commit',
      '-q',
      '-m',
      'feat: greet',
      '-m',
      'Adds `greetByName`, which greets people by their name.',
    ]);
    const prepared = cli(repo.root, '--json', 'prepare', '--offline');
    expect(prepared.code).toBe(0);
    const { run, runDir } = prepared.json;
    const ctx: RelationalContext = JSON.parse(
      readFileSync(join(runDir, 'relational-context.json'), 'utf8'),
    );
    const links = ctx.links!;
    expect(links.chunks.map((c) => c.id)).toEqual(['H1']);
    const sentence = links.sentences[0]!;
    expect(sentence.id).toMatch(/^commit:[0-9a-f]{12}#1$/);
    expect(sentence.chunks).toEqual(['H1']);
    // The context text the writer reads names no link data.
    expect(ctx.text).not.toContain('"chunks"');

    writeFileSync(join(runDir, 'title.txt'), 'Add a greet helper');
    const write = (tags: string) =>
      writeFileSync(
        join(runDir, 'body.md'),
        [
          `Adds a helper that greets people by name. [${tags}]`,
          '',
          '<!-- tracetoon:validation -->',
          '',
        ].join('\n'),
      );
    // Citing the chunk the sentence describes covers the sentence…
    write('S1, H1');
    let r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    expect(r.json.briefCheck.uncovered.join(' ')).not.toContain(
      'greets people by their name',
    );
    // …citing only the request does not.
    write('S1');
    r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    expect(r.code).toBe(0);
    expect(r.json.briefCheck.uncovered.join(' ')).toContain(
      'greets people by their name',
    );

    write('S1, H1');
    r = cli(repo.root, '--json', 'render', '--run', run, '--no-comic', '--lean');
    const p = cli(repo.root, '--json', 'review-packet', '--lean', '--run', run);
    expect(p.code).toBe(0);
    const text = readFileSync(p.json.path, 'utf8');
    expect(text).toContain(LEGEND);
    expect(text).toContain('## Commit messages');
    expect(text).toMatch(
      /#1 "Adds `greetByName`, which greets people by their name\." → H1 greet\.ts \| covered by its code/,
    );
    expect(text).toMatch(/body:\d+ ← S1, H1/);
    expect(text).toMatch(
      /H1 L1-4 diff:\d+-\d+ \+4\/−0 \| new: greetByName \| branches 1 \| asked in S1 \| cited \| shown/,
    );
    expect(text).not.toContain('Hunks and owning symbols');
    const patch = readFileSync(join(runDir, 'changes.patch'), 'utf8').split(/\r?\n/);
    const n = patch.findIndex((l) => l.includes('if (!name)')) + 1;
    expect(text).toContain(
      `${String(n).padStart(String(patch.length).length)} +  if (!name) return "Hello!";`,
    );
  });
});
