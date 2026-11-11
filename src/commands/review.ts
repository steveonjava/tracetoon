/**
 * The lean reviewer: one packet in (review-packet.md), findings out
 * (review-findings.json), imported into review.json v2 by Tracetoon.
 *
 * The packet holds only what drove useful findings in measured reviews: the
 * line-numbered title and body, the brief rows a claim can be checked against,
 * which symbol owns each hunk, and the diff (whole when small; otherwise the
 * hunks the body cites, every branching hunk and the test assertion lines).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileRole } from '../digest/build.ts';
import type { TraceDigest } from '../digest/build.ts';
import { patchHunks, type PatchHunk } from '../graph/build.ts';
import { graphBriefParts, loadGraph } from '../graph/evidence.ts';
import { runLayout } from '../graph/layout.ts';
import type { EvidenceGraph } from '../graph/model.ts';
import type { Section } from '../graph/queries.ts';
import { passOnSubmittedContent } from '../workflow/checks.ts';
import { evidenceExists } from '../contribution/review.ts';
import { parseBodyReview } from '../contribution/bodyReview.ts';
import {
  FINDINGS_FILE,
  leanToReview,
  locateQuote,
  parseFindings,
  placeholderAgentId,
  type ImportContext,
  type LeanFinding,
  type LeanFindings,
} from '../contribution/leanReview.ts';
import {
  MERGED_FILE,
  mergedMarkdown,
  mergeFindings,
  type MergedList,
} from '../contribution/mergeFindings.ts';
import {
  loadReviewPlan,
  recheckStep,
  type ReviewPlan,
  parseEffort,
  parseLens,
  planEnforced,
  planMissing,
  planSummary,
  requiredPasses,
  type ReviewLens,
  type ReviewPass,
} from '../contribution/reviewPlan.ts';
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
/** The packet file for a lens reviewer (review-packet-a.md), or the default packet. */
export const packetFile = (lens?: string) =>
  lens ? `review-packet-${lens}.md` : PACKET_FILE;
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
  /** Commit-message row ref → the hunks it describes, shown as `→ H#`. */
  hunkLinks?: Record<string, string[]>;
  /** A lens reviewer's packet: its checklist first, brief rows it doesn't use left out. */
  lens?: ReviewLens;
}

/** What each lens checks, printed at the top of its packet. */
export const LENS_CHECKLISTS: Record<
  ReviewLens,
  { title: string; rows?: string[]; check: string[] }
> = {
  a: {
    title: 'Lens A: place',
    rows: ['changes', 'owners', 'commitMessages'],
    check: [
      '- Each file, function, type or command the body names: is it where "Hunks and owning symbols" shows that behavior? A behavior credited to the wrong file or function is `contradicted`.',
      '- "new"/"added"/"introduces" only for symbols in `new:`; "existing"/"already"/"extends" only for symbols not in `new:`.',
      '- A fact only a commit message states (implementedBy: none found) written as code fact.',
    ],
  },
  b: {
    title: 'Lens B: scope words, old behavior, housekeeping',
    rows: ['changes', 'commitMessages', 'tests'],
    check: [
      '- only, just, always, every, all, never, no longer: find the branch, default, fallback or caller that takes another path.',
      '- "previously", "used to", "before", "was", "no longer": the old behavior must match removed (-) lines or a `was:` row; invented old behavior is `unsupported`.',
      '- Housekeeping claims (version bump, generated or lock files, renames, docs, formatting, "no other changes") vs the diff and the omitted files.',
    ],
  },
  c: {
    title: 'Lens C: omissions',
    check: [
      '- Motive or trigger: a background, request or why row explains the change but the body never says why.',
      '- Open limits and uncertainties the body leaves out, or turns into certainty.',
      '- Failure-then-pass history in process rows (what broke, what fixed it) the body skips.',
      '- Paths no test or receipt covers, described as verified.',
    ],
  },
  d: {
    title: 'Lens D: completeness',
    check: [
      '- Every change unit (CH#) and every commit-message sentence: a body sentence says specifically what it does (the function or command and its new behavior), not just that the area changed.',
      '- Tests: each added or changed test file is named with what its new tests assert (from `tests` rows and test hunks).',
      '- Docs, guides, SKILL/README and prompt files the diff changes: each gets a clause saying what changed in it.',
      '- Old → new values (`was:` rows: models, limits, windows, names, defaults): stated with both values.',
      '- The reason the code itself gives (code comments in added lines, commit messages): said, attributed.',
      '- A secondary user-visible change (preview page, output format, CLI flag) the body skips.',
    ],
  },
};

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
function briefLines(
  brief: Section[] | undefined,
  hunkLinks: Record<string, string[]> = {},
  only?: string[],
): string[] {
  if (!brief) return ['(No evidence graph for this run: check claims against the diff.)'];
  const rows = (t: string) =>
    only && !only.includes(t) ? [] : (brief.find((s) => s.title === t)?.rows ?? []);
  const out: string[] = [];
  const changes = rows('changes');
  if (changes.length) {
    out.push('changes (where = file (owning symbols); new = symbols not in the base):');
    for (const r of changes)
      out.push(
        `- ${show(r.change)} where: ${oneLine(r.where)}${(r.newSymbols as string[])?.length ? ` | new: ${oneLine(r.newSymbols)}` : ''}${(r.was as string[])?.length ? ` | was: ${oneLine(r.was)}` : ''}${(r.diff as string[])?.length ? ` | ${oneLine(r.diff)}` : ''}`,
      );
  }
  const owners = rows('owners');
  if (owners.length) {
    out.push(
      'owners (where each behavior lives: the function whose changed lines do what the commit sentence says):',
    );
    for (const r of owners)
      out.push(
        `- ${show(r.change)} "${oneLine(r.behavior, 120)}" → ${show(r.function)} in ${show(r.file)} (${show(r.cites)})`,
      );
  }
  const commits = rows('commitMessages');
  if (commits.length) {
    out.push(
      'commitMessages (facts only a message states; implementedBy = where the patch does it; → H# = the hunks it describes):',
    );
    for (const r of commits) {
      const to = hunkLinks[String(r.ref)] ?? [];
      out.push(
        `- ${show(r.ref)}: "${oneLine(r.text, 300)}"${(r.implementedBy as string[])?.length ? ` | implementedBy: ${oneLine(r.implementedBy)}` : ' | implementedBy: (none found)'}${to.length ? ` → ${to.join(' ')}` : ''}`,
      );
    }
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
  const background = rows('background');
  if (background.length) {
    out.push(
      "background (why the work started, from the session; attribute it to the session, not to this PR's request):",
    );
    for (const r of background)
      out.push(`- ${show(r.ref)} (${oneLine(r.kind, 80)}): "${oneLine(r.text, 300)}"`);
  }
  const process = rows('process');
  if (process.length) {
    out.push('process (recorded facts about how the work went):');
    for (const r of process)
      out.push(`- ${show(r.ref)} (${show(r.kind)}): ${oneLine(r.fact, 300)}`);
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

  const lens = input.lens ? LENS_CHECKLISTS[input.lens] : undefined;
  const out: string[] = [
    `# Lean review packet: run ${input.runId}${lens ? ` (${lens.title})` : ''}`,
    '',
    `review-input fingerprint: ${input.fingerprint}`,
    'Cite: body:N (body line), diff:N (changes.patch line, left of each diff line), brief refs (CH#, commit:<sha>#n, L#, T#, S#, P#, D#, PR#), or path:line.',
    '',
    ...(lens
      ? [
          `## ${lens.title}: checklist`,
          '',
          'Check only these; at most 6 findings.',
          ...lens.check,
          ...(lens.rows
            ? [
                `(Brief rows shown: ${lens.rows.join(', ')}; the others are left out for this lens.)`,
              ]
            : []),
          '',
        ]
      : []),
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
    ...briefLines(input.brief, input.hunkLinks, lens?.rows),
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

export function openRun(cwd: string, id?: string): { run: Run; root: string } {
  const repo = repository(cwd);
  const run = findRun(repo.gitDir, id);
  assertRunOwner(run, repo.root, repo.branch);
  return { run, root: repo.root };
}

export function renderedInput(run: Run): { input: ReviewInput; patch: string } {
  const input = readJson<ReviewInput>(run, 'review-input.json');
  const patch = readText(run, 'changes.patch');
  if (!input || patch === undefined)
    throw new UserError(
      `This run has no rendered review input. Run tracetoon render --json --run ${run.id} first.`,
    );
  return { input, patch };
}

/** The brief as the run's writer read it (its layout), with the commit → hunk links. */
function storedBrief(
  run: Run,
  graph: EvidenceGraph | undefined,
): { sections: Section[]; hunkLinks: Record<string, string[]> } | undefined {
  return graph
    ? graphBriefParts(graph, runLayout(run), passOnSubmittedContent(run))
    : undefined;
}

export function reviewPacketCmd(
  cwd: string,
  opts: OutOpts & { run?: string; lean?: boolean; lens?: string },
): void {
  if (!opts.lean)
    throw new UserError(
      'Only the lean packet exists: run tracetoon review-packet --lean.',
    );
  let lens: ReviewLens | undefined;
  try {
    lens = parseLens(opts.lens);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const { run } = openRun(cwd, opts.run);
  const { path, packet } = writeLeanPacket(run, lens);
  emit(
    opts,
    {
      path,
      chars: packet.text.length,
      mode: packet.mode,
      ...(lens ? { lens, findingsFile: join(run.dir, lensFindingsFile(lens)) } : {}),
    },
    () =>
      lens
        ? `${path}
The lens ${lens} reviewer writes ${join(run.dir, lensFindingsFile(lens))}; import it with tracetoon review import --run ${run.id} --lens ${lens} --agent-id <its id>.`
        : path,
  );
}

/** Build and write the run's lean packet (review-packet[-lens].md) for the current render. */
export function writeLeanPacket(
  run: Run,
  lens?: ReviewLens,
  /** Another file name, so parallel general passes don't share one packet. */
  fileName?: string,
): { path: string; packet: Packet } {
  const { input, patch } = renderedInput(run);
  const graph = loadGraph(run);
  const parts = storedBrief(run, graph);
  const packet = leanPacket({
    runId: run.id,
    title: input.title,
    body: input.body,
    draft: readText(run, 'body.md'),
    patch,
    fingerprint: input.fingerprint,
    graph,
    brief: parts?.sections,
    hunkLinks: parts?.hunkLinks,
    ...(lens ? { lens } : {}),
  });
  const path = join(run.dir, fileName ?? packetFile(lens));
  writeFileSync(path, packet.text, 'utf8');
  return { path, packet };
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

/** Every imported pass with its findings, so each import can rebuild review.json from all of them. */
export const PASSES_FILE = 'review-passes.json';
export interface StoredPass extends ReviewPass {
  raw: LeanFindings;
}
export const loadPasses = (run: Run): StoredPass[] =>
  readJson<{ passes?: StoredPass[] }>(run, PASSES_FILE)?.passes ?? [];
const passSummary = ({ raw: _raw, ...pass }: StoredPass): ReviewPass => pass;
const bodyHash = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Claim findings (contradicted, overstated, unsupported) whose quote is still
 * verbatim in the body after the body changed since that reviewer saw it: a
 * correction round left them as they were. Each must be fixed or rejected with
 * the diff line that supports it, so render lists them as a soft note. Passes
 * with no recorded body (older imports) are skipped.
 */
export function unchangedFlags(
  passes: StoredPass[],
  body: string,
): { pass: number; lens?: string; quote: string; verdict: string; evidence: string }[] {
  const now = bodyHash(body);
  const out: ReturnType<typeof unchangedFlags> = [];
  for (const p of passes) {
    if (!p.bodySha256 || p.bodySha256 === now) continue;
    for (const f of p.raw?.findings ?? []) {
      const quote = (f.quote ?? '').trim();
      if (f.kind !== 'claim' || f.verdict === 'missing' || quote.length < 8) continue;
      if (!body.includes(quote)) continue;
      out.push({
        pass: p.pass,
        ...(p.lens ? { lens: p.lens } : {}),
        quote,
        verdict: f.verdict,
        evidence: Array.isArray(f.evidence) ? f.evidence.join(' | ') : String(f.evidence),
      });
    }
  }
  return out;
}

export interface ImportOptions {
  findings?: string;
  agentId?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  /** Which pass this is (default: this reviewer's earlier pass with the same lens, else the next number). */
  pass?: string | number;
  lens?: string;
  /** Rebuild review.json for the current render from the passes already imported. */
  rebind?: boolean;
  /** Recorded on the pass by `tracetoon review run` (source, session, verified model). */
  provenance?: Pick<
    ReviewPass,
    'source' | 'runner' | 'sessionId' | 'verifiedModel' | 'bodySha256' | 'slot'
  >;
}

function readFindingsFile(file: string): ReturnType<typeof parseFindings> {
  if (!existsSync(file))
    throw new UserError(
      `No findings file at ${file}. The reviewer writes ${file.split(/[\\/]/).pop()}.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(
      `${file.split(/[\\/]/).pop()} is not valid JSON: ${(e as Error).message}`,
    );
  }
  try {
    return parseFindings(raw);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
}

/** The findings file a lens reviewer writes, so parallel reviewers don't overwrite each other. */
export const lensFindingsFile = (lens?: string) =>
  lens ? `review-findings-${lens}.json` : FINDINGS_FILE;

export function importLeanReview(
  run: Run,
  root: string,
  opts: ImportOptions,
): {
  path: string;
  warnings: string[];
  incomplete: string[];
  /** reviewer.model as recorded in review.json; null when none was given. */
  reviewerModel: string | null;
  /** The pass this import recorded (undefined on --rebind). */
  pass?: ReviewPass;
  passes: ReviewPass[];
  /** What the run's review plan still needs (empty when met or not enforced). */
  planMissing: string[];
} {
  const { input, patch } = renderedInput(run);
  const plan = loadReviewPlan(run);
  const warnings: string[] = [];
  let lens: ReviewLens | undefined;
  let effort: string | undefined;
  try {
    lens = parseLens(opts.lens);
    effort = parseEffort(opts.reviewerEffort);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const stored = loadPasses(run);
  let current: StoredPass | undefined;
  if (opts.rebind) {
    if (!stored.length)
      throw new UserError(
        'No reviewer pass has been imported for this run yet: import one before --rebind.',
      );
  } else {
    // General (no-lens) reviewers are allowed when the plan asks for more
    // passes than it has lenses ("Review passes: 2. Review lenses: d.").
    if (plan?.lenses.length && !lens && requiredPasses(plan) <= plan.lenses.length)
      throw new UserError(
        `This run's review plan has lenses ${plan.lenses.join(', ')}: import each reviewer with --lens <${plan.lenses.join('|')}>.`,
      );
    if (lens && plan?.lenses.length && !plan.lenses.includes(lens))
      throw new UserError(
        `Lens ${lens} is not in this run's review plan (lenses ${plan.lenses.join(', ')}).`,
      );
    const file = opts.findings
      ? isAbsolute(opts.findings)
        ? opts.findings
        : resolve(opts.findings)
      : join(run.dir, lensFindingsFile(lens));
    const parsed = readFindingsFile(file);
    warnings.push(...parsed.warnings);
    const agentId = (opts.agentId ?? parsed.findings.reviewer.agentId).trim();
    if (placeholderAgentId(agentId))
      throw new UserError(
        `"${agentId}" is not a real reviewer agent id. Pass the id your host reported for the reviewer (--agent-id <id>) or have the reviewer write it in ${lensFindingsFile(lens)}.`,
      );
    const model =
      (opts.reviewerModel ?? parsed.findings.reviewer.model)?.trim() || undefined;
    for (const [label, want, got, flag] of [
      ['model', plan?.reviewerModel, model, '--reviewer-model'],
      ['effort', plan?.reviewerEffort, effort, '--reviewer-effort'],
    ] as const) {
      if (!want) continue;
      if (got && got !== want)
        throw new UserError(
          `This run's review plan names reviewer ${label} ${want}, but this reviewer ran with ${got}. Start a fresh reviewer with ${label} ${want} and import it with ${flag} ${want}.`,
        );
      if (!got)
        warnings.push(
          `No reviewer ${label} recorded; the plan needs ${want}: if the reviewer ran with it, import again with ${flag} ${want}, else start a fresh reviewer with it. Publishing refuses until then.`,
        );
    }
    let pass: number;
    if (opts.pass !== undefined) {
      pass = Number(opts.pass);
      if (!Number.isInteger(pass) || pass < 1)
        throw new UserError(
          `--pass must be a positive whole number, not "${opts.pass}".`,
        );
    } else
      pass =
        stored.find((p) => p.agentId === agentId && p.lens === lens)?.pass ??
        Math.max(0, ...stored.map((p) => p.pass)) + 1;
    const twin = stored.find((p) => p.agentId === agentId && p.pass !== pass);
    if (twin)
      warnings.push(
        `Reviewer ${agentId} also made pass ${twin.pass}; the review plan counts distinct reviewer agents only.`,
      );
    current = {
      pass,
      agentId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(lens ? { lens } : {}),
      findings: parsed.findings.findings.length,
      importedAt: new Date().toISOString(),
      // The body this reviewer saw, so render can tell a correction round happened.
      bodySha256: bodyHash(input.body),
      ...(opts.provenance ?? {}),
      raw: parsed.findings,
    };
  }
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
    brief: storedBrief(run, loadGraph(run))?.sections,
    contractRef,
    fileExists: (p) =>
      !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && existsSync(join(root, p)),
    checkpoints,
  };
  const passes = [
    ...stored.filter((p) => p.pass !== current?.pass),
    ...(current ? [current] : []),
  ].sort((a, b) => a.pass - b.pass);
  // The current pass's findings must all match this render. Other passes'
  // claims whose quote is gone from the body were fixed; the rest are merged.
  const latest =
    current ??
    [...passes].sort((a, b) => a.importedAt.localeCompare(b.importedAt)).at(-1)!;
  const merged: LeanFinding[] = current ? [...current.raw.findings] : [];
  for (const p of passes) {
    if (p === current) continue;
    const kept = p.raw.findings.filter(
      (f) => f.kind !== 'claim' || !!locateQuote(f.quote ?? '', input.title, input.body),
    );
    if (kept.length < p.raw.findings.length)
      warnings.push(
        `Pass ${p.pass}: ${p.raw.findings.length - kept.length} claim finding(s) whose quote is no longer in the body count as fixed.`,
      );
    merged.push(...kept);
  }
  const coldRead =
    latest.raw.coldRead ?? passes.map((p) => p.raw.coldRead).find(Boolean) ?? undefined;
  let built: ReturnType<typeof leanToReview>;
  try {
    built = leanToReview(
      {
        v: 1,
        reviewer: { agentId: latest.agentId },
        ...(coldRead ? { coldRead } : {}),
        findings: merged,
      },
      latest.agentId,
      input.fingerprint,
      ctx,
      latest.model,
    );
    // The same check render applies, so render never finds the import invalid.
    parseBodyReview(built.review.bodyReview, contractRef, {
      body: input.body,
      title: input.title,
      checkpoints: checkpoints.map((c) => c.id),
    });
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const summaries = passes.map(passSummary);
  const path = writeJson(run, 'review.json', {
    ...built.review,
    importedFrom: lensFindingsFile(latest.lens),
    passes: summaries,
  });
  writeJson(run, PASSES_FILE, { v: 1, passes });
  return {
    path,
    warnings: [...warnings, ...built.warnings],
    incomplete: incompleteReasons(run, root, input),
    reviewerModel: built.review.reviewer.model ?? null,
    ...(current ? { pass: passSummary(current) } : {}),
    passes: summaries,
    planMissing: planMissing(plan, summaries),
  };
}

/** Each pass's label in the merged list: `lens x`, `general`, or `general N` when there are several. */
export function passLabels(passes: StoredPass[]): Map<StoredPass, string> {
  const general = passes.filter((p) => !p.lens);
  const out = new Map<StoredPass, string>();
  for (const p of passes)
    out.set(
      p,
      p.lens
        ? `lens ${p.lens}`
        : p.slot?.startsWith('general')
          ? p.slot === 'general'
            ? 'general'
            : `general ${p.slot.slice(7)}`
          : general.length > 1
            ? `general ${general.indexOf(p) + 1}`
            : 'general',
    );
  return out;
}

/** Build and write `<run>/review-findings-merged.md` from the imported passes. */
export function writeMergedList(run: Run): MergedList & { path: string; text: string } {
  const passes = loadPasses(run).sort((a, b) => a.pass - b.pass);
  const { input } = renderedInput(run);
  const labels = passLabels(passes);
  const list = mergeFindings(
    passes.map((p) => ({ label: labels.get(p)!, findings: p.raw?.findings ?? [] })),
    {
      isFixed: (f) =>
        f.kind === 'claim' &&
        !!(f.quote ?? '').trim() &&
        !locateQuote(f.quote!, input.title, input.body),
    },
  );
  const text = mergedMarkdown(run.id, list);
  const path = join(run.dir, MERGED_FILE);
  writeFileSync(path, text, 'utf8');
  return { ...list, path, text };
}

/** The correction round's next step after a merged list, by the plan's `Review recheck:` setting. */
export function recheckNext(
  run: Run,
  plan: ReviewPlan | undefined,
  findings: number,
): string {
  const render = `tracetoon render --check --json --run ${run.id}`;
  if (!findings) return `${render}; publish when the review is current`;
  return `apply ${MERGED_FILE} in ONE edit pass of body.md (check each finding against the lines it cites; fix or reject every flagged claim), ${render}, then ${recheckStep(run.id, plan)}`;
}

export function reviewMergeCmd(cwd: string, opts: OutOpts & { run?: string }): void {
  const { run } = openRun(cwd, opts.run);
  if (!loadPasses(run).length)
    throw new UserError(
      `No reviewer pass has been imported for run ${run.id} yet: import each reviewer with tracetoon review import --run ${run.id} first.`,
    );
  const plan = loadReviewPlan(run);
  const merged = writeMergedList(run);
  const missing = planMissing(
    plan,
    loadPasses(run).map(({ raw: _raw, ...p }) => p),
  );
  const next = recheckNext(run, plan, merged.items.length);
  emit(opts, { ...merged, planMissing: missing, next }, () =>
    [
      merged.text.trimEnd(),
      '',
      `Wrote ${merged.path}.`,
      planEnforced(plan) && missing.length
        ? `Review plan (${planSummary(plan)}) still needs:\n${missing.map((m) => `  - ${m}`).join('\n')}`
        : '',
      `Next: ${next}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export function reviewImportCmd(
  cwd: string,
  opts: OutOpts & ImportOptions & { run?: string },
): void {
  const { run, root } = openRun(cwd, opts.run);
  const result = importLeanReview(run, root, opts);
  const next = `tracetoon render --json --run ${run.id}`;
  const plan = loadReviewPlan(run);
  emit(opts, { ...result, next }, () =>
    [
      `Wrote ${result.path}${result.pass ? ` (pass ${result.pass.pass}${result.pass.lens ? `, lens ${result.pass.lens}` : ''}; ${result.passes.length} pass(es) recorded)` : ` (rebuilt from ${result.passes.length} pass(es))`}.`,
      `Reviewer model: ${result.reviewerModel ?? 'not recorded (pass --reviewer-model <name> when SKILL.md names one)'}.`,
      ...result.warnings.map((w) => `  warning: ${w}`),
      result.incomplete.length
        ? `Render will report the review incomplete (publishing still allowed): ${result.incomplete.join('; ')}.`
        : '',
      planEnforced(plan)
        ? result.planMissing.length
          ? `Review plan (${planSummary(plan)}) still needs:\n${result.planMissing.map((m) => `  - ${m}`).join('\n')}`
          : `Review plan (${planSummary(plan)}): met.`
        : '',
      `Next: ${next}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
