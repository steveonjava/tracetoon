/**
 * How the evidence brief is laid out for the writer.
 * - `neighborhood` (default on this branch): one block per change unit with its
 *   requests, commit sentences and hunks (key changed lines inline), packed to a
 *   fixed evidence budget. See `neighborhood.ts`.
 * - `toon`: the original TOON tables.
 */
export type BriefLayout = 'neighborhood' | 'toon';
export const briefLayout = (): BriefLayout =>
  process.env.TRACETOON_BRIEF_LAYOUT === 'toon' ? 'toon' : 'neighborhood';

/** Evidence budget of the neighborhood brief's change blocks, in tokens (characters / 4). */
export const BRIEF_BUDGET_TOKENS = 2112;
export const briefBudgetTokens = () =>
  Number(process.env.TRACETOON_BRIEF_BUDGET) || BRIEF_BUDGET_TOKENS;
