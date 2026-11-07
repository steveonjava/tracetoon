/**
 * Antigravity adapter (CLI and IDE). Reads the plain-JSONL transcript at
 * `~/.gemini/antigravity-{cli,ide}/brain/<conversation>/.system_generated/logs/transcript.jsonl`
 * plus the brain's markdown artifacts (implementation_plan.md, task.md,
 * walkthrough.md). The SQLite/protobuf conversation stores are not read.
 *
 * Transcript lines carry no working directory, so locations come from edit
 * targets, command folders, and `history.jsonl`, which records the workspace each
 * prompt was typed in.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { antigravity, antigravityIde } from '@showtail/agent-traces';
import { headTail, splitLines } from './diffLines.ts';
import { mentionsAnyRoot } from './pathMatch.ts';
import { discoveryIndex } from './discovery.ts';
import type {
  AgentId,
  SessionRef,
  TraceAdapter,
  TraceRecord,
  TraceSession,
} from './types.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const ARTIFACTS = ['implementation_plan.md', 'task.md', 'walkthrough.md', 'plan.md'];
const KNOWN = new Set([
  'USER_INPUT',
  'PLANNER_RESPONSE',
  'CODE_ACTION',
  'RUN_COMMAND',
  'VIEW_FILE',
  'LIST_DIRECTORY',
  'GREP_SEARCH',
  'SEARCH_WEB',
  'READ_URL_CONTENT',
  'ERROR_MESSAGE',
  'SYSTEM_MESSAGE',
  'CHECKPOINT',
  'CONVERSATION_HISTORY',
  'KNOWLEDGE_ARTIFACTS',
  'GENERIC',
  'ASK_QUESTION',
  'BROWSER_SUBAGENT',
  'MANAGE_TASK',
  'FIND',
]);

/** Strip Antigravity's `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` wrapping off a prompt. */
// Mirrors the private helper in @showtail/agent-traces' Antigravity reader.
export function cleanUserContent(raw: string): string {
  let text = raw;
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(text);
  text = m ? m[1]! : text.replace(/^\s*<USER_REQUEST>\s*/i, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  return text.trim();
}

/** IDE tool arguments arrive JSON-encoded twice (`"\"C:\\\\x\""`); undo that. */
export function unwrapArg(value: unknown): string | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* use as is */
    }
  }
  return s;
}

function fileFromArg(v: unknown): string | undefined {
  const s = unwrapArg(v);
  if (!s) return undefined;
  if (s.startsWith('file:///'))
    return decodeURIComponent(s.slice(8)).replace(/^\/([A-Za-z]:)/, '$1');
  return s;
}

interface HistoryEntry {
  display: string;
  ms: number;
  workspace: string;
}

function readHistory(home: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const dir of ['antigravity-cli', 'antigravity-ide', 'antigravity']) {
    const p = join(home, dir, 'history.jsonl');
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      try {
        const o = JSON.parse(line) as {
          display?: string;
          timestamp?: number;
          workspace?: string;
        };
        if (o.display && o.workspace && typeof o.timestamp === 'number') {
          out.push({
            display: o.display.trim(),
            ms: o.timestamp,
            workspace: fileFromArg(o.workspace) ?? o.workspace,
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** The workspace a prompt was typed in, matched by text and time. */
function workspaceFor(
  text: string,
  ts: string | undefined,
  history: HistoryEntry[],
): string | undefined {
  const t = ts ? Date.parse(ts) : NaN;
  const head = text.slice(0, 60);
  const hit = history.find(
    (h) =>
      (h.display.startsWith(head) || head.startsWith(h.display.slice(0, 60))) &&
      (!Number.isFinite(t) || Math.abs(h.ms - t) < 10 * 60_000),
  );
  return hit?.workspace;
}

interface ParseCtx {
  history: HistoryEntry[];
  brainDir?: string;
}

/** Parse one transcript.jsonl. Exported for tests. */
export function parseAntigravityLines(
  content: string,
  into: TraceSession,
  ctx: ParseCtx,
): void {
  let model: string | undefined;
  let cwd: string | undefined;
  let pendingEdits: Extract<TraceRecord, { kind: 'edit' }>[] = [];
  const pendingCommands: { cmd: string; ts?: string; cwd?: string }[] = [];
  let pendingQuestion: { text: string; ts?: string } | undefined;
  const brainKey = ctx.brainDir?.replace(/\\/g, '/').toLowerCase();

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
    const ts = str(o.created_at);
    const status = str(o.status) ?? '';
    if (!KNOWN.has(type)) {
      into.unknownTypes[type] = (into.unknownTypes[type] ?? 0) + 1;
      continue;
    }

    if (type === 'USER_INPUT') {
      const rawText = str(o.content) ?? '';
      const m = /Model Selection[^\n]*?\bto\s+(.+?)(?:\.\s|\.$|\n|$)/.exec(rawText);
      if (m) model = m[1]!.trim();
      const text = cleanUserContent(rawText);
      if (!text) continue;
      cwd = workspaceFor(text, ts, ctx.history) ?? cwd;
      into.records.push({ kind: 'prompt', text, ts, cwd });
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const text = str(o.content)?.trim();
      if (text && str(o.source) !== 'SYSTEM')
        into.records.push({ kind: 'assistant', text, model, ts, cwd });
      const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      for (const call of calls) {
        if (!isObj(call)) continue;
        const name = str(call.name) ?? '';
        const args = isObj(call.args) ? call.args : {};
        const target = fileFromArg(args.TargetFile);
        if (
          target &&
          brainKey &&
          target.replace(/\\/g, '/').toLowerCase().startsWith(brainKey)
        )
          continue;
        const file = target ? resolve(cwd ?? '.', target) : undefined;
        const at = { ts, cwd: file ? dirname(file) : cwd, model };
        if (name === 'write_to_file' && file) {
          pendingEdits.push({
            kind: 'edit',
            file,
            added: splitLines(unwrapArg(args.CodeContent) ?? ''),
            removed: [],
            created: true,
            ...at,
          });
        } else if (name === 'replace_file_content' && file) {
          pendingEdits.push({
            kind: 'edit',
            file,
            added: splitLines(unwrapArg(args.ReplacementContent) ?? ''),
            removed: splitLines(unwrapArg(args.TargetContent) ?? ''),
            ...at,
          });
        } else if (name === 'multi_replace_file_content' && file) {
          let chunks: unknown;
          try {
            chunks = JSON.parse(unwrapArg(args.ReplacementChunks) ?? '[]');
          } catch {
            chunks = [];
          }
          const added: string[] = [];
          const removed: string[] = [];
          for (const c of Array.isArray(chunks) ? chunks : []) {
            if (!isObj(c)) continue;
            added.push(...splitLines(str(c.ReplacementContent) ?? ''));
            removed.push(...splitLines(str(c.TargetContent) ?? ''));
          }
          pendingEdits.push({ kind: 'edit', file, added, removed, ...at });
        } else if (name === 'run_command') {
          const cmd = unwrapArg(args.CommandLine);
          if (cmd) pendingCommands.push({ cmd, ts, cwd: fileFromArg(args.Cwd) ?? cwd });
        } else if (
          name === 'view_file' ||
          name === 'grep_search' ||
          name === 'list_dir'
        ) {
          // Best effort: the argument names Antigravity uses for reads and searches.
          const at =
            fileFromArg(args.AbsolutePath) ??
            fileFromArg(args.SearchPath) ??
            fileFromArg(args.DirectoryPath) ??
            target;
          const pattern = unwrapArg(args.Query);
          (into.reads ??= []).push({
            tool: name,
            ts,
            cwd,
            ...(at ? { path: resolve(cwd ?? '.', at) } : {}),
            ...(pattern ? { pattern } : {}),
          });
        } else if (name === 'ask_question') {
          pendingQuestion = { text: unwrapArg(args.questions) ?? '', ts };
        }
      }
      continue;
    }

    if (type === 'CODE_ACTION') {
      // Confirms the edit(s) proposed just before it.
      if (!/error|fail|cancel|reject/i.test(status)) into.records.push(...pendingEdits);
      pendingEdits = [];
      continue;
    }
    if (type === 'ERROR_MESSAGE') {
      pendingEdits = [];
      continue;
    }
    if (type === 'RUN_COMMAND') {
      const c = pendingCommands.shift();
      if (!c) continue;
      const output = headTail(str(o.content) ?? '');
      const exit = /exit(?:ed with)? code[:\s]+(\d+)/i.exec(output)?.[1];
      into.records.push({
        kind: 'command',
        cmd: c.cmd,
        isError: /error|fail/i.test(status) || (exit !== undefined && exit !== '0'),
        output,
        ts: c.ts,
        cwd: c.cwd,
      });
      continue;
    }
    if (type === 'ASK_QUESTION' && pendingQuestion) {
      const answer = str(o.content) ?? '';
      into.records.push({
        kind: 'decision',
        text: `${pendingQuestion.text}\n${answer}`.trim(),
        ts: pendingQuestion.ts,
        cwd,
      });
      pendingQuestion = undefined;
    }
  }
}

function readArtifacts(brainDir: string, into: TraceSession): void {
  for (const f of ARTIFACTS) {
    const p = join(brainDir, f);
    if (!existsSync(p)) continue;
    let summary: string | undefined;
    let ts: string | undefined;
    try {
      const meta = JSON.parse(readFileSync(`${p}.metadata.json`, 'utf8')) as {
        summary?: string;
        updatedAt?: string;
      };
      summary = meta.summary;
      ts = meta.updatedAt;
    } catch {
      /* no metadata */
    }
    ts ??= new Date(statSync(p).mtimeMs).toISOString();
    const markdown = readFileSync(p, 'utf8');
    const name = f.replace(/\.md$/, '');
    into.records.push({ kind: 'artifact', name, markdown, summary, ts });
    if (!into.title && name === 'task')
      into.title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  }
}

function makeAdapter(
  id: AgentId,
  label: string,
  find: () => { path: string; sessionId: string; mtimeMs: number }[],
): TraceAdapter {
  return {
    id,
    label,
    home() {
      const home = antigravity.geminiHome();
      return find().length || existsSync(join(home, id)) ? home : undefined;
    },
    count: () => find().length,
    discover(query) {
      const { roots, sinceMs, all } = query;
      const history = readHistory(antigravity.geminiHome());
      const historyNeedles = history
        .filter((h) => h.ms >= sinceMs && mentionsAnyRoot(h.workspace, roots))
        .map((h) => h.display.slice(0, 40))
        .filter((s) => s.trim().length >= 10);
      const index = discoveryIndex(
        { ...query, needles: [...(query.needles ?? []), ...historyNeedles] },
        id,
      );
      const out: SessionRef[] = [];
      for (const t of find()) {
        const info = index.inspect(t.path);
        if (!info) continue;
        const active =
          query.currentSessionPath &&
          resolve(t.path) === resolve(query.currentSessionPath);
        const recent = Math.max(t.mtimeMs, info.recent);
        if (!active && recent < sinceMs) continue;
        if (all || info.match || active) {
          out.push({
            agent: id,
            sessionId: t.sessionId,
            path: t.path,
            mtimeMs: recent,
          });
        }
      }
      index.save();
      return out;
    },
    read(ref) {
      const session: TraceSession = {
        agent: id,
        sessionId: ref.sessionId,
        source: ref.path,
        records: [],
        unknownTypes: {},
        warnings: [],
      };
      // .../brain/<id>/.system_generated/logs/transcript.jsonl → .../brain/<id>
      const brainDir = dirname(dirname(dirname(ref.path)));
      try {
        parseAntigravityLines(readFileSync(ref.path, 'utf8'), session, {
          history: readHistory(antigravity.geminiHome()),
          brainDir,
        });
        readArtifacts(brainDir, session);
      } catch (e) {
        session.warnings.push(
          `Could not read Antigravity transcript: ${(e as Error).message}`,
        );
      }
      session.records.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
      return session;
    },
  };
}

export const antigravityCliAdapter = makeAdapter(
  'antigravity-cli',
  'Antigravity CLI',
  () => antigravity.findAntigravityCliTranscripts(),
);
export const antigravityIdeAdapter = makeAdapter('antigravity-ide', 'Antigravity', () =>
  antigravityIde.findAntigravityIdeTranscripts(),
);
