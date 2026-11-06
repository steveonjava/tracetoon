/** Handoffs between the host's researcher, drafter and independent reviewer. */
export interface AgentRole {
  mode: 'delegated' | 'inline';
  /** The actual host invocation id, not an invented persona or model name. */
  agentId?: string;
}

export interface SourceRef {
  source: string;
  startLine: number;
  endLine: number;
}

export interface GuidanceSource {
  id: string;
  kind: 'repository' | 'web';
  /** Repo-relative path or HTTPS URL. */
  location: string;
  scope: string;
  content: string;
  sha256: string;
  retrievedAt: string;
  revision?: string;
  discoveredFrom?: SourceRef;
}

export type RenderingRule =
  | 'disclosure-required'
  | 'disclosure-prohibited'
  | 'media-prohibited'
  | 'text-prohibited'
  | 'author-written-recommended'
  | 'no-pull-requests';

export interface Requirement {
  id: string;
  text: string;
  strength:
    'required' | 'expected' | 'prohibited' | 'recommended' | 'conditional' | 'advisory';
  applicability: 'applicable' | 'inapplicable' | 'unknown';
  appliesWhen: string;
  exceptions: string[];
  evidenceExpected: string[];
  sources: SourceRef[];
  /** Only explicit, applicable source requirements can affect composition. */
  rendering?: RenderingRule;
}

export interface Guidance {
  v: 1;
  requestFingerprint: string;
  researcher: AgentRole;
  sources: GuidanceSource[];
  requirements: Requirement[];
  gaps: string[];
}

export interface GuidanceRequest {
  v: 1;
  fingerprint: string;
  offline: boolean;
  changedPaths: string[];
  sourceSeeds: { location: string; scope: string; sha256: string }[];
  changesPath: string;
  headSha: string;
  diffSha256: string;
  gaps: string[];
}

export interface GuidanceResult {
  status: 'current' | 'partial' | 'missing' | 'invalid' | 'stale';
  issues: string[];
  guidance?: Guidance;
  sha256: string;
}

export type AssessmentState =
  'satisfied' | 'violated' | 'inapplicable' | 'missing-evidence' | 'unresolved-conflict';

export interface Assessment {
  requirement: string;
  state: AssessmentState;
  reason: string;
  /** Source refs, digest ids, author.md, or a location in the reviewed title/body/diff. */
  evidence: string[];
  correction?: string;
}

export interface ContributionReview {
  v: 1 | 2;
  inputFingerprint: string;
  drafter: AgentRole;
  reviewer: AgentRole;
  assessments: Assessment[];
  comicReview?: ComicReview;
  bodyReview?: BodyReview;
}

/** How a claim in the body compares with the diff and captured evidence. */
export const CLAIM_VERDICTS = [
  'supported',
  'overstated',
  'unsupported',
  'contradicted',
] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];
export interface BodyClaim {
  id?: string;
  quote?: string;
  kind?: 'behavior' | 'validation' | 'review-location' | 'context';
  /** Where the claim is in the reviewed body, as `body:<line[-line]>`. */
  at: string;
  claim: string;
  verdict: ClaimVerdict;
  /** `diff:`, `digest:`, `author:` or `body:` references, as in assessments. */
  evidence: string[];
  correction?: string;
}
export interface BodyOmission {
  /** Behavior the diff changes that the body leaves out or misdescribes. */
  behavior: string;
  evidence: string[];
  correction?: string;
}
/**
 * The reviewer's accuracy read of the body. A cold read comes first (body only,
 * no diff) to test whether the text alone conveys the change; then each claim
 * is checked against the diff, looking for counter-evidence.
 */
export interface BodyReview {
  inferredChange: string;
  inferredStart: string;
  transfer: { state: 'satisfied' | 'needs-revision'; reason: string };
  claims: BodyClaim[];
  omissions: BodyOmission[];
  coverage?: { checkpoint: string; claims: string[]; omission?: string }[];
}

export const COMIC_REVIEW_CHECKS = [
  'clarity',
  'continuity',
  'fidelity',
  'payoff',
  'readability',
  'relevance',
] as const;
export type ComicReviewCheck = (typeof COMIC_REVIEW_CHECKS)[number];
export interface ComicReviewAssessment {
  state: 'satisfied' | 'needs-revision' | 'uncertain' | 'inapplicable';
  reason: string;
  /** One-based references to the observed panels. */
  panels: number[];
}
export interface ComicReview {
  /** Host-reported image-first reading, not a machine certification of humor. */
  imageSha256: string;
  observedPanels: string[];
  inferredStory: string;
  perceivedJoke: string;
  /**
   * The software change the reviewer reads from the image alone, before seeing
   * the PR. Missing only in reports written before relevance was reviewed.
   */
  inferredChange?: string;
  /** `relevance` is missing only in those older reports. */
  checks: Record<Exclude<ComicReviewCheck, 'relevance'>, ComicReviewAssessment> & {
    relevance?: ComicReviewAssessment;
  };
  correction?: {
    target: 'premise' | 'script' | 'art' | 'lettering';
    instruction: string;
  };
}

export interface ReviewInput {
  v: 1;
  fingerprint: string;
  title: string;
  body: string;
  guidanceSha256: string;
  digestSha256: string;
  diffSha256: string;
  headSha: string;
  authorSha256: string;
  comicSha256: string;
  /** Present when the complete redacted evidence or change map was supplied. */
  fullDigestSha256?: string;
  changeMapSha256?: string;
  codeSourcesSha256?: string;
  /** Present on new comic renders; absent on legacy packets and comic-free PRs. */
  comic?: { imagePath: string; scriptPath: string; panelCount: number };
  /**
   * Leads from the evidence graph: behavior/test files no passing check followed
   * after their last captured edit, and hunks no captured edit explains. Check the
   * body makes no verification or attribution claim about them it can't support.
   */
  graphLeads?: {
    unverified: { file: string; why: string }[];
    unexplained: {
      diff: string;
      file: string;
      commits: string[];
      removalOnly: boolean;
    }[];
  };
  /** Run-relative evidence paths for the reviewer. */
  artifacts: string[];
}

export interface ReviewResult {
  status: 'current' | 'incomplete' | 'missing' | 'stale' | 'invalid';
  mode?: 'delegated' | 'inline';
  issues: string[];
  guidanceStatus: GuidanceResult['status'];
  assessments: Assessment[];
  requirements: Requirement[];
  sources: GuidanceSource[];
  comicReview?: ComicReview;
  bodyReview?: BodyReview;
}
