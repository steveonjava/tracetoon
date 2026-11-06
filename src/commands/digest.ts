import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeResearchPacket } from '../contribution/guidance.ts';
import { loadConfig } from '../config.ts';
import { buildDigestPair, type TraceDigest } from '../digest/build.ts';
import { findPrTemplate, detectAiPolicy } from '../github/repoContext.ts';
import { decodeMeta, humanPart, regionContent, regionEdited } from '../github/body.ts';
import { prTruth, type PrTruth } from '../git/pr.ts';
import { scan, type ScanResult } from '../pipeline.ts';
import { recentComics } from '../github/history.ts';
import { describeTitleRules, readTitleRules } from '../github/titleRules.ts';
import { assertRunOwner, findRun, newRun, readJson, writeJson } from '../run.ts';
import { recordTiming } from '../workflow/publication.ts';
import { emit, UserError, type OutOpts } from './output.ts';
import { submissionSnapshot } from '../review/snapshot.ts';
import { checkReport, receiptEvidence } from '../workflow/checks.ts';
import { detectInterop } from '../git/interop.ts';
import { readTask, saveTask } from '../workflow/state.ts';
import { receipts } from '../workflow/checks.ts';
import { fileHash } from '../workflow/readiness.ts';
import { makeScrubber } from '../digest/sanitize.ts';
import { digestFact } from '../digest/facts.ts';
import { evidenceNotes } from '../digest/notes.ts';
import { repository, workFingerprint } from '../workflow/state.ts';
import type { Run } from '../run.ts';
import { count } from '../util/profile.ts';
import {
  graphEnricher,
  graphOutline,
  saveGraph,
  type GraphOutcome,
} from '../graph/evidence.ts';

export interface ScanOpts extends OutOpts {
  base?: string;
  offline?: boolean;
}

export function scanCmd(cwd: string, opts: ScanOpts): void {
  const { truth, matches } = scan(cwd, { base: opts.base, noGh: opts.offline });
  const rows = matches.map((m) => ({
    session: m.session.sessionId,
    agent: m.session.agent,
    title: m.session.title,
    score: m.score,
    band: m.band,
    reasons: m.reasons,
    keptRecords: m.kept.length,
  }));
  emit(
    opts,
    { head: truth.head, base: truth.base, commits: truth.commits.length, sessions: rows },
    () => {
      const head = `${truth.head} -> ${truth.base}: ${truth.commits.length} commit(s), ${truth.files.length} file(s)`;
      if (!rows.length) return `${head}\nNo agent sessions found for this repository.`;
      return [
        head,
        ...rows.map(
          (r) =>
            `  ${r.band.padEnd(9)} ${r.score.toFixed(2)}  ${r.agent}  ${r.title ?? r.session.slice(0, 8)}\n` +
            `            ${r.reasons.join('; ')}`,
        ),
      ].join('\n');
    },
  );
}

export interface DigestOpts extends ScanOpts {
  run?: string;
  include?: string[];
  exclude?: string[];
  budget?: number;
}

export function digestHash(d: TraceDigest): string {
  const { generatedAt: _ignored, ...stable } = d;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 12);
}

export function digestCmd(
  cwd: string,
  opts: DigestOpts,
  shared?: ScanResult,
  display = true,
) {
  const { truth, matches } = shared ?? scan(cwd, { base: opts.base, noGh: opts.offline });
  const run = opts.run ? findRun(truth.gitDir, opts.run) : newRun(truth.gitDir);
  assertRunOwner(run, truth.toplevel, truth.head);
  const config = loadConfig(truth.toplevel);
  const selected = readJson<{ include?: string[]; exclude?: string[] }>(
    run,
    'session-selection.json',
  );
  const build = {
    include: opts.include ?? selected?.include,
    exclude: opts.exclude ?? selected?.exclude,
  };
  // Both digests describe the same truth; read its provenance once.
  const interop = detectInterop(truth);
  const graph: GraphOutcome = {};
  const { digest, full, extractionMs, projectionMs } = buildDigestPair(truth, matches, {
    ...build,
    interop,
    budgetTokens: opts.budget ?? config.budgetTokens,
    enrich: graphEnricher(truth, graph),
  });
  try {
    recordTiming(run, 'digest-extraction', extractionMs);
    recordTiming(run, 'digest-projection', projectionMs);
  } catch {
    // Optional telemetry must not prevent creation of the evidence packet.
  }
  if (readTask(run)) {
    const report = checkReport(truth.toplevel, run);
    const validation = report.map((c) => ({
      name: c.name,
      command: c.command.join(' '),
      outcome: c.outcome,
      current: c.current,
      reason: c.reason,
      durationMs: c.durationMs,
    }));
    const verification = receiptEvidence(truth.toplevel, run, report);
    digest.verification = full.verification = verification;
    digest.checksSha = full.checksSha = receipts(run).length
      ? fileHash(run, 'checks.json')
      : undefined;
    const noChecks = readTask(run)?.noChecksReason;
    if (noChecks)
      validation.push({
        name: 'No local checks applicable',
        command: '',
        outcome: 'not-run',
        current: true,
        reason: makeScrubber([truth.toplevel]).text(noChecks),
        durationMs: 0,
      });
    digest.validation = full.validation = validation;
  }
  const previous = opts.run
    ? readJson<{ head: string }>(run, 'approval.json')
    : undefined;
  if (previous?.head && previous.head !== truth.head)
    throw new UserError(
      `This run belongs to branch ${previous.head}. Switch to that branch before refreshing it.`,
    );
  // Retain preparation ownership for existing run records; this never holds the session open.
  const task = readTask(run);
  if (task && task.state !== 'published') {
    // The session running the digest is the one asking; the task owner is a fallback.
    const by =
      process.env.CODEX_THREAD_ID ||
      process.env.CLAUDE_CODE_SESSION_ID ||
      process.env.CLAUDE_SESSION_ID ||
      task.session;
    if (!task.prRequestedAt || (by && task.prRequestedBy !== by)) {
      task.prRequestedAt ??= new Date().toISOString();
      if (by) task.prRequestedBy = by;
    }
    if (
      task.state === 'working' ||
      task.state === 'blocked' ||
      task.state === 'deferred'
    ) {
      if (task.state !== 'working')
        task.recoveryGeneration = (task.recoveryGeneration ?? 0) + 1;
      task.state = 'preparing';
      task.reason = undefined;
    }
    saveTask(run, task);
  }
  writeJson(run, 'session-selection.json', build);
  const path = writeJson(run, 'digest.json', digest);
  writeJson(run, 'digest-full.json', full);
  saveGraph(run, graph);
  const outline = graph.graph ? graphOutline(graph.graph) : undefined;
  writeFileSync(join(run.dir, 'evidence-notes.md'), evidenceNotes(full, outline), 'utf8');
  const captured = submissionSnapshot(truth);
  writeJson(run, 'submission.json', captured);
  const ambiguous = digest.sessions.filter((s) => s.band === 'ambiguous');
  if (display)
    emit(
      opts,
      {
        run: run.id,
        runDir: run.dir,
        digestPath: path,
        evidenceNotesPath: join(run.dir, 'evidence-notes.md'),
        sessions: digest.sessions.map((s) => ({
          ref: s.ref,
          agent: s.agent,
          title: s.title,
          band: s.band,
          score: s.score,
        })),
        ambiguous: ambiguous.map((s) => s.ref),
        stats: digest.stats,
        notes: digest.notes,
      },
      () =>
        [
          `Run ${run.id}: digest written to ${path}`,
          `${digest.sessions.length} session(s): ` +
            digest.sessions
              .map(
                (s) => `${s.ref} ${s.agent} "${s.title ?? ''}" (${s.band}, ${s.score})`,
              )
              .join('; '),
          ambiguous.length
            ? `Ambiguous, left out: ${ambiguous.map((s) => s.ref).join(', ')}. The PR message says so; re-run with --include only if one clearly belongs.`
            : '',
          ...digest.notes,
        ]
          .filter(Boolean)
          .join('\n'),
    );
  return { truth, run, digest, full, captured, graph: graph.graph, outline };
}

export function expandCmd(
  cwd: string,
  ref: string | string[],
  opts: OutOpts & { run?: string },
): void {
  const repo = repository(cwd);
  const run = findRun(repo.gitDir, opts.run);
  assertRunOwner(run, repo.root, repo.branch);
  const full = readJson<TraceDigest>(run, 'digest-full.json');
  const refs = typeof ref === 'string' ? [ref] : ref;
  count('evidence.requestedRefs', refs.length);
  if (refs.length > 1) count('evidence.batchExpansions');
  const records = refs.map((id) => {
    const evidence = full && digestFact(full, id);
    if (!evidence) throw new UserError(`No evidence ${id} in run ${run.id}.`);
    return { ref: id, evidence };
  });
  const value = records.length === 1 ? records[0]!.evidence : records;
  emit(opts, value, () => JSON.stringify(value, null, 2));
}

export function contextCmd(
  cwd: string,
  opts: OutOpts & { run?: string; offline?: boolean },
  prepared?: { truth: PrTruth; run: Run },
  display = true,
) {
  let truth = prepared?.truth ?? prTruth(cwd, { noGh: opts.offline });
  let run;
  if (prepared) run = prepared.run;
  else if (opts.run) run = findRun(truth.gitDir, opts.run);
  else {
    try {
      run = findRun(truth.gitDir);
    } catch {
      run = newRun(truth.gitDir);
    }
  }
  assertRunOwner(run, truth.toplevel, truth.head);
  const digest = readJson<TraceDigest>(run, 'digest.json');
  if (digest?.pr.base && digest.pr.base !== truth.base)
    truth = prTruth(cwd, { base: digest.pr.base, noGh: opts.offline });
  const contribution = writeResearchPacket(run, truth, opts.offline);
  const template = findPrTemplate(truth.toplevel);
  const policy = detectAiPolicy(truth.toplevel);
  const titleRules = readTitleRules(truth.toplevel, {
    offline: opts.offline,
    repo: truth.remote ? `${truth.remote.owner}/${truth.remote.name}` : undefined,
  });
  const config = loadConfig(truth.toplevel);
  // Compact creative choices help this comic differ. Skipped when comics are off.
  const recent =
    config.comic !== 'off' ? recentComics(truth, { offline: opts.offline }) : [];
  const ctx = {
    repo: truth.remote ? `${truth.remote.owner}/${truth.remote.name}` : null,
    head: truth.head,
    base: truth.base,
    template: template ?? null,
    aiPolicy: policy,
    existingPr: truth.pr
      ? {
          number: truth.pr.number,
          url: truth.pr.url,
          title: truth.pr.title,
          humanBody: humanPart(truth.pr.body),
          body: truth.pr.body,
          // Someone edited Tracetoon's section on GitHub since it was posted:
          // their text is the starting point, not something to overwrite.
          editedOnGitHub: regionEdited(truth.pr.body) ?? false,
          editedText: regionEdited(truth.pr.body)
            ? regionContent(truth.pr.body)
            : undefined,
          previous: decodeMeta(truth.pr.body) ?? null,
        }
      : null,
    config,
    comic: {
      recentStyles: recent.flatMap((c) => (c.style ? [c.style] : [])),
      recentComics: recent,
    },
    titleRules,
    contribution,
  };
  writeJson(run, 'context.json', ctx);
  if (display)
    emit(
      opts,
      {
        run: run.id,
        ...ctx,
        runDir: run.dir,
        contextPath: join(run.dir, 'context.json'),
        existingPr: ctx.existingPr && { ...ctx.existingPr, body: undefined },
      },
      () =>
        [
          `Run ${run.id}: context written`,
          `PR: ${ctx.existingPr ? `#${ctx.existingPr.number} ${ctx.existingPr.title}` : 'none yet (will create one)'}`,
          ...(ctx.existingPr?.editedOnGitHub
            ? [
                "Note: Tracetoon's section of this PR was edited on GitHub since it was posted. Start from that text (existingPr.editedText) and keep the edits.",
              ]
            : ctx.existingPr?.humanBody
              ? [
                  'Note: this PR already has a description written by someone. Keep it; add to it rather than replacing it.',
                ]
              : []),
          `Template: ${template ? template.path : 'none'}`,
          `Contribution research: ${contribution.sourceSeeds.length} source seed(s); guidance-request.json and changes.patch written${contribution.offline ? ' (offline: do not browse external links)' : ''}.`,
          `AI policy: ${policy.verdict}${policy.excerpts.length ? ` (${policy.excerpts.length} mention(s))` : ''}`,
          ...policy.excerpts.slice(0, 5).map((e) => `  ${e.file}:${e.line}: ${e.text}`),
          `prompt quoting: ${config.promptQuoting} | comic: ${config.comic}`,
          ...describeTitleRules(titleRules),
          config.comic === 'off'
            ? ''
            : config.style && config.style !== 'auto'
              ? `Comic style: pinned to ${config.style}`
              : `Comic: choose the story, composition and cast; compare recent creative choices (${
                  recent
                    .map((c) => c.style)
                    .filter(Boolean)
                    .join('; ') || 'none yet'
                })`,
        ]
          .filter(Boolean)
          .join('\n'),
    );
  return { run, context: ctx };
}

/** One immutable preparation snapshot shared by digest and contributor research. */
/**
 * The first drafting step, printed where every drafter looks: agents that
 * write the description themselves often go from `prepare` straight to the
 * body, past the skill's drafter instructions.
 */
export function graphNext(run: string): string {
  return `before drafting, map the change with the evidence graph: \`tracetoon query outline --run ${run}\`, then \`tracetoon query why <path> --run ${run}\` for each behavior file. Then read every behavior hunk it lists and expand commits marked with a message body.`;
}

export function prepareCmd(cwd: string, opts: DigestOpts) {
  const repo = repository(cwd);
  const before = workFingerprint(repo.root);
  const shared = scan(cwd, { base: opts.base, noGh: opts.offline });
  const prepared = digestCmd(cwd, opts, shared, false);
  const context = contextCmd(cwd, { ...opts, run: prepared.run.id }, prepared, false);
  if (workFingerprint(repo.root) !== before)
    throw new UserError(
      'Repository changed during preparation. Retained outputs are stale; prepare again after finalizing the changes.',
    );
  const roles = {
    schema: 'tracetoon.role-packets/v1',
    run: prepared.run.id,
    snapshot: {
      headBranch: shared.truth.head,
      headSha: prepared.captured.headSha,
      diffSha256: prepared.captured.diffSha256,
      mergeBase: shared.truth.mergeBase,
      digest: digestHash(prepared.full),
      sourceFingerprint: before,
    },
    researcher: ['guidance-request.json', 'context.json', 'changes.patch'],
    drafter: [
      'digest.json',
      'evidence-notes.md',
      'changes.patch',
      'context.json',
      'guidance.json',
      'author.md',
    ],
    reviewerColdRead: ['title.txt', 'final-body.md'],
    reviewerEvidence: [
      'review-input.json',
      'changes.patch',
      'source-evidence.json',
      'guidance.json',
      'digest.json',
      'evidence-notes.md',
      'change-map.json',
    ],
    graph: prepared.graph
      ? {
          path: 'evidence-graph.json',
          stats: prepared.graph.stats,
          drafter: ['outline', 'why <path>', 'turn <S#>', 'unverified'],
          reviewer: ['unverified', 'unexplained', 'why <path|H#>', 'stale <R#>'],
        }
      : null,
    instructions:
      'Use fresh role contexts where supported. Read the cold-read packet before the reviewer evidence. Expand referenced evidence in batches; missing evidence remains unknown. Drafter and reviewer: ask the evidence graph with `tracetoon query <name> --run <id>` (start with `outline`) before reading the whole patch; its diff refs are citable as change-map behaviorChecks evidence.',
  };
  writeJson(prepared.run, 'role-packets.json', roles);
  emit(
    opts,
    {
      run: prepared.run.id,
      ...(prepared.graph ? { next: graphNext(prepared.run.id) } : {}),
      // One JSON line, so piping through `head` still shows the whole map.
      ...(prepared.outline ? { graphOutline: prepared.outline } : {}),
      runDir: prepared.run.dir,
      rolePackets: join(prepared.run.dir, 'role-packets.json'),
      digestPath: join(prepared.run.dir, 'digest.json'),
      contextPath: join(prepared.run.dir, 'context.json'),
      ...context.context.contribution,
    },
    () =>
      [
        `Run ${prepared.run.id}: digest, context and role-packets.json prepared from one snapshot.`,
        prepared.graph ? `Next: ${graphNext(prepared.run.id)}` : '',
        prepared.outline ? `Evidence graph outline:\n${prepared.outline}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
  );
  return prepared;
}
