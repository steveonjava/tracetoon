/**
 * Which agent host this command runs under, from the environment the host
 * gives its tool calls: Codex sets CODEX_THREAD_ID; Claude Code sets
 * CLAUDECODE=1 and CLAUDE_CODE_SESSION_ID (the same variables the task and
 * digest commands read for the session id). TRACETOON_HOST_AGENT overrides
 * (claude, codex, or none for "unknown"). Undefined when unknown; review
 * plans then use the main agent's model and reviewer agents.
 */
export type HostAgent = 'claude' | 'codex';

export function hostAgent(env: NodeJS.ProcessEnv = process.env): HostAgent | undefined {
  const forced = env.TRACETOON_HOST_AGENT?.trim().toLowerCase();
  if (forced) return forced === 'claude' || forced === 'codex' ? forced : undefined;
  if (env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID)
    return 'claude';
  return undefined;
}
