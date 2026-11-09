/**
 * The relational/vector arm of the shape test (see
 * prbench/results/shape-test/PREREGISTRATION.md).
 *
 * On this branch, Tracetoon writes PR context from a relational/vector-shaped
 * store instead of the evidence graph's brief:
 * - **Inputs:** the same evidence the graph is built from (`GraphInputs`).
 * - **Store:** record tables in SQLite with foreign keys only, searched with
 *   BM25 plus local-embedding similarity.
 * - **Output:** a context packed to a fixed token budget.
 *
 * `prepare` prints that context where the brief would be, followed by the same
 * writing rules. The evidence graph is still built, but only so `render` can
 * write the shared Validation section; the writer never sees it, and graph
 * queries are refused.
 *
 * The builder (`./builder.ts`) is written by an independent designer. This file
 * is the fixed interface around it.
 */
import type { GraphInputs } from '../graph/build.ts';

/** Default on this branch; TRACETOON_EVIDENCE_MODE=graph restores the brief. */
export const relationalVectorMode = () => process.env.TRACETOON_EVIDENCE_MODE !== 'graph';

/** A citable item in the context: the writer tags sentences with these ids. */
export interface ContextRef {
  /** Short, unique within the run, e.g. S3, H12, commit:abc1234, commit:abc1234#2. */
  id: string;
  /** The item's own text (what a sentence citing it may rest on). */
  text: string;
}

export interface RelationalContext {
  /** What the writer reads, at most `budgetTokens` (estimated as characters / 4). */
  text: string;
  refs: ContextRef[];
  /** Estimated tokens of `text`. */
  tokens: number;
  /** Free-form build facts for the report (table sizes, retrieval settings, model). */
  stats?: Record<string, unknown>;
  /**
   * The store's links, kept for the review packet and render's coverage check
   * (never shown to the writer): read by src/packet/evidence.ts.
   */
  links?: StoreLinks;
}

/** Links the relational store computed, by the ids the context and packet use. */
export interface StoreLinks {
  v: 1;
  /** Every diff chunk, with what the store ties to it. */
  chunks: {
    id: string;
    file: string;
    start: number;
    end: number;
    /** Requests, decisions, plans and commit sentences tied to it, strongest first. */
    why: string[];
    /** For test chunks: names defined in other changed files that it uses, `name (H#)`. */
    uses: string[];
  }[];
  /** Each commit and the chunks its own lines are in. */
  commits: { id: string; subject: string; chunks: string[] }[];
  /** Each commit-message sentence and the chunks (of its own commit) it is tied to. */
  sentences: { id: string; text: string; result: boolean; chunks: string[] }[];
  /** Requests, decisions and plans the builder weighed (noise and repeats dropped). */
  facts: { id: string; kind: string; labels: string[]; text: string }[];
}

export interface BuildOptions {
  budgetTokens: number;
  /** The run folder, for the designer's own store or cache files. */
  runDir?: string;
}

/**
 * The fixed token budget, set from the median size of the graph arm's brief on
 * the 7 cases (preregistration). TRACETOON_R_BUDGET overrides it for experiments.
 */
export const R_BUDGET_TOKENS = 2112;
export const budgetTokens = () =>
  Number(process.env.TRACETOON_R_BUDGET) || R_BUDGET_TOKENS;

/** The writing rules both arms follow, without the graph's field names. */
export const R_RULES = [
  'These rules are instructions for you, not content for the PR: never copy their wording into the description.',
  "Don't write test, build, lint or typecheck results yourself: put the line `<!-- tracetoon:validation -->` where the validation section belongs, and `render` writes it from the recorded runs.",
  'Tag each sentence that states a fact with the refs it rests on, e.g. `[H3, S1]` (any ref listed in the context above); `render` removes the tags and lists sentences with no tag or an unknown ref.',
  "Don't report who wrote what as percentages or counts.",
  'A commit-message sentence speaks for its own commit only: never generalize it to other commits.',
  'Results that appear only in a commit message are not runs: attribute them to that commit message or leave them out.',
  "A check run before later edits to a file did not see those edits: don't present it as testing the final code.",
  'A check after the last captured edit ran after the last edit the logs show, not necessarily on the final code: never say "on the final code" or "after all changes".',
  'Absence of a recorded run is not evidence a check was never run or that code is untested: write "no recorded run", never "not tested", "not exercised" or "never ran".',
  'Quote run results exactly as the evidence gives them (command and counts); never add a count, suite or file it does not show.',
  'Point reviewers at files, not at functions, and not at the largest file.',
  'Name a file or symbol for a behavior only where the diff or commit evidence in the context shows it; otherwise describe the behavior without naming where it lives.',
  'Call a symbol new, added or introduced only if the diff adds its definition; others already existed and were changed.',
  'State what the code did before whenever the removed lines or the request show it, quoting values; never infer old behavior from the new code alone.',
  'No blanket negatives ("no X was run", "nothing tests Y") unless the evidence states it; give mechanism claims their conditions (flags, fallbacks) instead of "any", "always" or "every".',
  'Give every changed area at least a clause, including docs, skill or config files and each test file; say each thing once.',
  "Don't count tests or name test helpers: say what the added test titles check.",
  "State plainly what the patch shows. Attribute only what it can't show (a reason, a result, a remark about scope) to the request or commit message that says it.",
  "Don't repeat in the prose what the generated Validation section says about runs.",
  "Words a commit message puts in parentheses or asides ('local only', 'experimental', 'for now') are that commit's own remark: attribute them or leave them out.",
];

/** What `prepare` prints in the brief's place: the context, then the rules. */
export function contextText(ctx: RelationalContext): string {
  return [ctx.text.trimEnd(), '', 'Rules:', ...R_RULES.map((r) => `- ${r}`)].join('\n');
}

export type { GraphInputs };
