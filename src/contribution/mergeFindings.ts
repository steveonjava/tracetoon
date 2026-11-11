/**
 * One merged findings list across every imported reviewer pass, so the
 * drafter reads one short file and applies it in one edit pass instead of
 * reading each reviewer's findings separately.
 *
 * Findings are deduplicated by normalized quote (near-duplicate quotes too;
 * omissions without a quote by their evidence refs), the strongest verdict
 * wins, claims come before omissions (contradicted > overstated > unsupported
 * > missing), and the list is capped.
 */
import type { LeanFinding } from './leanReview.ts';

export const MERGED_FILE = 'review-findings-merged.md';
export const MERGED_CAP = 12;
const RANK: Record<string, number> = {
  contradicted: 0,
  overstated: 1,
  unsupported: 2,
  missing: 3,
};

export interface MergeSource {
  /** e.g. `general`, `general 2`, `lens d`. */
  label: string;
  findings: LeanFinding[];
}

export interface MergedFinding {
  kind: LeanFinding['kind'];
  verdict: LeanFinding['verdict'];
  quote: string;
  evidence: string[];
  fix: string;
  /** Which passes raised it. */
  passes: string[];
}

export interface MergedList {
  items: MergedFinding[];
  /** Findings across all passes before dedupe (already-fixed claims excluded). */
  total: number;
  /** Duplicates folded into another line. */
  duplicates: number;
  /** Lines left out over the cap. */
  dropped: number;
  /** Claim findings whose quote is no longer in the body. */
  fixed: number;
  passes: string[];
  cap: number;
}

const normQuote = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const tokens = (q: string) => new Set(q.split(' ').filter(Boolean));

export function evidenceRefs(e: LeanFinding['evidence']): string[] {
  const list = Array.isArray(e) ? e : String(e ?? '').split(/\s*[|,]\s*/);
  return [...new Set(list.map((r) => String(r).trim()).filter(Boolean))];
}

/** Same quote after normalizing, one inside the other, or nearly the same words. */
export function nearDuplicateQuote(a: string, b: string): boolean {
  const x = normQuote(a);
  const y = normQuote(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const ts = tokens(short);
  if (ts.size >= 3 && ` ${long} `.includes(` ${short} `)) return true;
  const tl = tokens(long);
  if (ts.size < 3) return false;
  let both = 0;
  for (const t of ts) if (tl.has(t)) both++;
  return both / (ts.size + tl.size - both) >= 0.75;
}

function sameFinding(a: MergedFinding, f: LeanFinding): boolean {
  const q = (f.quote ?? '').trim();
  if (a.quote && q) return nearDuplicateQuote(a.quote, q);
  if (a.quote || q) return false;
  const e = evidenceRefs(f.evidence);
  return (
    a.kind === f.kind &&
    e.length > 0 &&
    e.length === a.evidence.length &&
    e.every((r) => a.evidence.includes(r))
  );
}

export function mergeFindings(
  sources: MergeSource[],
  opts: { cap?: number; isFixed?: (f: LeanFinding) => boolean } = {},
): MergedList {
  const cap = opts.cap ?? MERGED_CAP;
  const out: MergedFinding[] = [];
  let total = 0;
  let duplicates = 0;
  let fixed = 0;
  for (const src of sources)
    for (const f of src.findings) {
      if (opts.isFixed?.(f)) {
        fixed++;
        continue;
      }
      total++;
      const hit = out.find((m) => sameFinding(m, f));
      if (!hit) {
        out.push({
          kind: f.kind,
          verdict: f.verdict,
          quote: (f.quote ?? '').trim(),
          evidence: evidenceRefs(f.evidence),
          fix: (f.fix ?? '').trim(),
          passes: [src.label],
        });
        continue;
      }
      duplicates++;
      if (!hit.passes.includes(src.label)) hit.passes.push(src.label);
      for (const r of evidenceRefs(f.evidence))
        if (!hit.evidence.includes(r)) hit.evidence.push(r);
      if ((RANK[f.verdict] ?? 9) < (RANK[hit.verdict] ?? 9)) {
        // The stronger verdict and its fix win; keep the shorter of the quotes.
        hit.verdict = f.verdict;
        hit.kind = f.kind;
        if (f.fix?.trim()) hit.fix = f.fix.trim();
      }
      const q = (f.quote ?? '').trim();
      if (q && q.length < hit.quote.length) hit.quote = q;
    }
  const order = out
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        (RANK[a.m.verdict] ?? 9) - (RANK[b.m.verdict] ?? 9) ||
        b.m.passes.length - a.m.passes.length ||
        a.i - b.i,
    )
    .map((x) => x.m);
  return {
    items: order.slice(0, cap),
    total,
    duplicates,
    dropped: Math.max(0, order.length - cap),
    fixed,
    passes: sources.map((s) => s.label),
    cap,
  };
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** One line per finding: verdict, quote, evidence, fix, passes. */
export function mergedLine(m: MergedFinding, i: number): string {
  const verdict = m.kind === 'omission' ? `${m.verdict} (omission)` : m.verdict;
  return [
    `${i + 1}. ${verdict}`,
    m.quote ? `"${clip(m.quote, 140)}"` : '',
    m.evidence.length ? m.evidence.join(' | ') : 'no evidence ref',
    m.fix ? `fix: ${clip(m.fix, 160)}` : '',
    `[${m.passes.join(', ')}]`,
  ]
    .filter(Boolean)
    .join(' — ');
}

export function mergedMarkdown(runId: string, list: MergedList): string {
  const head = [
    `${list.items.length} finding(s) from ${list.passes.length} pass(es) (${list.passes.join(', ') || 'none'})`,
    list.duplicates ? `${list.duplicates} duplicate(s) merged` : '',
    list.fixed ? `${list.fixed} already fixed (quote gone from the body)` : '',
    list.dropped ? `${list.dropped} more dropped over the cap of ${list.cap}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return [
    `# Merged review findings (run ${runId})`,
    '',
    `${head}.`,
    list.items.length
      ? 'Check each against the lines it cites, then fix or reject every flagged claim in ONE edit pass of body.md.'
      : 'Nothing to fix.',
    '',
    ...list.items.map(mergedLine),
    '',
  ].join('\n');
}
