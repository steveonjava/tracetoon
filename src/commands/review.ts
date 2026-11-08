/**
 * The lean reviewer: one packet in (review-packet.md), findings out
 * (review-findings.json), imported into review.json v2 by Tracetoon.
 *
 * The packet holds only what drove useful findings in measured reviews: the
 * line-numbered title and body, the brief rows a claim can be checked against,
 * which symbol owns each hunk, and the diff (whole when small; otherwise the
 * hunks the body cites, every branching hunk and the test assertion lines).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileRole } from '../digest/build.ts';
import type { TraceDigest } from '../digest/build.ts';
import { patchHunks, type PatchHunk } from '../graph/build.ts';
import { graphBriefParts, loadGraph } from '../graph/evidence.ts';
import type { EvidenceGraph } from '../graph/model.ts';
import type { Section } from '../graph/queries.ts';
import { evidenceExists } from '../contribution/review.ts';
import { parseBodyReview } from '../contribution/bodyReview.ts';
import {
  FINDINGS_FILE,
  leanToReview,
  parseFindings,
  placeholderAgentId,
  type ImportContext,
} from '../contribution/leanReview.ts';
import type { CodeSources } from './source.ts';
import { loadGuidance } from '../contribution/guidance.ts';
import type {
  GuidanceRequest,
  GuidanceResult,
  ReviewInput,
} from '../contribution/types.ts';
import {
  assertRunOwner,
  findRun,
  readJson,
  readText,
  writeJson,
  type Run,
} from '../run.ts';
import { repository } from '../workflow/state.ts';
import { emit, UserError, type OutOpts } from './output.ts';

export const PACKET_FILE = 'review-packet.md';
/** Whole-diff budget: a reduced patch at or under this many characters is shown entire. */
export const WHOLE_DIFF_CHARS = 16_000;

const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock)$/;
/** Added test lines worth keeping: assertions and test titles. */
const ASSERTION =
  /expect|assert|toBe|toEqual|\btest\s*\(|\bit\s*\(|\bdescribe\s*\(|\bdef test_|\bfunc Test/;

export interface PacketInput {
  runId: string;
  title: string;
  /** The rendered body (review-input.json), whose lines body:N refs cite. */
  body: string;
  /** body.md as drafted, whose ref tags ([CH1, ...]) say which hunks the body cites. */
  draft?: string;
  patch: string;
  fingerprint: string;
  graph?: EvidenceGraph;
  brief?: Section[];
}

export interface Packet {
  text: string;
  mode: 'whole' | 'selected';
  /** Reduced patch size the mode was chosen by. */
  diffChars: number;
  shownHunks: string[];
}

type Role = ReturnType<typeof fileRole>;
const roleOf = (graph: EvidenceGraph | undefined) => {
  const roles = new Map<string, string>();
  for (const n of graph?.nodes ?? [])
    if (n.label === 'File' && typeof n.props.role === 'string')
      roles.set(n.id, n.props.role);
  return (file: string): Role => (roles.get(file) as Role) ?? fileRole(file);
};
const skipped = (file: string, role: Role) =>
  role === 'generated' || role === 'version' || LOCKFILE.test(file);

/** Which Change (CH#) each hunk belongs to, by its diff range. */
function hunkChanges(graph: EvidenceGraph | undefined): Map<string, string[]> {
  const diffOf = new Map<string, string>();
  for (const n of graph?.nodes ?? [])
    if (n.label === 'Hunk' && typeof n.props.diff === 'string')
      diffOf.set(n.id, n.props.diff);
  const out = new Map<string, string[]>();
  for (const r of graph?.rels ?? [])
    if (r.type === 'HAS' && r.from.label === 'Change' && r.to.label === 'Hunk') {
      const d = diffOf.get(r.to.id);
      if (d) out.set(d, [...(out.get(d) ?? []), r.from.id].sort(byNum));
    }
  return out;
}
const byNum = (a: string, b: string) =>
  Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
const lineRange = (diff: string): [number, number] => {
  const m = /^diff:(\d+)(?:-(\d+))?$/.exec(diff)!;
  return [Number(m[1]), Number(m[2] ?? m[1])];
};

const show = (v: unknown): string =>
  Array.isArray(v)
    ? v.map(show).join('; ')
    : v === null || v === undefined
      ? ''
      : String(v);
const oneLine = (v: unknown, max = 400) => {
  const s = show(v).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Brief rows a reviewer checks claims against, one line each. */
function briefLines(brief: Section[] | undefined): string[] {
  if (!brief) return ['(No evidence graph for this run: check claims against the diff.)'];
  const rows = (t: string) => brief.find((s) => s.title === t)?.rows ?? [];
  const out: string[] = [];
  const changes = rows('changes');
  if (changes.length) {
    out.push('changes (where = file (owning symbols); new = symbols not in the base):');
    for (const r of changes)
      out.push(
        `- ${show(r.change)} where: ${oneLine(r.where)}${(r.newSymbols as string[])?.length ? ` | new: ${oneLine(r.newSymbols)}` : ''}${(r.was as string[])?.length ? ` | was: ${oneLine(r.was)}` : ''}${(r.diff as string[])?.length ? ` | ${oneLine(r.diff)}` : ''}`,
      );
  }
  const commits = rows('commitMessages');
  if (commits.length) {
    out.push(
      'commitMessages (facts only a message states; implementedBy = where the patch does it):',
    );
    for (const r of commits)
      out.push(
        `- ${show(r.ref)}: "${oneLine(r.text, 300)}"${(r.implementedBy as string[])?.length ? ` | implementedBy: ${oneLine(r.implementedBy)}` : ' | implementedBy: (none found)'}`,
      );
  }
  const open = rows('limits').filter((r) => r.kind === 'open');
  if (open.length) {
    out.push('open limits (what the evidence does not establish):');
    for (const r of open)
      out.push(
        `- ${show(r.ref)}${r.change ? ` [${show(r.change)}]` : ''}: ${oneLine(r.limit)}`,
      );
  }
  const tests = rows('tests');
  if (tests.length) {
    out.push('tests (added test titles):');
    for (const r of tests)
      out.push(`- ${show(r.ref)} ${show(r.file)}: ${oneLine(r.titles, 600)}`);
  }
  const requests = rows('requests');
  if (requests.length) {
    out.push('requests (verbatim; a "user asked" claim must match one):');
    for (const r of requests)
      out.push(`- ${show(r.ref)} (${oneLine(r.kind, 120)}): "${oneLine(r.text, 600)}"`);
  }
  return out.length ? out : ['(The brief has no rows for this run.)'];
}

/** The body with line numbers; the generated Validation section, markers and comic are elided. */
function numberedBody(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const w = String(lines.length).length;
  const out: string[] = [];
  let skip: string | undefined;
  let from = 0;
  const flush = (to: number) => {
    if (skip) out.push(`${''.padStart(w)}   (lines ${from}-${to}: ${skip}, skipped)`);
    skip = undefined;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (skip === 'generated Validation section' && /^#{1,3}\s/.test(line)) flush(n - 1);
    if (skip === 'comic' && /<\/details>/.test(lines[i - 1] ?? '')) flush(n - 1);
    if (!skip && /^#{1,3}\s+Validation\b/.test(line)) {
      skip = 'generated Validation section';
      from = n;
    } else if (!skip && /^<p align="center"><img /.test(line)) {
      skip = 'comic';
      from = n;
    }
    if (skip) return;
    if (/^<!-- tracetoon:/.test(line)) return;
    out.push(`${String(n).padStart(w)} | ${line}`);
  });
  flush(lines.length);
  while (out.length && /^\s*\d+ \| \s*$/.test(out.at(-1)!)) out.pop();
  return out;
}

/** Which hunks the body points at: diff refs, its brief CH tags, or a file it names. */
function citedHunks(
  hunks: PatchHunk[],
  texts: string[],
  changeOf: Map<string, string[]>,
): Set<string> {
  const all = texts.join('\n');
  const cited = new Set<string>();
  const ranges = [...all.matchAll(/diff:(\d+)(?:-(\d+))?/g)].map(
    (m) => [Number(m[1]), Number(m[2] ?? m[1])] as const,
  );
  const tags = new Set(all.match(/\bCH\d+\b/g) ?? []);
  for (const h of hunks) {
    const [a, b] = lineRange(h.diff);
    const base = h.file.split('/').pop()!;
    if (
      ranges.some(([x, y]) => x <= b && a <= y) ||
      (changeOf.get(h.diff) ?? []).some((c) => tags.has(c)) ||
      all.includes(h.file) ||
      (base.includes('.') &&
        new RegExp(`(^|[^\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
          all,
        ))
    )
      cited.add(h.id);
  }
  return cited;
}

/** Build review-packet.md. Deterministic: the same inputs give the same text. */
export function leanPacket(input: PacketInput): Packet {
  const patchLines = input.patch.split(/\r?\n/);
  const hunks = patchHunks(input.patch);
  const role = roleOf(input.graph);
  const changeOf = hunkChanges(input.graph);
  const w = String(patchLines.length).length;
  const num = (n: number) => `${String(n).padStart(w)} ${patchLines[n - 1]}`;
  // Each hunk reduced: test files keep only the @@ line and added assertions.
  const reduced = new Map<string, number[]>();
  const omittedFiles = new Set<string>();
  for (const h of hunks) {
    const r = role(h.file);
    if (skipped(h.file, r)) {
      omittedFiles.add(h.file);
      continue;
    }
    const [a, b] = lineRange(h.diff);
    const keep: number[] = [];
    for (let n = a; n <= b; n++) {
      const line = patchLines[n - 1] ?? '';
      if (r !== 'tests' || n === a || (line.startsWith('+') && ASSERTION.test(line)))
        keep.push(n);
    }
    if (r !== 'tests' || keep.length > 1) reduced.set(h.id, keep);
  }
  const diffChars = [...reduced.values()]
    .flat()
    .reduce((sum, n) => sum + (patchLines[n - 1] ?? '').length + 1, 0);
  const mode: Packet['mode'] = diffChars <= WHOLE_DIFF_CHARS ? 'whole' : 'selected';
  const cited = citedHunks(hunks, [input.title, input.body, input.draft ?? ''], changeOf);
  const shown = hunks.filter(
    (h) =>
      reduced.has(h.id) &&
      (mode === 'whole' || role(h.file) === 'tests' || h.branches > 0 || cited.has(h.id)),
  );
  const shownIds = new Set(shown.map((h) => h.id));

  const out: string[] = [
    `# Lean review packet: run ${input.runId}`,
    '',
    `review-input fingerprint: ${input.fingerprint}`,
    'Cite: body:N (body line), diff:N (changes.patch line, left of each diff line), brief refs (CH#, commit:<sha>#n, L#, T#, S#), or path:line.',
    '',
    '## Title',
    '',
    input.title,
    '',
    '## Body (line-numbered)',
    '',
    ...numberedBody(input.body),
    '',
    '## Brief rows',
    '',
    ...briefLines(input.brief),
    '',
    '## Hunks and owning symbols',
    '',
    'H# file diff-range | touched symbols | new symbols | branches | change | shown below',
    ...hunks.map((h) =>
      [
        `- ${h.id} ${h.file} ${h.diff}`,
        h.touched.length ? h.touched.join(', ') : (h.scope ?? '-'),
        h.fresh.length ? `new: ${h.fresh.join(', ')}` : '-',
        h.branches ? `branches: ${h.branches}` : '-',
        (changeOf.get(h.diff) ?? []).join(', ') || '-',
        shownIds.has(h.id)
          ? role(h.file) === 'tests'
            ? 'assertions'
            : 'yes'
          : omittedFiles.has(h.file)
            ? 'no (generated/lock/version)'
            : 'no',
      ].join(' | '),
    ),
    '',
    mode === 'whole'
      ? `## Diff (whole; ${diffChars} chars without generated, lock and version files; test files reduced to assertions)`
      : `## Diff (selected: ${diffChars} chars is over ${WHOLE_DIFF_CHARS}; hunks the body cites, every branching hunk, and test assertions)`,
    '',
  ];
  let file: string | undefined;
  for (const h of shown) {
    if (h.file !== file) {
      file = h.file;
      out.push(`### ${file}`);
    }
    out.push(...reduced.get(h.id)!.map(num));
  }
  if (!shown.length) out.push('(No hunks to show.)');
  if (omittedFiles.size)
    out.push(
      '',
      `Omitted files (generated, lock or version): ${[...omittedFiles].join(', ')}`,
    );
  return { text: out.join('\n') + '\n', mode, diffChars, shownHunks: [...shownIds] };
}

function openRun(cwd: string, id?: string): { run: Run; root: string } {
  const repo = repository(cwd);
  const run = findRun(repo.gitDir, id);
  assertRunOwner(run, repo.root, repo.branch);
  return { run, root: repo.root };
}

function renderedInput(run: Run): { input: ReviewInput; patch: string } {
  const input = readJson<ReviewInput>(run, 'review-input.json');
  const patch = readText(run, 'changes.patch');
  if (!input || patch === undefined)
    throw new UserError(
      `This run has no rendered review input. Run tracetoon render --json --run ${run.id} first.`,
    );
  return { input, patch };
}

function storedBrief(graph: EvidenceGraph | undefined): Section[] | undefined {
  return graph ? graphBriefParts(graph)?.sections : undefined;
}

export function reviewPacketCmd(
  cwd: string,
  opts: OutOpts & { run?: string; lean?: boolean },
): void {
  if (!opts.lean)
    throw new UserError(
      'Only the lean packet exists: run tracetoon review-packet --lean.',
    );
  const { run } = openRun(cwd, opts.run);
  const { input, patch } = renderedInput(run);
  const graph = loadGraph(run);
  const packet = leanPacket({
    runId: run.id,
    title: input.title,
    body: input.body,
    draft: readText(run, 'body.md'),
    patch,
    fingerprint: input.fingerprint,
    graph,
    brief: storedBrief(graph),
  });
  const path = join(run.dir, PACKET_FILE);
  writeFileSync(path, packet.text, 'utf8');
  emit(opts, { path, chars: packet.text.length, mode: packet.mode }, () => path);
}

const NO_GUIDANCE: GuidanceResult = { status: 'missing', issues: [], sha256: '' };

/** What keeps an imported lean review at `incomplete` rather than `current`. */
function incompleteReasons(run: Run, root: string, input: ReviewInput): string[] {
  const reasons: string[] = [];
  const request = readJson<GuidanceRequest>(run, 'guidance-request.json');
  const guidance = request ? loadGuidance(run, root, request) : undefined;
  if (guidance?.status !== 'current')
    reasons.push(
      guidance?.status === 'missing' || !guidance
        ? 'no guidance.json (contributor guidance was not collected)'
        : `contributor guidance is ${guidance.status}`,
    );
  const requirements = guidance?.guidance?.requirements.length ?? 0;
  if (requirements)
    reasons.push(
      `${requirements} guidance requirement(s) the lean review does not assess`,
    );
  const map = readJson<{ groups?: { kind?: string; behaviorChecks?: unknown[] }[] }>(
    run,
    'change-map.json',
  );
  if (
    !map ||
    (map.groups ?? []).some((g) => g.kind === 'behavior' && !g.behaviorChecks?.length)
  )
    reasons.push('change-map.json is missing or a behavior group has no behaviorChecks');
  if (input.comic) reasons.push('the comic has no image-first review (comicReview)');
  return reasons;
}

export function importLeanReview(
  run: Run,
  root: string,
  opts: { findings?: string; agentId?: string },
): { path: string; warnings: string[]; incomplete: string[] } {
  const { input, patch } = renderedInput(run);
  const file = opts.findings
    ? isAbsolute(opts.findings)
      ? opts.findings
      : resolve(opts.findings)
    : join(run.dir, FINDINGS_FILE);
  if (!existsSync(file))
    throw new UserError(
      `No findings file at ${file}. The reviewer writes ${FINDINGS_FILE}.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(
      `review-findings.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  let parsed: ReturnType<typeof parseFindings>;
  try {
    parsed = parseFindings(raw);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const agentId = (opts.agentId ?? parsed.findings.reviewer.agentId).trim();
  if (placeholderAgentId(agentId))
    throw new UserError(
      `"${agentId}" is not a real reviewer agent id. Pass the id your host reported for the reviewer (--agent-id <id>) or have the reviewer write it in review-findings.json.`,
    );
  const digest =
    readJson<TraceDigest>(run, 'digest-full.json') ??
    readJson<TraceDigest>(run, 'digest.json');
  if (!digest) throw new UserError('This run has no digest. Run tracetoon digest first.');
  const author = readText(run, 'author.md') ?? '';
  const code = readJson<CodeSources>(run, 'source-evidence.json');
  const contractRef = (ref: string) =>
    evidenceExists(ref, input, NO_GUIDANCE, digest, patch, author, code);
  const map = readJson<{ groups?: { behaviorChecks?: { evidence?: string[] }[] }[] }>(
    run,
    'change-map.json',
  );
  const checkpoints = (map?.groups ?? []).flatMap((g, i) =>
    (g.behaviorChecks ?? []).map((c, j) => ({
      id: `B${i + 1}.${j + 1}`,
      evidence: c.evidence ?? [],
    })),
  );
  const ctx: ImportContext = {
    title: input.title,
    body: input.body,
    patch,
    hunks: patchHunks(patch),
    brief: storedBrief(loadGraph(run)),
    contractRef,
    fileExists: (p) =>
      !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && existsSync(join(root, p)),
    checkpoints,
  };
  let built: ReturnType<typeof leanToReview>;
  try {
    built = leanToReview(parsed.findings, agentId, input.fingerprint, ctx);
    // The same check render applies, so render never finds the import invalid.
    parseBodyReview(built.review.bodyReview, contractRef, {
      body: input.body,
      title: input.title,
      checkpoints: checkpoints.map((c) => c.id),
    });
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const path = writeJson(run, 'review.json', {
    ...built.review,
    importedFrom: FINDINGS_FILE,
  });
  return {
    path,
    warnings: [...parsed.warnings, ...built.warnings],
    incomplete: incompleteReasons(run, root, input),
  };
}

export function reviewImportCmd(
  cwd: string,
  opts: OutOpts & { run?: string; findings?: string; agentId?: string },
): void {
  const { run, root } = openRun(cwd, opts.run);
  const result = importLeanReview(run, root, opts);
  const next = `tracetoon render --json --run ${run.id}`;
  emit(opts, { ...result, next }, () =>
    [
      `Wrote ${result.path}.`,
      ...result.warnings.map((w) => `  warning: ${w}`),
      result.incomplete.length
        ? `Render will report the review incomplete (publishing still allowed): ${result.incomplete.join('; ')}.`
        : '',
      `Next: ${next}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
