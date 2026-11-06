/**
 * Optional, skippable notes for the author, shown beside the draft. Each names
 * something a reviewer may want that the captured evidence doesn't cover, says
 * what *was* captured, and never claims something wasn't done (it may have
 * happened outside the logs). Nothing here blocks or asks before drafting.
 */
import type { Run, TraceDigest } from './build.ts';
import type { ClaimFinding } from './claims.ts';

export interface ContextNote {
  topic: 'validation' | 'ui' | 'rationale' | 'attribution' | 'review';
  text: string;
}

const UI_FILE =
  /\.(css|scss|sass|less|html|tsx|jsx|vue|svelte|xaml|storyboard|swiftui)$/i;
const CAUSAL =
  /\b(because|so that|in order to|to avoid|to keep|since|which means|otherwise|so the|so it)\b/i;
const REVIEW_POINTER =
  /\b(start(s|ing)? (with|at|in|by)|where to (start|look)|review path|reading order|read [^.\n]{1,80} first|review(ing|ers?)? (should|could)? ?(start|focus|look))/i;
const VISUAL =
  /\b(screenshot|by eye|visually|in the browser|manually checked|looked at)\b/i;

export function contextNotes(
  digest: Pick<TraceDigest, 'sessions' | 'files' | 'stats' | 'verification'>,
  body: string,
  claims: ClaimFinding[] = [],
): ContextNote[] {
  const notes: ContextNote[] = [];
  const included = digest.sessions.filter((s) => s.band === 'included');
  const runs = [
    ...included.flatMap((s) => s.runs ?? []),
    ...(digest.verification ?? []),
  ].filter((r) => r.revision !== 'after later work');
  const behavior = digest.files.filter((f) => (f.role ?? 'behavior') === 'behavior');
  const behaviorAdded = behavior.reduce((n, f) => n + f.added, 0);

  if (behavior.length && !runs.length)
    notes.push({
      topic: 'validation',
      text: 'No test, build or check result was captured for this change. If you ran checks elsewhere (CI, another terminal), add a line saying what ran.',
    });
  const tests = runs.filter((r) => r.kind === 'test');
  const lastTest = tests[tests.length - 1];
  if (lastTest && lastTest.revision === 'before later edits' && !/\bbefore\b/i.test(body))
    notes.push({
      topic: 'validation',
      text: `The last captured test run (${lastTest.cmd}) was before the final edits. Re-run it, or say it passed before them.`,
    });
  if (digest.files.some((f) => UI_FILE.test(f.path)) && !VISUAL.test(body))
    notes.push({
      topic: 'ui',
      text: 'This changes UI files and no visual check was captured. If you looked at it, add what you checked or a screenshot.',
    });
  const decided = included.some(
    (s) => s.decisions.length || s.plans.some((p) => p.approved),
  );
  if (behavior.length && !decided && !CAUSAL.test(body))
    notes.push({
      topic: 'rationale',
      text: "The trace doesn't record why this approach was taken. Add a sentence if reviewers will wonder.",
    });
  if (digest.stats.unmatchedPct > 50)
    notes.push({
      topic: 'attribution',
      text: `About ${digest.stats.unmatchedPct}% of the added lines aren't matched to captured agent edits (formatters, shell edits, other tools or hand edits). Say so if parts were written another way and it helps reviewers.`,
    });
  if (behaviorAdded > 300 && !REVIEW_POINTER.test(body))
    notes.push({
      topic: 'review',
      text: 'This is a large change; a short review path helps: the main idea or riskiest part first, then the key test, then what is mechanical.',
    });
  // Claims the check couldn't establish are already marked beside the text.
  void claims;
  return notes;
}

/**
 * An outline of the evidence for authors who write the description themselves
 * (or must, by the repo's policy). Facts only, grouped; no prose to copy.
 */
export function evidenceNotes(
  digest: Pick<
    TraceDigest,
    'sessions' | 'files' | 'pr' | 'verification' | 'validation' | 'graph'
  >,
  outline?: string,
): string {
  const included = digest.sessions.filter((s) => s.band === 'included');
  const lines: string[] = ['# Notes to write from', ''];
  if (digest.graph)
    lines.push(
      'Start with the evidence graph: `tracetoon query outline`, then `tracetoon query why <path>` for each behavior file. It maps every hunk to the request behind it and marks commits whose message explains them.',
      '',
    );
  if (outline)
    lines.push(
      '## Evidence graph outline (`tracetoon query outline`)',
      '',
      '```',
      outline,
      '```',
      '',
      'Each file lists the prompts whose edits survive in it and the commits that touched it; commits marked with a body hold an explanation worth expanding. `tracetoon query why <path>` gives each hunk with whether a captured edit explains it.',
      '',
    );
  const asks = included.flatMap((s) =>
    s.prompts.filter((p, i) => p.ledToEdits || p.pushback || i === 0),
  );
  if (asks.length) {
    lines.push('## What was asked (your prompts that shaped the change)');
    for (const p of asks)
      lines.push(
        `- ${p.id}: ${p.text.replace(/\s+/g, ' ').slice(0, 400)}${p.pushback ? ' _(pushback)_' : ''}`,
      );
    lines.push('');
  }
  const decisions = included.flatMap((s) =>
    s.decisions.flatMap((d) => d.questions ?? []),
  );
  if (decisions.length) {
    lines.push('## Decisions you made');
    for (const q of decisions)
      lines.push(
        `- ${q.question} → ${q.answer ?? '(answer not recorded)'}${q.ownWords ? ' _(in your own words)_' : ''}`,
      );
    lines.push('');
  }
  const plans = included.flatMap((s) => s.plans);
  if (plans.length) {
    lines.push('## Plans');
    for (const p of plans)
      lines.push(
        `- ${p.approved === false ? 'Sent back' : p.approved ? 'Approved' : 'Proposed'}: ${p.excerpt.split('\n')[0]!.replace(/^#+\s*/, '')}`,
      );
    lines.push('');
  }
  const history = included
    .flatMap((s) => s.runs ?? [])
    .filter((r) => r.revision !== 'after later work')
    .sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''));
  const lastByCommand = new Map(history.map((r) => [r.cmd, r]));
  const historicalScope = (r: Run) =>
    r.revision === 'before later edits'
      ? 'before later edits; tested content unverified'
      : 'tested content unverified';
  if (lastByCommand.size) {
    lines.push('## Historical checks (log evidence, not proof of the submitted content)');
    for (const r of [...lastByCommand.values()]
      .sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''))
      .slice(-12)) {
      lines.push(
        `- ${r.id}: \`${r.cmd}\`: ${r.outcome}; ${historicalScope(r)}${r.summary.length ? ` (${r.summary.join(', ')})` : ''}`,
      );
      const earlierPass = history
        .filter((p) => p.cmd === r.cmd && p.outcome === 'passed')
        .at(-1);
      if (r.outcome !== 'passed' && earlierPass)
        lines.push(
          `  Earlier ${earlierPass.id}: passed; ${historicalScope(earlierPass)}. The later result does not erase this historical run.`,
        );
    }
    if (lastByCommand.size > 12)
      lines.push('- More historical commands are available in digest-full.json.');
    lines.push('');
  }
  if (digest.verification?.length) {
    lines.push('## Current validation receipts');
    for (const r of digest.verification)
      lines.push(
        `- ${r.id}: \`${r.cmd}\`: ${r.outcome}; receipt matches current content and environment.`,
      );
    lines.push('');
  }
  const gaps =
    digest.validation?.filter(
      (c) => !c.current || !['passed', 'failed'].includes(c.outcome),
    ) ?? [];
  if (gaps.length) {
    lines.push('## Stale, missing or unavailable validation');
    for (const c of gaps)
      lines.push(
        `- ${c.name}: ${c.current ? c.outcome : 'stale'}${c.reason ? `; ${c.reason}` : ''}`,
      );
    lines.push('');
  }
  const explanations = digest.pr.commits.filter((c) => c.body);
  if (explanations.length) {
    lines.push('## Commit explanations (attribute these accounts to the commit)');
    for (const c of explanations)
      lines.push(`- commit:${c.sha}: ${c.body!.slice(0, 1200)}`);
    lines.push('');
  }
  const traced = digest.files.filter(
    (f) => (f.role ?? 'behavior') === 'behavior' || f.role === 'tests',
  );
  if (traced.some((f) => f.facts || f.checksAfterLastEdit)) {
    lines.push('## Where each change came from (evidence graph)');
    for (const f of traced.slice(0, 15)) {
      const from = f.facts?.length ? f.facts.join(', ') : 'no captured prompt';
      const checks = f.checksAfterLastEdit?.length
        ? `checks after its last captured edit: ${f.checksAfterLastEdit.join(', ')}`
        : 'no check captured after its last edit';
      lines.push(`- ${f.path}: ${from}; ${checks}`);
    }
    if (traced.length > 15) lines.push(`- ${traced.length - 15} more files.`);
    lines.push(
      '',
      'Ask `tracetoon query why <path>` for the turns, diff refs and commits behind a file, `tracetoon query unverified` for files no check followed, and `tracetoon query outline` for the whole map.',
      '',
    );
  }
  const byRole = new Map<string, string[]>();
  for (const f of digest.files) {
    const role = f.role ?? 'behavior';
    byRole.set(role, [...(byRole.get(role) ?? []), f.path]);
  }
  lines.push('## What changed, by role');
  for (const [role, paths] of byRole)
    lines.push(
      `- ${role}: ${paths.length > 6 ? `${paths.slice(0, 6).join(', ')} and ${paths.length - 6} more` : paths.join(', ')}`,
    );
  if (digest.pr.dirty)
    lines.push('', '_Uncommitted changes existed when this was made._');
  return lines.join('\n') + '\n';
}
