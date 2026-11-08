/** A review describes one exact render. It is advisory, never a publish gate. */
import type { TraceDigest } from '../digest/build.ts';
import { bodyReviewLines, parseBodyReview } from './bodyReview.ts';
import { comicReviewLines, parseComicReview } from './comicReview.ts';
import { readJson, readText, type Run } from '../run.ts';
import { digestFact } from '../digest/facts.ts';
import { codeHash, type CodeSources } from '../commands/source.ts';
import { repoPath } from '../util/repoFiles.ts';
import {
  checkRole,
  nonempty,
  objectHash,
  requireThat,
  strings,
  textHash,
} from './guidance.ts';
import type {
  ContributionReview,
  GuidanceResult,
  ReviewInput,
  ReviewResult,
} from './types.ts';

export function reviewInput(input: {
  title: string;
  body: string;
  guidance: GuidanceResult;
  digest: TraceDigest;
  fullDigest?: TraceDigest;
  diffSha256: string;
  headSha: string;
  authorText?: string;
  comicSha256?: string;
  comic?: ReviewInput['comic'];
  /** The drafter's local change map, shared as a coverage aid when present. */
  changeMap?: boolean;
  changeMapSha256?: string;
  codeSourcesSha256?: string;
  graphLeads?: ReviewInput['graphLeads'];
}): ReviewInput {
  const { generatedAt: _time, ...digest } = input.digest;
  const { generatedAt: _fullTime, ...fullDigest } = input.fullDigest ?? input.digest;
  const stable = {
    title: input.title,
    body: input.body,
    guidanceSha256: input.guidance.sha256,
    guidanceStatus: input.guidance.status,
    guidanceIssues: input.guidance.issues,
    digestSha256: objectHash(digest),
    diffSha256: input.diffSha256,
    headSha: input.headSha,
    authorSha256: textHash(input.authorText ?? ''),
    comicSha256: input.comicSha256 ?? '',
    ...(input.fullDigest ? { fullDigestSha256: objectHash(fullDigest) } : {}),
    ...(input.changeMapSha256 ? { changeMapSha256: input.changeMapSha256 } : {}),
    ...(input.codeSourcesSha256 ? { codeSourcesSha256: input.codeSourcesSha256 } : {}),
    ...(input.comic ? { comic: input.comic } : {}),
    ...(input.graphLeads
      ? {
          graphLeads: {
            unverified: input.graphLeads.unverified.slice(0, 20),
            unexplained: input.graphLeads.unexplained.slice(0, 20),
          },
        }
      : {}),
  };
  return {
    v: 1,
    fingerprint: objectHash(stable),
    ...stable,
    artifacts: [
      'guidance-request.json',
      'guidance.json',
      'changes.patch',
      'digest.json',
      ...(input.fullDigest ? ['digest-full.json'] : []),
      'evidence-notes.md',
      'context.json',
      'author.md',
      'final-body.md',
      'approval.json',
      ...(input.changeMap ? ['change-map.json'] : []),
      ...(input.codeSourcesSha256 ? ['source-evidence.json'] : []),
      ...(input.graphLeads ? ['evidence-graph.json'] : []),
      ...(input.comic
        ? ['comic-observation-input.json', input.comic.imagePath, input.comic.scriptPath]
        : []),
    ],
  };
}

const STATES = [
  'satisfied',
  'violated',
  'inapplicable',
  'missing-evidence',
  'unresolved-conflict',
];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function evidenceExists(
  ref: string,
  input: ReviewInput,
  guidance: GuidanceResult,
  digest: TraceDigest,
  patch: string,
  author: string,
  code?: CodeSources,
): boolean {
  const codeRef = /^code:([a-f0-9]{24}):(\d+)(?:-(\d+))?$/.exec(ref);
  if (codeRef) {
    const file = code?.files.find((file) => file.id === codeRef[1]);
    const start = Number(codeRef[2]),
      end = Number(codeRef[3] ?? codeRef[2]);
    return (
      !!file &&
      repoPath(file.path) &&
      (file.revision === digest.pr.mergeBase ||
        (!digest.pr.usedWorkingTree && file.revision === input.headSha)) &&
      file.id === codeHash(`${file.revision}\0${file.path}\0${file.blob}`).slice(0, 24) &&
      file.sha256 === codeHash(file.content) &&
      start >= 1 &&
      end >= start &&
      end <= file.content.split(/\r?\n/).length
    );
  }
  if (ref === 'title') return true;
  if (/^commit:[a-f0-9]{7,40}$/i.test(ref)) return !!digestFact(digest, ref);
  const fact = /^digest:([^:]+)$/.exec(ref);
  if (fact)
    return (
      !!digest.verification?.some((r) => r.id === fact[1]) ||
      digest.sessions
        .filter((s) => s.band === 'included')
        .some((s) =>
          [
            ...(s.prompts ?? []),
            ...(s.plans ?? []),
            ...(s.decisions ?? []),
            ...(s.runs ?? []),
          ].some((f) => f.id === fact[1]),
        )
    );
  const range = /^(body|diff|author|source:([^:]+)):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!range) return false;
  const text =
    range[1] === 'body'
      ? input.body
      : range[1] === 'diff'
        ? patch
        : range[1] === 'author'
          ? author
          : guidance.guidance?.sources.find((s) => s.id === range[2])?.content;
  const start = Number(range[3]);
  const end = Number(range[4] ?? range[3]);
  return (
    typeof text === 'string' &&
    !!text &&
    start >= 1 &&
    end >= start &&
    end <= text.split(/\r?\n/).length
  );
}

export function loadReview(
  run: Run,
  input: ReviewInput,
  guidance: GuidanceResult,
  digest: TraceDigest,
  patch: string,
  extraIssues: string[] = [],
): ReviewResult {
  const base: ReviewResult = {
    status: 'missing',
    issues: [...guidance.issues, ...extraIssues],
    guidanceStatus: guidance.status,
    assessments: [],
    requirements: guidance.guidance?.requirements ?? [],
    sources: guidance.guidance?.sources ?? [],
  };
  let raw: string | undefined;
  try {
    raw = readText(run, 'review.json');
  } catch {
    return {
      ...base,
      status: 'invalid',
      issues: [...base.issues, 'review.json could not be read.'],
    };
  }
  if (raw === undefined)
    return {
      ...base,
      issues: [...base.issues, 'The rendered PR has not been reviewed.'],
    };
  try {
    const value: unknown = JSON.parse(raw);
    requireThat(
      isRecord(value) &&
        (value.v === 1 || value.v === 2) &&
        nonempty(value.inputFingerprint),
      'review.json needs v: 1 or 2 and inputFingerprint.',
    );
    checkRole(value.drafter);
    checkRole(value.reviewer);
    requireThat(Array.isArray(value.assessments), 'Review needs an assessments array.');
    const roles = [guidance.guidance?.researcher, value.drafter, value.reviewer].filter(
      (r) => r !== undefined,
    );
    const mode = roles.some((r) => r.mode === 'inline') ? 'inline' : 'delegated';
    const ids = roles.filter((r) => r.mode === 'delegated').map((r) => r.agentId);
    requireThat(
      new Set(ids).size === ids.length,
      'Researcher, drafter and reviewer must be distinct host agents; label sequential fallback as inline.',
    );
    if (value.inputFingerprint !== input.fingerprint)
      return {
        ...base,
        mode,
        status: 'stale',
        issues: [
          ...base.issues,
          'The PR, code, evidence, guidance or comic changed after this review. Review the new review-input.json.',
        ],
      };
    const review = value as unknown as ContributionReview;
    const comicReview =
      value.comicReview === undefined ? undefined : parseComicReview(value.comicReview);
    if (comicReview && comicReview.imageSha256 !== input.comicSha256)
      return {
        ...base,
        mode,
        status: 'stale',
        issues: [
          ...base.issues,
          'The comic content review describes a different image; inspect the current image first.',
        ],
      };
    if (input.comic && !comicReview)
      base.issues.push(
        'Comic content assessment is missing. Read comic-observation-input.json with the image before reading its script or the full review packet.',
      );
    if (input.comic && comicReview && !comicReview.checks.relevance)
      base.issues.push(
        'Comic relevance is not assessed. From the image alone, record which software change it suggests (inferredChange), then compare it with the PR in a relevance check.',
      );
    if (
      input.comic &&
      comicReview &&
      comicReview.observedPanels.length !== input.comic.panelCount
    )
      base.issues.push(
        `Comic reviewer observed ${comicReview.observedPanels.length} panels; the script specifies ${input.comic.panelCount}. Check the reading order and actual framing.`,
      );
    const seen = new Set<string>();
    const author = readText(run, 'author.md') ?? '';
    const fullDigest = readJson<TraceDigest>(run, 'digest-full.json') ?? digest;
    const code = readJson<CodeSources>(run, 'source-evidence.json');
    if ((code ? objectHash(code) : undefined) !== input.codeSourcesSha256)
      return {
        ...base,
        mode,
        status: 'stale',
        issues: [
          ...base.issues,
          'Code evidence changed after this render; render and review the updated packet.',
        ],
      };
    const map = readJson<{ groups?: { kind?: string; behaviorChecks?: unknown[] }[] }>(
      run,
      'change-map.json',
    );
    const missingCheckpoints =
      value.v === 2 &&
      (!map ||
        (map.groups ?? []).some(
          (group) => group.kind === 'behavior' && !group.behaviorChecks?.length,
        ));
    if (missingCheckpoints)
      base.issues.push(
        'Review v2 needs material behavior checkpoints for each behavior group in change-map.json.',
      );
    const checkpoints = (map?.groups ?? []).flatMap((group, i) =>
      (group.behaviorChecks ?? []).map((_, j) => `B${i + 1}.${j + 1}`),
    );
    const bodyReview =
      value.bodyReview === undefined
        ? undefined
        : parseBodyReview(
            value.bodyReview,
            (ref) =>
              evidenceExists(ref, input, guidance, fullDigest, patch, author, code),
            value.v === 2
              ? { body: input.body, title: input.title, checkpoints }
              : undefined,
          );
    if (!bodyReview)
      base.issues.push(
        'Description accuracy review is missing. Read only the title and body first and record inferredChange; then check each claim against the diff, looking for counter-evidence, and list omitted behavior (bodyReview).',
      );
    for (const finding of review.assessments) {
      requireThat(
        isRecord(finding) &&
          nonempty(finding.requirement) &&
          !seen.has(finding.requirement) &&
          base.requirements.some((r) => r.id === finding.requirement),
        'Assessments must reference unique, known requirement ids.',
      );
      seen.add(finding.requirement);
      requireThat(
        STATES.includes(finding.state) &&
          nonempty(finding.reason) &&
          strings(finding.evidence) &&
          (finding.correction === undefined || typeof finding.correction === 'string'),
        `Invalid assessment for ${finding.requirement}.`,
      );
      requireThat(
        finding.state !== 'satisfied' || finding.evidence.length > 0,
        `Satisfied requirement ${finding.requirement} needs evidence.`,
      );
      for (const ref of finding.evidence)
        requireThat(
          evidenceExists(ref, input, guidance, fullDigest, patch, author, code),
          `Unknown evidence reference: ${ref}`,
        );
      const rule = base.requirements.find((r) => r.id === finding.requirement)!;
      requireThat(
        rule.applicability !== 'unknown' || finding.state !== 'satisfied',
        `Applicability is unknown for ${rule.id}; do not claim satisfaction.`,
      );
      requireThat(
        rule.applicability !== 'applicable' || finding.state !== 'inapplicable',
        `Research and review disagree about applicability for ${rule.id}; update guidance or report an unresolved conflict.`,
      );
      requireThat(
        rule.applicability !== 'inapplicable' || finding.state !== 'satisfied',
        `${rule.id} was declared inapplicable; do not claim satisfaction.`,
      );
    }
    const assessments = [...review.assessments];
    for (const rule of base.requirements)
      if (!seen.has(rule.id)) {
        assessments.push({
          requirement: rule.id,
          state: 'missing-evidence',
          reason: 'The reviewer did not assess this requirement.',
          evidence: [],
        });
        base.issues.push(`Requirement not assessed: ${rule.id}`);
      }
    if (mode === 'inline')
      base.issues.push(
        'Inline fallback: drafting or review was performed without three independent host agents.',
      );
    const incomplete =
      !guidance.guidance ||
      guidance.status !== 'current' ||
      seen.size !== base.requirements.length ||
      extraIssues.length > 0;
    return {
      ...base,
      mode,
      status:
        incomplete ||
        missingCheckpoints ||
        !bodyReview ||
        (input.comic && !comicReview) ||
        (input.comic && !comicReview?.checks.relevance) ||
        (input.comic && comicReview?.observedPanels.length !== input.comic.panelCount)
          ? 'incomplete'
          : 'current',
      assessments,
      ...(comicReview ? { comicReview } : {}),
      ...(bodyReview ? { bodyReview } : {}),
    };
  } catch (e) {
    return { ...base, status: 'invalid', issues: [...base.issues, (e as Error).message] };
  }
}

export function reviewLine(review: ReviewResult): string {
  const attention = review.assessments.filter(
    (a) =>
      a.state === 'violated' ||
      a.state === 'missing-evidence' ||
      a.state === 'unresolved-conflict',
  );
  return [
    `Contribution review (advisory): ${review.status}${review.mode === 'inline' ? ' (inline draft / self-review)' : review.mode === 'delegated' ? ' (independent host agents)' : ''}; guidance ${review.guidanceStatus}; ${attention.length} finding(s).`,
    ...review.issues.map((i) => `  - ${i}`),
    ...attention.map(
      (a) =>
        `  - ${a.state} (${a.requirement}): ${a.reason}${a.correction ? ` Suggested correction: ${a.correction}` : ''}`,
    ),
    ...(review.bodyReview ? bodyReviewLines(review.bodyReview) : []),
    ...(review.comicReview ? comicReviewLines(review.comicReview) : []),
  ].join('\n');
}

/** Keep full source snapshots in the run, rather than echoing them to terminals. */
export function reviewSummary(review: ReviewResult) {
  return {
    ...review,
    sources: review.sources.map(({ id, location }) => ({ id, location })),
  };
}
