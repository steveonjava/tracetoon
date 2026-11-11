/**
 * Brief rows built from facts the other sections already hold, kept apart so
 * the main brief query stays readable:
 * - open points a writer should state (`limits` rows): no passing run after
 *   the last commit, a failed publishing command, added remote-call branches
 *   no recorded run shows running live;
 * - the entry point: the changed function that owns the behavior, by the
 *   other changed symbols its new lines call;
 * - the cap on `limits` rows.
 * Generic rules over graph facts only; each row is short and cites its refs.
 */
import type { GraphEngine } from './engine.ts';
import { fileRole as pathRole } from '../digest/build.ts';
import { unitRole } from './build.ts';
import { wordsOf } from './codeEvidence.ts';

type Row = Record<string, unknown>;

/** At most this many `limits` rows: each needs a clause in the PR. */
export const MAX_LIMITS = 6;

const shortSha = (s: unknown) => String(s ?? '').slice(0, 12);

/**
 * "No passing run after the last commit", when it holds: the session's check
 * runs (this PR's turns) all came before the last commit, or none passed after.
 * The process rows say the same per kind; as a limit a writer states it.
 */
export function noPassAfterCommitRow(g: GraphEngine, scopedRuns: Row[]): Row | undefined {
  if (!scopedRuns.length) return undefined;
  const last = g
    .run('MATCH (k:Commit) WHERE k.t IS NOT NULL RETURN k.id AS id, k.t AS t')
    .rows.sort(
      (a, b) =>
        String(b.t).localeCompare(String(a.t)) ||
        String(a.id).localeCompare(String(b.id)),
    )[0];
  if (!last) return undefined;
  const passed = scopedRuns.filter((r) => r.outcome === 'passed');
  if (passed.some((r) => String(r.t ?? '') > String(last.t))) return undefined;
  const lastPass =
    [...passed]
      .sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')))
      .filter((r) => r.kind === 'test')
      .at(-1) ?? passed.at(-1);
  return {
    change: null,
    kind: 'open',
    limit: `No passing check run was recorded after the last commit (${shortSha(last.id)})${
      lastPass
        ? `; the last pass (${String(lastPass.id)}, ${String(lastPass.kind)}) came before it`
        : ''
    }.`,
  };
}

/** Commands that publish, push or deploy: their failure leaves open what reached the remote. */
const PUBLISHING =
  /^(?:gh\s+(?:pr|release|repo|workflow)|git\s+push|(?:npm|pnpm|bun|yarn(?:\s+npm)?)\s+publish|cargo\s+publish|twine\s+upload|poetry\s+publish|gem\s+push|docker\s+push|helm\s+(?:install|upgrade)|kubectl\s+(?:apply|rollout)|terraform\s+apply|vercel|netlify|fly(?:ctl)?\s+deploy|wrangler|firebase\s+deploy|\S+\s+deploy)\b/i;

/** `failedCmds` entries are `<cmd> (failed N of M)`; older graphs have only `failedCommand`. */
const parseFailed = (s: string) => {
  const m = /^(.*?)\s+\(failed (\d+) of (\d+)\)$/.exec(s);
  return m
    ? { cmd: m[1]!, failures: Number(m[2]), count: Number(m[3]) }
    : { cmd: s, failures: 1, count: 0 };
};

/** A failed command that publishes, pushes or deploys, from the included sessions. */
export function failedPublishRows(g: GraphEngine): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const s of g
    .run(
      `MATCH (s:Session {band: 'included'})
       RETURN s.id AS id, s.agent AS agent, s.failedCmds AS cmds, s.failedCommand AS one`,
    )
    .rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const cmds = Array.isArray(s.cmds)
      ? (s.cmds as string[])
      : s.one
        ? [String(s.one)]
        : [];
    for (const c of cmds.map(parseFailed)) {
      if (!PUBLISHING.test(c.cmd.trim()) || seen.has(c.cmd)) continue;
      seen.add(c.cmd);
      const again = c.count > c.failures;
      out.push({
        change: null,
        kind: 'open',
        limit: again
          ? `\`${c.cmd}\` failed ${c.failures} of ${c.count} times in the ${String(s.agent)} session; which attempt published or pushed what isn't recorded.`
          : `\`${c.cmd}\` failed in the ${String(s.agent)} session; whether or how the work was then published or pushed isn't recorded.`,
      });
    }
  }
  return out.slice(0, 2);
}

/** Words of code that reaches a remote service or external program. */
const REMOTE_CODE = new Set([
  'fetch',
  'http',
  'https',
  'axios',
  'socket',
  'websocket',
  'webhook',
  'bearer',
  'authorization',
  'grpc',
  'curl',
]);
/** Words of a path or name about a remote route. */
const REMOTE_NAME =
  /\b(?:providers?|routes?|remote|clients?|api|http|network|endpoints?|servers?|upload|download|webhooks?|services?|gateway|fetch)\b/i;
const splitName = (s: string) =>
  s
    .replace(/\.[^./]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z]+/g, ' ');

/** Recorded commands that ran something (Session `invoked`), and the code they could reach. */
export interface LiveEvidence {
  invocations: { cmd: string; out: string[] }[];
  /** Source hunks: file, scope, touched, symbols, fresh, code (added lines). */
  hunks: Row[];
}

/** What `remotePathRows` needs to see live runs: included sessions' commands and the source hunks. */
export function liveEvidence(g: GraphEngine): LiveEvidence {
  const invocations: LiveEvidence['invocations'] = [];
  for (const s of g.run(
    `MATCH (s:Session {band: 'included'}) RETURN s.invoked AS cmds, s.invokedOut AS out`,
  ).rows) {
    const outs = ((s.out as string[]) ?? []).map(String);
    ((s.cmds as string[]) ?? []).forEach((c, i) =>
      invocations.push({
        cmd: String(c),
        out: (outs[i] ?? '').split(' ').filter(Boolean),
      }),
    );
  }
  const hunks = g.run(
    `MATCH (h:Hunk) RETURN h.file AS file, h.scope AS scope, h.touched AS touched,
            h.symbols AS symbols, h.fresh AS fresh, h.code AS code`,
  ).rows;
  return { invocations, hunks };
}

const lowerWords = (s: string) =>
  (s.match(/[A-Za-z][a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []).map((w) => w.toLowerCase());
/** Words of a command's bare arguments: tokens that are not paths or file names. */
const bareWords = (cmd: string) =>
  cmd
    .split(/\s+/)
    .filter((t) => !/[/\\.~:]/.test(t))
    .flatMap(lowerWords);
/** Name words that only say "this is a command handler". */
const HANDLER_WORD = new Set(['cmd', 'command', 'handler', 'action', 'run', 'main']);
const HANDLER = /(?:Cmd|Command|Handler|Action)$/;

/** Literal values a remote file's changed branches choose between (`id === 'gemini'`, `case 'openai'`). */
function routesOf(conds: string[]): string[] {
  const byVar = new Map<string, Set<string>>();
  const cases = new Set<string>();
  for (const c of conds) {
    for (const m of c.matchAll(/([\w$.]+)\s*[!=]==?\s*'([a-z][\w-]{2,})'/g)) {
      const v = m[1]!.split('.').pop()!;
      byVar.set(v, (byVar.get(v) ?? new Set()).add(m[2]!));
    }
    for (const m of c.matchAll(/\bcase\s+'([a-z][\w-]{2,})'/g)) cases.add(m[1]!);
  }
  const top = [...byVar.values()].sort((a, b) => b.size - a.size)[0];
  if (!top || top.size < 2) return [];
  return [...new Set([...top, ...cases])].sort();
}

/**
 * The recorded commands that reach a remote file's changed code: a command
 * whose words name a changed command handler (`comicArtCmd` ← `… comic art`)
 * in a file whose changed lines call that file's changed symbols (or in the
 * file itself), or name such a calling file (`comic.ts` ← `… comic …`).
 * Matching by words leans toward "reached": a wrong match drops a limit, it
 * never claims one.
 */
function reachingRuns(file: string, live: LiveEvidence): LiveEvidence['invocations'] {
  if (!live.invocations.length) return [];
  const own = live.hunks.filter((h) => String(h.file) === file);
  const defined = new Set(
    own
      .flatMap((h) => [
        ...((h.symbols as string[]) ?? []),
        ...((h.fresh as string[]) ?? []),
        ...((h.touched as string[]) ?? []),
      ])
      .map(String)
      .filter((x) => x.length >= 4),
  );
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const calls = (code: unknown) => {
    const text = addedCode(code);
    return [...defined].some((d) => new RegExp(`\\b${esc(d)}\\b`).test(text));
  };
  // Files that reach the remote file: itself, and those whose added lines name its symbols.
  const reaching = new Set([
    file,
    ...live.hunks
      .filter((h) => String(h.file) !== file && calls(h.code))
      .map((h) => String(h.file)),
  ]);
  const handlers = live.hunks
    .filter((h) => reaching.has(String(h.file)))
    .flatMap((h) => [h.scope, ...((h.touched as string[]) ?? [])])
    .filter((x): x is string => typeof x === 'string' && HANDLER.test(x))
    .map((x) => lowerWords(x).filter((w) => !HANDLER_WORD.has(w)))
    .filter((ws) => ws.length);
  const fileWords = [...reaching]
    .filter((f) => f !== file && unitRole(f, pathRole(f)) === 'src')
    .map((f) => lowerWords((f.split('/').pop() ?? '').replace(/\.[^.]+$/, '')))
    .filter((ws) => ws.length && ws.every((w) => w.length >= 4));
  return live.invocations.filter((inv) => {
    // Bare arguments only (subcommands, values): a path argument (a formatter
    // given `src/commands/comic.ts`) runs nothing of that file.
    const words = new Set(bareWords(inv.cmd));
    return [...handlers, ...fileWords].some((ws) => ws.every((w) => words.has(w)));
  });
}

/**
 * Added branches in a source file that calls out to a remote service (its
 * changed lines fetch, use http or a socket, and its path or symbols name a
 * provider, route, client or API) and that no recorded check run's command
 * names: tests and checks don't show those paths running against the real
 * service. Conservative: both signals, added branches, at most two files.
 * A recorded command that reaches the file's code (`reachingRuns`) ran it
 * live: the row then names only the routes (`id === 'x'` values) no such
 * run names, when every such run names its route; otherwise it is dropped.
 */
export function remotePathRows(
  hunkRows: Row[],
  fileRole: Map<string, string>,
  scopedRuns: Row[],
  live?: LiveEvidence,
): Row[] {
  const byFile = new Map<string, Row[]>();
  for (const h of hunkRows) {
    const f = String(h.file);
    if (unitRole(f, fileRole.get(f) ?? pathRole(f)) !== 'src') continue;
    byFile.set(f, [...(byFile.get(f) ?? []), h]);
  }
  const cmds = scopedRuns.map((r) => String(r.cmd ?? '')).join('\n');
  const out: {
    file: string;
    change: string;
    branches: number;
    syms: string[];
    open?: { routes: string[]; used: string[]; cmd: string };
  }[] = [];
  for (const [file, hs] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    const branches = hs.reduce((n, h) => n + Number(h.branches ?? 0), 0);
    if (!branches) continue;
    const words = new Set(hs.flatMap((h) => ((h.words as string[]) ?? []).map(String)));
    if (![...REMOTE_CODE].some((w) => words.has(w))) continue;
    const syms = [
      ...new Set(
        hs
          .filter((h) => Number(h.branches ?? 0) > 0)
          .flatMap((h) => ((h.symbols as string[]) ?? []).map(String)),
      ),
    ].filter((x) => /[a-z][A-Z]|_/.test(x) || x.length >= 8);
    const named = [file.split('/').pop() ?? '', ...syms].map(splitName).join(' ');
    if (!REMOTE_NAME.test(named)) continue;
    const stem = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    if (
      stem.length >= 3 &&
      new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(cmds)
    )
      continue;
    const top = [...hs].sort(
      (a, b) => Number(b.branches ?? 0) - Number(a.branches ?? 0),
    )[0]!;
    const row = { file, change: String(top.change), branches, syms: syms.slice(0, 3) };
    const ran = live ? reachingRuns(file, live) : [];
    if (ran.length) {
      // Live runs reached this code: only routes none of them names stay open.
      const routes = routesOf(
        hs.flatMap((h) => ((h.conds as string[]) ?? []).map(String)),
      );
      const usedBy = ran.map((inv) => {
        const ws = new Set([...bareWords(inv.cmd), ...inv.out]);
        return routes.filter((r) => lowerWords(r).every((w) => ws.has(w)));
      });
      const used = [...new Set(usedBy.flat())].sort();
      // A run naming no route may have taken any: unsure, so no row.
      if (!routes.length || usedBy.some((u) => !u.length) || used.length >= routes.length)
        continue;
      out.push({
        ...row,
        open: {
          routes: routes.filter((r) => !used.includes(r)),
          used,
          cmd: ran.find((inv, i) => usedBy[i]!.length)!.cmd,
        },
      });
      continue;
    }
    out.push(row);
  }
  const ticks = (xs: string[]) => xs.map((s) => `\`${s}\``).join(', ');
  return out
    .sort((a, b) => b.branches - a.branches || a.file.localeCompare(b.file))
    .slice(0, 2)
    .map((x) => ({
      change: x.change,
      kind: 'open',
      limit: x.open
        ? `${x.file} adds branches that call a remote service; the recorded run of \`${x.open.cmd}\` used ${ticks(x.open.used)}, and no recorded run shows ${ticks(x.open.routes)} running against the real service.`
        : `${x.file} adds branches that call a remote service${x.syms.length ? ` (${ticks(x.syms)})` : ''}; no recorded check run shows those paths running against the real service.`,
    }));
}

/**
 * At most MAX_LIMITS rows. Over the cap, the lowest-priority rows go first:
 * the remote-path rows, then the "no request recorded" row, then the tail.
 */
export function capLimits(
  existing: Row[],
  extra: Row[],
  remote: Row[],
  max = MAX_LIMITS,
): Row[] {
  let all = [...existing, ...extra, ...remote];
  const drop = (pred: (r: Row) => boolean) => {
    while (all.length > max) {
      const i = all.findLastIndex(pred);
      if (i < 0) return;
      all.splice(i, 1);
    }
  };
  drop((r) => remote.includes(r));
  drop((r) => /^No user request was recorded/.test(String(r.limit ?? '')));
  return all.slice(0, max);
}

/** Added code of a hunk's `code` lines: `+ x`, or the new side of `- a ⇒ + b`. */
const addedCode = (code: unknown) =>
  ((code as string[]) ?? [])
    .map(String)
    .map((l) => (l.includes('⇒') ? l.split('⇒').pop()!.trim() : l))
    .filter((l) => l.startsWith('+ '))
    .map((l) => l.slice(2))
    .join('\n');

const NAME = /^[A-Za-z_$][\w$]{2,}$/;
/** A function or value name: starts lowercase, not ALL_CAPS. */
const CALLABLE = /^[a-z_$][\w$]*[a-z][\w$]*$/;
const uniqStr = (xs: string[]) => [...new Set(xs)];
const MIN_CALLS = 2;

/** Commit-message rows and their `→ H#` links (structural and search), for ownership. */
export interface SentenceLinks {
  sentences: { ref: string; text: string }[];
  links: Record<string, string[]>;
}

/**
 * What the graph ties to one changed function: the commit sentences linked to
 * a hunk only it owns (the one function the hunk defines, or the only one it
 * touches) or naming it outright, and the added branches of those hunks.
 * `words` (stemmed) is everything said about it, for matching prose.
 */
export interface FnProfile {
  name: string;
  file: string;
  sentences: { ref: string; text: string }[];
  conds: string[];
  /** Stemmed words of the name. */
  nameWords: string[];
  /** Stemmed words of its sentences, its own hunks' words and its branches. */
  words: string[];
}

const fnNames = (h: Row) =>
  uniqStr(
    [h.scope, ...((h.touched as string[]) ?? []), ...((h.symbols as string[]) ?? [])]
      .filter((x): x is string => typeof x === 'string')
      .filter((x) => NAME.test(x) && CALLABLE.test(x) && x.length >= 4),
  );
/** The one function a hunk belongs to, when it is clear: it defines one, or touches one. */
const soleOf = (h: Row): string | undefined => {
  const defined = ((h.symbols as string[]) ?? [])
    .map(String)
    .filter((x) => NAME.test(x) && CALLABLE.test(x) && x.length >= 4);
  if (defined.length === 1) return defined[0];
  if (defined.length) return undefined;
  const all = fnNames(h);
  return all.length === 1 ? all[0] : undefined;
};
const nameWordsOf = (name: string) =>
  [...wordsOf(name)].filter((w) => !HANDLER_WORD.has(w));

/** Per changed source function, what the graph ties to it (see `FnProfile`). */
export function functionProfiles(
  g: GraphEngine,
  ctx?: SentenceLinks,
): Map<string, FnProfile> {
  const hunks = g
    .run(
      `MATCH (h:Hunk)-[:OF]->(f:File)
       RETURN h.id AS id, h.file AS file, f.role AS role, h.scope AS scope, h.touched AS touched,
              h.symbols AS symbols, h.conds AS conds, h.words AS words`,
    )
    .rows.filter((h) => unitRole(String(h.file), String(h.role ?? '')) === 'src')
    .sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));
  const out = new Map<string, FnProfile>();
  const sole = new Map<string, Row[]>();
  for (const h of hunks) {
    for (const n of fnNames(h))
      if (!out.has(n))
        out.set(n, {
          name: n,
          file: String(h.file),
          sentences: [],
          conds: [],
          nameWords: nameWordsOf(n),
          words: [],
        });
    const one = soleOf(h);
    if (one) {
      sole.set(one, [...(sole.get(one) ?? []), h]);
      out.get(one)!.file = String(h.file);
    }
  }
  const sentences = ctx?.sentences ?? [];
  const linkCount = (ref: string) => (ctx?.links[ref] ?? []).length || 99;
  for (const p of out.values()) {
    const own = sole.get(p.name) ?? [];
    const ownIds = new Set(own.map((h) => String(h.id)));
    const esc = p.name.replace(/[$]/g, '\\$');
    p.sentences = sentences
      .filter((x) => {
        if ((ctx?.links[x.ref] ?? []).some((id) => ownIds.has(id))) return true;
        if (new RegExp(`\`${esc}\``).test(x.text)) return true;
        const ws = wordsOf(x.text);
        return p.nameWords.length >= 2 && p.nameWords.every((w) => ws.has(w));
      })
      .sort((a, b) => linkCount(a.ref) - linkCount(b.ref));
    p.conds = uniqStr(
      own
        .flatMap((h) => ((h.conds as string[]) ?? []).map(String))
        .filter((c) => c.startsWith('+ '))
        .map((c) => c.slice(2).trim()),
    );
    p.words = [
      ...new Set([
        ...p.sentences.flatMap((x) => [...wordsOf(x.text)]),
        ...own.flatMap((h) => [...wordsOf(((h.words as string[]) ?? []).join(' '))]),
        ...p.conds.flatMap((c) => [...wordsOf(c)]),
      ]),
    ];
  }
  return out;
}

const clipAt = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[\s,;:]+$/, '')}…`;
};
/** What the graph ties to a function, short: its most specific sentence, else its longest added branch. */
function ownedBy(
  p: FnProfile | undefined,
  n: number,
): { text: string; cite?: string } | undefined {
  if (!p) return undefined;
  const s = p.sentences[0];
  if (s) return { text: `${clipAt(s.text, n)} (${s.ref})`, cite: s.ref };
  const c = [...p.conds].sort((a, b) => b.length - a.length)[0];
  return c ? { text: `\`${clipAt(c, n - 6).replace(/`/g, "'")}\`` } : undefined;
}

/** Above this the entry row stops adding functions. */
const ENTRY_CHARS = 300;

/**
 * Where a reviewer starts: the changed function in a shipped source file
 * (not a test or script) whose new lines call the most changed symbols of
 * other files (it owns the behavior they implement), named with its file. A hunk belongs to the function git names after its @@
 * (the one it starts in), else the first it touches. Needs MIN_CALLS distinct
 * calls; otherwise the most-referenced changed symbol from the head scan, if
 * a source file defines it. Undefined when neither holds.
 *
 * The row also says what each function owns (`functionProfiles`): what the
 * graph ties to the entry, then its changed callees, the next function in its
 * file and its changed callers, each with what is tied to it, so a writer
 * doesn't pin a caller's or callee's behavior on the entry.
 */
export function entryRow(g: GraphEngine, ctx?: SentenceLinks): Row | undefined {
  const hunks = g
    .run(
      `MATCH (c:Change)-[:HAS]->(h:Hunk)-[:OF]->(f:File)
       RETURN c.id AS change, h.id AS id, h.file AS file, f.role AS role, h.scope AS scope,
              h.touched AS touched, h.fresh AS fresh, h.symbols AS symbols, h.code AS code,
              h.diff AS diff, h.branches AS branches`,
    )
    .rows.filter((h) => unitRole(String(h.file), String(h.role ?? '')) === 'src')
    .sort((a, b) => Number(String(a.id).slice(1)) - Number(String(b.id).slice(1)));
  if (!hunks.length) return undefined;
  const definedIn = new Map<string, string>();
  for (const h of hunks)
    for (const s of [
      ...((h.symbols as string[]) ?? []),
      ...((h.fresh as string[]) ?? []),
      ...((h.touched as string[]) ?? []),
    ])
      if (NAME.test(String(s)) && String(s).length >= 4 && !definedIn.has(String(s)))
        definedIn.set(String(s), String(h.file));
  const refsOf = new Map(
    g
      .run(
        `MATCH (x:HeadRef) WHERE x.kind <> 'still mentions' RETURN x.term AS term, x.files AS files, x.kind AS kind, x.definedIn AS definedIn`,
      )
      .rows.map((r) => [String(r.term), r]),
  );
  type Owner = {
    name: string;
    file: string;
    change: string;
    calls: Set<string>;
    diff: string[];
    branches: number;
  };
  const owners = new Map<string, Owner>();
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const h of hunks) {
    const owner = [h.scope, ...((h.touched as string[]) ?? [])]
      .map((x) => (x == null ? '' : String(x)))
      .find((x) => NAME.test(x));
    if (!owner) continue;
    const code = addedCode(h.code);
    const key = `${String(h.file)}#${owner}`;
    const o = owners.get(key) ?? {
      name: owner,
      file: String(h.file),
      change: String(h.change),
      calls: new Set<string>(),
      diff: [],
      branches: 0,
    };
    // Calls into other files' changed code: the function that wires the
    // change together, not a helper calling its neighbours.
    // Functions and values only: a type (`ProviderId`) or constant is not a call.
    for (const [name, file] of definedIn)
      if (
        name !== owner &&
        file !== String(h.file) &&
        CALLABLE.test(name) &&
        new RegExp(`\\b${esc(name)}\\s*[(),\\]]`).test(code)
      )
        o.calls.add(name);
    o.diff.push(String(h.diff));
    o.branches += Number(h.branches ?? 0);
    owners.set(key, o);
  }
  const profiles = functionProfiles(g, ctx);
  const fileOf = (n: string) => profiles.get(n)?.file ?? definedIn.get(n);
  /** The entry's own clause, then one clause per related function while the row stays short. */
  const compose = (
    entry: string,
    entryFile: string,
    lead: string,
    related: { name: string; how: string }[],
  ) => {
    const cites: string[] = [];
    const mine = ownedBy(profiles.get(entry), 64);
    if (mine?.cite) cites.push(mine.cite);
    let text = `Start at \`${entry}\` in ${entryFile}${lead}${mine ? `; tied to it: ${mine.text}` : ''}.`;
    const head = ` Not in \`${entry}\`: `;
    const parts: string[] = [];
    for (const r of related) {
      const what = ownedBy(profiles.get(r.name), 48);
      // A callee the lead already names adds something only with what is tied to it.
      if (r.how === 'called' && !what) continue;
      const file = fileOf(r.name);
      const where = file === entryFile ? 'same file' : (file ?? '');
      // Call relations are matched from hunk text, not a real call graph, so they
      // are never printed: only where a function lives and what is tied to it.
      if (!what) continue;
      const part = `\`${r.name}\`${where ? ` (${where})` : ''}: ${what.text}`;
      if (
        text.length + head.length + [...parts, part].join('; ').length > ENTRY_CHARS &&
        parts.length
      )
        break;
      parts.push(part);
      if (what?.cite) cites.push(what.cite);
    }
    if (parts.length) text += `${head}${parts.join('; ')}.`;
    return { text, cites };
  };
  const callersOf = (name: string) =>
    [...owners.values()]
      .filter((o) => o.name !== name && o.calls.has(name))
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const refFiles = (n: string) => Number(refsOf.get(n)?.files ?? 0);
  const ranked = [...owners.values()]
    .filter((o) => o.calls.size >= MIN_CALLS)
    .sort(
      (a, b) =>
        b.calls.size - a.calls.size ||
        refFiles(b.name) - refFiles(a.name) ||
        b.branches - a.branches ||
        a.file.localeCompare(b.file) ||
        a.name.localeCompare(b.name),
    );
  const best = ranked[0];
  if (best) {
    // The next owner in the same file, often the one choosing between paths.
    const next = ranked.find((o) => o !== best && o.file === best.file);
    const called = [...best.calls].sort();
    const elsewhere = [
      ...new Set(called.map((c) => definedIn.get(c)!).filter((f) => f !== best.file)),
    ];
    // `called`/`elsewhere` only rank the entry; call claims are not printed.
    void elsewhere;
    const lead = '';
    const related = [
      ...(next
        ? [
            {
              name: next.name,
              how: `calls ${[...next.calls]
                .sort()
                .slice(0, 3)
                .map((c) => `\`${c}\``)
                .join(', ')}`,
            },
          ]
        : []),
      ...called.map((c) => ({ name: c, how: 'called' })), // already in the lead
      ...callersOf(best.name).map((o) => ({
        name: o.name,
        how: `calls \`${best.name}\``,
      })),
    ].filter(
      (r, i, all) =>
        r.name !== best.name && all.findIndex((x) => x.name === r.name) === i,
    );
    const { text, cites } = compose(best.name, best.file, lead, related);
    return {
      kind: 'entry',
      fact: text,
      cites: uniqStr([
        best.change,
        ...best.diff.slice(0, 2),
        ...(next ? [next.change, next.diff[0]!] : []),
        ...cites,
      ]),
    };
  }
  const top = [...refsOf.values()].find((r) => r.kind === 'most referenced');
  const file = top ? ((top.definedIn as string[]) ?? []).map(String)[0] : undefined;
  if (!top || !file || unitRole(file, pathRole(file)) !== 'src') return undefined;
  const h = hunks.find((x) => x.file === file);
  const term = String(top.term);
  const related = callersOf(term).map((o) => ({
    name: o.name,
    how: `calls \`${term}\``,
  }));
  const { text, cites } = compose(
    term,
    file,
    `: the changed symbol most named elsewhere (${Number(top.files)} other file(s))`,
    related,
  );
  return {
    kind: 'entry',
    fact: text,
    cites: uniqStr([...(h ? [String(h.change), String(h.diff)] : []), ...cites]),
  };
}

// --- Where each behavior lives ---------------------------------------------

/** Most `owners` rows, and per change unit. */
export const MAX_OWNER_ROWS = 6;
const OWNERS_PER_CHANGE = 5;
/** Characters of a sentence excerpt in an `owners` row. */
const OWNER_TEXT = 80;

/**
 * Where each behavior lives: commit sentences mapped to the one or two changed
 * functions whose changed lines say what the sentence says. A hunk's changed
 * lines are split by the function they sit in (`fnWords`, with a doc comment
 * going to the definition below it), so a hunk that defines several functions
 * still tells them apart. A sentence linked to hunks (`→ H#`) is matched only
 * against the functions in those hunks; an unlinked one against every changed
 * source function, with a higher bar. Kept only when one or two functions
 * clearly lead (high precision), and only in change units where at least two
 * distinct functions own different sentences: that is where a writer pins one
 * function's behavior on its neighbour. Never says who calls whom.
 */
/** A sentence's clauses: split at `;`, and at `: ` when both sides say something. */
export function clausesOf(text: string): string[] {
  const words = (x: string) => x.trim().split(/\s+/).filter(Boolean).length;
  const out: string[] = [];
  for (const part of text.split(/;\s+/)) {
    const i = part.indexOf(': ');
    if (i > 0 && words(part.slice(0, i)) >= 3 && words(part.slice(i + 2)) >= 3)
      out.push(part.slice(0, i), part.slice(i + 2));
    else out.push(part);
  }
  return out.map((x) => x.trim().replace(/[.;:,]+$/, '')).filter(Boolean);
}

export function ownerRows(
  g: GraphEngine,
  ctx: SentenceLinks,
  max = MAX_OWNER_ROWS,
): Row[] {
  let hunks: Row[];
  try {
    hunks = g.run(
      `MATCH (c:Change)-[:HAS]->(h:Hunk)-[:OF]->(f:File)
       RETURN c.id AS change, h.id AS id, h.file AS file, f.role AS role, h.diff AS diff,
              h.fnWords AS fnWords`,
    ).rows;
  } catch {
    return [];
  }
  type Seg = {
    fn: string;
    file: string;
    change: string;
    hunk: string;
    diff: string;
    words: Set<string>;
  };
  const segs: Seg[] = [];
  for (const h of hunks) {
    if (unitRole(String(h.file), String(h.role ?? '')) !== 'src') continue;
    for (const entry of ((h.fnWords as string[]) ?? []).map(String)) {
      const i = entry.indexOf(': ');
      const fn = i < 0 ? entry : entry.slice(0, i);
      if (!NAME.test(fn) || !CALLABLE.test(fn) || fn.length < 4) continue;
      segs.push({
        fn,
        file: String(h.file),
        change: String(h.change),
        hunk: String(h.id),
        diff: String(h.diff),
        words: wordsOf(i < 0 ? '' : entry.slice(i + 2)),
      });
    }
  }
  if (!segs.length) return [];
  const byNum = (a: string, b: string) =>
    Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));
  type Hit = { ref: string; text: string; fns: Seg[][]; change: string; file: string };
  const hits: Hit[] = [];
  for (const s of ctx.sentences) {
    // Sentences, not subjects: a subject sums up what its sentences detail.
    if (!s.ref.includes('#')) continue;
    const linked = new Set(ctx.links[s.ref] ?? []);
    const linkedFiles = new Set(segs.filter((x) => linked.has(x.hunk)).map((x) => x.file));
    // Linked: the functions of the linked hunks' files, those hunks first.
    const pool = linked.size ? segs.filter((x) => linkedFiles.has(x.file)) : segs;
    const byFn = new Map<string, Seg[]>();
    for (const x of pool) {
      const key = `${x.file}#${x.fn}`;
      byFn.set(key, [...(byFn.get(key) ?? []), x]);
    }
    // A word most of the pool's functions share tells them apart less.
    const fnSets = [...byFn.values()].map((xs) => ({
      xs,
      words: new Set(xs.flatMap((x) => [...x.words])),
      name: nameWordsOf(xs[0]!.fn),
    }));
    const df = (w: string, of: (f: (typeof fnSets)[number]) => Iterable<string>) =>
      fnSets.filter((f) => [...of(f)].includes(w)).length;
    const done = new Set<string>();
    for (const clause of clausesOf(s.text)) {
      const sw = wordsOf(clause);
      if (sw.size < 3) continue;
      const scored = fnSets
        .map(({ xs, words, name }) => {
          const named = name
            .filter((w) => sw.has(w))
            .reduce((n, w) => n + (df(w, (f) => f.name) > 1 ? 1 : 2), 0);
          const said = [...sw]
            .filter((w) => words.has(w))
            .reduce((n, w) => n + (df(w, (f) => f.words) > 2 ? 0.5 : 1), 0);
          const tied = xs.some((x) => linked.has(x.hunk)) ? 2 : 0;
          return { xs, score: said + named + tied };
        })
        .sort((a, b) => b.score - a.score || a.xs[0]!.fn.localeCompare(b.xs[0]!.fn));
      const top = scored[0];
      if (!top) continue;
      const bar = linked.size ? 3 : 4;
      if (top.score < bar) continue;
      const chosen = scored.filter((x) => x.score >= Math.max(bar, top.score * 0.75));
      if (chosen.length > 2) continue;
      // A clear lead over every other function.
      const rest = scored[chosen.length];
      if (rest && rest.score > top.score * (linked.size ? 0.7 : 0.6)) continue;
      // Both functions in one file, or the row would name two places.
      if (chosen.some((c) => c.xs[0]!.file !== top.xs[0]!.file)) continue;
      const key = chosen.map((c) => c.xs[0]!.fn).join(' ');
      if (done.has(key)) continue;
      done.add(key);
      hits.push({
        ref: s.ref,
        text: clause,
        fns: chosen.map((c) => c.xs),
        change: top.xs[0]!.change,
        file: top.xs[0]!.file,
      });
    }
  }
  // Change units where two or more distinct functions own different sentences.
  const fnsOf = (h: Hit) => h.fns.map((xs) => xs[0]!.fn);
  const confused = new Set(
    [...new Set(hits.map((h) => h.change))].filter((ch) => {
      const own = hits.filter((h) => h.change === ch);
      return own.some((a) =>
        own.some(
          (b) =>
            a !== b &&
            a.file === b.file &&
            fnsOf(a).some((f) => !fnsOf(b).includes(f)) &&
            fnsOf(b).some((f) => !fnsOf(a).includes(f)),
        ),
      );
    }),
  );
  const out: Row[] = [];
  const perChange = new Map<string, number>();
  const seenFn = new Set<string>();
  // One row per function first, so each owner in a unit gets a turn.
  // Units with the most distinct owners first: there a writer mixes them up most.
  const owners = (ch: string) =>
    new Set(hits.filter((h) => h.change === ch).flatMap(fnsOf)).size;
  const ordered = hits
    .filter((h) => confused.has(h.change))
    .sort((a, b) => owners(b.change) - owners(a.change) || a.change.localeCompare(b.change));
  const taken = new Set<string>();
  const take = (h: Hit) => {
    const n = perChange.get(h.change) ?? 0;
    if (taken.has(`${h.ref} ${h.text}`) || n >= OWNERS_PER_CHANGE || out.length >= max) return;
    taken.add(`${h.ref} ${h.text}`);
    perChange.set(h.change, n + 1);
    for (const f of fnsOf(h)) seenFn.add(f);
    const diffs = [...new Set(h.fns.flat().map((x) => x.diff))].sort(byNum).slice(0, 2);
    out.push({
      change: h.change,
      behavior: clipAt(h.text, OWNER_TEXT),
      function: fnsOf(h)
        .map((f) => `\`${f}\``)
        .join(' '),
      file: h.file,
      cites: [h.ref, ...diffs].join(' '),
    });
  };
  for (const h of ordered) if (fnsOf(h).some((f) => !seenFn.has(f))) take(h);
  for (const h of ordered) take(h);
  return out.sort(
    (a, b) =>
      String(a.change).localeCompare(String(b.change)) ||
      String(a.file).localeCompare(String(b.file)),
  );
}
