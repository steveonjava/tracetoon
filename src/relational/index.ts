/**
 * The relational/vector evidence mode (`Evidence mode: relational.`, or
 * `prepare --evidence-mode relational`; see ./mode.ts), first built for the
 * shape test (prbench/results/shape-test/PREREGISTRATION.md).
 *
 * In this mode Tracetoon writes PR context from a relational/vector-shaped
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
 * The relational context's token budget (characters / 4), a build constant:
 * set so `query brief` (context plus rules) matches the median size of the
 * graph mode's TOON brief on the 5 dev cases: 9,466 characters against
 * 9,456 at 96686e9 (the shape test's 7-case value; packing stops at whole
 * items, so 2110 gives the same contexts). TRACETOON_R_BUDGET overrides it for
 * experiments.
 */
export const R_BUDGET_TOKENS = 2112;
export const budgetTokens = () =>
  Number(process.env.TRACETOON_R_BUDGET) || R_BUDGET_TOKENS;

/**
 * What `prepare` prints after the context. The drafting rules live in
 * references/drafting.md for both evidence modes (structure, tagging, the
 * claim rules); these lines only say how this context's rows stand in for the
 * graph brief's, so they never contradict it.
 */
export const R_RULES = [
  'Draft title.txt and body.md by references/drafting.md, as for the graph brief: its structure, tagging and rules all apply. These lines only map its brief rows to this context; never copy their wording into the PR.',
  'Tag with the ids above (S, D, P, commit:<sha>, commit:<sha>#n, F, H) where drafting.md tags with brief refs; `render` lists untagged sentences and unknown refs.',
  'There are no `changes`, `newSymbols`, `implementedBy`, `doNotSay`, `process` or `background` rows: name a file for a behavior only where an H chunk or a commit sentence\'s "→" shows it (otherwise describe it without a file); call a symbol new only where its chunk adds the definition; old behavior only from removed (-) lines or a request.',
  'Run results come from the recorded runs: put `<!-- tracetoon:validation -->` where the Validation section belongs; results only a commit message states are not runs.',
  'This context is the whole evidence index: other `tracetoon query` lookups are refused; read changes.patch for any chunk you describe.',
];

/** What `prepare` prints in the brief's place: the context, then the rules. */
export function contextText(ctx: RelationalContext): string {
  return [ctx.text.trimEnd(), '', 'Rules:', ...R_RULES.map((r) => `- ${r}`)].join('\n');
}

export type { GraphInputs };
