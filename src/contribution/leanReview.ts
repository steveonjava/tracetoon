/**
 * The lean reviewer's output (review-findings.json) and its conversion into the
 * review contract (review.json v2). The lean reviewer reports only what is wrong
 * or missing, each with one piece of evidence; Tracetoon binds it to the current
 * review-input.json fingerprint and fills in the contract's bookkeeping.
 */
import type { PatchHunk } from '../graph/build.ts';
import type { Section } from '../graph/queries.ts';
import type { BodyClaim, BodyOmission, BodyReview, ContributionReview } from './types.ts';

export const FINDINGS_FILE = 'review-findings.json';
export const FINDING_KINDS = ['claim', 'omission'] as const;
export const FINDING_VERDICTS = [
  'contradicted',
  'overstated',
  'unsupported',
  'missing',
] as const;
export const MAX_FINDINGS = 8;

export interface LeanFinding {
  kind: (typeof FINDING_KINDS)[number];
  /** The body sentence or phrase a claim finding is about (an omission may describe the behavior here). */
  quote?: string;
  verdict: (typeof FINDING_VERDICTS)[number];
  /** `diff:123`, a brief ref (CH2, commit:abc#3, L4, T1, S1), or `path:line`; several may be separated by `|` or `,`. */
  evidence: string | string[];
  fix: string;
}

export interface LeanFindings {
  v: 1;
  reviewer: { agentId: string };
  /** Optional two-line cold read of the title and body. */
  coldRead?: { change?: string; start?: string };
  findings: LeanFinding[];
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

/** Names agents write when they don't know their own id. */
export function placeholderAgentId(id: unknown): boolean {
  if (typeof id !== 'string') return true;
  const s = id.trim().toLowerCase();
  return (
    !s ||
    /[<>{}]/.test(s) ||
    [
      'unknown',
      'none',
      'null',
      'undefined',
      'n/a',
      'na',
      'id',
      'todo',
      'tbd',
      'placeholder',
      'self',
      'me',
      'inline',
      'delegated',
      'real id',
      'actual id',
      'host',
      'claude',
      'codex',
    ].includes(s) ||
    /^(the[-_ ]?)?(lean[-_ ]?|independent[-_ ]?|fresh[-_ ]?)?(reviewer|agent|subagent|review)([-_ ]?(id|\d+))?$/.test(
      s,
    )
  );
}

/**
 * Check review-findings.json's shape. Throws one error listing everything to fix.
 * Returns warnings for issues that don't block the import.
 */
export function parseFindings(value: unknown): {
  findings: LeanFindings;
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!record(value)) throw new Error(fixList(['the file must hold one JSON object']));
  if (value.v !== 1) errors.push('"v" must be 1');
  if (!record(value.reviewer) || typeof value.reviewer.agentId !== 'string')
    errors.push('"reviewer" must be {"agentId": "<your real agent id>"}');
  if (
    value.coldRead !== undefined &&
    (!record(value.coldRead) ||
      (value.coldRead.change !== undefined &&
        typeof value.coldRead.change !== 'string') ||
      (value.coldRead.start !== undefined && typeof value.coldRead.start !== 'string'))
  )
    errors.push('"coldRead" must be {"change": "...", "start": "..."} when given');
  if (!Array.isArray(value.findings)) errors.push('"findings" must be an array');
  else {
    if (value.findings.length > MAX_FINDINGS)
      warnings.push(
        `${value.findings.length} findings; the lean review keeps at most ${MAX_FINDINGS}, the most consequential first.`,
      );
    value.findings.forEach((f, i) => {
      const at = `findings[${i}]`;
      if (!record(f)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!(FINDING_KINDS as readonly unknown[]).includes(f.kind))
        errors.push(`${at}.kind ${JSON.stringify(f.kind)} must be "claim" or "omission"`);
      if (!(FINDING_VERDICTS as readonly unknown[]).includes(f.verdict))
        errors.push(
          `${at}.verdict ${JSON.stringify(f.verdict)} must be one of ${FINDING_VERDICTS.join(', ')}`,
        );
      if (f.kind === 'claim' && f.verdict === 'missing')
        errors.push(`${at}: verdict "missing" is for kind "omission", not "claim"`);
      if (
        f.kind === 'omission' &&
        f.verdict !== 'missing' &&
        FINDING_VERDICTS.includes(f.verdict as never)
      )
        warnings.push(`${at}: omissions use verdict "missing"; treated as an omission.`);
      if (f.kind === 'claim' && !text(f.quote))
        errors.push(
          `${at}.quote is required for a claim: copy the sentence or phrase from the body`,
        );
      if (f.quote !== undefined && typeof f.quote !== 'string')
        errors.push(`${at}.quote must be a string`);
      const ev = f.evidence;
      if (!(text(ev) || (Array.isArray(ev) && ev.length > 0 && ev.every(text))))
        errors.push(
          `${at}.evidence is missing: give diff:<line>, a brief ref (CH2, commit:<sha>#3, L4, T1) or path:line`,
        );
      if (!text(f.fix)) errors.push(`${at}.fix is missing: give a one-line correction`);
    });
  }
  if (errors.length) throw new Error(fixList(errors));
  return { findings: value as unknown as LeanFindings, warnings };
}

const fixList = (errors: string[]) =>
  `review-findings.json needs fixing:\n${errors.map((e) => `  - ${e}`).join('\n')}`;

/** What import needs to know about the run to resolve evidence. */
export interface ImportContext {
  title: string;
  /** The exact rendered body (review-input.json body). */
  body: string;
  patch: string;
  hunks: PatchHunk[];
  /** Brief sections (from the stored graph), when the run has one. */
  brief?: Section[];
  /** Whether a ref is valid in the review contract (diff:, body:, commit:, digest:, code:, title). */
  contractRef: (ref: string) => boolean;
  /** Whether a repo-relative path exists (for path:line lookups outside the diff). */
  fileExists?: (path: string) => boolean;
  /** change-map.json behavior checkpoints as B<g>.<c> with their diff evidence. */
  checkpoints: { id: string; evidence: string[] }[];
}

interface Resolved {
  contract: string[];
  notes: string[];
  invalid: string[];
}

const rows = (brief: Section[] | undefined, title: string) =>
  brief?.find((s) => s.title === title)?.rows ?? [];
const DIFF = /^diff:(\d+)(?:-(\d+))?$/;
const range = (ref: string): [number, number] | undefined => {
  const m = DIFF.exec(ref);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : undefined;
};
const overlaps = (a: string, b: string) => {
  const x = range(a),
    y = range(b);
  return !!x && !!y && x[0] <= y[1] && y[0] <= x[1];
};

/** Turn one finding's evidence into contract refs, brief-only notes and unknown refs. */
export function resolveEvidence(
  evidence: string | string[],
  ctx: ImportContext,
): Resolved {
  const out: Resolved = { contract: [], notes: [], invalid: [] };
  const tokens = (Array.isArray(evidence) ? evidence : [evidence])
    .flatMap((s) => s.split(/\s*[|,;]\s*|\s+/))
    .map((t) => t.replace(/^[(\[`'"]+|[)\]`'".:]+$/g, ''))
    .filter(Boolean);
  const changes = rows(ctx.brief, 'changes');
  const changeDiffs = (id: string) => {
    const row = changes.find((r) => r.change === id);
    return row
      ? ((row.diff as string[]) ?? []).filter((d) => DIFF.test(d) && ctx.contractRef(d))
      : undefined;
  };
  const known = new Set(
    (ctx.brief ?? []).flatMap((s) =>
      s.rows.flatMap((r) =>
        [r.ref, r.change, r.check].filter((x) => typeof x === 'string'),
      ),
    ) as string[],
  );
  const add = (refs: string[] | undefined, token: string, note = false) => {
    if (refs?.length) out.contract.push(...refs.slice(0, 3));
    if (note || !refs?.length) {
      if (known.has(token) || note) out.notes.push(token);
      else out.invalid.push(token);
    }
  };
  for (const t of tokens) {
    if (t === 'title' || /^(diff|body|author|code|digest|source):/.test(t)) {
      if (ctx.contractRef(t)) out.contract.push(t);
      else out.invalid.push(t);
      continue;
    }
    const commit = /^commit:([0-9a-f]{7,40})(#\d+)?$/i.exec(t);
    if (commit) {
      const base = `commit:${commit[1]}`;
      if (ctx.contractRef(base)) out.contract.push(base);
      if (commit[2] || !ctx.contractRef(base)) {
        if (known.has(t) || known.has(base) || ctx.contractRef(base)) out.notes.push(t);
        else out.invalid.push(t);
      }
      continue;
    }
    if (/^CH\d+$/.test(t)) {
      add(changeDiffs(t), t);
      continue;
    }
    if (/^T\d+$/.test(t)) {
      const row = rows(ctx.brief, 'tests').find((r) => r.ref === t);
      add(
        row ? ctx.hunks.filter((h) => h.file === row.file).map((h) => h.diff) : undefined,
        t,
      );
      continue;
    }
    if (/^L\d+$/.test(t)) {
      const row = rows(ctx.brief, 'limits').find((r) => r.ref === t);
      if (!row) out.invalid.push(t);
      else {
        const diffs =
          typeof row.change === 'string' ? changeDiffs(row.change) : undefined;
        if (diffs?.length) out.contract.push(...diffs.slice(0, 3));
        out.notes.push(t);
      }
      continue;
    }
    if (/^H\d+$/.test(t)) {
      const h = ctx.hunks.find((h) => h.id === t);
      if (h) out.contract.push(h.diff);
      else out.invalid.push(t);
      continue;
    }
    if (/^[SPDRV]\d+$/.test(t)) {
      if (ctx.contractRef(`digest:${t}`)) out.contract.push(`digest:${t}`);
      else if (known.has(t)) out.notes.push(t);
      else out.invalid.push(t);
      continue;
    }
    if (/^HK\d+$/.test(t)) {
      if (known.has(t)) out.notes.push(t);
      else out.invalid.push(t);
      continue;
    }
    const loc = /^(.+?):(\d+)(?:-(\d+))?$/.exec(t);
    if (loc) {
      const [path, line] = [loc[1]!.replace(/^[ab]\//, ''), Number(loc[2])];
      const inFile = ctx.hunks.filter(
        (h) => h.file === path || h.file.endsWith(`/${path}`),
      );
      const hit = inFile.find((h) => h.start <= line && line <= h.end);
      if (hit) out.contract.push(hit.diff);
      if (!hit && (inFile.length || ctx.fileExists?.(path))) out.notes.push(t);
      else if (!hit) out.invalid.push(t);
      continue;
    }
    out.invalid.push(t);
  }
  out.contract = [...new Set(out.contract)];
  out.notes = [...new Set(out.notes)];
  return out;
}

const norm = (s: string) =>
  s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Where a quote sits in the reviewed title/body, with an exact substring to cite. */
export function locateQuote(
  quote: string,
  title: string,
  body: string,
): { at: string; quote: string } | undefined {
  const lines = body.split(/\r?\n/);
  const q = quote.trim();
  const exact = lines.findIndex((l) => l.includes(q));
  if (exact >= 0) return { at: `body:${exact + 1}`, quote: q };
  if (title.includes(q)) return { at: 'title', quote: q };
  const nq = norm(q);
  if (!nq) return undefined;
  const loose = lines.findIndex((l) => l.trim() && norm(l).includes(nq));
  if (loose >= 0) return { at: `body:${loose + 1}`, quote: lines[loose]!.trim() };
  if (norm(title).includes(nq)) return { at: 'title', quote: title };
  // A sentence wrapped across lines.
  for (let i = 0; i < lines.length; i++)
    for (let k = 1; k <= 3 && i + k < lines.length; k++)
      if (lines[i]!.trim() && norm(lines.slice(i, i + k + 1).join(' ')).includes(nq))
        return { at: `body:${i + 1}-${i + k + 1}`, quote: lines[i]!.trim() };
  return undefined;
}

const claimKind = (quote: string): BodyClaim['kind'] =>
  /\b(tests?|tested|passe[sd]|checks?|suite|assert\w*|covered)\b/i.test(quote)
    ? 'validation'
    : /[\w-]+\/[\w./-]+|\b\w+\.(ts|js|py|go|rs|java|md|tsx|jsx)\b|`[^`]+\(\)`/.test(quote)
      ? 'review-location'
      : 'behavior';

/**
 * Build review.json v2 from lean findings. Throws when a claim's quote can't be
 * found in the reviewed title or body (the reviewer read a different render).
 * Unknown evidence refs are dropped from the contract and listed in `warnings`.
 */
export function leanToReview(
  input: LeanFindings,
  agentId: string,
  inputFingerprint: string,
  ctx: ImportContext,
): { review: ContributionReview; warnings: string[] } {
  const warnings: string[] = [];
  const unplaced: string[] = [];
  const claims: BodyClaim[] = [];
  const omissions: BodyOmission[] = [];
  const unanchored: string[] = [];
  input.findings.forEach((f, i) => {
    const id = `F${i + 1}`;
    const ev = resolveEvidence(f.evidence, ctx);
    if (ev.invalid.length)
      warnings.push(
        `${id}: unknown evidence ${ev.invalid.join(', ')} (left out of review.json).`,
      );
    const noted = ev.notes.length ? ` [evidence: ${ev.notes.join(', ')}]` : '';
    if (f.kind === 'claim') {
      const where = locateQuote(f.quote ?? '', ctx.title, ctx.body);
      if (!where) {
        unplaced.push(
          `findings[${i}].quote "${f.quote}" is not in the reviewed title or body`,
        );
        return;
      }
      const verdict = f.verdict as BodyClaim['verdict'];
      let evidence = ev.contract;
      if (!evidence.length && verdict !== 'unsupported') {
        evidence = [where.at];
        warnings.push(
          `${id}: no diff/commit evidence resolved${ev.notes.length ? ` (brief ${ev.notes.join(', ')})` : ''}; review.json cites the claim's own line.`,
        );
      }
      claims.push({
        id,
        at: where.at,
        quote: where.quote,
        kind: claimKind(where.quote),
        claim: f.quote!.trim(),
        verdict,
        evidence,
        correction: `${f.fix.trim()}${noted}`,
      });
    } else {
      const behavior = (f.quote?.trim() || f.fix.trim()).replace(/\s+/g, ' ');
      const diffs = ev.contract.filter((r) => r.startsWith('diff:'));
      if (diffs.length)
        omissions.push({
          behavior,
          evidence: ev.contract,
          correction: `${f.fix.trim()}${noted}`,
        });
      else {
        unanchored.push(
          `${behavior} (${[...ev.notes, ...ev.contract].join(', ') || 'no evidence'}): ${f.fix.trim()}`,
        );
        warnings.push(
          `${id}: omission has no diff evidence; it is reported in the cold-read gap (transfer) instead.`,
        );
      }
    }
  });
  if (unplaced.length)
    throw new Error(
      `review-findings.json needs fixing:\n${unplaced.map((u) => `  - ${u}; copy it exactly from review-packet.md`).join('\n')}`,
    );
  // The contract needs at least one audited claim: with no claim findings, the
  // title stands for the claims the lean reviewer read and found no problem with.
  if (!claims.length) {
    const n = ctx.patch ? ctx.patch.split(/\r?\n/).length : 0;
    claims.push({
      id: 'F0',
      at: 'title',
      quote: ctx.title,
      kind: 'context',
      claim: 'The lean review found no claim to correct.',
      verdict: 'supported',
      evidence: n && ctx.contractRef(`diff:1-${n}`) ? [`diff:1-${n}`] : ['title'],
    });
  }
  const gaps = [
    ...omissions.map((o) => `${o.behavior}: ${o.correction ?? ''}`.trim()),
    ...unanchored,
  ];
  const bodyReview: BodyReview = {
    inferredChange:
      input.coldRead?.change?.trim() || 'Not recorded by the lean reviewer.',
    inferredStart: input.coldRead?.start?.trim() || 'Not recorded by the lean reviewer.',
    transfer: gaps.length
      ? { state: 'needs-revision', reason: `The body leaves out: ${gaps.join(' | ')}` }
      : {
          state: 'satisfied',
          reason: 'The lean review found no behavior the body leaves out.',
        },
    claims,
    omissions,
    coverage: ctx.checkpoints.map((c) => {
      const ids = claims
        .filter((cl) => cl.evidence.some((e) => c.evidence.some((x) => overlaps(e, x))))
        .map((cl) => cl.id!);
      return ids.length
        ? { checkpoint: c.id, claims: ids }
        : {
            checkpoint: c.id,
            claims: [],
            omission: 'The lean review raised no finding about this checkpoint.',
          };
    }),
  };
  return {
    review: {
      v: 2,
      inputFingerprint,
      drafter: { mode: 'inline' },
      reviewer: { mode: 'delegated', agentId },
      assessments: [],
      bodyReview,
    },
    warnings,
  };
}
