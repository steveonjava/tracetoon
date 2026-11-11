/**
 * How the evidence brief is laid out for the writer.
 * - `toon` (default): the TOON tables.
 * - `neighborhood`: one block per change unit with its requests, commit
 *   sentences and hunks (key changed lines inline), packed to an evidence
 *   budget. See `neighborhood.ts`.
 *
 * `prepare --layout` chooses it for a run and stores it in the run folder, so
 * `query brief`, `render` and the review packet read the same brief.
 */
import { readJson, writeJson, type Run } from '../run.ts';

export type BriefLayout = 'toon' | 'neighborhood' | 'neighborhood-wide';
export const BRIEF_LAYOUTS: readonly BriefLayout[] = [
  'toon',
  'neighborhood',
  'neighborhood-wide',
];

/** Both neighborhood layouts; `neighborhood-wide` packs to the full budget instead of the TOON size. */
export function isNeighborhood(layout: BriefLayout | undefined): boolean {
  return layout === 'neighborhood' || layout === 'neighborhood-wide';
}
export const LAYOUT_FILE = 'brief-layout.json';

/** A `--layout` value, checked; undefined when none was given. */
export function parseLayout(value: unknown): BriefLayout | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if ((BRIEF_LAYOUTS as readonly string[]).includes(String(value)))
    return value as BriefLayout;
  throw new Error(
    `Unknown brief layout "${String(value)}": use ${BRIEF_LAYOUTS.join(' or ')}.`,
  );
}

/** The layout `prepare` chose for this run (toon when none was chosen). */
export function runLayout(run: Run): BriefLayout {
  const stored = readJson<{ layout?: string }>(run, LAYOUT_FILE)?.layout;
  return stored === 'neighborhood' || stored === 'neighborhood-wide' ? stored : 'toon';
}

export function saveRunLayout(run: Run, layout: BriefLayout): void {
  writeJson(run, LAYOUT_FILE, { layout });
}

/**
 * Evidence budget of the neighborhood brief's change blocks, in tokens
 * (characters / 4): at most BRIEF_BUDGET_TOKENS, and by default no more than
 * keeps the whole neighborhood brief as long as the TOON brief of the same
 * run (`matchToon`). TRACETOON_BRIEF_BUDGET sets a fixed budget instead.
 */
export const BRIEF_BUDGET_TOKENS = 1500;
export function briefBudget(layout?: BriefLayout): {
  tokens: number;
  matchToon: boolean;
} {
  const fixed = Number(process.env.TRACETOON_BRIEF_BUDGET);
  if (fixed > 0) return { tokens: fixed, matchToon: false };
  return { tokens: BRIEF_BUDGET_TOKENS, matchToon: layout !== 'neighborhood-wide' };
}
