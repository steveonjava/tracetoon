/**
 * Brief rows on how the work landed and what its scope leaves open:
 * - `landing`: the PR's head and base, and the git commands the included
 *   sessions recorded (push, new branch or worktree, cherry-pick, a rewritten
 *   history, what was staged). Only what the logs show: a push is never
 *   inferred, and its absence is said as "not recorded".
 * - scope limits: target platforms or environments the request, a plan or a
 *   commit names with no recorded run on them, effects claimed with no
 *   recorded measurement, and manual or migration steps existing users need.
 * Generic rules over graph facts only; each row is short and citable.
 */
import type { GraphEngine } from './engine.ts';

type Row = Record<string, unknown>;

/** At most this many `landing` rows: the writer gives them one clause. */
export const MAX_LANDING = 5;

const tick = (s: string) => `\`${s}\``;
const list = (xs: string[], n = 3) =>
  xs.length > n
    ? `${xs.slice(0, n).map(tick).join(', ')} and ${xs.length - n} more`
    : xs.map(tick).join(', ');

/** The `landing` rows (ref LD#): PR truth first, then the recorded git commands by kind. */
export function landingRows(g: GraphEngine): Row[] {
  const out: Row[] = [];
  const add = (kind: string, fact: string, cites: string[] = []) =>
    out.length < MAX_LANDING &&
    out.push({ ref: `LD${out.length + 1}`, kind, fact, cites });
  const ops = g
    .run(
      `MATCH (s:Session {band: 'included'})
       RETURN s.id AS session, s.gitOps AS ops, s.gitKinds AS kinds, s.gitT AS ts`,
    )
    .rows.sort((a, b) => String(a.session).localeCompare(String(b.session)))
    .flatMap((r) =>
      ((r.ops as string[]) ?? []).map((op, i) => ({
        session: String(r.session),
        op: String(op),
        kind: String(((r.kinds as string[]) ?? [])[i] ?? ''),
        t: String(((r.ts as string[]) ?? [])[i] ?? ''),
      })),
    )
    .sort((a, b) => a.t.localeCompare(b.t));
  const of = (kind: string) => ops.filter((x) => x.kind === kind);
  const distinct = (xs: { op: string }[]) => [...new Set(xs.map((x) => x.op))];
  const sessionsOf = (xs: { session: string }[]) => [
    ...new Set(xs.map((x) => x.session)),
  ];
  const pushes = of('push');
  const pr = g.run(
    'MATCH (p:PrTruth) RETURN p.head AS head, p.base AS base, p.usedWorkingTree AS wt, p.commits AS commits',
  ).rows[0];
  if (pr?.head || pr?.base) {
    const head = pr.head ? `branch \`${String(pr.head)}\`` : 'its branch';
    const onto = pr.base ? ` onto \`${String(pr.base)}\`` : '';
    const how = pr.wt
      ? ' from uncommitted changes in the working tree'
      : Number(pr.commits) > 0
        ? ` with ${Number(pr.commits)} commit(s)`
        : '';
    add(
      'pr',
      `The PR proposes ${head}${onto}${how}${
        pushes.length
          ? ''
          : "; the session logs record no `git push`, so how the branch reached the remote isn't recorded"
      }.`,
    );
  }
  if (pushes.length)
    add(
      'push',
      `The session ran ${list(distinct(pushes))} with no error recorded${
        pushes.some((x) => x.op.includes('--force'))
          ? ' (a force push: the remote history was replaced)'
          : ''
      }.`,
      sessionsOf(pushes),
    );
  const moved = [...of('branch'), ...of('worktree')];
  if (moved.length)
    add(
      'branch',
      `The work moved onto a new branch or worktree: ${list(distinct(moved))}.`,
      sessionsOf(moved),
    );
  const picked = of('cherry-pick');
  if (picked.length)
    add(
      'cherry-pick',
      `Commits were carried over with ${list(distinct(picked))}: the PR's commits may be copies of commits made elsewhere.`,
      sessionsOf(picked),
    );
  const history = of('history');
  if (history.length)
    add(
      'history',
      `History was rewritten rather than fixed by a new commit: ${list(distinct(history))}.`,
      sessionsOf(history),
    );
  const ci = of('ci');
  if (ci.length)
    add(
      'ci',
      `The session looked at CI with ${list(distinct(ci), 2)}; what CI reported isn't in the brief.`,
      sessionsOf(ci),
    );
  const staged = of('stage');
  if (staged.length) {
    const all = staged.some((x) => x.op === 'git add (all changes)');
    const named = distinct(staged.filter((x) => x.op !== 'git add (all changes)'));
    add(
      'staging',
      all && !named.length
        ? 'Everything in the working tree was staged at once (`git add` of all changes).'
        : named.length && !all
          ? `Only named files were staged: ${list(named)}.`
          : `Both named files (${list(named, 2)}) and all changes were staged at different points.`,
      sessionsOf(staged),
    );
  }
  return out;
}

/** Platforms and environments a text may name, with what a recorded command on one looks like. */
const PLATFORMS: { name: string; os?: string; named: RegExp; ran: RegExp }[] = [
  {
    name: 'Windows',
    os: 'win32',
    named: /\b(?:windows|win32|win64|powershell)\b/i,
    ran: /\b(?:pwsh|powershell|cmd\.exe|wine)\b|\.ps1\b/i,
  },
  {
    name: 'macOS',
    os: 'darwin',
    named: /\b(?:macos|mac os|os x|osx)\b/i,
    ran: /\b(?:darwin|macos|xcodebuild|xcrun|brew)\b/i,
  },
  {
    name: 'Linux',
    os: 'linux',
    named: /\blinux\b/i,
    ran: /\b(?:linux|docker|podman|wsl)\b/i,
  },
  {
    name: 'a mobile device or simulator',
    named: /\b(?:ios|android|iphone|ipad)\b/i,
    ran: /\b(?:xcodebuild|simctl|adb|gradlew|emulator|flutter run)\b/i,
  },
  {
    name: 'the target hardware',
    named:
      /\b(?:real|physical|actual|target)\s+(?:device|hardware)\b|\bon[- ]device\b|\b(?:gpu|cuda|raspberry pi|arduino|esp32|firmware|fpga)\b/i,
    ran: /\b(?:nvidia-smi|cuda|esptool|avrdude|openocd|adb|flash)\b/i,
  },
  {
    name: 'the deployed cloud service',
    named:
      /\b(?:aws|s3|lambda|gcp|google cloud|azure|cloudflare|vercel|netlify|heroku|kubernetes|k8s|in production|on staging)\b/i,
    ran: /\b(?:aws|gcloud|az|wrangler|vercel|netlify|heroku|kubectl|terraform|helm)\b/i,
  },
  {
    name: 'CI',
    named:
      /\bCI\b|\bgithub actions\b|\bgitlab[- ]ci\b|\bcircleci\b|\bbuildkite\b|\bjenkins\b/,
    ran: /\bgh (?:run|pr checks)\b|\bact\b/i,
  },
];

/** A claimed effect: performance or size (needs a measurement) or a fix (needs a passing run). */
const EFFECT =
  /\b(?:faster|speeds? up|speed-?up|slower|reduc(?:e|es|ed|ing)|lower(?:s|ed)? (?:the )?(?:latency|memory|cost|usage|load)|less (?:memory|cpu|time)|fewer (?:calls|requests|round[- ]trips|allocations)|improv(?:e|es|ed) (?:the )?(?:performance|latency|throughput|speed)|smaller|(?:\d+(?:\.\d+)?\s*(?:x|×|%)\s+(?:faster|smaller|less|fewer)))\b/i;
const FIX = /\b(?:fix(?:es|ed)?|resolv(?:e|es|ed)|prevents?)\b/i;
/** A recorded command that measures: a benchmark, a profiler, a timing run, an eval. */
const MEASURED =
  /\b(?:bench(?:mark)?s?|hyperfine|perf|profil(?:e|er|ing)|time|timing|pytest-benchmark|criterion|lighthouse|k6|wrk|ab|eval)\b/i;
/** A manual step or migration existing users or deployments need. */
const MANUAL_STEP =
  /\b(?:re-?install(?:ing)?|migrat(?:e|es|ion|ions|ing)|run(?:ning)? `?[\w.-]+ init`?|manual(?:ly)? (?:step|action|migration|update|re-?run)|existing (?:users|installs|installations|configs?|databases?)|breaking change|re-?run (?:the )?(?:setup|install)|clear (?:the |their )?cache|re-?(?:login|authenticate))\b/i;

/** The clause of a text around a match, for quoting. */
function around(text: string, m: RegExpExecArray, n = 110): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  let pos = 0;
  for (const s of sentences) {
    const at = text.indexOf(s, pos);
    if (at <= m.index && m.index < at + s.length) {
      const t = s.trim();
      return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
    }
    pos = at + s.length;
  }
  return m[0];
}

/**
 * Open scope limits from the request, plan and commit texts: a platform or
 * environment named with no recorded run on it, an effect claimed with no
 * recorded measurement, a manual or migration step. At most one row of each
 * kind, each naming the text it comes from.
 */
export function scopeRows(g: GraphEngine, texts: { ref: string; text: string }[]): Row[] {
  const cmds = [
    ...g
      .run(`MATCH (r:Run) RETURN r.cmd AS cmd, r.summary AS summary`)
      .rows.flatMap((r) => [
        String(r.cmd ?? ''),
        ...((r.summary as string[]) ?? []).map(String),
      ]),
    ...g
      .run(`MATCH (v:Receipt) RETURN v.cmd AS cmd`)
      .rows.map((r) => String(r.cmd ?? '')),
    ...g
      .run(
        `MATCH (s:Session {band: 'included'})
         RETURN s.invoked AS invoked, s.lateCmds AS late, s.gitOps AS ops, s.failedCmds AS failed`,
      )
      .rows.flatMap((r) =>
        [r.invoked, r.late, r.ops, r.failed].flatMap((x) =>
          ((x as string[]) ?? []).map(String),
        ),
      ),
  ];
  const ranAny = (re: RegExp) => cmds.some((c) => re.test(c));
  const passed =
    g.run(
      `MATCH (r) WHERE (r:Run OR r:Receipt) AND r.outcome = 'passed' RETURN r.id AS id`,
    ).rows.length > 0;
  const os = String(g.run('MATCH (p:PrTruth) RETURN p.os AS os').rows[0]?.os ?? '');
  const out: Row[] = [];
  const first = (re: RegExp) => {
    for (const t of texts) {
      const m = re.exec(t.text);
      if (m) return { ref: t.ref, m, text: t.text };
    }
    return undefined;
  };
  const platforms: string[] = [];
  let platformRef = '';
  for (const p of PLATFORMS) {
    const hit = first(p.named);
    if (!hit || (p.os && p.os === os) || ranAny(p.ran)) continue;
    platforms.push(p.name);
    platformRef ||= hit.ref;
  }
  if (platforms.length)
    out.push({
      change: null,
      kind: 'open',
      scope: 'platform',
      limit: `${platforms.slice(0, 3).join(', ')} ${platforms.length > 1 ? 'are' : 'is'} named (per ${platformRef}), but the record shows no run on ${platforms.length > 1 ? 'them' : 'it'}.`,
    });
  const effect = first(EFFECT);
  if (effect && !ranAny(MEASURED))
    out.push({
      change: null,
      kind: 'open',
      scope: 'effect',
      limit: `No measurement of the claimed effect is recorded: "${around(effect.text, effect.m)}" (per ${effect.ref}); the effect was not measured in the record.`,
    });
  else {
    const fix = first(FIX);
    if (fix && !passed)
      out.push({
        change: null,
        kind: 'open',
        scope: 'effect',
        limit: `No passing run that shows the fix is recorded: "${around(fix.text, fix.m)}" (per ${fix.ref}).`,
      });
  }
  const step = first(MANUAL_STEP);
  if (step)
    out.push({
      change: null,
      kind: 'open',
      scope: 'manual step',
      limit: `Existing users or deployments may need a step the diff doesn't perform: "${around(step.text, step.m)}" (per ${step.ref}).`,
    });
  return out;
}
