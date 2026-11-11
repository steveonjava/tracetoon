/** Explicit verification receipts; raw output and environment values are never persisted. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { contentFingerprint, readTask } from './state.ts';
import { readLocal, writeLocal } from '../util/localJson.ts';
import type { Run } from '../run.ts';
import type { Run as EvidenceRun } from '../digest/build.ts';
import { makeScrubber } from '../digest/sanitize.ts';
import { publicationLock } from './publication.ts';
import { readSubmittedFile, repoPath } from '../util/repoFiles.ts';
import { dependencyFingerprint } from './validationInputs.ts';
import { count } from '../util/profile.ts';

export interface CheckReceipt {
  v: 1;
  name: string;
  command: string[];
  cwd: string;
  kind: EvidenceRun['kind'];
  fingerprint: string;
  environment: string;
  outcome: 'passed' | 'failed' | 'not-run' | 'running';
  exitCode: number | null;
  reason?: string;
  summary: string[];
  startedAt: string;
  durationMs: number;
  commandSha256?: string;
  inputs?: string[];
  reuse?: { state: 'executed' | 'reused'; reason: string; matchedName?: string };
}
export const receipts = (run: Run): CheckReceipt[] =>
  readLocal<CheckReceipt[]>(join(run.dir, 'checks.json')) ?? [];
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function inputFingerprint(
  root: string,
  inputs: string[],
  content = contentFingerprint(root),
  dependency = dependencyFingerprint(root),
): string {
  const complete = dependency === null ? content : hash([content, dependency]);
  if (!inputs.length) return complete;
  return hash([
    complete,
    [...new Set(inputs)].sort().map((path) => {
      if (!repoPath(path))
        throw new Error(
          'Extra validation inputs must be public worktree-relative files.',
        );
      return [
        path,
        createHash('sha256').update(readSubmittedFile(root, path)).digest('hex'),
      ];
    }),
  ]);
}
/**
 * Variables a coding agent sets to describe its own session, not the code,
 * toolchain or test environment. They change mid-task: Codex's per-call id, and
 * Claude Code's effort level, attended flag, ids and version string.
 */
const HOST_SESSION_VARS =
  /^(CODEX_TOOL_CALL_ID|CODEX_THREAD_ID|CLAUDE_EFFORT|CLAUDE_PID|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_\w+|AI_AGENT)$/;

/**
 * Result lines of a check's output: the last three that report counts.
 * stderr is read before stdout, so a wrapper's own total on stdout ("46 passed,
 * 0 failed") wins over the last child's per-file lines on stderr; a runner that
 * writes only one stream is unaffected.
 */
export function checkSummary(
  stdout: string,
  stderr: string,
  scrub: (text: string) => string = (t) => t,
): string[] {
  return scrub(`${stderr}\n${stdout}`)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((s) =>
      /\b\d+\s+(?:pass(?:ed|es)?|fail(?:ed|ures?|s)?|tests?|checks?)\b|\b(?:Tests|Test Files):/i.test(
        s,
      ),
    )
    .slice(-3)
    .map((s) => s.slice(0, 200));
}
/**
 * Terminal, display and temp-directory variables: they differ between shells
 * of one machine without changing what a check does, so they don't invalidate
 * a receipt.
 */
const VOLATILE_VARS =
  /^(TMPDIR|TMP|TEMP|TERM|TERM_PROGRAM\w*|COLORTERM|COLUMNS|LINES|DISPLAY|WAYLAND_DISPLAY|WINDOWID|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_\w+|XDG_RUNTIME_DIR|SSH_\w+|VTE_VERSION|KITTY_\w+|ITERM_\w+|TMUX\w*|STY|WT_SESSION|WT_PROFILE_ID)$/;
export function checkEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  // Hash, don't log, the environment. Changed PATH/toolchain/options invalidate reuse.
  return hash([
    process.platform,
    process.arch,
    process.version,
    (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
    Object.entries(env)
      .filter(
        ([k]) =>
          !/^(TRACETOON|FAKE_|_|PWD$|OLDPWD$|SHLVL$|SHELL$)/.test(k) &&
          !HOST_SESSION_VARS.test(k) &&
          !VOLATILE_VARS.test(k),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function checkKind(command: string): EvidenceRun['kind'] {
  if (/typecheck|\btsc\b/i.test(command)) return 'typecheck';
  if (/lint|prettier/i.test(command)) return 'lint';
  if (/\btest|pytest|vitest/i.test(command)) return 'test';
  if (/build|bundle|compile/i.test(command)) return 'build';
  if (/\beval/i.test(command)) return 'eval';
  return 'other';
}
interface CheckOptions {
  name: string;
  cwd?: string;
  command: string[];
  skip?: string;
  force?: boolean;
  onStart?: (receipt: CheckReceipt) => void;
  input?: string[];
}
export function executeCheck(
  root: string,
  run: Run,
  opts: CheckOptions,
): CheckReceipt & { reused?: boolean } {
  return publicationLock(
    run,
    () => {
      const prepared = prepareCheck(root, run, opts);
      if ('cached' in prepared) return prepared.cached;
      const result = opts.skip
        ? undefined
        : spawnSync(opts.command[0]!, opts.command.slice(1), {
            cwd: prepared.cwd,
            env: process.env,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
          });
      if (result?.stdout) process.stderr.write(result.stdout);
      if (result?.stderr) process.stderr.write(result.stderr);
      return prepared.finish(result);
    },
    'checks.lock',
  );
}
interface CheckResult {
  status: number | null;
  error?: Error;
  stdout: string;
  stderr: string;
}
export function executeCheckLive(
  root: string,
  run: Run,
  opts: CheckOptions,
): Promise<CheckReceipt & { reused?: boolean }> {
  return publicationLock(
    run,
    async () => {
      const prepared = prepareCheck(root, run, opts);
      if ('cached' in prepared) return prepared.cached;
      const result = opts.skip
        ? undefined
        : await streamCheck(opts.command, prepared.cwd);
      return prepared.finish(result);
    },
    'checks.lock',
  );
}
function streamCheck(command: string[], cwd: string): Promise<CheckResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '',
      stderr = '',
      error: Error | undefined,
      bytes = 0;
    const interrupt = (signal: NodeJS.Signals) => {
      error ??= new Error(`Validation interrupted by ${signal}.`);
      child.kill(signal);
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const capture = (text: string, isError: boolean) => {
      process.stderr.write(text);
      bytes += Buffer.byteLength(text);
      if (bytes > 64 * 1024 * 1024) {
        error ??= new Error('Validation output exceeded the 64 MiB capture limit.');
        child.kill();
        return;
      }
      if (isError) stderr += text;
      else stdout += text;
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (text: string) => capture(text, false));
    child.stderr!.on('data', (text: string) => capture(text, true));
    child.on('error', (failure) => {
      error ??= failure;
    });
    child.once('close', (status) => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      resolveResult({ status, error, stdout, stderr });
    });
  });
}
function prepareCheck(
  root: string,
  run: Run,
  opts: CheckOptions,
):
  | { cached: CheckReceipt & { reused?: boolean } }
  | { cwd: string; finish: (result: CheckResult | undefined) => CheckReceipt } {
  const cwd = resolve(root, opts.cwd ?? '.');
  const rel = relative(root, cwd).replace(/\\/g, '/');
  if (
    rel === '..' ||
    rel.startsWith('../') ||
    resolve(root, rel) !== cwd ||
    !existsSync(cwd)
  )
    throw new Error('Check directory must be inside this worktree.');
  if (!opts.name.trim() || (!opts.command.length && !opts.skip?.trim()))
    throw new Error('Supply a check command or an explicit --skip reason.');
  const fingerprint = inputFingerprint(root, opts.input ?? []);
  const environment = checkEnvironment();
  const safeName = makeScrubber([root]).text(opts.name);
  const previous = receipts(run);
  const old = previous.find(
    (c) =>
      c.outcome === 'passed' &&
      c.fingerprint === fingerprint &&
      c.environment === environment &&
      c.cwd === rel &&
      (c.commandSha256 ?? hash(c.command)) === hash(opts.command),
  );
  if (
    !opts.force &&
    old?.outcome === 'passed' &&
    old.fingerprint === fingerprint &&
    old.environment === environment &&
    old.cwd === rel &&
    (old.commandSha256 ?? hash(old.command)) === hash(opts.command) &&
    !opts.skip
  ) {
    count('check.reused');
    const reused = {
      ...old,
      name: safeName,
      reused: true,
      reuse: {
        state: 'reused' as const,
        reason: 'Exact command, inputs, directory and environment match.',
        matchedName: old.name,
      },
    };
    if (old.name !== safeName)
      writeLocal(join(run.dir, 'checks.json'), [
        ...previous.filter((c) => c.name !== safeName),
        reused,
      ]);
    return { cached: reused };
  }
  count('check.executed');
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const scrub = makeScrubber([root]);
  const running: CheckReceipt = {
    v: 1,
    name: safeName,
    command: opts.command.map((c) => scrub.text(atRepo(c, root))),
    commandSha256: hash(opts.command),
    cwd: rel,
    kind: checkKind(`${opts.name} ${opts.command.join(' ')}`),
    fingerprint,
    inputs: opts.input,
    environment,
    outcome: 'running',
    exitCode: null,
    summary: [],
    startedAt,
    durationMs: 0,
  };
  writeLocal(join(run.dir, 'checks.json'), [
    ...previous.filter((c) => c.name !== safeName),
    running,
  ]);
  opts.onStart?.(running);
  return {
    cwd,
    finish: (result) => {
      const after = inputFingerprint(root, opts.input ?? []);
      const receipt: CheckReceipt = {
        v: 1,
        name: safeName,
        command: opts.command.map((c) => scrub.text(atRepo(c, root))),
        commandSha256: hash(opts.command),
        cwd: rel,
        kind: checkKind(`${opts.name} ${opts.command.join(' ')}`),
        fingerprint,
        inputs: opts.input,
        environment,
        outcome: opts.skip
          ? 'not-run'
          : result?.status === 0 && !result.error && after === fingerprint
            ? 'passed'
            : 'failed',
        exitCode: result?.status ?? null,
        reason:
          scrub.text(
            opts.skip ??
              (after !== fingerprint
                ? 'The command changed validation inputs; run checks after finalizing those changes.'
                : (result?.error?.message ?? '')),
          ) || undefined,
        summary: checkSummary(result?.stdout ?? '', result?.stderr ?? '', (t) =>
          makeScrubber([root]).text(t),
        ),
        startedAt,
        durationMs: Math.round(performance.now() - start),
        reuse: {
          state: 'executed',
          reason: opts.force
            ? 'Explicitly forced.'
            : 'No passing receipt matches the current command, inputs, directory and environment.',
        },
      };
      writeLocal(join(run.dir, 'checks.json'), [
        ...previous.filter((c) => c.name !== safeName),
        receipt,
      ]);
      return receipt;
    },
  };
}
export function checkReport(root: string, run: Run) {
  const fingerprint = contentFingerprint(root);
  const dependency = dependencyFingerprint(root);
  const environment = checkEnvironment();
  return receipts(run).map((c) => ({
    ...c,
    current: (() => {
      try {
        return (
          c.fingerprint ===
            inputFingerprint(root, c.inputs ?? [], fingerprint, dependency) &&
          c.environment === environment
        );
      } catch {
        return false;
      }
    })(),
  }));
}
/**
 * A `tracetoon check` receipt that passed on the content as it is now (and in
 * this environment). Read from the run folder when the brief is read, so a
 * check run after `prepare` retires "no passing run after the last commit"
 * without a rebuilt graph. False when there is no receipt or no known root.
 */
export function passOnSubmittedContent(run: Run, root?: string): boolean {
  if (!receipts(run).some((c) => c.outcome === 'passed')) return false;
  const at = root ?? readTask(run)?.root;
  if (!at) return false;
  try {
    return checkReport(at, run).some((c) => c.current && c.outcome === 'passed');
  } catch {
    return false;
  }
}
/**
 * Paths inside the repository written as `<repo>/…`, so an absolute path the
 * command used stays distinguishable from a relative one (the scrubber alone
 * strips the root, which made a passing absolute-path retry read as the failed
 * relative-path attempt; conf21 pr12).
 */
function atRepo(arg: string, root: string): string {
  const roots = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {
    /* the root as given */
  }
  let out = arg;
  for (const r of roots) out = out.split(`${r}/`).join('<repo>/').split(r).join('<repo>');
  return out;
}

/** argv as a shell would need it typed: arguments with spaces or shell characters quoted. */
export function shellJoin(argv: string[]): string {
  return argv
    .map((a) =>
      a === '' ? "''" : /[^\w@%+=:,./<>-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a,
    )
    .join(' ');
}

export function receiptEvidence(
  root: string,
  run: Run,
  // Reuse a report the caller already computed (fingerprinting walks every file).
  report: ReturnType<typeof checkReport> = checkReport(root, run),
): EvidenceRun[] {
  return report
    .filter((c) => c.current && ['passed', 'failed'].includes(c.outcome))
    .map((c, i) => ({
      id: `V${i + 1}`,
      cmd: shellJoin(c.command),
      kind: c.kind,
      outcome: c.outcome as 'passed' | 'failed',
      basis: 'exit status',
      summary: c.summary,
      t: c.startedAt,
      revision: 'no later edits seen',
      verificationBasis: 'exact-content-receipt',
    }));
}
