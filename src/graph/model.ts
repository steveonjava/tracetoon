/**
 * The evidence graph: how the PR was made, as nodes and relationships, built from
 * the same redacted evidence as the digest plus the submitted patch.
 *
 * The digest lists facts; the graph connects them. A prompt is linked to the
 * edits made in its turn, an edit to the diff hunks its lines survive in, a run
 * to the files edited after it, a commit to the session that made it. Agents ask
 * it questions with `tracetoon query` ("why did src/x.ts change?", "which
 * behavior files were never checked after their last edit?") instead of
 * reading every fact, and Tracetoon derives per-file provenance, run scope and
 * fact relevance from it for the digest, the notes and the review packet.
 *
 * Every string in it comes from the redacted digest or the patch the agents
 * already receive; it holds no raw transcript text and no line contents.
 */

export const GRAPH_SCHEMA = 'tracetoon.evidence-graph/v1';

export type NodeLabel =
  | 'Session'
  | 'Prompt'
  | 'Decision'
  | 'Plan'
  | 'Run'
  | 'Receipt'
  | 'Edit'
  | 'File'
  | 'Hunk'
  | 'Commit'
  | 'CommitClaim'
  | 'Change'
  | 'HeadRef';

export type RelType =
  | 'IN_SESSION'
  | 'IN_TURN'
  | 'NEXT'
  | 'EDITS'
  | 'SURVIVES_IN'
  | 'OF'
  | 'LATER_EDIT'
  | 'MADE'
  | 'TOUCHES'
  | 'INTRODUCED'
  | 'SAYS'
  | 'ASKED_BEFORE'
  | 'HAS'
  | 'ASKED_BY'
  | 'EXPLAINED_BY'
  | 'TIED_TO';

export type Value = string | number | boolean | null | string[];

export interface GraphNode {
  label: NodeLabel;
  /** Unique within its label: S1, D1, P1, R1, V1, E1, H1, a file path, a short SHA, a session ref. */
  id: string;
  props: Record<string, Value>;
}

export interface GraphRel {
  type: RelType;
  from: { label: NodeLabel; id: string };
  to: { label: NodeLabel; id: string };
  props?: Record<string, Value>;
}

export interface EvidenceGraph {
  schema: typeof GRAPH_SCHEMA;
  nodes: GraphNode[];
  rels: GraphRel[];
  stats: {
    nodes: number;
    rels: number;
    hunks: number;
    /** Hunks with at least one surviving agent edit. */
    linkedHunks: number;
    edits: number;
    /** Edits none of whose lines survive in the PR. */
    deadEndEdits: number;
    /** Change units (one idea each). */
    changes?: number;
  };
}

/** The schema as agents see it (`tracetoon query schema`). */
export const SCHEMA_DOC = {
  nodes: {
    Session:
      'id (hashed ref), agent, band (included|ambiguous), score, title, failedCommands (failed non-check commands), failedCommand (the most frequent of them), failedCmds (each failed non-check command as `<cmd> (failed N of M)`, most frequent first), invoked (commands other than checks and file utilities that ran something, as plain words without flags, e.g. `bun src/cli.ts comic art codex`), invokedOut (per invoked command, same position: the words of its output that the PR changed lines also contain, space-separated)',
    Prompt:
      'id (S#), t, text (up to 1500 chars; expand for full), pushback, ledToEdits, session',
    Decision:
      'id (D#), t, text, answers (each question = "answer"), truncated (the record itself is cut off), session',
    Plan: 'id (P#), t, approved, text (first line), excerpt, session',
    Run: 'id (R#), t, cmd, kind (test|build|lint|typecheck|eval|other), outcome (passed|failed|unknown), revision, summary (result lines), when (relative to the edits), session',
    Receipt:
      'id (V#), cmd, kind, outcome, summary, when: a check run on the submitted content',
    Edit: 'id (E#), t, file, added, removed, surviving (lines still in the PR), inPr, via (shell when made by a command), session',
    File: 'id (repo-relative path), role (behavior|tests|docs|config|generated|version), inPr, added, removed, unmatched',
    Hunk: 'id (H#), file, start, end (new-file lines), added, removed, diff (changes.patch lines, e.g. diff:120-141, citable in change-map behaviorChecks), context, scope (symbol git names after @@), symbols (defined on added lines), touched (symbols whose bodies the changed lines are in), branches, pairs (old → new values), conds (changed conditions old → new, + added branch or fallback, - removed condition), code (up to 24 key changed lines: `- old ⇒ + new` pairs, definitions and branches first), keyLines (up to 8 lines worth quoting: added comments, then literal values and pairs, then conditions; added lines for docs), literals (number and version tokens of the changed lines), fnWords (per function a changed line is in: `name: words of those lines`)',
    Commit: 'id (short SHA), subject, body (message body; null when none), t',
    CommitClaim:
      'id (<sha>#n), commit, text (one sentence of the commit message), assertsResult (reports a result: commit-message assertion, not a run)',
    HeadRef:
      'id (HR#), kind (still mentions | references | most referenced), term, refs (file:line for stale mentions in docs/config, files for references; capped), count, files, hunk, fresh, definedIn: from one `git grep -w -F` of the head tree, no line contents',
    Change:
      'id (CH#), key (commit:<sha> | prompt:S# | dir:<path>), files, roles, symbols (defined or enclosing), added, removed, branches (added lines that branch or fall back)',
  },
  relationships: {
    IN_SESSION: '(Prompt|Decision|Plan|Run|Edit)-[:IN_SESSION]->(Session)',
    IN_TURN:
      '(Decision|Plan|Run|Edit)-[:IN_TURN]->(Prompt): happened while answering that prompt',
    NEXT: '(Prompt)-[:NEXT]->(Prompt): the following prompt in the same session',
    EDITS: '(Edit)-[:EDITS]->(File)',
    SURVIVES_IN:
      '(Edit)-[:SURVIVES_IN {lines}]->(Hunk): lines of the edit still in that hunk',
    OF: '(Hunk)-[:OF]->(File)',
    LATER_EDIT:
      '(Run)-[:LATER_EDIT]->(File): the session edited this PR file after the run (the run did not see that edit)',
    MADE: '(Session)-[:MADE]->(Commit)',
    TOUCHES: '(Commit)-[:TOUCHES]->(File)',
    INTRODUCED:
      "(Commit)-[:INTRODUCED {lines}]->(Hunk): lines from that commit's own patch still in the hunk",
    SAYS: '(Commit)-[:SAYS]->(CommitClaim)',
    ASKED_BEFORE:
      '(Prompt)-[:ASKED_BEFORE]->(Commit): typed in an included session after the previous commit and before this one',
    HAS: '(Change)-[:HAS]->(Hunk)',
    ASKED_BY: '(Change)-[:ASKED_BY {how}]->(Prompt)',
    EXPLAINED_BY:
      '(Change)-[:EXPLAINED_BY]->(Commit): commits whose lines are in the change',
    TIED_TO:
      "(CommitClaim|Commit|Prompt|Plan)-[:TIED_TO {score, rankers}]->(Hunk): search link (prepare's Graph search): Relate FULLTEXT (BM25) over the hunk's path, symbols and changed lines agreeing with an exact name/path mention, or a dominant BM25 hit; a commit's text only links its own hunks; score 0..1, rankers e.g. bm25 mention",
  },
  notes: [
    'Timestamps (t) are ISO strings; compare them as strings.',
    'Absence of a relationship means it was not captured, not that it did not happen.',
    'Cite facts by id (S1, D1, R1, V1) and hunks by their diff ref; expand ids for full text.',
  ],
} as const;
