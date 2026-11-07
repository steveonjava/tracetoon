/** Normalized, agent-neutral view of what happened in an agent session. */

export type AgentId = 'claude-code' | 'codex' | 'antigravity-cli' | 'antigravity-ide';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Fields every record may carry: when it happened and where the agent was. */
interface Base {
  ts?: string;
  cwd?: string;
  branch?: string;
  /** The model in effect when this happened, if the agent records it. */
  model?: string;
}

/**
 * One question the user answered. The answer is recorded exactly; nothing is
 * inferred about options that weren't picked (unselected is not "rejected").
 */
export interface DecisionQuestion {
  question: string;
  /** The offered options' labels. */
  options: string[];
  /** What the user answered: an option label, several, or their own words. */
  answer?: string;
  /** True when the answer matches none of the options (the user wrote their own). */
  ownWords?: boolean;
}

export type TraceRecord =
  | (Base & {
      kind: 'prompt';
      text: string;
      /** Written by a parent agent to a subagent, not typed by the user. */
      delegated?: boolean;
      /** Typed while rejecting a tool call: steers the current turn, doesn't start a new one. */
      feedback?: boolean;
    })
  | (Base & { kind: 'assistant'; text: string })
  | (Base & { kind: 'plan'; markdown: string; approved?: boolean })
  | (Base & {
      kind: 'decision';
      text: string;
      /** Structured questions, when the agent's log has them. */
      questions?: DecisionQuestion[];
    })
  | (Base & {
      kind: 'edit';
      /** Absolute path of the edited file. */
      file: string;
      added: string[];
      removed: string[];
      created?: boolean;
      /** Made by a shell command (sed, a script) rather than an edit tool. */
      via?: 'shell';
    })
  | (Base & {
      kind: 'command';
      cmd: string;
      isError?: boolean;
      /** Start and end of the command's output. Used only for matching (e.g. commit SHAs); never shown. */
      output?: string;
      /** Still running when the log was read: no result (or output) yet. */
      pending?: boolean;
    })
  | (Base & {
      kind: 'link';
      prUrl?: string;
      prNumber?: number;
      prRepository?: string;
      worktreePath?: string;
      worktreeBranch?: string;
    })
  | (Base & { kind: 'usage'; usage: Usage })
  | (Base & {
      kind: 'artifact';
      /** e.g. "walkthrough", "task", "implementation_plan". */
      name: string;
      markdown: string;
      /** The agent's own one-line summary of the artifact, when it keeps one. */
      summary?: string;
    });

export type RecordKind = TraceRecord['kind'];

/**
 * A file the agent read or a search it ran (Read, Grep, Glob, view_file, …).
 * Kept beside the records, never among them, so it can't change which sessions
 * or records belong to a PR; only the SQLite evidence store's extras read it.
 */
export interface ReadRecord {
  ts?: string;
  cwd?: string;
  /** The agent's tool name. */
  tool: string;
  /** Absolute path read, or the folder searched. */
  path?: string;
  /** The search pattern (Grep, Glob, grep_search). */
  pattern?: string;
}

/** A session log found on disk, before it is fully read. */
export interface SessionRef {
  agent: AgentId;
  sessionId: string;
  path: string;
  mtimeMs: number;
  cwd?: string;
}

export interface TraceSession {
  agent: AgentId;
  sessionId: string;
  source: string;
  title?: string;
  records: TraceRecord[];
  /** Whole-session cost reported by the agent, when it records one. */
  sessionCostUsd?: number;
  /** Record types this adapter did not recognize, with counts. */
  unknownTypes: Record<string, number>;
  warnings: string[];
  /** Set on a subagent's own log: the session that spawned it. */
  parentSessionId?: string;
  /** Files read and searches run, for the SQLite store's extras. */
  reads?: ReadRecord[];
}

export interface DiscoverQuery {
  /** Local metadata cache, normally under this worktree's git directory. */
  cacheDir?: string;
  /** The active host transcript is always inspected, even with stale timestamps. */
  currentSessionPath?: string;
  /** Repository roots (main checkout plus worktrees). */
  roots: string[];
  /** Earliest relevant event time (ms since epoch). Filesystem mtime alone cannot exclude a live log. */
  sinceMs: number;
  /**
   * Extra strings that make a log relevant even if it never names a root: the
   * PR's short commit SHAs, which find sessions that worked in a deleted worktree.
   */
  needles?: string[];
  /** Return every session regardless of repo (for `doctor --probe`). */
  all?: boolean;
}

export interface TraceAdapter {
  id: AgentId;
  label: string;
  /** Where this agent's logs live on this machine, or undefined if absent. */
  home(): string | undefined;
  /** How many session logs exist on this machine (for `doctor`). */
  count(): number;
  discover(q: DiscoverQuery): SessionRef[];
  read(ref: SessionRef): TraceSession;
}
