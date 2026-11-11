/**
 * Which session-log runs the brief and the Validation section may state, and
 * each check kind's run history in order. Pure functions over Run rows (as the
 * brief's Cypher returns them), so they can be replayed on stored graphs.
 *
 * A session-log run is stated only when the claim can be checked exactly:
 * - it is the last run of its command (a later run of the same command whose
 *   result wasn't captured supersedes it: pr11's `tsc` pass was followed by a
 *   rerun with no result, so "passed" contradicted the brief's own process row);
 * - its output has result lines of its own (`13 pass`, `All matched files…`):
 *   a pass inferred from an exit status alone, often of a whole `&&` chain,
 *   shows a reader nothing to check;
 * - it is one command, not several test commands sharing one output;
 * - no later run of the same kind ended differently.
 */
import { shownCommand } from './briefRender.ts';

export type RunRow = Record<string, unknown>;

const KNOWN = (r: RunRow) => r.outcome === 'passed' || r.outcome === 'failed';
const summaryOf = (r: RunRow) =>
  (Array.isArray(r.summary) ? r.summary : []).map(String).filter(Boolean);

/** Kinds whose history and session-log result a reader can use. */
export const HISTORY_KINDS = ['test', 'typecheck', 'lint', 'build'];

/** Several test commands' shared output (`a ; b`): no result can be pinned on either. */
export const compositeCommand = (cmd: unknown) => shownCommand(cmd).includes(' ; ');

/** A run whose recorded result a reader can check against the session: see above. */
export function statableRun(r: RunRow): boolean {
  return (
    KNOWN(r) &&
    summaryOf(r).length > 0 &&
    !compositeCommand(r.cmd) &&
    !!shownCommand(r.cmd)
  );
}

const byTime = (a: RunRow, b: RunRow) =>
  String(a.t ?? '').localeCompare(String(b.t ?? ''));

/** The last run of each command (as shown), in the order of those last runs. */
export function lastRunOfEach(runs: RunRow[]): RunRow[] {
  const last = new Map<string, RunRow>();
  for (const r of [...runs].sort(byTime)) {
    const key = shownCommand(r.cmd);
    last.delete(key);
    last.set(key, r);
  }
  return [...last.values()];
}

/**
 * A test command with no file or filter arguments (flags only): the whole
 * suite, not a focused rerun of a few files.
 */
const WHOLE_SUITE =
  /^(?:(?:bun|npm|pnpm|yarn)(?: run)? test|(?:python3? -m )?pytest|cargo test|go test \.\/\.\.\.|(?:npx |bunx |bun x )?(?:jest|vitest(?: run)?))(?:\s+-[^\s=]+(?:=\S+)?)*$/;
export const wholeSuite = (cmd: unknown) => WHOLE_SUITE.test(shownCommand(cmd));

/** How many tests a run's result lines say passed (`96 pass`, `12 passed`); 0 when none. */
const passCount = (r: RunRow) => {
  for (const line of summaryOf(r)) {
    const m = /(\d+)\s+pass(?:ed|es)?\b/i.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
};

/**
 * One session-log run per kind for the brief's validation rows, chosen from
 * the statable last runs of each command:
 * 1. standing: runs that saw the final edits, or whose later edits are only
 *    files no check reads as code (`minorLater`: version bumps, docs, config),
 *    over runs that later code edits made stale;
 * 2. at that standing, the outcome of the latest run (so a later failure is
 *    never hidden behind an earlier pass);
 * 3. among those, the broadest run: the whole suite (no file arguments) over
 *    a focused rerun, then (on the final code) the one that passed the most
 *    tests, then the latest. A focused rerun of two unrelated files after the
 *    full suite says less about the PR than the full suite (pr12).
 * A kind with no statable run keeps its last run when that run's result
 * wasn't captured (an honest "ran, no result"); otherwise it has no row.
 * Kinds in `skip` (checked by a receipt) get none.
 */
export function selectValidationRuns(
  runs: RunRow[],
  opts: {
    skip?: Set<string>;
    current?: (r: RunRow) => boolean;
    minorLater?: (r: RunRow) => boolean;
  } = {},
): RunRow[] {
  const current =
    opts.current ??
    ((r: RunRow) =>
      r.revision === 'no later edits seen' &&
      !((r.later as string[] | undefined) ?? []).length);
  const standing = (r: RunRow) => current(r) || !!opts.minorLater?.(r);
  const sorted = [...runs].sort(byTime);
  const out = new Map<string, RunRow>();
  const kinds = [...new Set(sorted.map((r) => String(r.kind)))];
  for (const kind of kinds) {
    if (opts.skip?.has(kind)) continue;
    const ofKind = sorted.filter((r) => String(r.kind) === kind);
    const candidates = lastRunOfEach(ofKind).filter(statableRun);
    const top = candidates.some(standing) ? candidates.filter(standing) : candidates;
    const latest = top.at(-1);
    const pool = top.filter((r) => r.outcome === latest?.outcome);
    const fresh = latest ? standing(latest) : false;
    const rank = (r: RunRow): number[] => [
      Number(wholeSuite(r.cmd)),
      fresh ? passCount(r) : 0,
      Number(current(r)),
      pool.indexOf(r),
    ];
    let best: RunRow | undefined;
    for (const r of pool) {
      if (!best) {
        best = r;
        continue;
      }
      const a = rank(r);
      const b = rank(best);
      const i = a.findIndex((x, k) => x !== b[k]);
      if (i >= 0 && a[i]! > b[i]!) best = r;
    }
    // A later run of the kind that ended differently would contradict it.
    if (best) {
      const t = String(best.t ?? '');
      const at = ofKind.indexOf(best);
      const later = ofKind.filter(
        (r, i) =>
          (String(r.t ?? '') > t || (String(r.t ?? '') === t && i > at)) &&
          KNOWN(r) &&
          r.outcome !== best!.outcome,
      );
      if (later.length) best = undefined;
    }
    const last = ofKind.at(-1);
    if (!best && last && last.outcome === 'unknown') best = last;
    if (best) out.set(kind, best);
  }
  return [...out.values()];
}

/**
 * The last failure of a kind before a passing run, for one short clause in
 * the Validation section ("an earlier run, `cmd`, failed (4 pass, 1 fail)").
 * Undefined unless `chosen` passed and an earlier run of its kind failed.
 */
export function earlierFailure(runs: RunRow[], chosen: RunRow): RunRow | undefined {
  if (chosen.outcome !== 'passed') return undefined;
  const sorted = [...runs].sort(byTime);
  const at = sorted.indexOf(chosen);
  const before = sorted.filter(
    (r, i) =>
      String(r.kind) === String(chosen.kind) &&
      (at >= 0 ? i < at : String(r.t ?? '') < String(chosen.t ?? '')),
  );
  return before.filter((r) => r.outcome === 'failed' && !compositeCommand(r.cmd)).at(-1);
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const OUTCOME_WORD: Record<string, string> = {
  passed: 'passed',
  failed: 'failed',
  unknown: 'no result captured',
};

const SUBJECT: Record<string, string> = {
  test: 'Tests',
  typecheck: 'The typecheck',
  lint: 'Lint',
  build: 'The build',
};

/**
 * The plain sentence a writer can copy when a kind's results changed between
 * the first and the last run with a result: "`bun test` failed in the first
 * run, then passed (failing to passing)." Undefined when the first and last
 * results agree.
 */
function trendSentence(
  groups: { outcome: string; runs: RunRow[] }[],
  sorted: RunRow[],
  command: string | undefined,
): string | undefined {
  const first = groups[0];
  const end = groups.at(-1);
  if (!first || !end || first.outcome === end.outcome) return undefined;
  const subject = command
    ? `\`${command}\``
    : (SUBJECT[String(sorted[0]!.kind)] ?? `${String(sorted[0]!.kind)} runs`);
  const n = first.runs.length;
  const opening =
    groups.length === 2
      ? sorted[0] === first.runs[0]
        ? n === 1
          ? ' in the first run'
          : ` in the first ${n} runs`
        : n === 1
          ? ''
          : ` ${times(n)}`
      : '';
  return first.outcome === 'failed'
    ? `${subject} failed${opening}, then passed (failing to passing).`
    : `${subject} passed${opening}, then failed (passing to failing).`;
}

/**
 * A kind's runs in order, when they ended differently: `failed twice (R3, R5),
 * then passed (R8)`, read from the runs with a result (many alternations:
 * the failures, then how it ended); a last run with no result is said. Undefined
 * for fewer than two runs, or when the runs with a result all ended the same way
 * and the last run has one (the counts already say it).
 */
export function runHistory(
  runs: RunRow[],
): { text: string; cites: string[] } | undefined {
  const sorted = [...runs].sort(byTime);
  if (sorted.length < 2) return undefined;
  // The sequence is read from the runs with a result; runs with none are
  // counted, and named only when the last run is one of them.
  const known = sorted.filter(KNOWN);
  const last = sorted.at(-1)!;
  const lastUnknown = !KNOWN(last) && known.length > 0;
  const groups: { outcome: string; runs: RunRow[] }[] = [];
  for (const r of known) {
    const g = groups.at(-1);
    if (g && g.outcome === r.outcome) g.runs.push(r);
    else groups.push({ outcome: String(r.outcome), runs: [r] });
  }
  if (groups.length < 2 && !lastUnknown) return undefined;
  const commands = new Set(sorted.map((r) => shownCommand(r.cmd)));
  const one = commands.size === 1;
  const ids = (rs: RunRow[]) => {
    const xs = rs.map((r) => String(r.id));
    return xs.length > 3 ? `${xs.slice(0, 2).join(', ')} … ${xs.at(-1)}` : xs.join(', ');
  };
  const failedCmd = (rs: RunRow[]) =>
    !one && new Set(rs.map((r) => shownCommand(r.cmd))).size === 1
      ? ` \`${shownCommand(rs[0]!.cmd)}\``
      : '';
  const part = (g: { outcome: string; runs: RunRow[] }) => {
    const n = g.runs.length;
    return `${OUTCOME_WORD[g.outcome]!}${n > 1 ? ` ${times(n)}` : ''} (${ids(g.runs)}${g.outcome === 'failed' ? failedCmd(g.runs) : ''})`;
  };
  let order: string;
  if (groups.length <= 3) order = `in order: ${groups.map(part).join(', then ')}`;
  else {
    // Many alternations: the failures, then how the runs ended.
    const failed = known.filter((r) => r.outcome === 'failed');
    order = `${failed.length} failed (${ids(failed)}); after the last failure: ${part(groups.at(-1)!)}`;
  }
  if (lastUnknown)
    order += `, then the last run (${String(last.id)}) has no captured result`;
  const unknown = sorted.length - known.length - (lastUnknown ? 1 : 0);
  const lead = trendSentence(groups, sorted, one ? [...commands][0]! : undefined);
  const head = one
    ? `${lead ? '' : `\`${[...commands][0]}\`: `}${sorted.length} runs in this PR's turns`
    : `${sorted.length} ${String(sorted[0]!.kind)} runs in this PR's turns (${commands.size} commands)`;
  const cites = [
    ...new Set([
      ...(groups.length <= 3
        ? groups.flatMap((g) => [String(g.runs[0]!.id), String(g.runs.at(-1)!.id)])
        : [
            ...known
              .filter((r) => r.outcome === 'failed')
              .slice(0, 4)
              .map((r) => String(r.id)),
            String(groups.at(-1)!.runs.at(-1)!.id),
          ]),
      ...(lastUnknown ? [String(last.id)] : []),
    ]),
  ];
  return {
    text: `${lead ? `${lead} ` : ''}${head}, ${order}${unknown > 0 ? `; ${unknown} other run(s) with no captured result` : ''}`,
    cites,
  };
}
