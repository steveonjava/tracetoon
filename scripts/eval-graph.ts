// Measures what the evidence graph changes, offline and deterministically.
//
//   bun scripts/eval-graph.ts [--repo DIR] [--base REF] [--head REF] [--json]
//   bun scripts/eval-graph.ts --synthetic [--json]
//
// For one PR (the current branch, a past PR via --base/--head, or a generated
// large case) it builds the full digest once, then compares:
//   - budgeting: compact digests at several budgets with the fixed trimming
//     rules and with graph relevance: tokens, how much text of the facts that
//     explain the PR survives, and whether each command's final run is kept;
//   - provenance lookups: tokens an agent reads to learn which requests and
//     checks are behind each behavior file (digest + whole patch, versus
//     `query outline` plus `query why <file>`);
//   - cost: graph build, load and query times.
// Reads this machine's agent logs for real PRs; prints a report, commits nothing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { submission } from '../src/contribution/guidance.ts';
import { buildDigestPair, compactDigest, type TraceDigest } from '../src/digest/build.ts';
import { withGraph } from '../src/graph/engine.ts';
import { graphEnricher, type GraphOutcome } from '../src/graph/evidence.ts';
import { findQuery } from '../src/graph/queries.ts';
import { toToon } from '../src/graph/toon.ts';
import { scan } from '../src/pipeline.ts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const tok = (s: string | unknown) =>
  Math.ceil((typeof s === 'string' ? s : JSON.stringify(s)).length / 4);
const BUDGETS = [3000, 6000, 12000];

function synthetic(): { repo: string; claudeHome: string } {
  const base = join(tmpdir(), `tracetoon-eval-graph-${process.pid}`);
  const repo = join(base, 'repo');
  const claudeHome = join(base, 'claude');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const g = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'eval@example.com');
  g('config', 'user.name', 'Eval');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# eval\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  // A long session: 12 requests that shape 10 files, 28 discussions that don't,
  // plans and decisions, 60 test/build runs, dead-end edits.
  const lines: unknown[] = [];
  let n = 0;
  // Inside the matching window: the hours before the commit made below.
  const t0 = Date.now() - 3 * 60 * 60_000;
  const ts = () => new Date(t0 + n++ * 7000).toISOString();
  const basePart = () => ({
    cwd: repo,
    gitBranch: 'feature',
    sessionId: 'eval',
    timestamp: ts(),
    uuid: `u${n}`,
  });
  const user = (text: string) =>
    lines.push({ type: 'user', ...basePart(), message: { role: 'user', content: text } });
  const tool = (
    name: string,
    input: unknown,
    result: { content: string; isError?: boolean; toolUseResult?: unknown },
  ) => {
    const id = `t${n}`;
    lines.push({
      type: 'assistant',
      ...basePart(),
      message: {
        id: `m${n}`,
        model: 'claude-eval',
        content: [{ type: 'tool_use', id, name, input }],
      },
    });
    lines.push({
      type: 'user',
      ...basePart(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: result.content,
            is_error: result.isError,
          },
        ],
      },
      toolUseResult: result.toolUseResult,
    });
  };
  const write = (file: string, content: string) =>
    tool(
      'Write',
      { file_path: join(repo, file), content },
      {
        content: 'ok',
        toolUseResult: {
          type: 'create',
          filePath: join(repo, file),
          content,
          structuredPatch: [],
        },
      },
    );
  const bash = (command: string, out: string, isError = false) =>
    tool(
      'Bash',
      { command },
      { content: out, isError, toolUseResult: { stdout: out, stderr: '' } },
    );
  const plan = (md: string) =>
    tool('ExitPlanMode', { plan: md }, { content: 'User has approved your plan.' });
  const ask = (q: string, options: string[], answer: string) =>
    tool(
      'AskUserQuestion',
      {
        questions: [
          {
            question: q,
            header: 'h',
            options: options.map((label) => ({ label, description: label })),
            multiSelect: false,
          },
        ],
      },
      {
        content: `User has answered your questions: "${q}"="${answer}"`,
        toolUseResult: {
          questions: [{ question: q, options: options.map((label) => ({ label })) }],
          answers: { [q]: answer },
        },
      },
    );
  // Letter suffixes: the redactor withholds digit-bearing names like module0.test.ts.
  const files = Array.from({ length: 10 }, (_, i) =>
    i < 6
      ? `src/module${'ABCDEF'[i]}.ts`
      : i < 9
        ? `tests/module${'ABC'[i - 6]}.test.ts`
        : 'docs/guide.md',
  );
  const body = (f: string, v: number) =>
    Array.from(
      { length: 60 },
      (_, l) =>
        `export const ${f.replace(/\W/g, '_')}_value_${l} = ${l * 7 + v}; // behavior line ${l} of ${f}`,
    ).join('\n') + '\n';
  const filler = (k: number) =>
    `Let us talk through option ${k}: ` +
    'we weigh tradeoffs, edge cases and naming conventions in prose. '.repeat(9);
  let fileIdx = 0;
  for (let p = 0; p < 40; p++) {
    const shaping = p % 10 < 3; // 12 of 40 prompts lead to edits
    user(
      shaping
        ? `Request ${p}: implement part ${fileIdx} carefully. ` +
            'Details of the behavior we need and why it matters. '.repeat(6)
        : filler(p),
    );
    if (p % 7 === 0)
      plan(
        `# Plan ${p}\n` +
          'Step: do a well-defined thing to the code and test it. '.repeat(40),
      );
    if (p % 5 === 0) ask(`Which approach for ${p}?`, ['A', 'B', 'C'], p % 2 ? 'B' : 'A');
    if (shaping && fileIdx < files.length) {
      write(
        `src/scratch${p}.ts`,
        `export const scratchAttempt${p} = 'abandoned idea number ${p}';\n`,
      );
      write(files[fileIdx]!, body(files[fileIdx]!, 0));
      fileIdx++;
    }
    bash('bun test', `${10 + p} pass\n${p % 4 === 1 ? 1 : 0} fail`, p % 4 === 1);
    if (p % 3 === 0) bash('bun run typecheck', 'ok');
  }
  const dir = join(claudeHome, 'projects', 'eval');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'eval.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  for (const f of files) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), body(f, 0));
  }
  writeFileSync(join(repo, 'src/handwritten.ts'), 'export const tunedByHand = 3;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'feat: ten modules');
  return { repo, claudeHome };
}

function factTexts(d: TraceDigest): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of d.sessions) {
    for (const p of s.prompts) if (p.id) m.set(p.id, p.text.length);
    for (const x of s.decisions) if (x.id) m.set(x.id, x.text.length);
    for (const x of s.plans) if (x.id) m.set(x.id, x.excerpt.length);
    for (const r of s.runs) if (r.id) m.set(r.id, r.cmd.length + 1);
  }
  return m;
}

function main() {
  let repo = resolve(flag('--repo') ?? process.cwd());
  if (args.includes('--synthetic')) {
    const s = synthetic();
    repo = s.repo;
    process.env.CLAUDE_CONFIG_DIR = s.claudeHome;
    process.env.CODEX_HOME = join(s.claudeHome, 'none');
    process.env.ANTIGRAVITY_HOME = join(s.claudeHome, 'none');
    process.env.GEMINI_HOME = join(s.claudeHome, 'none');
  }
  const t0 = performance.now();
  const scanned = scan(repo, { base: flag('--base'), head: flag('--head'), noGh: true });
  const scanMs = performance.now() - t0;
  const outcome: GraphOutcome = {};
  const t1 = performance.now();
  const pair = buildDigestPair(scanned.truth, scanned.matches, {
    enrich: graphEnricher(scanned.truth, outcome),
  });
  const digestMs = performance.now() - t1;
  if (!outcome.graph || !outcome.derived) throw new Error(`No graph: ${outcome.error}`);
  const full = pair.full;
  const relevance = outcome.derived.relevance;
  const sizes = factTexts(full);
  const important = [...sizes.keys()].filter(
    (id) => !id.startsWith('R') && (relevance[id] ?? 0) >= 2,
  );
  const finalRuns = new Map<string, string>();
  for (const s of full.sessions.filter((x) => x.band === 'included'))
    for (const r of [...s.runs].sort((a, b) => (a.t ?? '').localeCompare(b.t ?? '')))
      if (r.id && r.revision !== 'after later work') finalRuns.set(r.cmd, r.id);
  const retention = (d: TraceDigest) => {
    const kept = factTexts(d);
    const r = important.map((id) =>
      Math.min(1, (kept.get(id) ?? 0) / Math.max(1, sizes.get(id)!)),
    );
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 1;
  };
  const finalKept = (d: TraceDigest) => {
    const kept = factTexts(d);
    const f = [...finalRuns.values()];
    return f.length ? f.filter((id) => kept.has(id)).length / f.length : 1;
  };
  const budgets = BUDGETS.map((b) => {
    const fixed = compactDigest(full, b);
    const graph = compactDigest(full, b, relevance);
    return {
      budget: b,
      fixed: {
        tokens: tok(fixed),
        importantTextRetained: +retention(fixed).toFixed(3),
        finalRunsKept: +finalKept(fixed).toFixed(3),
        steps: fixed.truncated.length,
      },
      graph: {
        tokens: tok(graph),
        importantTextRetained: +retention(graph).toFixed(3),
        finalRunsKept: +finalKept(graph).toFixed(3),
        steps: graph.truncated.length,
      },
    };
  });

  const patch = submission(scanned.truth).patch;
  const behavior = full.files
    .filter((f) => (f.role ?? 'behavior') === 'behavior')
    .map((f) => f.path);
  const q = (name: string, a: string[] = []) =>
    withGraph(outcome.graph!, (g) => toToon(findQuery(name)!.run(g, a), { rowCap: 60 }));
  const t2 = performance.now();
  const outline = q('outline');
  const whys = behavior.map((f) => q('why', [f]));
  const queryMs = (performance.now() - t2) / (1 + whys.length);
  const compact = pair.digest;
  const lookups = {
    behaviorFiles: behavior.length,
    // Without the graph, linking requests and checks to files means reading the
    // digest's facts and the whole patch, then matching them by hand.
    withoutGraphTokens: tok(compact) + tok(patch),
    withGraphTokens: tok(compact) + tok(outline) + whys.reduce((n, w) => n + tok(w), 0),
    perFileWhyTokens: whys.length
      ? Math.round(whys.reduce((n, w) => n + tok(w), 0) / whys.length)
      : 0,
    patchTokens: tok(patch),
  };
  const report = {
    repo,
    head: scanned.truth.head,
    sessions: full.sessions.length,
    facts: sizes.size,
    importantFacts: important.length,
    graph: outcome.graph.stats,
    review: {
      unverified: outcome.derived.review.unverified.length,
      unexplained: outcome.derived.review.unexplained.length,
    },
    timingsMs: {
      scan: Math.round(scanMs),
      digestWithGraph: Math.round(digestMs),
      perQuery: +queryMs.toFixed(1),
    },
    budgets,
    lookups,
  };
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `${repo} (${report.head}): ${report.sessions} session(s), ${report.facts} facts, ${report.importantFacts} that explain the PR`,
    );
    console.log(
      `graph: ${JSON.stringify(report.graph)}; leads: ${JSON.stringify(report.review)}`,
    );
    console.log(
      `time: scan ${report.timingsMs.scan} ms, digest+graph ${report.timingsMs.digestWithGraph} ms, ${report.timingsMs.perQuery} ms/query`,
    );
    console.log(
      'budget  | fixed: tokens retained finalRuns | graph: tokens retained finalRuns',
    );
    for (const b of budgets)
      console.log(
        `${String(b.budget).padEnd(7)} | ${b.fixed.tokens} ${b.fixed.importantTextRetained} ${b.fixed.finalRunsKept} | ${b.graph.tokens} ${b.graph.importantTextRetained} ${b.graph.finalRunsKept}`,
      );
    console.log(
      `provenance for ${lookups.behaviorFiles} behavior files: ${lookups.withoutGraphTokens} tokens without the graph, ${lookups.withGraphTokens} with it (${lookups.perFileWhyTokens}/file)`,
    );
  }
}

main();
