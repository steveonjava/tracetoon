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
  | 'Commit';

export type RelType =
  | 'IN_SESSION'
  | 'IN_TURN'
  | 'NEXT'
  | 'EDITS'
  | 'SURVIVES_IN'
  | 'OF'
  | 'LATER_EDIT'
  | 'MADE'
  | 'TOUCHES';

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
  };
}

/** The schema as agents see it (`tracetoon query schema`). */
export const SCHEMA_DOC = {
  nodes: {
    Session: 'id (hashed ref), agent, band (included|ambiguous), score, title',
    Prompt: 'id (S#), t, text (clipped; expand for full), pushback, ledToEdits, session',
    Decision: 'id (D#), t, text (clipped), session',
    Plan: 'id (P#), t, approved, text (first line), session',
    Run: 'id (R#), t, cmd, kind (test|build|lint|typecheck|eval|other), outcome (passed|failed|unknown), revision, session',
    Receipt: 'id (V#), cmd, outcome: current exact-content validation receipt',
    Edit: 'id (E#), t, file, added, removed, surviving (lines still in the PR), inPr, via (shell when made by a command), session',
    File: 'id (repo-relative path), role (behavior|tests|docs|config|generated|version), inPr, added, removed, unmatched',
    Hunk: 'id (H#), file, start, end (new-file lines), added, removed, diff (changes.patch lines, e.g. diff:120-141, citable in change-map behaviorChecks), context',
    Commit: 'id (short SHA), subject, body (message body, clipped; null when none)',
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
  },
  notes: [
    'Timestamps (t) are ISO strings; compare them as strings.',
    'Absence of a relationship means it was not captured, not that it did not happen.',
    'Cite facts by id (S1, D1, R1, V1) and hunks by their diff ref; expand ids for full text.',
  ],
} as const;
