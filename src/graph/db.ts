/**
 * What the named queries need from an evidence store, whichever engine holds it:
 * cypherlite (the graph arm) or SQLite (the sqlite arm). Each query carries
 * both dialects; an engine runs the one it speaks, and the TypeScript around
 * the query (grouping, ordering, wording) is shared, so both arms produce the
 * same brief from the same evidence.
 */
export class GraphError extends Error {}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * A query: Cypher only (a plain string), or both dialects. `json` names SQL
 * aggregate columns (json_group_array) to return as lists, as Cypher's collect() does;
 * `bool` names 0/1 columns to return as booleans (where the column name alone can't say).
 */
export type Q =
  string | { cypher: string; sql: string; json?: string[]; bool?: string[] };

export interface EvidenceDb {
  readonly dialect: 'cypher' | 'sql';
  run(q: Q, params?: Record<string, unknown>): QueryResult;
  close(): void;
}
