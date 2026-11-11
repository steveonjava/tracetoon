/**
 * The trace digest: a compact, redacted JSON summary of how the PR was made, sized
 * to fit an LLM's context. The host agent writes the PR description from this.
 */
import { createHash } from 'node:crypto';
import {
  attribute,
  evidenceLine,
  isGeneratedPath,
  prLineIndex,
  repoRel,
  type SessionMatch,
} from '../correlate/correlate.ts';
import type { PrTruth } from '../git/pr.ts';
import type { Usage } from '../trace/types.ts';
import { clip, makeScrubber, type Scrubber } from './sanitize.ts';
import { TOOL_VERSION } from '../version.ts';
import { detectInterop, type Interop } from '../git/interop.ts';
import { shellSegments, splitCommands } from '../util/shell.ts';

export interface DigestSession {
  ref: string;
  agent: string;
  title?: string;
  models: string[];
  span: { start?: string; end?: string };
  usage: Usage | null;
  sessionCostUsd?: number;
  score: number;
  band: 'included' | 'ambiguous';
  reasons: string[];
  /**
   * What the user typed. `id` (S1, S2…) lets text cite it. `ledToEdits`: led to
   * edits that survive in the PR. `pushback`: typed while rejecting the agent's
   * action, so it steers or corrects what the agent was doing.
   */
  prompts: {
    id?: string;
    t?: string;
    text: string;
    ledToEdits: boolean;
    pushback?: boolean;
  }[];
  /** Tasks the agent handed to its own subagents. */
  delegations: { t?: string; text: string }[];
  /** Short SHAs of PR commits made during this session. */
  commitsMade: string[];
  /** `approved: false` means sent back; that alone doesn't mean its design was rejected. */
  plans: { id?: string; t?: string; approved?: boolean; excerpt: string }[];
  /** Documents the agent kept for the session (Antigravity task, plan, walkthrough). */
  artifacts: { name: string; summary?: string; excerpt: string }[];
  /**
   * Questions the user answered. `questions` (when the log has them) keeps the
   * options and the exact answer. An option that wasn't picked is only that:
   * not picked. `ownWords`: the user answered in their own words.
   */
  decisions: {
    id?: string;
    t?: string;
    text: string;
    questions?: {
      question: string;
      options: string[];
      answer?: string;
      ownWords?: boolean;
    }[];
  }[];
  commands: { cmd: string; count: number; failures: number; isTest: boolean }[];
  /** Individual verification runs (tests, builds, linters, type checks, evals). */
  runs: Run[];
  milestones: string[];
  filesEdited: string[];
  discardedEdits: number;
  unknownRecordTypes: Record<string, number>;
}

/**
 * One verification run, as captured. `outcome` says what the log shows and
 * `basis` how we know: the command's exit status, its output, or neither (e.g.
 * a pipe hid the status). `revision` relates the run to the final change and is
 * never certified by timestamps alone:
 *  - `before later edits`: files in the PR were edited after this run;
 *  - `no later edits seen`: no normalized edit record to PR files followed it;
 *    shell writes and other unrecognized edits may be present even in the logs.
 *    This is a heuristic, not a freshness claim for prose;
 *  - `after later work`: it ran after the PR's last commit and after further
 *    edits to PR files, so it tested code that isn't this PR (the session kept
 *    going); it is not evidence about this PR either way;
 *  - `unknown`: no timestamp to compare.
 */
export interface Run {
  verificationBasis?: 'exact-content-receipt';
  id?: string;
  t?: string;
  cmd: string;
  kind: 'test' | 'build' | 'lint' | 'typecheck' | 'eval' | 'other';
  outcome: 'passed' | 'failed' | 'unknown';
  basis: 'exit status' | 'output' | 'none';
  /** Up to three result lines from the output, e.g. "96 pass", "0 fail". */
  summary: string[];
  revision: 'before later edits' | 'no later edits seen' | 'after later work' | 'unknown';
  /** PR files the session edited after this run (from the evidence graph): what it did not see. */
  laterEdits?: string[];
}

export interface TraceDigest {
  /** Exact-content receipts, distinguished from inferred historical log runs. */
  verification?: Run[];
  checksSha?: string;
  validation?: {
    name: string;
    command: string;
    outcome: string;
    current: boolean;
    reason?: string;
    durationMs: number;
  }[];
  v: 1;
  tool: string;
  generatedAt: string;
  repo: { owner?: string; name?: string };
  pr: {
    number?: number;
    url?: string;
    title?: string;
    base: string;
    head: string;
    mergeBase: string;
    usedWorkingTree: boolean;
    /** Uncommitted changes existed when the digest was made: runs may have tested code that isn't in the PR. */
    dirty?: boolean;
    commits: {
      sha: string;
      subject: string;
      /** Redacted commit explanation; attribute it to the commit when used. */
      body?: string;
      trailers: Record<string, string[]>;
      time?: string;
    }[];
  };
  stats: {
    filesChanged: number;
    added: number;
    removed: number;
    evidenceLines: number;
    agentMatchedPct: number;
    unmatchedPct: number;
    /** PR commits made during the included sessions (catches shell-driven edits). */
    commitsMadeInSessions: number;
    commits: number;
    /** How to read these numbers; they are Tracetoon's matching, not authorship. */
    about?: string;
  };
  sessions: DigestSession[];
  files: {
    path: string;
    /** What the file is for, to help point reviewers at the logic first. */
    role?: FileRole;
    added: number;
    removed: number;
    sessions: { ref: string; lines: number }[];
    unmatchedLines: number;
    /** Facts whose turns' edits survive in this file, strongest first (evidence graph). */
    facts?: string[];
    /** Check runs after the file's last captured edit, latest first, as `R4:passed`. */
    checksAfterLastEdit?: string[];
  }[];
  disclosure: {
    agents: string[];
    models: string[];
    suggestedTrailers: string[];
    existingTrailers: string[];
  };
  /** Provenance other tools recorded in the repo (Entire checkpoints, git-ai notes). */
  interop: Interop;
  privacy: { redactions: number; droppedForeignRecords: number; sessionIdsHashed: true };
  /** Other PR numbers the included sessions linked themselves to (Claude pr-link). */
  linkedPrs: number[];
  notes: string[];
  truncated: string[];
  /** Size of this run's evidence graph; ask it questions with `tracetoon query`. */
  graph?: {
    nodes: number;
    rels: number;
    hunks: number;
    linkedHunks: number;
    edits: number;
    deadEndEdits: number;
  };
}

/** Test runners, matched against the program at the start of a command segment. */
const TEST_RUNNERS = [
  /^(bun|npm|yarn|pnpm|deno)\s+(run\s+)?test\b/,
  /^npx\s+(jest|vitest|mocha|playwright\s+test)\b/,
  /^(python3?\s+-m\s+)?(pytest|unittest|tox|nox)\b/,
  /^(jest|vitest|mocha|rspec|phpunit|ctest)\b/,
  /^(go|cargo|dotnet|swift|mix|zig)\s+test\b/,
  /^(mvn|gradle|\.\/gradlew|gradlew)\b.*\btest\b/,
  /^make\s+(test|check)\b/,
];

/** Leading `NAME=value` assignments, quoted values included (`X="$(pwd)/a b"`). */
const ENV_PREFIX = /^([A-Z_][A-Z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/;

/** Words of the PR's changed lines, once per line index. */
const prWordCache = new WeakMap<object, Set<string>>();
function prWordsOf(prSets: Map<string, Set<string>>): Set<string> {
  let w = prWordCache.get(prSets);
  if (!w) {
    w = new Set<string>();
    for (const lines of prSets.values())
      for (const l of lines) for (const x of outWords(l)) w.add(x);
    prWordCache.set(prSets, w);
  }
  return w;
}

/** The part of a chained command that runs tests, if any. */
export function testSegment(cmd: string): string | undefined {
  return splitCommands(cmd)
    .map((s) => s.replace(ENV_PREFIX, ''))
    .find((s) => TEST_RUNNERS.some((re) => re.test(s)));
}

export function isTestCommand(cmd: string): boolean {
  return testSegment(cmd) !== undefined;
}

/**
 * Whether test output reports failures. Needed because a piped run
 * (`bun test | tail`) exits with the last program's status, not the tests'.
 */
export function testOutputFailed(output: string | undefined): boolean {
  if (!output) return false;
  return (
    /(^|\s)([1-9]\d*) (fail|failed|failing|failures?)\b/im.test(output) || // bun, pytest, mocha, vitest
    /^Tests?:.*\b[1-9]\d* failed/im.test(output) || // jest
    /^(FAIL|not ok)\b/m.test(output) || // jest file lines, TAP
    /^test result: FAILED/m.test(output) || // cargo
    /^--- FAIL:/m.test(output) || // go
    /^\(fail\) /m.test(output) // bun's per-test failure lines
  );
}

export type FileRole = 'behavior' | 'tests' | 'docs' | 'config' | 'generated' | 'version';

/** A rough role for a changed file, from its path. */
export function fileRole(path: string): FileRole {
  const p = path.toLowerCase();
  if (isGeneratedPath(p)) return 'generated';
  if (/(^|\/)(version|version\.txt)$|(^|\/)src\/version\.ts$/.test(p)) return 'version';
  if (
    /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/.test(
      p,
    )
  )
    return 'tests';
  if (/\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//.test(p)) return 'docs';
  if (
    /\.(json|ya?ml|toml|ini|cfg|lock)$|(^|\/)\.github\/|(^|\/)\.[a-z]+rc(\.[a-z]+)?$/.test(
      p,
    )
  )
    return 'config';
  return 'behavior';
}

const VERIFY: [Run['kind'], RegExp][] = [
  ['typecheck', /^((bun|npx|pnpm|yarn)\s+(x\s+)?)?(tsc|mypy|pyright)\b/],
  [
    'lint',
    /^((bun|npx|pnpm|yarn)\s+(x\s+)?)?(eslint|prettier\s+--check|ruff\s+(check|format\s+--check)|biome\s+(check|lint)|clippy|golangci-lint)\b|^cargo\s+clippy\b|^go\s+vet\b/,
  ],
  [
    'build',
    /^((bun|npm|pnpm|yarn)\s+run\s+(build|bundle|compile)\b|cargo\s+build\b|go\s+build\b|make(\s|$)|bun\s+build\b)/,
  ],
  ['eval', /^(bun|node|python3?|deno)\s+(run\s+)?\S*(eval|bench)\S*/],
];

/** The part of a command that verifies something, and what kind of check it is. */
export function verificationSegment(
  cmd: string,
): { seg: string; kind: Run['kind'] } | undefined {
  const test = testSegment(cmd);
  if (test) return { seg: test, kind: 'test' };
  for (const s of splitCommands(cmd).map((x) => x.replace(ENV_PREFIX, ''))) {
    for (const [kind, re] of VERIFY) if (re.test(s)) return { seg: s, kind };
  }
  return undefined;
}

/**
 * The verification run in one shell command, if any. Several test commands in
 * one shell command share one output, so it can't say which one failed: they
 * are listed together and the outcome is left unknown.
 */
export function commandRun(
  cmd: string,
  isError: boolean | undefined,
  output: string | undefined,
): Omit<Run, 'id' | 't' | 'revision'> | undefined {
  return commandRuns(cmd, isError, output)[0];
}

/** Output lines that belong to each kind of check, when one command runs several. */
const KIND_LINE: Partial<Record<Run['kind'], RegExp>> = {
  test: /(\b\d+\s+(pass|passed|passing|fail|failed|failing)\b|^Tests?:\s|\btest result:)/i,
  typecheck: /(\bFound \d+ errors?\b|\berror TS\d+)/i,
  lint: /(All matched files use|\b\d+\s+(errors?|warnings?)\b|\bFound \d+ errors?)/i,
  build: /(\b\d+\s+(errors?|warnings?)\b|\bBundled\b|\bbuild (failed|succeeded)\b)/i,
  eval: /\b\d+\/\d+\s+checks?\b/i,
};

/**
 * Every verification run in one shell command, in order. Agents chain checks
 * (`bun run bundle; bun x tsc --noEmit && bun test; bun scripts/eval.ts`), and
 * each is a run in its own right: recording only one makes the others look
 * like they never happened. Test commands keep the rule above (one listed run).
 * With several checks the output is shared, so each run keeps only the result
 * lines of its own kind, and a failing exit status can't be pinned on one.
 */
export function commandRuns(
  cmd: string,
  isError: boolean | undefined,
  output: string | undefined,
): Omit<Run, 'id' | 't' | 'revision'>[] {
  const parsed = shellSegments(cmd);
  const segments = parsed.map((x) => x.command.replace(ENV_PREFIX, ''));
  // A segment that sends its stdout to a file leaves no result in the log unless
  // a later segment reads that file back (`> out.log; grep pass out.log`); the
  // output captured then belongs to the other segments.
  const toFile = (s: string) => {
    const target = /(?:^|[^0-9&>])>{1,2}\s*(?!&)(\S+)/.exec(s)?.[1];
    if (!target) return false;
    const later = segments.slice(segments.indexOf(s) + 1);
    return !later.some((x) => x.includes(target));
  };
  const testSegments = segments.filter((s) => TEST_RUNNERS.some((re) => re.test(s)));
  const logged = testSegments.filter((s) => !toFile(s));
  const tests = logged.length ? logged : testSegments;
  const found: { seg: string; kind: Run['kind']; unlogged?: boolean }[] = [];
  let testAdded = false;
  for (const seg of segments) {
    if (TEST_RUNNERS.some((re) => re.test(seg))) {
      if (!tests.includes(seg)) {
        // Its results went to a file; record that it ran, not what it showed.
        found.push({ seg, kind: 'test', unlogged: true });
        continue;
      }
      if (!testAdded) found.push({ seg: tests[0]!, kind: 'test' });
      testAdded = true;
      continue;
    }
    const hit = VERIFY.find(([, re]) => re.test(seg));
    if (hit) found.push({ seg, kind: hit[0] });
  }
  const several = found.length > 1;
  const results = found.map(
    ({ seg, kind, unlogged }): Omit<Run, 'id' | 't' | 'revision'> => {
      if (unlogged)
        return { cmd: seg, kind, outcome: 'unknown', basis: 'none', summary: [] };
      const own = several
        ? (output ?? '')
            .split(/\r?\n/)
            .filter((l) => KIND_LINE[kind]?.test(l) ?? false)
            .join('\n')
        : output;
      const result = runOutcome(cmd, seg, isError, own, kind);
      if (several && result.basis === 'exit status' && result.outcome === 'failed')
        Object.assign(result, { outcome: 'unknown', basis: 'none' });
      // Several test commands' results are mixed in one output, so no count can
      // be pinned on either: list them with no result lines rather than let a
      // reader credit one suite with another's numbers.
      // The outcome is still clear when each of them reported zero failures.
      if (kind === 'test' && tests.length > 1) {
        // Every test command must have reported a failure count, all zero.
        const counts =
          (own ?? '').match(/\b\d+\s+(fail|failed|failing|failures?)\b/gi) ?? [];
        // A failure line in the shared output means one of them failed (no
        // count is pinned on either, but the run did not pass).
        const failed = testOutputFailed(own) || /^\(fail\) /m.test(output ?? '');
        const clean =
          counts.length >= tests.length && counts.every((c) => /^0\s/.test(c)) && !failed;
        return {
          cmd: tests.join(' ; '),
          kind,
          ...result,
          outcome: failed ? 'failed' : clean ? 'passed' : 'unknown',
          basis: failed || clean ? 'output' : 'none',
          summary: [],
        };
      }
      return { cmd: seg, kind, ...result };
    },
  );
  // A check that failed stops its `&&` chain: the checks after it never ran.
  const at = found.map(({ seg }) => segments.indexOf(seg));
  return results.filter(
    (_, i) =>
      !results.some(
        (r, j) =>
          j < i &&
          r.outcome === 'failed' &&
          at[j]! >= 0 &&
          at[j]! < at[i]! &&
          parsed
            .slice(at[j]! + 1, at[i]! + 1)
            .every((p) => p.before === '&&' || p.before === '|'),
      ),
  );
}

const RESULT_LINE =
  /(\b\d+\s+(pass|passed|passing|fail|failed|failing|errors?|warnings?)\b|\b\d+\/\d+\s+checks?\b|^Tests?:\s|\btest result:|All matched files use|Found \d+ errors?)/i;

/** What a captured run shows, and how we know. */
export function runOutcome(
  cmd: string,
  seg: string,
  isError: boolean | undefined,
  output: string | undefined,
  kind: Run['kind'],
): Pick<Run, 'outcome' | 'basis' | 'summary'> {
  const summary = (output ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => RESULT_LINE.test(l))
    .slice(-3)
    .map((l) => l.slice(0, 120));
  const isTest = kind === 'test';
  if (isTest && testOutputFailed(output))
    return { outcome: 'failed', basis: 'output', summary };
  // A compiler error in a typecheck's own output is a failure, whatever the exit status says.
  if (
    kind === 'typecheck' &&
    /\berror TS\d+|\bFound [1-9]\d* errors?\b/.test(output ?? '')
  )
    return { outcome: 'failed', basis: 'output', summary };
  // A failing check stops an && chain, so the tool reports an error. After
  // `;` or a pipe, the exit status belongs to a later command.
  const after = cmd
    .slice(cmd.indexOf(seg) + seg.length)
    .replace(/\d*>&\d+/g, '') // redirections like 2>&1 aren't separators
    .trimStart();
  const masked = /^(;|\|(?!\|))/.test(after) || /^[^&|;]*(;|\|(?!\|))/.test(after);
  // With the status masked, an error belongs to a later command (e.g. a grep
  // that found nothing), so judge by the output instead.
  if (isError === true && !masked)
    return { outcome: 'failed', basis: 'exit status', summary };
  if (!masked && isError === false)
    return { outcome: 'passed', basis: 'exit status', summary };
  if (
    summary.length &&
    !summary.some((l) => /\b[1-9]\d*\s+(fail|failed|failing|errors?)\b/i.test(l))
  )
    return { outcome: 'passed', basis: 'output', summary };
  return { outcome: 'unknown', basis: 'none', summary };
}

/** A short grouping key for a shell command: the program and its first argument. */
export function commandKey(cmd: string): string {
  const segments = splitCommands(cmd).filter((s) => !/^(cd|set|export|pushd)\b/.test(s));
  const first = segments[0] ?? cmd.trim();
  const tokens = first
    .replace(ENV_PREFIX, '')
    .split(/\s+/)
    .filter((t) => !/^(-|<|>|\d>)/.test(t)); // flags, heredocs and redirections
  return tokens.slice(0, 2).join(' ') || first.slice(0, 40);
}

export function hashId(salt: string, id: string): string {
  return 'h:' + createHash('sha256').update(`${salt}\0${id}`).digest('hex').slice(0, 12);
}

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'antigravity-cli': 'Antigravity CLI',
  'antigravity-ide': 'Antigravity',
};

/**
 * What happened in a session, in order, keeping the turn each fact and edit
 * belongs to. Only the evidence graph reads it; it is never written out, and its
 * edit lines (normalized PR lines, used to find the hunks an edit survives in)
 * never leave memory.
 */
export type TrailEvent =
  | { kind: 'prompt'; fact: DigestSession['prompts'][number] }
  | { kind: 'decision'; fact: DigestSession['decisions'][number] }
  | { kind: 'plan'; fact: DigestSession['plans'][number] }
  | { kind: 'run'; fact: Run }
  | {
      kind: 'edit';
      t?: string;
      /** Repo-relative, redacted. */
      file: string;
      inPr: boolean;
      /** Normalized added lines that are also added by the PR. */
      lines: string[];
      added: number;
      removed: number;
      via?: 'shell';
    };

export interface SessionTrail {
  ref: string;
  events: TrailEvent[];
  /** Commands other than checks that ran the project's own code (see `invocationsOf`). */
  invocations?: Invocation[];
}

/**
 * A command other than a check or a file utility, as plain words: the program
 * and its arguments without flags, assignments, quotes or redirections
 * (`bun src/cli.ts comic art codex`), and the words of its output that the
 * PR's own changed lines also contain. Only the evidence graph reads it.
 */
export interface Invocation {
  t?: string;
  cmd: string;
  out: string[];
}

/** Programs that read, move or inspect files: running one runs none of the project's code. */
const UTILITY =
  /^(for|while|until|if|then|else|do|done|fi|case|esac|function|\[\[?|cd|pushd|popd|ls|dir|cat|type|sed|awk|grep|egrep|rg|ag|head|tail|less|more|wc|echo|printf|git|gh|find|fd|which|where|whereis|command|test|true|false|sleep|mkdir|rmdir|rm|cp|mv|ln|touch|chmod|chown|diff|cmp|sort|uniq|cut|tr|xargs|tee|jq|yq|curl|wget|tar|zip|unzip|stat|file|du|df|ps|kill|pwd|export|set|unset|source|\.|read|exit|wait|history|clear|date|open|start|explorer|code|vim|nano|python3?\s+-c|node\s+-e|bun\s+-e)(?=\s|$)/;
/** Wrappers before the real program. */
const WRAPPER = /^(?:\(\s*)?(?:(?:time|env|exec|nohup|sudo|command)\s+)+/;
const outWords = (s: string) =>
  (s.match(/[A-Za-z][a-z]+|[A-Z]+(?![a-z])/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);

/** The non-check segments of a command that run something, as `Invocation`s. */
export function invocationsOf(
  cmd: string,
  output: string | undefined,
  prWords: Set<string>,
  scrub: Scrubber,
): Omit<Invocation, 't'>[] {
  const out: Omit<Invocation, 't'>[] = [];
  for (const raw of splitCommands(cmd)) {
    const seg = raw.replace(ENV_PREFIX, '').replace(WRAPPER, '').trim();
    if (!seg || UTILITY.test(seg)) continue;
    if (TEST_RUNNERS.some((re) => re.test(seg)) || VERIFY.some(([, re]) => re.test(seg)))
      continue;
    const words: string[] = [];
    for (const tok of seg.split(/\s+/)) {
      if (/^\d?[<>|&;]/.test(tok)) break; // redirections and what follows
      const t = tok.replace(/\)+$/, '');
      if (!t || t.startsWith('-') || /[=<>|&;"'`$(){}\\]/.test(t)) continue;
      // Long mixed tokens may be keys or ids: never kept.
      if (t.length >= 20 && /\d/.test(t) && /[A-Za-z]/.test(t) && !/[./]/.test(t))
        continue;
      words.push(t);
      if (words.length >= 10) break;
    }
    if (words.length < 2) continue;
    out.push({
      cmd: clip(scrub.text(words.join(' ')), 120),
      out: [...new Set(outWords(output ?? '').filter((w) => prWords.has(w)))].slice(
        0,
        40,
      ),
    });
  }
  return out;
}

function sessionDigest(
  m: SessionMatch,
  ref: string,
  truth: PrTruth,
  prSets: Map<string, Set<string>>,
  scrub: Scrubber,
  trail: TrailEvent[] = [],
  invocations: Invocation[] = [],
): DigestSession {
  const recs = m.kept;
  const models = new Set<string>();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  const prompts: DigestSession['prompts'] = [];
  const delegations: DigestSession['delegations'] = [];
  const artifacts: DigestSession['artifacts'] = [];
  const plans: DigestSession['plans'] = [];
  const decisions: DigestSession['decisions'] = [];
  const cmdGroups = new Map<
    string,
    { count: number; failures: number; isTest: boolean }
  >();
  const milestones: string[] = [];
  const runs: Run[] = [];
  const files = new Set<string>();
  let testFailedEarlier = false;
  let current: { ledToEdits: boolean } | undefined;

  for (const r of recs) {
    if (r.model && !r.model.startsWith('<')) models.add(r.model);
    switch (r.kind) {
      case 'prompt': {
        if (r.delegated) {
          delegations.push({ t: r.ts, text: clip(scrub.text(r.text), 200) });
          break;
        }
        const p: DigestSession['prompts'][number] = {
          t: r.ts,
          text: scrub.text(r.text),
          ledToEdits: false,
          ...(r.feedback ? { pushback: true } : {}),
        };
        prompts.push(p);
        trail.push({ kind: 'prompt', fact: p });
        current = p;
        break;
      }
      case 'assistant':
        if (r.model) models.add(r.model);
        break;
      case 'usage':
        if (r.model && !r.model.startsWith('<')) models.add(r.model);
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        usage.cacheRead += r.usage.cacheRead;
        usage.cacheWrite += r.usage.cacheWrite;
        sawUsage = true;
        break;
      case 'plan': {
        const plan = {
          t: r.ts,
          approved: r.approved,
          excerpt: scrub.text(r.markdown),
        };
        plans.push(plan);
        trail.push({ kind: 'plan', fact: plan });
        if (r.approved) milestones.push('plan approved');
        break;
      }
      case 'decision': {
        const decision: DigestSession['decisions'][number] = {
          t: r.ts,
          text: scrub.text(r.text),
          ...(r.questions?.length
            ? {
                questions: r.questions.map((q) => ({
                  question: scrub.text(q.question),
                  options: q.options.map((o) => scrub.text(o)),
                  ...(q.answer !== undefined
                    ? {
                        answer: scrub.text(q.answer),
                      }
                    : {}),
                  ...(q.ownWords !== undefined ? { ownWords: q.ownWords } : {}),
                })),
              }
            : {}),
        };
        decisions.push(decision);
        trail.push({ kind: 'decision', fact: decision });
        break;
      }
      case 'edit': {
        const rel = repoRel({ roots: m.roots }, r.file);
        if (rel) files.add(rel);
        const set = rel ? prSets.get(rel) : undefined;
        const surviving = set
          ? r.added.flatMap((l) => {
              const e = evidenceLine(l);
              return e && set.has(e) ? [e] : [];
            })
          : [];
        if (current && surviving.length) current.ledToEdits = true;
        if (rel)
          trail.push({
            kind: 'edit',
            t: r.ts,
            file: scrub.text(rel),
            inPr: !!set,
            lines: surviving,
            added: r.added.length,
            removed: r.removed.length,
            ...(r.via ? { via: r.via } : {}),
          });
        break;
      }
      case 'command': {
        for (const x of invocationsOf(r.cmd, r.output, prWordsOf(prSets), scrub))
          if (invocations.length < 60) invocations.push({ t: r.ts, ...x });
        for (const run of commandRuns(r.cmd, r.isError, r.output)) {
          const fact: Run = {
            t: r.ts,
            ...run,
            cmd: scrub.text(run.cmd),
            summary: run.summary.map((line) => scrub.text(line)),
            revision: 'unknown',
          };
          runs.push(fact);
          trail.push({ kind: 'run', fact });
        }
        const seg = testSegment(r.cmd);
        const test = seg !== undefined;
        const key = clip(scrub.text(commandKey(seg ?? r.cmd)), 60);
        const failed = r.isError === true || (test && testOutputFailed(r.output));
        const g = cmdGroups.get(key) ?? { count: 0, failures: 0, isTest: test };
        g.count++;
        if (failed) g.failures++;
        cmdGroups.set(key, g);
        if (test && failed) testFailedEarlier = true;
        if (test && !failed && testFailedEarlier) {
          milestones.push('tests went from failing to passing');
          testFailedEarlier = false;
        }
        break;
      }
      case 'link':
        if (r.prNumber) milestones.push(`linked to PR #${r.prNumber}`);
        break;
      case 'artifact':
        artifacts.push({
          name: r.name,
          summary: r.summary ? clip(scrub.text(r.summary), 300) : undefined,
          excerpt: clip(scrub.text(r.markdown), 1500),
        });
        break;
    }
  }
  // Relate each run to later edits of files in the PR (never certifies a revision).
  const prEditTimes = recs
    .filter((r) => r.kind === 'edit' && r.ts)
    .filter((r) => {
      const rel = repoRel({ roots: m.roots }, (r as { file: string }).file);
      return !!rel && prSets.has(rel);
    })
    .map((r) => Date.parse(r.ts!));
  // The PR's last commit, when it is a committed range (not the working tree).
  const headTime = truth.usedWorkingTree
    ? undefined
    : Math.max(0, ...truth.commits.map((c) => c.commitTime ?? 0)) || undefined;
  for (const run of runs) {
    if (!run.t) continue;
    const at = Date.parse(run.t);
    run.revision =
      headTime !== undefined &&
      at > headTime &&
      prEditTimes.some((e) => e > headTime && e < at)
        ? 'after later work'
        : prEditTimes.some((e) => e > at)
          ? 'before later edits'
          : 'no later edits seen';
  }
  if (files.size) milestones.push(`edited ${files.size} file(s)`);
  if (m.commitsMade.length)
    milestones.push(`made ${m.commitsMade.length} of the PR's commits`);
  if (m.discardedEdits)
    milestones.push(`${m.discardedEdits} edit(s) did not survive into the PR`);

  const times = recs
    .map((r) => r.ts)
    .filter((t): t is string => !!t)
    .sort();
  return {
    ref,
    agent: AGENT_LABEL[m.session.agent] ?? m.session.agent,
    title: m.session.title ? clip(scrub.text(m.session.title), 80) : undefined,
    models: [...models],
    span: { start: times[0], end: times[times.length - 1] },
    usage: sawUsage ? usage : null,
    sessionCostUsd: m.session.sessionCostUsd,
    score: m.score,
    band: m.band === 'included' ? 'included' : 'ambiguous',
    reasons: m.reasons,
    prompts,
    delegations: delegations.slice(0, 10),
    commitsMade: m.commitsMade.map((s) => s.slice(0, 12)),
    plans,
    artifacts,
    decisions,
    runs,
    commands: [...cmdGroups.entries()]
      .map(([cmd, g]) => ({ cmd, ...g }))
      .sort((a, b) => Number(b.isTest) - Number(a.isTest) || b.count - a.count)
      .slice(0, 15),
    milestones: [...new Set(milestones)],
    filesEdited: [...files].sort(),
    discardedEdits: m.discardedEdits,
    unknownRecordTypes: m.session.unknownTypes,
  };
}

const estimateTokens = (o: unknown) => Math.ceil(JSON.stringify(o).length / 4);

/** Fact id → how much of the PR it explains (from the evidence graph). */
export type Relevance = Record<string, number>;

/** The `n` most relevant runs (newest first among equals), in their original order. */
function topRuns(runs: Run[], relevance: Relevance, n: number): Run[] {
  const keep = new Set(
    runs
      .map((r, i) => ({ r, i }))
      .sort(
        (a, b) =>
          (relevance[b.r.id ?? ''] ?? 0) - (relevance[a.r.id ?? ''] ?? 0) || b.i - a.i,
      )
      .slice(0, n)
      .map((x) => x.r),
  );
  return runs.filter((r) => keep.has(r));
}

/**
 * Trim the digest until it fits the token budget, least important content first.
 * With relevance from the evidence graph, facts that explain more of the PR keep
 * more text and runs are kept by relevance rather than recency.
 */
function fitBudget(d: TraceDigest, budget: number, relevance?: Relevance): void {
  const rel = (id?: string) => (id && relevance ? (relevance[id] ?? 0) : 0);
  const median = (() => {
    if (!relevance) return 0;
    const v = d.sessions
      .flatMap((s) => s.prompts.map((p) => rel(p.id)))
      .sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : 0;
  })();
  const steps: [string, () => boolean][] = [
    relevance
      ? [
          'plan excerpts shortened to 600 chars (200 for plans from turns with no surviving edits)',
          () =>
            shrink((s) =>
              s.plans.forEach(
                (p) => (p.excerpt = clip(p.excerpt, rel(p.id) > 1 ? 600 : 200)),
              ),
            ),
        ]
      : [
          'plan excerpts shortened to 600 chars',
          () => shrink((s) => s.plans.forEach((p) => (p.excerpt = clip(p.excerpt, 600)))),
        ],
    [
      'prompts that led to no surviving edits dropped',
      () =>
        shrink(
          (s) =>
            (s.prompts = s.prompts.filter(
              (p, i) => p.ledToEdits || p.pushback || i === 0,
            )),
        ),
    ],
    relevance
      ? [
          'prompts shortened to 260 chars (140 for prompts that explain less of the PR)',
          () => {
            const high = (p: DigestSession['prompts'][number]) =>
              !!p.pushback || (rel(p.id) > 0 && rel(p.id) >= median);
            const signal = d.sessions.some((s) => s.prompts.some(high));
            return shrink((s) =>
              s.prompts.forEach(
                (p) => (p.text = clip(p.text, !signal ? 200 : high(p) ? 260 : 140)),
              ),
            );
          },
        ]
      : [
          'prompts shortened to 200 chars',
          () => shrink((s) => s.prompts.forEach((p) => (p.text = clip(p.text, 200)))),
        ],
    [
      'artifact excerpts shortened to 500 chars',
      () => shrink((s) => s.artifacts.forEach((a) => (a.excerpt = clip(a.excerpt, 500)))),
    ],
    ['delegations dropped', () => shrink((s) => (s.delegations = []))],
    [
      'decision excerpts shortened to 150 chars',
      () => shrink((s) => s.decisions.forEach((d) => (d.text = clip(d.text, 150)))),
    ],
    [
      'commit explanations shortened to 300 chars',
      () => {
        d.pr.commits.forEach((c) => {
          if (c.body) c.body = clip(c.body, 300);
        });
        return true;
      },
    ],
    relevance
      ? [
          'runs limited to the 10 most relevant per session (final run of each command, runs no later edit followed)',
          () => shrink((s) => (s.runs = topRuns(s.runs, relevance, 10))),
        ]
      : [
          'runs limited to the last 10 per session',
          () => shrink((s) => (s.runs = s.runs.slice(-10))),
        ],
    [
      'commands limited to 5 per session',
      () => shrink((s) => (s.commands = s.commands.slice(0, 5))),
    ],
    ['file list limited to 40', () => ((d.files = d.files.slice(0, 40)), true)],
    [
      'plan excerpts shortened to 200 chars',
      () => shrink((s) => s.plans.forEach((p) => (p.excerpt = clip(p.excerpt, 200)))),
    ],
  ];
  function shrink(f: (s: DigestSession) => void): boolean {
    d.sessions.forEach(f);
    return true;
  }
  for (const [label, step] of steps) {
    if (estimateTokens(d) <= budget) return;
    step();
    d.truncated.push(label);
  }
}

/**
 * A forked or resumed session repeats its parent's history. Keep each prompt, plan
 * and decision only in the highest-scoring session that has it.
 */
function dedupeAcrossSessions(sessions: DigestSession[]): Map<object, object> {
  const seen = new Map<string, object>();
  /** Each dropped repeat, mapped to the copy that was kept. */
  const alias = new Map<object, object>();
  const fresh = <T extends { t?: string }>(items: T[], text: (x: T) => string): T[] =>
    items.filter((x) => {
      const k = `${x.t ?? ''}|${text(x)}`;
      const kept = seen.get(k);
      if (kept) {
        alias.set(x, kept);
        return false;
      }
      seen.set(k, x);
      return true;
    });
  for (const s of sessions) {
    s.prompts = fresh(s.prompts, (p) => p.text);
    s.delegations = fresh(s.delegations, (p) => p.text);
    s.plans = fresh(s.plans, (p) => p.excerpt);
    s.decisions = fresh(s.decisions, (p) => p.text);
  }
  return alias;
}

/** Give prompts, decisions, plans and runs short ids (S1, D1, P1, R1) the text can cite. */
function numberFacts(sessions: DigestSession[]): void {
  const n = { S: 0, D: 0, P: 0, R: 0 };
  for (const s of sessions) {
    for (const p of s.prompts) p.id = `S${++n.S}`;
    for (const d of s.decisions) d.id = `D${++n.D}`;
    for (const p of s.plans) p.id = `P${++n.P}`;
    for (const r of s.runs) r.id = `R${++n.R}`;
  }
}

export interface BuildOptions {
  budgetTokens?: number;
  /** Preserve complete redacted fact text and runs for expansion. */
  full?: boolean;
  /** Session ids the user chose to include or exclude, overriding the bands. */
  include?: string[];
  exclude?: string[];
  /** Provenance already read for this truth; building twice need not ask git again. */
  interop?: Interop;
  /** Receives each chosen session's ordered trail, for the evidence graph. */
  trails?: SessionTrail[];
}

function buildFullDigest(
  truth: PrTruth,
  matches: SessionMatch[],
  opts: BuildOptions = {},
): TraceDigest {
  const scrub = makeScrubber(truth.roots);
  const salt = truth.remote?.url ?? truth.toplevel;
  const prLines = prLineIndex(truth);
  const prSets = new Map([...prLines.byFile].map(([k, v]) => [k, new Set(v)]));

  const want = (m: SessionMatch) => {
    const h = hashId(salt, m.session.sessionId);
    if (opts.exclude?.some((x) => x === h || x === m.session.sessionId)) return false;
    if (opts.include?.some((x) => x === h || x === m.session.sessionId)) return true;
    return m.band !== 'excluded';
  };
  const chosen = matches.filter(want).sort((a, b) => b.score - a.score);
  const refOf = new Map(
    chosen.map((m) => [m.session.sessionId, hashId(salt, m.session.sessionId)]),
  );
  const trails: SessionTrail[] = [];
  const sessions = chosen.map((m) => {
    const events: TrailEvent[] = [];
    const invocations: Invocation[] = [];
    const s = sessionDigest(
      m,
      refOf.get(m.session.sessionId)!,
      truth,
      prSets,
      scrub,
      events,
      invocations,
    );
    trails.push({ ref: s.ref, events, invocations });
    if (opts.include?.some((x) => x === s.ref || x === m.session.sessionId))
      s.band = 'included';
    return s;
  });
  const alias = dedupeAcrossSessions(sessions);
  numberFacts(sessions);
  if (opts.trails) {
    // A resumed session repeats its parent's prompts; point its events at the kept copy.
    for (const t of trails)
      for (const e of t.events)
        if (e.kind !== 'edit' && alias.has(e.fact))
          (e as { fact: object }).fact = alias.get(e.fact)!;
    opts.trails.push(...trails);
  }
  const full = opts.full || opts.budgetTokens === Number.MAX_SAFE_INTEGER;
  if (!full)
    for (const s of sessions) {
      s.prompts.forEach((p) => (p.text = clip(p.text, 400)));
      s.plans.forEach((p) => (p.excerpt = clip(p.excerpt, 1500)));
      s.decisions.forEach((d) => {
        d.text = clip(d.text, 300);
        d.questions?.forEach((q) => {
          q.question = clip(q.question, 200);
          q.options = q.options.map((o) => clip(o, 80));
          if (q.answer !== undefined) q.answer = clip(q.answer, 400);
        });
      });
      s.runs = s.runs.slice(-25);
    }
  const commitsInSessions = new Set(chosen.flatMap((m) => m.commitsMade));

  const attribution = attribute(truth, prLines, chosen);
  const evidence = attribution.reduce((n, f) => n + f.evidenceLines, 0);
  const unmatched = attribution.reduce((n, f) => n + f.unmatched, 0);
  const pct = (x: number) => (evidence ? Math.round((x / evidence) * 100) : 0);

  const agents = [
    ...new Set(sessions.filter((s) => s.band === 'included').map((s) => s.agent)),
  ];
  const models = [
    ...new Set(sessions.filter((s) => s.band === 'included').flatMap((s) => s.models)),
  ];
  const existingTrailers = [
    ...new Set(
      truth.commits.flatMap((c) =>
        Object.entries(c.trailers)
          .filter(([k]) =>
            /^(co-authored-by|assisted-by|generated-by|ai-used-for)$/i.test(k),
          )
          .flatMap(([k, vs]) => vs.map((v) => `${k}: ${v}`)),
      ),
    ),
  ];
  const suggestedTrailers = sessions
    .filter((s) => s.band === 'included')
    .flatMap((s) =>
      (s.models.length ? s.models : ['unknown-model']).map(
        (m) => `Assisted-by: ${s.agent}:${m}`,
      ),
    );

  const notes: string[] = [];
  if (truth.usedWorkingTree)
    notes.push('No commits ahead of base yet; the digest describes uncommitted changes.');
  if (!sessions.length) notes.push('No agent sessions matched this change.');
  if (truth.dirty && !truth.usedWorkingTree)
    notes.push(
      'The working tree had uncommitted changes: a run in the session may have tested code that is not in the PR.',
    );
  if (sessions.some((s) => s.band === 'ambiguous')) {
    notes.push(
      'Some sessions are ambiguous: confirm with the user before describing them as part of this PR.',
    );
  }
  // Sessions left out that did work in this repo while the commits were made:
  // say so, rather than dropping them without a word.
  for (const m of matches) {
    if (chosen.includes(m) || m.score <= 0) continue;
    const excludedRef = hashId(salt, m.session.sessionId);
    if (opts.exclude?.some((x) => x === excludedRef || x === m.session.sessionId))
      continue;
    const s = m.signals;
    if (!(s.cwdInRepo || s.commandsTouchRepo) || s.timeOverlap <= 0) continue;
    const ref = hashId(salt, m.session.sessionId);
    notes.push(
      `Left out: ${m.session.agent} session "${scrub.text(m.session.title ?? 'untitled')}" (${ref}) worked in this repo while the commits were made, but no edits or commits of this PR were matched to it (score ${m.score}). It is left out; if it clearly belongs, add it with --include ${ref}.`,
    );
  }

  const digest: TraceDigest = {
    v: 1,
    tool: `tracetoon@${TOOL_VERSION}`,
    generatedAt: new Date().toISOString(),
    repo: { owner: truth.remote?.owner, name: truth.remote?.name },
    pr: {
      number: truth.pr?.number,
      url: truth.pr?.url,
      title: truth.pr ? scrub.text(truth.pr.title) : undefined,
      base: truth.base,
      head: truth.head,
      mergeBase: truth.mergeBase,
      usedWorkingTree: truth.usedWorkingTree,
      ...(truth.dirty ? { dirty: true } : {}),
      commits: truth.commits.map((c) => ({
        sha: full ? c.sha : c.sha.slice(0, 12),
        subject: scrub.text(c.subject),
        ...(c.body
          ? { body: full ? scrub.text(c.body) : clip(scrub.text(c.body), 1200) }
          : {}),
        trailers: c.trailers,
        ...(c.commitTime ? { time: new Date(c.commitTime).toISOString() } : {}),
      })),
    },
    stats: {
      filesChanged: truth.files.length,
      added: truth.files.reduce((n, f) => n + f.added.length, 0),
      removed: truth.files.reduce((n, f) => n + f.removed.length, 0),
      evidenceLines: evidence,
      agentMatchedPct: pct(evidence - unmatched),
      unmatchedPct: pct(unmatched),
      commitsMadeInSessions: commitsInSessions.size,
      commits: truth.commits.length,
      about:
        "Tracetoon's line matching between captured edits and the diff, for the trace section: not who wrote the code. Don't report these numbers as authorship in the description.",
    },
    sessions,
    files: attribution.map((f) => ({
      path: scrub.text(f.path),
      role: fileRole(f.path),
      added: f.added,
      removed: f.removed,
      sessions: [...f.bySession].map(([id, lines]) => ({ ref: refOf.get(id)!, lines })),
      unmatchedLines: f.unmatched,
    })),
    disclosure: {
      agents,
      models,
      suggestedTrailers: [...new Set(suggestedTrailers)],
      existingTrailers,
    },
    interop: opts.interop ?? detectInterop(truth),
    privacy: {
      redactions: 0,
      droppedForeignRecords: chosen.reduce((n, m) => n + m.droppedForeign, 0),
      sessionIdsHashed: true,
    },
    linkedPrs: [
      ...new Set(
        chosen
          .filter((m) => m.band !== 'excluded')
          .flatMap((m) => m.kept)
          .flatMap((r) =>
            r.kind === 'link' && r.prNumber && r.prNumber !== truth.pr?.number
              ? [r.prNumber]
              : [],
          ),
      ),
    ],
    notes,
    truncated: [],
  };
  if (!full) fitBudget(digest, opts.budgetTokens ?? 12000);
  digest.privacy.redactions = scrub.redactions;
  return digest;
}

/** Project from independent redacted data; budgeting must never trim expansion evidence. */
export function compactDigest(
  full: TraceDigest,
  budgetTokens = 12000,
  relevance?: Relevance,
): TraceDigest {
  const digest = structuredClone(full);
  for (const s of digest.sessions) {
    s.prompts.forEach((p) => (p.text = clip(p.text, 400)));
    s.plans.forEach((p) => (p.excerpt = clip(p.excerpt, 1500)));
    s.decisions.forEach((d) => {
      d.text = clip(d.text, 300);
      d.questions?.forEach((q) => {
        q.question = clip(q.question, 200);
        q.options = q.options.map((o) => clip(o, 80));
        if (q.answer !== undefined) q.answer = clip(q.answer, 400);
      });
    });
    s.runs = relevance ? topRuns(s.runs, relevance, 25) : s.runs.slice(-25);
  }
  digest.pr.commits = digest.pr.commits.map((c) => ({
    ...c,
    sha: c.sha.slice(0, 12),
    ...(c.body ? { body: clip(c.body, 1200) } : {}),
  }));
  fitBudget(digest, budgetTokens, relevance);
  return digest;
}

export function buildDigestPair(
  truth: PrTruth,
  matches: SessionMatch[],
  opts: BuildOptions & {
    /**
     * Called with the full digest and session trails before projection: builds the
     * evidence graph, annotates the full digest and returns fact relevance.
     */
    enrich?: (full: TraceDigest, trails: SessionTrail[]) => Relevance | undefined;
  } = {},
) {
  const start = performance.now();
  const trails: SessionTrail[] = [];
  const full = buildFullDigest(truth, matches, { ...opts, full: true, trails });
  const relevance = opts.enrich?.(full, trails);
  const extractionMs = performance.now() - start;
  const projectionStart = performance.now();
  const digest = compactDigest(full, opts.budgetTokens, relevance);
  return {
    digest,
    full,
    extractionMs,
    projectionMs: performance.now() - projectionStart,
  };
}

export function buildDigest(
  truth: PrTruth,
  matches: SessionMatch[],
  opts: BuildOptions = {},
): TraceDigest {
  const full = buildFullDigest(truth, matches, { ...opts, full: true });
  return opts.full || opts.budgetTokens === Number.MAX_SAFE_INTEGER
    ? full
    : compactDigest(full, opts.budgetTokens);
}
