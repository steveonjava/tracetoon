/**
 * The review plan: how many fresh reviewer passes a run needs, with which
 * lenses, and on which reviewer model and effort. `prepare` stores it in the
 * run folder (review-plan.json) from the SKILL's `Review passes:`,
 * `Review lenses:`, `Reviewer model:` and `Reviewer effort:` lines, so publish
 * enforces it without reading SKILL.md. Each `review import` records one pass
 * in review.json `passes`.
 *
 * A plan at its defaults (1 pass, no lenses, no model, no effort) adds no gate:
 * the single-reviewer flow behaves as before.
 */
import { readJson, writeJson, type Run } from '../run.ts';
import { hostAgent, type HostAgent } from '../util/host.ts';

export const PLAN_FILE = 'review-plan.json';
export const REVIEW_LENSES = ['a', 'b', 'c', 'd'] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];
export const REVIEWER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/**
 * Who runs the reviewer: `agent` (the drafting agent starts it and reports its
 * id and model) or `tracetoon` (`tracetoon review run` starts `codex exec` with
 * the model pinned and verifies it from the session rollout).
 */
export const REVIEWER_RUNNERS = ['agent', 'tracetoon'] as const;
export type ReviewerRunner = (typeof REVIEWER_RUNNERS)[number];
/**
 * `Reviewer runner: auto`: the host's own reviewer agents on Claude Code,
 * `tracetoon review run` (codex exec, model verified) on Codex, and `agent`
 * when the host is unknown.
 */
export const AUTO_RUNNER: Record<HostAgent, ReviewerRunner> = {
  claude: 'agent',
  codex: 'tracetoon',
};
/**
 * `Reviewer model: cheap`: the host's small fast model (Claude Code's haiku,
 * Codex's luna = gpt-6-luna). Unknown host: same as the main agent.
 */
export const CHEAP_MODELS: Record<HostAgent, string> = {
  claude: 'haiku',
  codex: 'luna',
};
/**
 * Whether reviewers recheck the drafter's correction round (SKILL `Review
 * recheck:`): `once` (every reviewer confirms the changed lines once),
 * `contested` (only reviewers whose findings the drafter rejected) or `none`.
 * Publish never requires a recheck: it is advice, not part of the gate.
 */
export const REVIEW_RECHECKS = ['once', 'contested', 'none'] as const;
export type ReviewRecheck = (typeof REVIEW_RECHECKS)[number];

/** SKILL short model names → Codex model ids. Anything else is used as given. */
export const CODEX_MODELS: Record<string, string> = {
  terra: 'gpt-6.1-terra',
  luna: 'gpt-6-luna',
  sol: 'gpt-6.1-sol',
};
export const resolveCodexModel = (name: string): string =>
  CODEX_MODELS[name.trim().toLowerCase()] ?? name.trim();

export interface ReviewPlan {
  v: 1;
  /** Fresh reviewer passes, from distinct reviewer agents. */
  passes: number;
  /** One pass per lens; the required pass count is at least the lens count. */
  lenses: ReviewLens[];
  reviewerModel?: string;
  reviewerEffort?: string;
  /** Stored only when `tracetoon`: passes must come from `tracetoon review run`. */
  runner?: 'tracetoon';
  /** Stored only when not `once` (the default). */
  recheck?: Exclude<ReviewRecheck, 'once'>;
}

/** One imported reviewer pass, as review.json `passes` records it. */
export interface ReviewPass {
  pass: number;
  agentId: string;
  model?: string;
  effort?: string;
  lens?: ReviewLens;
  /** How many findings the pass reported. */
  findings: number;
  importedAt: string;
  /** Set by `tracetoon review run`: Tracetoon started the reviewer itself. */
  source?: 'tracetoon-run';
  runner?: 'codex-exec';
  /** The Codex session (thread) id of the reviewer. */
  sessionId?: string;
  /** The model the session rollout says it ran on; null when no rollout was found. */
  verifiedModel?: string | null;
  /** sha256 of the body text the pass reviewed (for --recheck). */
  bodySha256?: string;
  /** `tracetoon review run`'s slot: the lens, `general` or `general<k>` (its file names). */
  slot?: string;
}

/** SKILL line values that mean "nothing chosen". */
const UNSET =
  /^(|none|default|same|same as (the )?main( agent)?|same as the main agent|-)$/i;
const clean = (v: unknown) =>
  v === undefined || v === null ? '' : String(v).trim().replace(/\.$/, '').trim();

export function parseLenses(value: unknown): ReviewLens[] {
  const s = clean(value);
  if (UNSET.test(s)) return [];
  const out: ReviewLens[] = [];
  for (const raw of s.split(/[\s,]+/).filter(Boolean)) {
    const l = raw.toLowerCase().replace(/^lens[-_]?/, '');
    if (!(REVIEW_LENSES as readonly string[]).includes(l))
      throw new Error(
        `Unknown review lens "${raw}": use ${REVIEW_LENSES.join(', ')} or none.`,
      );
    if (!out.includes(l as ReviewLens)) out.push(l as ReviewLens);
  }
  return out;
}

export function parseLens(value: unknown): ReviewLens | undefined {
  const lenses = parseLenses(value);
  if (lenses.length > 1) throw new Error('Give one lens: a, b or c.');
  return lenses[0];
}

export function parseEffort(value: unknown): string | undefined {
  const s = clean(value).toLowerCase();
  if (UNSET.test(s)) return undefined;
  if (!(REVIEWER_EFFORTS as readonly string[]).includes(s))
    throw new Error(
      `Unknown reviewer effort "${clean(value)}": use ${REVIEWER_EFFORTS.join(', ')} or default.`,
    );
  return s;
}

/** A reviewer model name; `cheap` resolves for the host (undefined when unknown). */
export function parseModel(
  value: unknown,
  host: HostAgent | null = hostAgent() ?? null,
): string | undefined {
  const s = clean(value);
  if (UNSET.test(s)) return undefined;
  if (s.toLowerCase() === 'cheap') return host ? CHEAP_MODELS[host] : undefined;
  return s;
}

/** A reviewer runner; `auto` resolves for the host (agent when unknown). */
export function parseRunner(
  value: unknown,
  host: HostAgent | null = hostAgent() ?? null,
): ReviewerRunner | undefined {
  const s = clean(value).toLowerCase();
  if (!s || /^(default|none|-)$/.test(s)) return undefined;
  if (s === 'auto') return host ? AUTO_RUNNER[host] : 'agent';
  if (!(REVIEWER_RUNNERS as readonly string[]).includes(s))
    throw new Error(
      `Unknown reviewer runner "${clean(value)}": use ${REVIEWER_RUNNERS.join(', ')} or auto.`,
    );
  return s as ReviewerRunner;
}

export function parseRecheck(value: unknown): ReviewRecheck | undefined {
  const s = clean(value).toLowerCase();
  if (!s || /^(default|-)$/.test(s)) return undefined;
  if (!(REVIEW_RECHECKS as readonly string[]).includes(s))
    throw new Error(
      `Unknown review recheck "${clean(value)}": use ${REVIEW_RECHECKS.join(', ')}.`,
    );
  return s as ReviewRecheck;
}

/** The plan's recheck setting (default once). */
export const planRecheck = (plan: ReviewPlan | undefined): ReviewRecheck =>
  plan?.recheck ?? 'once';

export function parsePasses(value: unknown): number | undefined {
  const s = clean(value);
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 9)
    throw new Error(`Review passes must be a whole number from 1 to 9, not "${s}".`);
  return n;
}

export interface PlanOptions {
  reviewPasses?: unknown;
  reviewLenses?: unknown;
  reviewerModel?: unknown;
  reviewerEffort?: unknown;
  reviewerRunner?: unknown;
  reviewRecheck?: unknown;
}

/**
 * The plan `prepare` was asked for; undefined when no review option was given.
 * `cheap` and `auto` are resolved here, for the host running prepare, so the
 * stored plan (and prepare's next step) names a concrete model and runner.
 */
export function planFromOptions(
  opts: PlanOptions,
  host: HostAgent | null = hostAgent() ?? null,
): ReviewPlan | undefined {
  if (
    opts.reviewPasses === undefined &&
    opts.reviewLenses === undefined &&
    opts.reviewerModel === undefined &&
    opts.reviewerEffort === undefined &&
    opts.reviewerRunner === undefined &&
    opts.reviewRecheck === undefined
  )
    return undefined;
  const model = parseModel(opts.reviewerModel, host);
  const effort = parseEffort(opts.reviewerEffort);
  const runner = parseRunner(opts.reviewerRunner, host);
  const recheck = parseRecheck(opts.reviewRecheck);
  return {
    v: 1,
    passes: parsePasses(opts.reviewPasses) ?? 1,
    lenses: parseLenses(opts.reviewLenses),
    ...(model ? { reviewerModel: model } : {}),
    ...(effort ? { reviewerEffort: effort } : {}),
    ...(runner === 'tracetoon' ? { runner } : {}),
    ...(recheck && recheck !== 'once' ? { recheck } : {}),
  };
}

export function saveReviewPlan(run: Run, plan: ReviewPlan): void {
  writeJson(run, PLAN_FILE, plan);
}

/** The run's plan; undefined when prepare stored none. */
export function loadReviewPlan(run: Run): ReviewPlan | undefined {
  const raw = readJson<Partial<ReviewPlan>>(run, PLAN_FILE);
  if (!raw) return undefined;
  return {
    v: 1,
    passes: Number.isInteger(raw.passes) && raw.passes! > 0 ? raw.passes! : 1,
    lenses: (raw.lenses ?? []).filter((l): l is ReviewLens =>
      (REVIEW_LENSES as readonly string[]).includes(l),
    ),
    ...(raw.reviewerModel ? { reviewerModel: raw.reviewerModel } : {}),
    ...(raw.reviewerEffort ? { reviewerEffort: raw.reviewerEffort } : {}),
    ...(raw.runner === 'tracetoon' ? { runner: 'tracetoon' as const } : {}),
    ...(raw.recheck === 'none' || raw.recheck === 'contested'
      ? { recheck: raw.recheck }
      : {}),
  };
}

/** Whether publish requires passes run (and model-verified) by `tracetoon review run`. */
export const tracetoonRuns = (plan: ReviewPlan | undefined): boolean =>
  !!plan && plan.runner === 'tracetoon' && !!plan.reviewerModel;

/**
 * The recheck step after the drafter's one edit pass, by `Review recheck:`.
 * Every variant ends with the review bound to the new render; none of them is
 * part of the publish gate.
 */
export function recheckStep(run: string, plan: ReviewPlan | undefined): string {
  const rebind = `\`tracetoon review import --run ${run} --rebind\``;
  const recheck = planRecheck(plan);
  if (tracetoonRuns(plan))
    return recheck === 'none'
      ? `no reviewer recheck (Review recheck: none): ${rebind}`
      : recheck === 'contested'
        ? `only if you rejected a finding, \`tracetoon review run --all --recheck --run ${run}\` (it rechecks just the passes whose findings you rejected; pass your reasons with --note), else ${rebind}`
        : `\`tracetoon review run --all --recheck --run ${run}\` once`;
  return recheck === 'none'
    ? `no reviewer recheck (Review recheck: none): ${rebind}`
    : recheck === 'contested'
      ? `only for findings you rejected, send the reviewer that raised them your rejection and its diff line (SendMessage / followup_task) and re-import it; then ${rebind}`
      : `send the same reviewer(s) the changed lines and your rejections once (SendMessage / followup_task), re-import each, then ${rebind}`;
}

/** Passes the plan needs: at least one per lens. */
export const requiredPasses = (plan: ReviewPlan) =>
  Math.max(plan.passes, plan.lenses.length);

/** Whether the plan asks for more than the default single reviewer. */
export function planEnforced(plan: ReviewPlan | undefined): plan is ReviewPlan {
  return (
    !!plan &&
    (requiredPasses(plan) > 1 ||
      plan.lenses.length > 0 ||
      !!plan.reviewerModel ||
      !!plan.reviewerEffort)
  );
}

/** The plan in one line, e.g. "3 passes from distinct reviewers (lenses a, b, c), model sonnet, effort xhigh". */
export function planSummary(plan: ReviewPlan): string {
  const n = requiredPasses(plan);
  return [
    `${n} fresh reviewer pass${n === 1 ? '' : 'es'}${n > 1 ? ' from distinct reviewer agents' : ''}`,
    plan.lenses.length ? `one per lens ${plan.lenses.join(', ')}` : '',
    plan.reviewerModel ? `reviewer model ${plan.reviewerModel}` : '',
    plan.reviewerEffort ? `reviewer effort ${plan.reviewerEffort}` : '',
    tracetoonRuns(plan) ? 'run by tracetoon review run' : '',
    plan.recheck ? `recheck ${plan.recheck}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** What the imported passes still lack against the plan; empty when the plan is met or not enforced. */
export function planMissing(
  plan: ReviewPlan | undefined,
  passes: ReviewPass[] | undefined,
): string[] {
  if (!planEnforced(plan)) return [];
  const list = passes ?? [];
  const missing: string[] = [];
  const required = requiredPasses(plan);
  const agents = new Set(list.map((p) => p.agentId));
  if (agents.size < required)
    missing.push(
      `${required - agents.size} more fresh reviewer pass(es): ${agents.size} of ${required} imported from distinct reviewer agent ids`,
    );
  const lensAgents = new Map<string, string>();
  for (const lens of plan.lenses) {
    const pass = list.find((p) => p.lens === lens && !lensAgents.has(p.agentId));
    if (!pass)
      missing.push(
        tracetoonRuns(plan)
          ? `lens ${lens}: no pass from its own reviewer (tracetoon review run --lens ${lens})`
          : `lens ${lens}: no pass from its own reviewer (tracetoon review-packet --lean --lens ${lens}, then review import --lens ${lens})`,
      );
    else lensAgents.set(pass.agentId, lens);
  }
  for (const [key, want, label, flag] of [
    ['model', plan.reviewerModel, 'reviewer model', '--reviewer-model'],
    ['effort', plan.reviewerEffort, 'reviewer effort', '--reviewer-effort'],
  ] as const) {
    if (!want) continue;
    const off = list.filter((p) => p[key] !== want);
    if (off.length)
      missing.push(
        `${label} ${want}: pass ${off.map((p) => `${p.pass} (${p[key] ?? 'not recorded'})`).join(', ')} — start that reviewer with ${label} ${want} and import it with ${flag} ${want}`,
      );
  }
  if (tracetoonRuns(plan)) {
    const want = resolveCodexModel(plan.reviewerModel!);
    for (const p of list) {
      const rerun = `tracetoon review run${p.lens ? ` --lens ${p.lens}` : ''}`;
      if (p.source !== 'tracetoon-run')
        missing.push(
          `pass ${p.pass} (${p.agentId}) was not run by Tracetoon: this plan's reviewer runner is tracetoon, so run ${rerun} instead of starting a reviewer agent`,
        );
      else if (p.verifiedModel !== want)
        missing.push(
          `pass ${p.pass}: its session ${p.verifiedModel ? `ran on ${p.verifiedModel}` : 'rollout shows no model'}, not ${want}; run ${rerun} again`,
        );
    }
  }
  return missing;
}

/** The gate publish applies, as one refusal message; undefined when nothing is missing. */
export function planGate(run: Run): string | undefined {
  const plan = loadReviewPlan(run);
  if (!planEnforced(plan)) return undefined;
  const review = readJson<{ passes?: ReviewPass[] }>(run, 'review.json');
  const missing = planMissing(plan, review?.passes);
  if (!missing.length) return undefined;
  return `This run's review plan (${planSummary(plan)}) is not met yet:\n${missing.map((m) => `  - ${m}`).join('\n')}`;
}
