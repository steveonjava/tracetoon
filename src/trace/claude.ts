/**
 * Claude Code adapter. Reads `~/.claude/projects/<dir>/<session>.jsonl` (and the
 * session's `subagents/*.jsonl`) into normalized records, keeping each record's own
 * cwd and branch, because one session can move between repos and branches.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { claude } from '@showtail/agent-traces';
import { isSyntheticPrompt } from '@showtail/agent-traces/prompts/synthetic';
import { resolvePlanResult } from '@showtail/agent-traces/transcript/plans';
import { headTail } from './diffLines.ts';
import { mentionsAnyRoot } from './pathMatch.ts';
import { discoveryIndex } from './discovery.ts';
import type {
  DecisionQuestion,
  SessionRef,
  TraceAdapter,
  TraceSession,
  Usage,
} from './types.ts';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that read the repo without changing it (kept as ReadRecords). */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const NON_USER_PROMPT_SOURCES = new Set(['system', 'sdk']);
/** Record types we read or deliberately skip; anything else is counted as unknown. */
const KNOWN_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'summary',
  'pr-link',
  'worktree-state',
  'ai-title',
  'cost-state',
  'file-history-snapshot',
  'file-history-delta',
  'relocated',
  'last-prompt',
  'queue-operation',
  'api-request',
  'api-request-start',
  'api-request-end',
  'progress',
  'custom-title',
  'tag',
  'agent-name',
  'mode',
  'permission-mode',
  'atis-latch',
  'api-request-shape',
  'api-request-blob',
  'continued-in',
]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Lines a Claude `structuredPatch` added and removed. */
function linesFromPatch(patch: unknown): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  if (!Array.isArray(patch)) return { added, removed };
  for (const hunk of patch) {
    const lines = isObj(hunk) && Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const l of lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added.push(l.slice(1));
      else if (l.startsWith('-')) removed.push(l.slice(1));
    }
  }
  return { added, removed };
}

/** Added/removed lines for an edit, preferring the result the tool recorded. */
function editLines(
  name: string,
  input: Obj,
  result: unknown,
): { added: string[]; removed: string[]; created?: boolean } {
  if (isObj(result)) {
    const fromPatch = linesFromPatch(result.structuredPatch);
    if (fromPatch.added.length || fromPatch.removed.length) return fromPatch;
    if (result.type === 'create' && typeof result.content === 'string') {
      return { added: splitLines(result.content), removed: [], created: true };
    }
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return { added: splitLines(input.content), removed: [] };
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const added: string[] = [];
    const removed: string[] = [];
    for (const e of input.edits) {
      if (!isObj(e)) continue;
      added.push(...splitLines(str(e.new_string) ?? ''));
      removed.push(...splitLines(str(e.old_string) ?? ''));
    }
    return { added, removed };
  }
  return {
    added: splitLines(str(input.new_string) ?? str(input.new_source) ?? ''),
    removed: splitLines(str(input.old_string) ?? ''),
  };
}

function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** The typed prompt in a user line, or undefined if it isn't one. */
function promptText(o: Obj, msg: Obj): string | undefined {
  if (o.isMeta || o.isCompactSummary || o.isApiErrorMessage) return undefined;
  if (NON_USER_PROMPT_SOURCES.has(str(o.promptSource) ?? '')) return undefined;
  let text: string | undefined;
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    if (msg.content.some((c) => isObj(c) && c.type === 'tool_result')) return undefined;
    text = msg.content
      .map((c) =>
        isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : '',
      )
      .join('\n');
  }
  text = text?.trim();
  if (!text || isSyntheticPrompt(text)) return undefined;
  // Slash-command echoes and local command output arrive wrapped in a single tag.
  if (/^<([a-z][a-z0-9-]*)>[\s\S]*<\/\1>$/.test(text)) return undefined;
  return text;
}

interface Pending {
  name: string;
  input: Obj;
  ts?: string;
  cwd?: string;
  branch?: string;
  model?: string;
}

/** Parse one Claude JSONL file's content into records. Exported for tests. */
export function parseClaudeLines(
  content: string,
  into: TraceSession,
  opts: { subagent?: boolean } = {},
): void {
  const pending = new Map<string, Pending>();
  const countedUsage = new Set<string>();
  let lastTs: string | undefined;
  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const type = str(o.type) ?? '';
    if (!KNOWN_TYPES.has(type)) {
      into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
      continue;
    }
    const base = { ts: str(o.timestamp), cwd: str(o.cwd), branch: str(o.gitBranch) };
    if (base.ts && (!lastTs || base.ts > lastTs)) lastTs = base.ts;

    if (type === 'ai-title' && str(o.aiTitle)) into.title = str(o.aiTitle);
    if (type === 'custom-title' && str(o.customTitle)) into.title = str(o.customTitle);
    if (type === 'cost-state' && typeof o.totalCostUSD === 'number') {
      into.sessionCostUsd = o.totalCostUSD;
    }
    if (type === 'pr-link') {
      into.records.push({
        kind: 'link',
        ts: base.ts,
        prUrl: str(o.prUrl),
        prNumber: typeof o.prNumber === 'number' ? o.prNumber : undefined,
        prRepository: str(o.prRepository),
      });
    }
    if (type === 'worktree-state' && isObj(o.worktreeSession)) {
      const w = o.worktreeSession;
      into.records.push({
        kind: 'link',
        worktreePath: str(w.worktreePath),
        worktreeBranch: str(w.worktreeBranch),
        cwd: str(w.worktreePath),
        branch: str(w.worktreeBranch),
      });
    }
    if (type !== 'user' && type !== 'assistant') continue;
    const msg = isObj(o.message) ? o.message : undefined;
    if (!msg) continue;

    if (type === 'user') {
      const text = promptText(o, msg);
      if (text) {
        into.records.push({
          kind: 'prompt',
          text,
          ...base,
          ...(opts.subagent ? { delegated: true } : {}),
        });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      for (const c of msg.content) {
        if (!isObj(c) || c.type !== 'tool_result') continue;
        // When the user rejects a tool call and types why, that is them steering
        // the work: keep it as a prompt.
        if (c.is_error === true) {
          const said = /the user said:\s*([\s\S]+)$/i
            .exec(textOfToolResult(c.content))?.[1]
            ?.trim();
          if (said && !isSyntheticPrompt(said)) {
            into.records.push({
              kind: 'prompt',
              text: said,
              feedback: true,
              ...base,
              ...(opts.subagent ? { delegated: true } : {}),
            });
          }
        }
        const id = str(c.tool_use_id);
        const call = id ? pending.get(id) : undefined;
        if (!call) continue;
        pending.delete(id!);
        const isError = c.is_error === true;
        const where = {
          ts: call.ts ?? base.ts,
          cwd: call.cwd ?? base.cwd,
          branch: call.branch ?? base.branch,
          model: call.model,
        };
        if (EDIT_TOOLS.has(call.name)) {
          if (isError) continue;
          const result = o.toolUseResult;
          const rawPath =
            (isObj(result) && str(result.filePath)) ||
            str(call.input.file_path) ||
            str(call.input.notebook_path);
          if (!rawPath) continue;
          const file = resolve(where.cwd ?? '.', rawPath);
          into.records.push({
            kind: 'edit',
            file,
            ...editLines(call.name, call.input, result),
            ...where,
          });
        } else if (COMMAND_TOOLS.has(call.name)) {
          const cmd = str(call.input.command);
          const r = isObj(o.toolUseResult) ? o.toolUseResult : undefined;
          const output = headTail(
            r
              ? `${str(r.stdout) ?? ''}\n${str(r.stderr) ?? ''}`
              : textOfToolResult(c.content),
          );
          if (cmd) into.records.push({ kind: 'command', cmd, isError, output, ...where });
          // Files the command changed (sed, a script, a heredoc): Claude Code
          // records them as diffs on the result. Kept even if the command failed
          // later on, since the edits happened.
          const shellDiff = r && isObj(r.bashEditDiff) ? r.bashEditDiff : undefined;
          for (const f of Array.isArray(shellDiff?.files) ? shellDiff.files : []) {
            const path = isObj(f) ? str(f.filePath) : undefined;
            if (!path) continue;
            const lines = linesFromPatch((f as Obj).hunks);
            if (!lines.added.length && !lines.removed.length) continue;
            into.records.push({
              kind: 'edit',
              file: resolve(where.cwd ?? '.', path),
              ...lines,
              via: 'shell',
              ...where,
            });
          }
        } else if (READ_TOOLS.has(call.name)) {
          if (isError) continue;
          const at =
            str(call.input.file_path) ??
            str(call.input.notebook_path) ??
            str(call.input.path);
          const pattern = str(call.input.pattern);
          (into.reads ??= []).push({
            tool: call.name,
            ts: where.ts,
            cwd: where.cwd,
            path: resolve(where.cwd ?? '.', at ?? '.'),
            ...(pattern ? { pattern } : {}),
          });
        } else if (call.name === 'ExitPlanMode') {
          // The result holds the plan as submitted; the call's input can be a
          // version behind (the plan file before the agent's last edit).
          const markdown =
            (isObj(o.toolUseResult) ? str(o.toolUseResult.plan) : undefined) ??
            str(call.input.plan);
          if (markdown) {
            const { approved } = resolvePlanResult(textOfToolResult(c.content));
            into.records.push({ kind: 'plan', markdown, approved, ...where });
          }
        } else if (call.name === 'AskUserQuestion') {
          const qs = Array.isArray(call.input.questions) ? call.input.questions : [];
          const questions = qs
            .map((q) => (isObj(q) ? str(q.question) : undefined))
            .filter(Boolean)
            .join(' / ');
          const answer = textOfToolResult(c.content);
          into.records.push({
            kind: 'decision',
            text: `${questions}\n${answer}`.trim(),
            questions: decisionQuestions(qs, o.toolUseResult),
            ...where,
          });
        }
      }
      continue;
    }

    // assistant
    const model = str(msg.model);
    const usage = isObj(msg.usage) ? msg.usage : undefined;
    const msgId = str(msg.id);
    if (usage && msgId && !countedUsage.has(msgId)) {
      countedUsage.add(msgId);
      const u: Usage = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
      };
      into.records.push({ kind: 'usage', model, usage: u, ...base });
    }
    if (!Array.isArray(msg.content)) continue;
    const texts: string[] = [];
    for (const c of msg.content) {
      if (!isObj(c)) continue;
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim())
        texts.push(c.text);
      if (c.type === 'tool_use' && str(c.id) && str(c.name)) {
        pending.set(str(c.id)!, {
          name: str(c.name)!,
          input: isObj(c.input) ? c.input : {},
          ...base,
          model,
        });
      }
    }
    if (texts.length)
      into.records.push({ kind: 'assistant', text: texts.join('\n'), model, ...base });
  }
  // Commands still running when the log was read (e.g. `git commit && tracetoon
  // digest` in one call): their result isn't written until they finish. Keep the
  // recent ones as commands with no output, so a commit's subject still counts.
  // Older unanswered calls were interrupted and never ran.
  const recentFrom = lastTs ? Date.parse(lastTs) - PENDING_WINDOW_MS : Infinity;
  for (const call of pending.values()) {
    const cmd = COMMAND_TOOLS.has(call.name) ? str(call.input.command) : undefined;
    if (!cmd || !call.ts || Date.parse(call.ts) < recentFrom) continue;
    into.records.push({
      kind: 'command',
      cmd,
      pending: true,
      ts: call.ts,
      cwd: call.cwd,
      branch: call.branch,
      model: call.model,
    });
  }
}

/** How recent an unanswered command must be to count as still running. */
const PENDING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The `subagents/*.jsonl` files that belong to a top-level session file. */
function subagentFiles(sessionPath: string): string[] {
  const dir = join(dirname(sessionPath), basename(sessionPath, '.jsonl'), 'subagents');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function claudeHome(): string {
  return dirname(claude.claudeProjectsDir());
}

export const claudeAdapter: TraceAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  home() {
    const dir = claude.claudeProjectsDir();
    return existsSync(dir) ? claudeHome() : undefined;
  },
  count: () => claude.findTranscripts().length,
  discover(query) {
    const { sinceMs } = query;
    const out: SessionRef[] = [];
    const index = discoveryIndex(query, 'claude-code');
    for (const t of claude.findTranscripts()) {
      const files = [t.path, ...subagentFiles(t.path)];
      const info = files.map((p) => index.inspect(p)).filter((p) => p !== undefined);
      const active =
        query.currentSessionPath &&
        files.some((p) => resolve(p) === resolve(query.currentSessionPath!));
      const recent = Math.max(t.mtimeMs, ...info.map((p) => p.recent));
      if ((active || recent >= sinceMs) && (active || info.some((p) => p.match))) {
        out.push({
          agent: 'claude-code',
          sessionId: t.sessionId,
          path: t.path,
          mtimeMs: recent,
          cwd: t.cwd,
        });
      }
    }
    index.save();
    return out;
  },
  read(ref) {
    const session: TraceSession = {
      agent: 'claude-code',
      sessionId: ref.sessionId,
      source: ref.path,
      records: [],
      unknownTypes: {},
      warnings: [],
    };
    for (const p of [ref.path, ...subagentFiles(ref.path)]) {
      try {
        parseClaudeLines(readFileSync(p, 'utf8'), session, { subagent: p !== ref.path });
      } catch (e) {
        session.warnings.push(`Could not read ${basename(p)}: ${(e as Error).message}`);
      }
    }
    session.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    return session;
  },
};

/**
 * The questions and the user's exact answers. Claude Code keeps them in
 * `toolUseResult.answers` (question -> answer); options come from the call.
 */
export function decisionQuestions(qs: unknown[], result: unknown): DecisionQuestion[] {
  const answers =
    isObj(result) && isObj(result.answers)
      ? (result.answers as Record<string, unknown>)
      : {};
  return qs.flatMap((q) => {
    if (!isObj(q)) return [];
    const question = str(q.question);
    if (!question) return [];
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => (isObj(o) ? str(o.label) : str(o)))
      .filter((l): l is string => !!l);
    const raw = answers[question];
    const answer =
      typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : undefined;
    const picked = answer
      ? options.includes(answer) ||
        answer.split(/,\s*/).every((a) => options.includes(a.trim()))
      : false;
    return [{ question, options, answer, ownWords: answer ? !picked : undefined }];
  });
}
