/**
 * render → publish. `render` freezes the exact title, body and comic image.
 * `publish` creates (or updates) the PR from that render, refusing only when
 * something changed since or the leak scan found something. The only edits
 * after rendering fill in where the comic image is hosted.
 */
import {
  loadReviewPlan,
  planEnforced,
  planGate,
  planRecheck,
  recheckStep,
  planMissing,
  tracetoonRuns,
  planSummary,
  requiredPasses,
  type ReviewPass,
} from '../contribution/reviewPlan.ts';
import { createHash } from 'node:crypto';
import {
  contributionPolicy,
  loadGuidance,
  objectHash,
  researchPacket,
} from '../contribution/guidance.ts';
import {
  loadReview,
  reviewInput,
  reviewLine,
  reviewSummary,
} from '../contribution/review.ts';
import type { GuidanceRequest, ReviewInput } from '../contribution/types.ts';
import { graphClaimFacts } from '../graph/claims.ts';
import {
  graphBrief,
  graphBriefParts,
  loadGraph,
  loadGraphReview,
} from '../graph/evidence.ts';
import { applyBrief, type BriefApplied } from '../graph/briefRender.ts';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvalCode, scanComment } from '@showtail/agent-traces/share/comment';
import { transcript } from '../comic/script.ts';
import type { ComicScript } from '../comic/types.ts';
import { loadConfig, type ComicMode } from '../config.ts';
import { comicDecision } from '../comic/decision.ts';
import type { TraceDigest } from '../digest/build.ts';
import { checkClaims, claimSummary, type ClaimFinding } from '../digest/claims.ts';
import { checkChangeMap } from '../digest/changeMap.ts';
import { contextNotes, evidenceNotes } from '../digest/notes.ts';
import { assetUrl, publishAssets, type AssetFile } from '../github/assets.ts';
import {
  contentHash,
  decodeMeta,
  titleHash,
  defuseMentions,
  stampSubmission,
  managedBlock,
  mergeIntoBody,
  type PrMeta,
} from '../github/body.ts';
import type { AiPolicy } from '../github/repoContext.ts';
import { defaultBase, prTruth, type PrTruth } from '../git/pr.ts';
import { findRun, readJson, readText, writeJson, type Run } from '../run.ts';
import { repoWeb } from '../github/history.ts';
import {
  prHead,
  repoArgs,
  resolveTarget,
  targetLine,
  type Target,
} from '../github/target.ts';
import type { TitleRules } from '../github/titleRules.ts';
import { checkTitle, titleLine } from '../digest/titleCheck.ts';
import { gh, git } from '../util/exec.ts';
import { TOOL_VERSION } from '../version.ts';
import { readComicStatus, renderedComic } from './comic.ts';
import { leakBlocks, leakNotice } from '../review/leak.ts';
import { digestHash } from './digest.ts';
import { loadPasses, unchangedFlags } from './review.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import {
  sameSubmission,
  snapshotProblem,
  submissionSnapshot,
  type SubmissionSnapshot,
} from '../review/snapshot.ts';
import { comicSummary } from '../comic/composition.ts';
import { comicObservationInput } from '../contribution/comicReview.ts';
import { readTask, saveTask, workFingerprint } from '../workflow/state.ts';
import { fileHash, publishProblem } from '../workflow/readiness.ts';
import { passOnSubmittedContent, receipts } from '../workflow/checks.ts';
import { publicationLock, recordTiming } from '../workflow/publication.ts';
import { readLocal, writeLocal } from '../util/localJson.ts';
import { acknowledgeRepository } from '../workflow/hostSession.ts';
import { runLayout } from '../graph/layout.ts';

export const COMIC_SRC = '{{tracetoon:comic-src}}';
const COMIC_MARKER = '{{tracetoon:comic}}';

interface Context {
  base?: string;
  /** The target repo `context` resolved; render records it, publish enforces it. */
  target?: Target | null;
  repo?: string | null;
  contribution?: GuidanceRequest;
  aiPolicy: AiPolicy;
  existingPr: { number: number; url: string; title: string; body: string } | null;
  config?: { disclosure?: 'assisted-by' | 'co-authored-by' | 'none' };
  titleRules?: TitleRules;
}

/**
 * One short disclosure line, added after the description and the comic. The
 * match percentage and session details stay in the render output, not the PR.
 */
export function disclosureLine(
  digest: Pick<TraceDigest, 'disclosure'>,
  mode: 'assisted-by' | 'co-authored-by' | 'none' = 'assisted-by',
  form?: AiPolicy['disclosure'],
): string {
  if (mode === 'none') return '';
  const trailers = digest.disclosure.suggestedTrailers;
  if (!trailers.length) return '';
  const tools = digest.disclosure.agents.join(', ');
  if (form === 'tool-and-use') {
    // e.g. Django, Ghostty: name the tool and model, and say what it was used for.
    const models = digest.disclosure.models.join(', ');
    return `<sub>AI use: ${tools}${models ? ` (${models})` : ''} assisted with the code; this description was drafted from the session logs with [Tracetoon](https://github.com/Tingsters/tracetoon).</sub>`;
  }
  const trailer =
    mode === 'assisted-by' ? trailers.join(' · ') : `AI-assisted with ${tools}`;
  return `<sub>${trailer} · description drafted from the session logs with [Tracetoon](https://github.com/Tingsters/tracetoon)</sub>`;
}

/** Whether the PR has a comic and, if not, why. */
export interface ComicStatus {
  state: 'included' | 'off' | 'policy' | 'skipped' | 'no-route' | 'failed' | 'none';
  detail?: string;
}

/**
 * The frozen render that `publish` posts. `code` identifies this exact render
 * (title, body, comic, target); publication uses it to reconcile retries.
 */
export interface Approval {
  /** Managed tasks bind validation and the public worktree to the render. */
  workspaceFingerprint?: string;
  checksSha?: string;
  originSha?: string;
  code: string;
  title: string;
  bodySha: string;
  /** SHA-256 of the comic image, when the PR has one. */
  comicSha?: string;
  comicFile?: string;
  findings: { kind: string; count: number }[];
  /** SHA-256 of body.md as rendered, so a later fix can be told apart from this render. */
  sourceSha?: string;
  /** Where the leak scan found something ("title" or "final-body.md:<line>"); never the value. */
  findingAt?: string[];
  allowFindings: boolean;
  mode: 'create' | 'edit';
  prNumber?: number;
  base: string;
  head: string;
  /** The repository the PR goes to (`owner/name`), fixed at render; every gh call uses it. */
  repo?: string;
  policy: AiPolicy['verdict'];
  /** The repo's agent instructions say never to open a PR. */
  noPullRequests?: boolean;
  ambiguousSessions: string[];
  comicMode?: ComicMode;
  comicStatus?: ComicStatus;
  renderedAt: string;
  /** Optional only for reading pre-upgrade renders; publishing requires it. */
  submission?: SubmissionSnapshot;
}

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const codeFor = (approval: Approval, body: string) =>
  approvalCode(
    `${approval.title}\n\0${body}\n\0${approval.comicSha ?? ''}\n\0${objectHash({ submission: approval.submission, head: approval.head, base: approval.base, mode: approval.mode, prNumber: approval.prNumber, ...(approval.repo ? { repo: approval.repo } : {}), ...(approval.workspaceFingerprint ? { workspaceFingerprint: approval.workspaceFingerprint, checksSha: approval.checksSha, originSha: approval.originSha } : {}) })}`,
  );

/**
 * The branch to open the PR against. A digest can compare with a commit (to
 * tell the story of the whole history, say), but a PR targets a branch: then
 * it's the repo's default branch.
 */
export function prBase(root: string, base: string): string {
  const branch = (name: string) =>
    git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok ||
    git(root, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok;
  return branch(base) ? base : defaultBase(root);
}

/** Commits added since the digest, which its checks can't see. */
export function digestStale(
  root: string,
  digest: Pick<TraceDigest, 'pr'>,
): string | undefined {
  if (digest.pr.usedWorkingTree) return undefined;
  const last = digest.pr.commits[digest.pr.commits.length - 1]?.sha;
  const head = git(root, ['rev-parse', `${digest.pr.head}^{commit}`]).stdout.trim();
  if (!last || !head || head.startsWith(last)) return undefined;
  const added = git(root, ['rev-list', '--count', `${last}..${head}`]).stdout.trim();
  return `${added && added !== '0' ? `${added} commit(s) were` : 'Commits were'} added after the digest; run \`tracetoon digest\` again so the description and checks see them.`;
}

export { prHead };
function loadRun(cwd: string, runId?: string): { run: Run; truth: PrTruth } {
  const truth = prTruth(cwd, { noGh: true });
  return { run: findRun(truth.gitDir, runId), truth };
}

/** The comic as it appears in the body: image, then a collapsed transcript. */
function comicBlock(script: ComicScript): string {
  const alt = script.altText.replace(/[\[\]\n]/g, ' ').trim();
  return `<p align="center"><img src="${COMIC_SRC}" alt="${alt.replace(/"/g, "'")}" width="760"></p>

<details>
<summary>Comic transcript</summary>

${transcript(script)}

</details>`;
}

export interface RenderOpts extends OutOpts {
  run?: string;
  allowFindings?: boolean;
  /** Leave the comic out of this PR. */
  noComic?: boolean;
  /** Replace a title a person chose (only after the user agrees). */
  retitle?: boolean;
  /**
   * The lean brief path: drafted inline from the evidence brief, with no
   * separate researcher or reviewer. Publishing then needs no review.json.
   */
  lean?: boolean;
  /** Same as `lean`: the brief-path draft check that comes before the slim review. */
  check?: boolean;
  /**
   * The reviewed brief path: drafted inline from the brief, then checked by one
   * slim reviewer whose corrections were applied (notes in reviewer-notes.md).
   */
  reviewed?: boolean;
}

/** One line a writer can't miss, printed first: what is left to fix. */
const briefCheckHeadline = (b: BriefApplied) => {
  const open = openProblems(b);
  return open || b.uncovered.length
    ? `Brief check: ${open} sentence(s) to fix, ${b.uncovered.length} brief row(s) to cover (listed below). Publishing refuses until both are 0.`
    : 'Brief check: nothing left to fix.';
};

const briefCheckSummary = (b: BriefApplied) => ({
  validationSection: b.validation,
  tags: b.tags,
  unknownRefs: b.unknownRefs,
  untagged: b.untagged,
  validationClaims: b.validationClaims,
  unbackedNames: b.unbackedNames,
  uncovered: b.uncovered,
  flags: b.flags,
  /** Sentences the writer must fix before publishing (coverage gaps are counted apart). */
  open: openProblems(b),
});

const openProblems = (b: BriefApplied) =>
  b.flags.filter((f) => f.severity === 'fix').length +
  b.untagged.length +
  b.validationClaims.length +
  b.unknownRefs.length;

/** What the brief check found, as instructions the writer can act on. */
function briefCheckLines(b: BriefApplied): string {
  const out: string[] = [];
  if (b.validation)
    out.push('Validation section: written by Tracetoon from the recorded checks.');
  if (b.validationClaims.length)
    out.push(
      `Run or test claims outside the Validation section (remove them; ${b.validation ? 'the section already says' : 'put `<!-- tracetoon:validation -->` where the section belongs and render writes'} what ran):\n${b.validationClaims
        .slice(0, 8)
        .map((s) => `  - ${s}`)
        .join('\n')}`,
    );
  if (b.unknownRefs.length)
    out.push(
      `Ref tags not in the brief (fix the sentence or its tag): ${b.unknownRefs.join(', ')}`,
    );
  const fix = b.flags.filter((f) => f.severity === 'fix');
  const check = b.flags.filter((f) => f.severity === 'check');
  if (fix.length)
    out.push(
      `Sentences that say more than the evidence shows (fix the wording; a tag doesn't fix these):\n${fix
        .slice(0, 8)
        .map((f) => `  - ${f.sentence}\n    → ${f.problem}`)
        .join('\n')}`,
    );
  if (check.length)
    out.push(
      `Check these against the patch (keep them if every path does what they say):\n${check
        .slice(0, 6)
        .map((f) => `  - ${f.sentence}\n    → ${f.problem}`)
        .join('\n')}`,
    );
  // Names placed outside a sentence's implementedBy stay in the JSON only: writers
  // deleted correct names on that hint (dev15).
  if (b.tags && b.untagged.length)
    out.push(
      `Sentences with no ref tag. These say something no brief row states: delete each one, unless a row says the same thing, then reword it to that row and tag it. Adding a tag without a row that states it is not a fix:\n${b.untagged
        .slice(0, 8)
        .map((s) => `  - ${s}`)
        .join(
          '\n',
        )}${b.untagged.length > 8 ? `\n  - …and ${b.untagged.length - 8} more` : ''}`,
    );
  if (b.uncovered.length)
    out.push(
      `Brief rows the description doesn't cover yet (add one sentence for each, in the brief's words, tagged with its ref):\n${b.uncovered
        .slice(0, 12)
        .map((u) => `  - ${u}`)
        .join(
          '\n',
        )}${b.uncovered.length > 12 ? `\n  - …and ${b.uncovered.length - 12} more` : ''}`,
    );
  if (b.tags) {
    const open = openProblems(b);
    out.push(
      open || b.uncovered.length
        ? `${open} sentence(s) to fix and ${b.uncovered.length} brief row(s) to cover: edit body.md and render again before publishing.`
        : 'Brief check: nothing left to fix.',
    );
  }
  return out.join('\n');
}

export function renderCmd(cwd: string, opts: RenderOpts): Approval {
  let { run, truth } = loadRun(cwd, opts.run);
  const digest = readJson<TraceDigest>(run, 'digest.json');
  if (!digest)
    throw new UserError('This run has no digest.json. Run `tracetoon digest` first.');
  if (
    readTask(run) &&
    digest.checksSha !== (receipts(run).length ? fileHash(run, 'checks.json') : undefined)
  )
    throw new UserError(
      'Validation evidence changed after the digest. Refresh digest --run before rendering and review.',
    );
  const ctx = readJson<Context>(run, 'context.json');
  if (!ctx)
    throw new UserError('This run has no context.json. Run `tracetoon context` first.');
  if (ctx.base && ctx.base !== truth.base)
    truth = prTruth(cwd, { base: ctx.base, noGh: true });
  // One target repo for this render; publish refuses to post anywhere else.
  const target: Target | undefined =
    ctx.target ?? (ctx.repo ? { repo: ctx.repo } : undefined);
  const targetRepo = target?.repo;
  const captured = readJson<SubmissionSnapshot>(run, 'submission.json');
  if (!captured || !sameSubmission(captured, submissionSnapshot(truth)))
    throw new UserError(
      `The digest needs refreshing for the current code. Run tracetoon digest --run ${run.id}, then context, update the description, and render again.`,
    );
  const packet = researchPacket(truth, ctx.contribution?.offline ?? false);
  const guidance = loadGuidance(run, truth.toplevel, packet.request);
  const composition = contributionPolicy(ctx.aiPolicy, guidance);
  ctx.aiPolicy = composition.policy;
  const bodyMd = readText(run, 'body.md');
  if (!bodyMd?.trim()) {
    throw new UserError(`Write the PR description to ${join(run.dir, 'body.md')} first.`);
  }
  // The brief's Validation section and ref tags: written and checked here.
  const storedGraph = loadGraph(run);
  // A check that passed on the submitted content retires "no pass after the last commit".
  const freshPass = passOnSubmittedContent(run, truth.toplevel);
  const briefCheck = applyBrief(
    bodyMd,
    storedGraph ? graphBriefParts(storedGraph, runLayout(run), freshPass) : undefined,
  );
  const draft = briefCheck.text;
  // The title: a person's choice is kept. A title edited on GitHub since
  // Tracetoon posted it, or written by someone on a PR Tracetoon didn't title,
  // stays unless the user agrees to replace it (--retitle).
  const proposed = readText(run, 'title.txt')?.trim();
  const current = ctx.existingPr?.title;
  const postedTitle = ctx.existingPr
    ? decodeMeta(ctx.existingPr.body)?.titleSha
    : undefined;
  const chosenByPerson =
    !!current && (postedTitle ? postedTitle !== titleHash(current) : true);
  let titleNote: string | undefined;
  let title: string;
  if (proposed && current && proposed !== current && chosenByPerson && !opts.retitle) {
    title = current;
    titleNote = `Kept the PR's current title "${current}" (${postedTitle ? 'edited on GitHub' : 'chosen by a person'}); title.txt proposes "${proposed}". Re-render with --retitle only if the user agrees.`;
  } else {
    title =
      proposed ||
      current ||
      digest.pr.commits[digest.pr.commits.length - 1]?.subject ||
      digest.pr.head;
  }
  const titleFindings = checkTitle({ title, rules: ctx.titleRules, digest });
  writeJson(run, 'title-checks.json', titleFindings);

  const script = readJson<ComicScript>(run, 'comic.json');
  const comicMode = loadConfig(truth.toplevel).comic;
  const decision = comicDecision(comicMode, ctx.aiPolicy);
  const mediaBanned = decision.state === 'policy';
  const comic = opts.noComic || !decision.include ? undefined : renderedComic(run);
  const comicStatus: ComicStatus =
    comic && script
      ? { state: 'included' }
      : opts.noComic
        ? { state: 'skipped', detail: 'left out for this PR' }
        : !decision.include
          ? { state: decision.state ?? 'off', detail: decision.reason }
          : (((s) => (s ? { state: s.state, detail: s.detail } : undefined))(
              readComicStatus(run),
            ) ?? { state: 'none', detail: 'none was drawn for this PR' });
  // The description comes first; the comic is the closing beat, unless the
  // writer placed it with the marker. A short disclosure goes last.
  let content = defuseMentions(draft).replace(COMIC_MARKER, '');
  if (comic && script) {
    const block = comicBlock(script);
    content = draft.includes(COMIC_MARKER)
      ? defuseMentions(draft).replace(COMIC_MARKER, block)
      : `${content.trim()}\n\n${block}`;
  }
  const disclosureMode =
    composition.disclosure === 'required' && ctx.config?.disclosure === 'none'
      ? 'assisted-by'
      : ctx.config?.disclosure;
  const disclosure =
    composition.disclosure === 'prohibited'
      ? ''
      : disclosureLine(digest, disclosureMode, ctx.aiPolicy.disclosure) ||
        (composition.disclosure === 'required'
          ? '<sub>This description was drafted with [Tracetoon](https://github.com/Tingsters/tracetoon).</sub>'
          : '');
  if (disclosure) content = `${content.trim()}\n\n${disclosure}`;

  // Compact creative choices (not plots/cast descriptions) and hashes used to
  // preserve edits made on GitHub.
  const meta: PrMeta = {
    v: 1,
    ...(comic && script?.style ? { style: script.style } : {}),
    ...(comic && script
      ? { comic: (({ style: _style, ...choices }) => choices)(comicSummary(script)) }
      : {}),
    contentSha: contentHash(content),
    titleSha: titleHash(title),
  };
  const block = managedBlock(content, meta);
  const body = mergeIntoBody(ctx.existingPr?.body, block);
  const findings = scanComment(
    `${title}\n${body.replace(/<!-- tracetoon:meta [\s\S]*? -->/, '')}`,
  );
  const findingAt = findings.length ? leakLocations(title, body) : [];
  const comicSha = comic ? sha(comic.data) : undefined;
  const approval: Approval = {
    ...(readTask(run) || receipts(run).length
      ? {
          workspaceFingerprint: workFingerprint(truth.toplevel),
          originSha: sha(
            git(truth.toplevel, ['remote', 'get-url', 'origin']).stdout.trim(),
          ),
          ...(receipts(run).length ? { checksSha: fileHash(run, 'checks.json') } : {}),
        }
      : {}),
    code: '',
    title,
    bodySha: sha(body),
    sourceSha: sha(bodyMd),
    comicSha,
    comicFile: comic?.path,
    findings,
    ...(findingAt.length ? { findingAt } : {}),
    allowFindings: !!opts.allowFindings,
    mode: ctx.existingPr ? 'edit' : 'create',
    prNumber: ctx.existingPr?.number,
    base: prBase(truth.toplevel, digest.pr.base),
    head: digest.pr.head,
    ...(targetRepo ? { repo: targetRepo } : {}),
    policy: ctx.aiPolicy.verdict,
    ...(ctx.aiPolicy.noPullRequests ? { noPullRequests: true } : {}),
    ambiguousSessions: digest.sessions
      .filter((s) => s.band === 'ambiguous')
      .map((s) => s.ref),
    comicMode,
    comicStatus,
    renderedAt: new Date().toISOString(),
    submission: captured,
  };
  approval.code = codeFor(approval, body);
  writeFileSync(join(run.dir, 'final-body.md'), body, 'utf8');
  writeFileSync(join(run.dir, 'changes.patch'), packet.patch, 'utf8');
  // Advisory: the drafter's local change map, checked against the diff.
  let changeMapRaw: unknown;
  try {
    changeMapRaw = readJson<unknown>(run, 'change-map.json');
  } catch {
    changeMapRaw = null; // Unreadable JSON is reported as an invalid map.
  }
  const changeMapFindings = checkChangeMap({
    raw: changeMapRaw,
    files: digest.files,
    changedPaths: packet.request.changedPaths,
    patch: packet.patch,
    exists: (path) =>
      !isAbsolute(path) &&
      !path.split(/[\\/]/).includes('..') &&
      existsSync(join(truth.toplevel, path)),
  });
  writeJson(run, 'change-map-checks.json', changeMapFindings);
  const graphLeads = loadGraphReview(run);
  const reviewPacket = reviewInput({
    title,
    body,
    guidance,
    digest,
    fullDigest: readJson<TraceDigest>(run, 'digest-full.json'),
    diffSha256: packet.request.diffSha256,
    headSha: packet.request.headSha,
    authorText: readText(run, 'author.md'),
    comicSha256: comicSha,
    changeMap: changeMapRaw !== undefined,
    ...(changeMapRaw !== undefined ? { changeMapSha256: objectHash(changeMapRaw) } : {}),
    ...(readJson(run, 'source-evidence.json')
      ? { codeSourcesSha256: objectHash(readJson(run, 'source-evidence.json')) }
      : {}),
    ...(graphLeads ? { graphLeads } : {}),
    ...(comic && script
      ? {
          comic: {
            imagePath: relative(run.dir, comic.path).replaceAll('\\', '/'),
            scriptPath: 'comic.json',
            panelCount: script.panels.length,
          },
        }
      : {}),
  });
  const observationInput = comicObservationInput(reviewPacket);
  if (observationInput) writeJson(run, 'comic-observation-input.json', observationInput);
  else if (existsSync(join(run.dir, 'comic-observation-input.json')))
    unlinkSync(join(run.dir, 'comic-observation-input.json'));
  writeJson(run, 'review-input.json', reviewPacket);
  const reviewed = loadReview(
    run,
    reviewPacket,
    guidance,
    digest,
    packet.patch,
    composition.issues,
  );
  // On the lean path a review someone did write still counts; none is needed.
  // `--check` (alias `--lean`): the draft checked against the brief, before the slim review.
  const briefMode = opts.reviewed
    ? 'reviewed-brief'
    : opts.lean || opts.check
      ? 'lean'
      : undefined;
  const contributionReview: typeof reviewed =
    briefMode && reviewed.status === 'missing'
      ? {
          ...reviewed,
          status: 'skipped',
          mode: briefMode,
          issues: [
            briefMode === 'lean'
              ? 'Checked draft: run render --json and the independent review next (SKILL step 2b.5); on the quick path (references/quick-path.md) the slim review comes next.'
              : existsSync(join(run.dir, 'reviewer-notes.md'))
                ? 'Reviewed brief path: drafted inline from the evidence brief, then checked by one slim reviewer (reviewer-notes.md).'
                : 'Reviewed brief path: no reviewer-notes.md found; run the slim reviewer before publishing.',
          ],
        }
      : reviewed;
  writeJson(run, 'review-result.json', {
    ...contributionReview,
    inputFingerprint: reviewPacket.fingerprint,
    reportSha256: objectHash(readJson(run, 'review.json') ?? null),
  });
  // Advisory: check the description's claims against the captured evidence.
  const claims = checkClaims({
    title,
    body: draft,
    digest,
    root: truth.toplevel,
    authorText: readText(run, 'author.md'),
    graph: storedGraph ? graphClaimFacts(storedGraph) : undefined,
  });
  writeJson(run, 'claims.json', claims);
  writeJson(run, 'brief-check.json', briefCheckSummary(briefCheck));
  const notes = contextNotes(digest, draft, claims);
  writeJson(run, 'notes.json', notes);
  // Authors who write the text themselves (or must, by policy) get the facts as an outline.
  const writeYourself =
    ctx.aiPolicy.text === 'prohibited' ||
    ctx.aiPolicy.text === 'author-written-recommended';
  const outline = evidenceNotes(
    readJson<TraceDigest>(run, 'digest-full.json') ?? digest,
    storedGraph
      ? graphBrief(storedGraph, { layout: runLayout(run), freshPass })
      : undefined,
  );
  writeFileSync(join(run.dir, 'evidence-notes.md'), outline, 'utf8');
  writeJson(run, 'approval.json', approval);
  for (const legacy of ['preview.html', 'review-state.json'])
    if (existsSync(join(run.dir, legacy))) unlinkSync(join(run.dir, legacy));
  const task = readTask(run);
  if (task && task.state === 'working') {
    task.state = 'preparing';
    saveTask(run, task);
  }

  const stale = digestStale(truth.toplevel, digest);
  const graphHint =
    digest.graph && !graphQueried(run)
      ? 'Check the draft against the evidence brief (`tracetoon query brief`, also at the top of evidence-notes.md): every claim within its change, reason and validation row, nothing references/drafting.md rules out. Then render again.'
      : undefined;
  const briefFirst = briefCheck.tags || briefMode;
  // The review plan prepare stored (SKILL "Review passes/lenses", reviewer model/effort).
  const plan = loadReviewPlan(run);
  const planNeeds = planMissing(
    plan,
    readJson<{ passes?: ReviewPass[] }>(run, 'review.json')?.passes,
  );
  // Soft: reviewer claim flags still verbatim in a body that changed since the
  // reviewer saw it (SKILL step 2b.8: fix each or reject it with its diff line).
  const stillFlagged = unchangedFlags(loadPasses(run), reviewPacket.body);
  const planText = planEnforced(plan)
    ? planNeeds.length
      ? `Review plan (${planSummary(plan)}) still needs:\n${planNeeds.map((m) => `  - ${m}`).join('\n')}`
      : `Review plan (${planSummary(plan)}): met.`
    : '';
  emit(
    opts,
    {
      // First, so a writer reading only the head of the output still sees it.
      ...(briefFirst ? { briefCheck: briefCheckSummary(briefCheck) } : {}),
      run: run.id,
      ...approval,
      ...(writeYourself ? { evidenceNotesPath: join(run.dir, 'evidence-notes.md') } : {}),
      titleChecks: titleFindings,
      contributionReview: reviewSummary(contributionReview),
      reviewInputPath: join(run.dir, 'review-input.json'),
      comicObservationInputPath: observationInput
        ? join(run.dir, 'comic-observation-input.json')
        : null,
      reviewFingerprint: reviewPacket.fingerprint,
      ...(planEnforced(plan)
        ? { reviewPlan: { ...plan, required: requiredPasses(plan), missing: planNeeds } }
        : {}),
      ...(leakBlocks(approval) ? { leakNotice: leakNotice(approval) } : {}),
      changeMap: changeMapFindings,
      ...(titleNote ? { titleNote } : {}),
      ...(graphHint ? { graphHint } : {}),
      ...(stillFlagged.length ? { reviewFlagsUnchanged: stillFlagged } : {}),
      briefCheck: briefCheckSummary(briefCheck),
      claims: {
        ...claimSummary(claims),
        findings: claims.filter(
          (c) => c.state === 'contradicted' || c.state === 'not established',
        ),
      },
    },
    () =>
      [
        briefFirst ? briefCheckHeadline(briefCheck) : '',
        // A PR the leak scan stops is the first thing the user must hear.
        leakBlocks(approval) ? leakNotice(approval) : '',
        `Rendered "${title}" (${approval.mode === 'edit' ? `update PR #${approval.prNumber}` : 'new PR'})${comic ? ' with comic' : ''}`,
        approval.repo ? targetLine(target) : '',
        approval.mode === 'create'
          ? `PR base: ${approval.base}${approval.base !== digest.pr.base ? ` (the story covers changes since ${digest.pr.base.slice(0, 12)})` : ''}`
          : '',
        stale ? `Warning: ${stale}` : '',
        findings.length && !approval.allowFindings
          ? ''
          : findings.length
            ? `Leak scan found: ${findings.map((f) => `${f.kind} x${f.count}`).join(', ')}. Allowed by --allow-findings.`
            : 'Leak scan: clean.',
        titleNote ? `Note: ${titleNote}` : '',
        titleLine(titleFindings),
        claimLine(claims),
        graphLine(graphLeads),
        graphHint ? `Evidence graph: ${graphHint}` : '',
        briefCheckLines(briefCheck),
        changeMapFindings.length
          ? `Change map (advisory):\n${changeMapFindings.map((f) => `  - ${f.text}`).join('\n')}`
          : '',
        reviewLine(contributionReview),
        stillFlagged.length
          ? `Note (soft): reviewer flags whose quoted text is still verbatim after the correction round. Fix each (narrow, attribute or remove it) or reject it with the diff line that supports the original; don't leave it unanswered${planRecheck(plan) === 'contested' ? ` (Review recheck: contested: recheck the rejected ones with ${tracetoonRuns(plan) ? `tracetoon review run --all --recheck --run ${run.id}` : 'the reviewer that raised them'})` : planRecheck(plan) === 'none' ? ' (Review recheck: none: no reviewer recheck needed)' : ''}:\n${stillFlagged.map((f) => `  - pass ${f.pass}${f.lens ? ` (lens ${f.lens})` : ''}, ${f.verdict} (${f.evidence}): "${f.quote}"`).join('\n')}`
          : '',
        notes.length
          ? `Optional notes for the author (skippable; offer them, don't ask before drafting):\n${notes.map((n) => `  - ${n.text}`).join('\n')}`
          : '',
        policyLines(ctx.aiPolicy, mediaBanned),
        comicStatus.state === 'included' && ctx.aiPolicy.media === 'prohibited'
          ? "Policy: this repository's rules forbid images in PRs; the comic is included because the comic setting is always."
          : '',
        comicStatus.state === 'included'
          ? 'Comic: included.'
          : `Comic: none — ${comicStatus.detail ?? comicStatus.state}.`,
        findings.length && !approval.allowFindings
          ? 'Not ready to publish: fix what the leak scan found (above), then render again.'
          : briefMode === 'lean'
            ? planEnforced(plan)
              ? `Next: tracetoon render --json --run ${run.id}, then ${tracetoonRuns(plan) ? `tracetoon review run --all --run ${run.id} (Tracetoon runs every planned pass on ${plan.reviewerModel} in parallel and writes review-findings-merged.md), apply it in ONE edit pass, render --check --json, then ${recheckStep(run.id, plan)}` : `the reviewer passes the review plan asks for, all started in one message (SKILL step 2b.5-7), then tracetoon review merge --run ${run.id}, ONE edit pass, then ${recheckStep(run.id, plan)}`}. ${planText}`
              : `Next: tracetoon render --json --run ${run.id}, then one fresh independent reviewer writes review.json v2 (SKILL step 2b.5). Quick path only: the slim reviewer (references/quick-path.md step 7), then render --reviewed.`
            : planNeeds.length
              ? `Next: not ready to publish. ${planText}\n${tracetoonRuns(plan) ? `Run the missing passes with tracetoon review run --all --run ${run.id} (Tracetoon starts the reviewers; don't start a reviewer agent), then render again.` : `Import each pass with tracetoon review import --run ${run.id}, then render again.`}`
              : `${planText ? `${planText}\n` : ''}Next: tracetoon publish --run ${run.id}`,
      ]
        .filter(Boolean)
        .join('\n'),
  );
  return approval;
}

/** Whether any `tracetoon query` ran against this run (from its profile log). */
function graphQueried(run: { dir: string }): boolean {
  try {
    return readFileSync(join(run.dir, 'profiles.jsonl'), 'utf8')
      .split('\n')
      .some((line) => {
        if (!line.trim()) return false;
        const p = JSON.parse(line) as { counters?: Record<string, number> };
        return (p.counters?.['graph.queries'] ?? 0) > 0;
      });
  } catch {
    return false;
  }
}

/** What the repo's AI policy means for this PR, in a few lines. */
function policyLines(policy: AiPolicy, mediaBanned: boolean): string {
  const out: string[] = [];
  if (policy.text === 'prohibited')
    out.push(
      'Policy: this repository appears to prohibit AI-written contributions. The user asked for this PR, so it is still posted; mention the policy to them.',
    );
  else if (policy.text === 'author-written-recommended')
    out.push(
      'Policy: this repository asks authors to write PR text themselves. Offer evidence-notes.md as an outline to write from; the draft is optional.',
    );
  void mediaBanned; // The comic line says why a comic was left out.
  if (policy.noPullRequests)
    out.push(
      "Policy: the repo's agent instructions say not to open PRs. The user asked for this one, so it is still posted; mention the instruction to them.",
    );
  if (policy.disclosure && policy.disclosure !== 'unspecified')
    out.push(
      `Policy: disclosure in the form the repo asks for (${policy.disclosure}) is added.`,
    );
  for (const i of policy.prInstructions ?? [])
    out.push(`Repo instruction (${i.file}:${i.line}): ${i.text}`);
  return out.join('\n');
}

/** What the evidence graph wants the reviewer to look at, in one or two lines. */
function graphLine(leads: ReviewInput['graphLeads'] | undefined): string {
  if (!leads || (!leads.unverified.length && !leads.unexplained.length)) return '';
  const parts = [
    leads.unverified.length
      ? `${leads.unverified.length} behavior/test file(s) with no passing check after their last captured edit (${leads.unverified
          .slice(0, 3)
          .map((u) => u.file)
          .join(', ')}${leads.unverified.length > 3 ? ', …' : ''})`
      : '',
    leads.unexplained.length
      ? `${leads.unexplained.length} hunk(s) no captured agent edit explains (${leads.unexplained
          .slice(0, 3)
          .map((u) => u.diff)
          .join(', ')}${leads.unexplained.length > 3 ? ', …' : ''})`
      : '',
  ].filter(Boolean);
  return `Evidence graph (advisory): ${parts.join('; ')}. The reviewer checks the body claims nothing about these it can't support; details: tracetoon query unverified|unexplained.`;
}

/** One advisory line about the claim check, with the claims worth a look. */
function claimLine(claims: ClaimFinding[]): string {
  if (!claims.length) return '';
  const c = claimSummary(claims);
  const look = claims.filter(
    (x) => x.state === 'contradicted' || x.state === 'not established',
  );
  return [
    `Claim check (advisory): ${c.observed} supported, ${c['author-reported']} author-reported, ${c['not established']} not established, ${c.contradicted} contradicted.`,
    ...look.map((x) => `  - ${x.state}: "${x.quote.slice(0, 90)}" (${x.detail})`),
  ].join('\n');
}

/**
 * A file path as an absolute file:/// URL. Terminals and agent UIs turn these
 * into clickable links (Ctrl+click), unlike bare or relative paths.
 */
export function fileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

function ghVersionAtLeast(cwd: string, min: [number, number]): boolean {
  const v = /(\d+)\.(\d+)\.(\d+)/.exec(gh(cwd, ['--version']).stdout);
  if (!v) return false;
  const [maj, minor] = [Number(v[1]), Number(v[2])];
  return maj > min[0] || (maj === min[0] && minor >= min[1]);
}

function repoIsPrivate(cwd: string, repo?: string): boolean {
  const r = gh(cwd, [
    'repo',
    'view',
    ...(repo ? [repo] : []),
    '--json',
    'visibility',
    '-q',
    '.visibility',
  ]);
  return r.ok && /private|internal/i.test(r.stdout);
}

interface Hosted {
  body: string;
  attach?: string;
  assetsCommit?: string;
  hosting: 'branch' | 'attach' | 'none';
  /** Where the comic image can be viewed, when it is on the assets branch. */
  imageUrl?: string;
}

/**
 * A ready-to-post caption for social media: the headline, what happened in one
 * line, and the PR link. Kept under 280 characters.
 */
export function shareCaption(
  script: ComicScript | undefined,
  title: string,
  url: string,
): string {
  const headline = (script?.v === 2 && script.headline) || script?.title || title;
  const tail = `\n${url} #tracetoon`;
  const room = 280 - headline.length - tail.length - 3;
  let line = (script?.synopsis ?? '').replace(/\s+/g, ' ').trim();
  if (line.length > room)
    line = `${line.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, '')}…`;
  return `${headline}${line ? ` — ${line}` : ''}${tail}`;
}

/** Put the comic somewhere GitHub can show it, and fill in its URL. */
function hostComic(
  truth: PrTruth,
  run: Run,
  approval: Approval,
  body: string,
  mode: 'auto' | 'branch' | 'attach',
): Hosted {
  if (!approval.comicFile || !approval.comicSha) return { body, hosting: 'none' };
  const data = readFileSync(approval.comicFile);
  if (sha(data) !== approval.comicSha) {
    throw new UserError(
      'The comic image changed after it was rendered. Run `tracetoon render` again.',
    );
  }
  const canAttach = ghVersionAtLeast(truth.toplevel, [2, 99]);
  const web = repoWeb(truth);
  const tryAttach = (): Hosted => {
    if (!canAttach)
      throw new UserError(
        'Attaching images needs GitHub CLI 2.99 or newer (`gh --version`).',
      );
    const local = approval.comicFile!.replace(/\\/g, '/');
    return {
      body: body.replaceAll(COMIC_SRC, local),
      attach: approval.comicFile,
      hosting: 'attach',
    };
  };
  const wantAttach =
    mode === 'attach' ||
    (mode === 'auto' && canAttach && repoIsPrivate(truth.toplevel, approval.repo));
  if (wantAttach) return tryAttach();
  if (!web) {
    if (canAttach) return tryAttach();
    throw new UserError(
      'Cannot work out the GitHub URL for this repo to host the comic. Set an `origin` GitHub remote.',
    );
  }
  // Only the image goes on the assets branch: nothing a later PR reads back.
  const folder = `comics/${approval.prNumber ?? approval.head.replace(/[^\w.-]+/g, '-')}-${approval.comicSha.slice(0, 7)}`;
  const ext = approval.comicFile.endsWith('.svg') ? 'svg' : 'png';
  const files: AssetFile[] = [{ path: `${folder}/comic.${ext}`, data }];
  try {
    const commit = publishAssets(truth.toplevel, files, `tracetoon: ${folder}`);
    return {
      body: body.replaceAll(COMIC_SRC, assetUrl(web, commit, `${folder}/comic.${ext}`)),
      imageUrl: assetUrl(web, commit, `${folder}/comic.${ext}`),
      assetsCommit: commit,
      hosting: 'branch',
    };
  } catch (e) {
    if (mode === 'auto' && canAttach) return tryAttach();
    throw new UserError(
      `Could not host the comic on the assets branch: ${(e as Error).message}`,
    );
  }
}

export interface PublishOpts extends OutOpts {
  run?: string;
  push?: boolean;
  draft?: boolean;
  hosting?: 'auto' | 'branch' | 'attach';
  /** Publish although the last render listed open problems or uncovered brief rows. */
  acceptOpen?: boolean;
  /** Publish a checked brief-path draft with no slim review (only when the user asks for the cheapest run). */
  noReview?: boolean;
}

/** Why a brief-path draft can't be published yet for lack of its slim review, if so. */
export function briefPathUnreviewed(run: { dir: string }): string | undefined {
  const review = readLocal<{ mode?: string }>(join(run.dir, 'review-result.json'));
  if (review?.mode !== 'lean') return undefined;
  if (existsSync(join(run.dir, 'reviewer-notes.md')))
    return 'reviewer-notes.md exists but the last render was the pre-review check: apply the notes and run tracetoon render --reviewed.';
  return 'This draft was only checked (render --check), not reviewed. Full path: run tracetoon render --json and the independent review (review.json v2). Quick path: the slim review (references/quick-path.md step 7), then tracetoon render --reviewed. Pass --no-review only if the user asked for the cheapest run.';
}

/** What the last render on a brief path left open, or undefined when nothing is. */
export function briefPathOpen(run: { dir: string }): string | undefined {
  const review = readLocal<{ mode?: string }>(join(run.dir, 'review-result.json'));
  if (review?.mode !== 'lean' && review?.mode !== 'reviewed-brief') return undefined;
  const b = readLocal<{ open?: number; uncovered?: string[] }>(
    join(run.dir, 'brief-check.json'),
  );
  const open = b?.open ?? 0;
  const uncovered = b?.uncovered?.length ?? 0;
  if (!open && !uncovered) return undefined;
  return `The last render left ${open} sentence(s) to fix and ${uncovered} brief row(s) to cover${
    uncovered
      ? `:\n${(b?.uncovered ?? [])
          .slice(0, 8)
          .map((u) => `  - ${u}`)
          .join('\n')}`
      : '.'
  }`;
}

export function publishCmd(cwd: string, opts: PublishOpts): void {
  const { run } = loadRun(cwd, opts.run);
  const start = performance.now();
  try {
    publicationLock(run, () => publishImpl(cwd, opts));
  } finally {
    try {
      recordTiming(run, 'publish', performance.now() - start);
    } catch {
      /* timing is not a publish gate */
    }
  }
}

function publishImpl(cwd: string, opts: PublishOpts): void {
  const { run, truth } = loadRun(cwd, opts.run);
  const approval = readJson<Approval>(run, 'approval.json');
  const bodyPath = join(run.dir, 'final-body.md');
  if (!approval || !existsSync(bodyPath))
    throw new UserError('Nothing rendered yet. Run `tracetoon render` first.');
  const problem = snapshotProblem(truth.toplevel, approval.submission);
  if (problem)
    throw new UserError(
      `${problem} Run tracetoon digest --run ${run.id}, then refresh context, description, review and render before publishing.`,
    );
  if (approval.submission?.usedWorkingTree)
    throw new UserError(
      `This render includes uncommitted work. Commit the changes, then run tracetoon digest --run ${run.id} and render again before publishing.`,
    );
  const preparationProblem = publishProblem(truth.toplevel, run, approval);
  if (preparationProblem) throw new UserError(preparationProblem);
  // A brief-path draft that was only checked still needs its slim review.
  const unreviewed = briefPathUnreviewed(run);
  if (unreviewed) {
    if (!opts.noReview) throw new UserError(unreviewed);
    writeJson(run, 'no-review.json', { at: new Date().toISOString() });
  }
  // The review plan from prepare: its passes, lenses, model and effort.
  const planProblem = planGate(run);
  if (planProblem)
    throw new UserError(
      tracetoonRuns(loadReviewPlan(run))
        ? `${planProblem}\nRun the missing passes with tracetoon review run --all --run ${run.id}, render again, then publish.`
        : `${planProblem}\nImport each missing pass with tracetoon review import --run ${run.id}, render again, then publish.`,
    );
  // On a brief path the brief check is the review: open items block publishing.
  const briefOpen = briefPathOpen(run);
  if (briefOpen) {
    if (!opts.acceptOpen)
      throw new UserError(
        `${briefOpen}\nFix body.md and run tracetoon render again. Pass --accept-open only if the user, in their own words, agrees to publish as is.`,
      );
    writeJson(run, 'accepted-open.json', {
      at: new Date().toISOString(),
      reason: briefOpen,
    });
  }
  const body = readFileSync(bodyPath, 'utf8');
  if (codeFor(approval, body) !== approval.code || sha(body) !== approval.bodySha) {
    throw new UserError(
      'The rendered body or publication target changed after rendering. Run `tracetoon render` again.',
    );
  }
  if (approval.findings.length && !approval.allowFindings) {
    throw new UserError(leakNotice(approval));
  }
  const config = loadConfig(truth.toplevel);

  if (approval.comicFile && sha(readFileSync(approval.comicFile)) !== approval.comicSha)
    throw new UserError('The comic image changed after rendering. Render again.');
  const published = readLocal<{ code: string; url: string; hosting: string }>(
    join(run.dir, 'published.json'),
  );
  if (published?.code === approval.code && published.url) {
    // Repair a crash between the durable publication receipt and local lifecycle updates.
    const task = readTask(run);
    if (task) {
      task.state = 'published';
      saveTask(run, task);
      if (task.session)
        acknowledgeRepository(
          task.session,
          truth.toplevel,
          workFingerprint(truth.toplevel),
        );
    }
    emit(
      opts,
      {
        url: published.url,
        mode: approval.mode,
        hosting: published.hosting,
        reused: true,
        message: publishSummary(approval, published.url),
        ci: 'not-waited',
        merged: false,
      },
      () => publishSummary(approval, published.url),
    );
    return;
  }
  type Progress = { code: string; hosted?: Hosted; attemptedCreate?: boolean };
  const progressPath = join(run.dir, 'publish-progress.json');
  let progress = readLocal<Progress>(progressPath);
  if (progress?.code !== approval.code) progress = { code: approval.code };

  {
    const remote = git(truth.toplevel, [
      'ls-remote',
      '--exit-code',
      '--heads',
      'origin',
      `refs/heads/${approval.head}`,
    ]);
    const remoteSha = remote.stdout.trim().split(/\s/)[0];
    if (!remote.ok || remoteSha !== approval.submission!.headSha) {
      if (opts.push === false) {
        throw new UserError(
          remoteSha
            ? `Branch ${approval.head} on GitHub differs from the rendered code. Push it (or re-run with --push) and publish again.`
            : `Branch ${approval.head} is not on GitHub yet. Push it (or re-run with --push) and publish again.`,
        );
      }
      const p = git(truth.toplevel, ['push', '-u', 'origin', approval.head]);
      if (!p.ok) throw new UserError(`git push failed: ${p.stderr.trim()}`);
    }
  }

  // Every gh call below names the repo that was approved; gh's own default never decides.
  const nowTarget = resolveTarget(truth.toplevel)?.repo;
  if (approval.repo && nowTarget?.toLowerCase() !== approval.repo.toLowerCase())
    throw new UserError(
      `The PR was rendered for ${approval.repo}, but this clone now targets ${nowTarget ?? 'no repository'} (origin or gh's default repo changed). Run \`tracetoon context\` (not offline) and \`tracetoon render\` again.`,
    );
  const repo = repoArgs(approval.repo);

  const hosted =
    progress.hosted ??
    hostComic(truth, run, approval, body, opts.hosting ?? config.hosting);
  progress.hosted = hosted;
  writeLocal(progressPath, progress);
  const postedPath = join(run.dir, 'posted-body.md');
  writeFileSync(postedPath, stampSubmission(hosted.body, approval.code), 'utf8');
  const args = ['--title', approval.title, '--body-file', postedPath];
  if (hosted.attach) args.push('--attach', hosted.attach);
  let url: string;
  if (approval.mode === 'edit' && approval.prNumber) {
    const r = gh(truth.toplevel, [
      'pr',
      'edit',
      String(approval.prNumber),
      ...repo,
      ...args,
    ]);
    if (!r.ok) throw new UserError(`gh pr edit failed: ${r.stderr.trim()}`);
    url = gh(truth.toplevel, [
      'pr',
      'view',
      String(approval.prNumber),
      ...repo,
      '--json',
      'url',
      '-q',
      '.url',
    ]).stdout.trim();
  } else {
    const head = prHead(approval.head, truth.remote?.owner, approval.repo);
    const headOwner = head.includes(':') ? head.split(':')[0]!.toLowerCase() : undefined;
    // A timed-out create may have succeeded on GitHub. Reconcile before every create.
    const listing = gh(truth.toplevel, [
      'pr',
      'list',
      '--state',
      'open',
      ...repo,
      '--head',
      approval.head,
      '--base',
      approval.base,
      '--json',
      'number,url,title,body,headRefName,baseRefName,headRefOid,headRepositoryOwner',
    ]);
    if (!listing.ok)
      throw new UserError(
        'Could not check for an existing PR. Retry publication when GitHub is reachable.',
      );
    let existing: {
      url?: string;
      body?: string;
      headRefName?: string;
      baseRefName?: string;
      headRefOid?: string;
      headRepositoryOwner?: { login?: string };
    }[];
    try {
      existing = JSON.parse(listing.stdout);
      if (!Array.isArray(existing)) throw new Error();
      // From a fork, only PRs whose head lives in that fork are ours.
      if (headOwner)
        existing = existing.filter(
          (pr) => (pr.headRepositoryOwner?.login ?? '').toLowerCase() === headOwner,
        );
    } catch {
      throw new UserError(
        'GitHub returned an unreadable PR list; publication stopped before creating a duplicate.',
      );
    }
    const matching = existing.find(
      (pr) =>
        pr.headRefName === approval.head &&
        pr.baseRefName === approval.base &&
        pr.body &&
        decodeMeta(pr.body)?.submission === approval.code,
    );
    if (matching?.url) {
      if (matching.headRefOid && matching.headRefOid !== approval.submission!.headSha)
        throw new UserError(
          'The existing PR head changed; refresh the digest and render before retrying.',
        );
      url = matching.url;
    } else {
      if (
        existing.some(
          (pr) => pr.headRefName === approval.head && pr.baseRefName === approval.base,
        )
      )
        throw new UserError(
          'A PR already exists for this branch and base. Refresh context and review its update instead of creating another.',
        );
      const create = [
        'pr',
        'create',
        ...repo,
        '--base',
        approval.base,
        '--head',
        head,
        ...args,
      ];
      if (opts.draft) create.push('--draft');
      progress.attemptedCreate = true;
      writeLocal(progressPath, progress);
      const r = gh(truth.toplevel, create);
      if (!r.ok) throw new UserError(`gh pr create failed: ${r.stderr.trim()}`);
      url = r.stdout.trim().split(/\s+/).pop() ?? '';
    }
  }
  if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url))
    throw new UserError(
      'Publication returned no PR URL. Retry to reconcile the existing PR.',
    );
  writeLocal(join(run.dir, 'published.json'), {
    url,
    at: new Date().toISOString(),
    code: approval.code,
    hosting: hosted.hosting,
    assetsCommit: hosted.assetsCommit,
  });
  const task = readTask(run);
  if (task) {
    task.state = 'published';
    saveTask(run, task);
    if (task.session)
      acknowledgeRepository(
        task.session,
        truth.toplevel,
        workFingerprint(truth.toplevel),
      );
  }
  const shareScript = readJson<ComicScript>(run, 'comic.json');
  const share =
    hosted.hosting !== 'none'
      ? {
          caption: shareCaption(shareScript, approval.title, url),
          image: hosted.imageUrl ?? null,
        }
      : undefined;
  const message = publishSummary(approval, url);
  emit(
    opts,
    {
      url,
      mode: approval.mode,
      hosting: hosted.hosting,
      message,
      share,
      ci: 'not-waited',
      merged: false,
    },
    () => message,
  );
}

/** Lines of the rendered PR text where the leak scan finds something. */
function leakLocations(title: string, body: string): string[] {
  const at: string[] = [];
  if (scanComment(title).length) at.push('title');
  body.split(/\r?\n/).forEach((line, i) => {
    if (!line.startsWith('<!-- tracetoon:meta') && scanComment(line).length)
      at.push(`final-body.md:${i + 1}`);
  });
  return at;
}

/**
 * The few lines the agent relays after creating the PR: that Tracetoon made
 * it, whether it has a comic (and why not), and how to change that.
 */
export function publishSummary(approval: Approval, url: string): string {
  const number = /\/pull\/(\d+)$/.exec(url)?.[1];
  const verb = approval.mode === 'edit' ? 'updated' : 'created';
  const status = approval.comicStatus;
  const comic =
    !status || status.state === 'included'
      ? status
        ? 'Comic: included.'
        : ''
      : `Comic: none — ${status.detail ?? status.state}.`;
  const left = approval.ambiguousSessions.length;
  return [
    `Tracetoon ${verb} PR${number ? ` #${number}` : ''}: ${url}`,
    comic,
    left
      ? `Left out: ${left} session${left === 1 ? '' : 's'} that may not belong to this PR.`
      : '',
    `Comics: tracetoon config set comic off|allowed|always (now: ${approval.comicMode ?? 'allowed'})`,
  ]
    .filter(Boolean)
    .join('\n');
}
