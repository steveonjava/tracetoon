/**
 * Named questions agents ask the evidence graph. Each runs Cypher on the loaded
 * graph; TypeScript only groups and orders rows so results are deterministic and
 * compact. Results are sections of rows, printed as TOON by `tracetoon query`.
 */
import { GraphError, type GraphEngine } from './engine.ts';
import { shownCommand } from './briefRender.ts';
import { SCHEMA_DOC } from './model.ts';
import { DO_NOT_SAY_COLUMNS, doNotSayRows } from './doNotSay.ts';
import {
  earlierFailure,
  lastRunOfEach,
  runHistory,
  selectValidationRuns,
  HISTORY_KINDS,
} from './runHistory.ts';
import { fileRole as pathRole } from '../digest/build.ts';
import { isNeighborhood, type BriefLayout } from './layout.ts';
import { addSearchEvidence, fillSearchLinks } from './searchBrief.ts';
import {
  capLimits,
  entryRow,
  ownerRows,
  failedPublishRows,
  noPassAfterCommitRow,
  remotePathRows,
  liveEvidence,
  functionProfiles,
  type FnProfile,
} from './briefExtras.ts';

export interface Section {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface NamedQuery {
  name: string;
  args: string;
  help: string;
  run(g: GraphEngine, args: string[]): Section[];
}

const CHECK_KINDS = ['test', 'build', 'typecheck', 'lint', 'eval'];
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const byDiff = (a: string, b: string) =>
  Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
const factOrder = (a: string, b: string) =>
  a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a.localeCompare(b);
const section = (title: string, columns: string[], rows: Record<string, unknown>[]) => ({
  title,
  columns,
  rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))),
});

/** Resolve a target to a file path or hunk id; accepts `path`, `path:line`, `H3`, `diff:120`. */
function target(
  g: GraphEngine,
  raw: string | undefined,
): { file?: string; hunk?: string } {
  if (!raw)
    throw new GraphError('Give a file path, a hunk (H3) or a diff line (diff:120).');
  if (/^H\d+$/.test(raw)) return { hunk: raw };
  const diff = /^diff:(\d+)/.exec(raw);
  const line = diff ? undefined : /^(.+?):(\d+)$/.exec(raw);
  if (diff || line) {
    const hunks = g.run(
      'MATCH (h:Hunk) RETURN h.id AS id, h.diff AS diff, h.file AS file, h.start AS start, h.end AS end',
    ).rows;
    const n = Number((diff ?? line)![diff ? 1 : 2]);
    const hit = hunks.find((h) => {
      if (diff) {
        const [a, b] = String(h.diff).slice(5).split('-').map(Number);
        return n >= a! && n <= (b ?? a!);
      }
      return h.file === line![1] && n >= Number(h.start) && n <= Number(h.end);
    });
    if (!hit) throw new GraphError(`No hunk at ${raw}.`);
    return { hunk: String(hit.id) };
  }
  const path = raw.replace(/^\.\//, '');
  const found = g.run(
    'MATCH (f:File) WHERE f.id = $p OR f.id ENDS WITH $s RETURN f.id AS id',
    {
      p: path,
      s: `/${path}`,
    },
  ).rows;
  if (!found.length) throw new GraphError(`No file ${raw} in this run's evidence graph.`);
  if (found.length > 1)
    throw new GraphError(
      `${raw} matches ${found.map((f) => f.id).join(', ')}; give the full path.`,
    );
  return { file: String(found[0]!.id) };
}

/** Per prompt: the turn's surviving edits into the target, its decisions and plans. */
function turnsInto(g: GraphEngine, t: { file?: string; hunk?: string }): Section {
  const rows = g.run(
    `${t.hunk ? 'MATCH (h0:Hunk {id: $id})<-[:SURVIVES_IN]-(e:Edit)' : 'MATCH (:File {id: $id})<-[:EDITS]-(e:Edit)'}-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (e)-[s:SURVIVES_IN]->(h:Hunk)
     OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
     OPTIONAL MATCH (x)-[:IN_TURN]->(p) WHERE x:Decision OR x:Plan
     RETURN p.id AS prompt, p.text AS text, p.pushback AS pushback, e.id AS edit,
            e.surviving AS surviving, h.diff AS diff, h.file AS hfile, collect(DISTINCT x.id) AS facts`,
    { id: t.hunk ?? t.file },
  ).rows;
  type Turn = {
    prompt: string;
    text: string;
    pushback: boolean;
    edits: Map<string, number>;
    diffs: string[];
    facts: string[];
  };
  const turns = new Map<string, Turn>();
  for (const r of rows) {
    const key = String(r.prompt ?? '(no prompt)');
    const turn: Turn = turns.get(key) ?? {
      prompt: key,
      text: String(r.text ?? ''),
      pushback: !!r.pushback,
      edits: new Map(),
      diffs: [],
      facts: [],
    };
    turn.edits.set(String(r.edit), Number(r.surviving ?? 0));
    if (r.diff && (!t.file || r.hfile === t.file)) turn.diffs.push(String(r.diff));
    turn.facts.push(...((r.facts as string[]) ?? []));
    turns.set(key, turn);
  }
  return section(
    'turns',
    [
      'prompt',
      'pushback',
      'edits',
      'survivingLines',
      'deadEndEdits',
      'diff',
      'facts',
      'text',
    ],
    [...turns.values()]
      .sort((a, b) => factOrder(a.prompt, b.prompt))
      .map((t) => ({
        prompt: t.prompt,
        pushback: t.pushback || null,
        edits: t.edits.size,
        survivingLines: [...t.edits.values()].reduce((a, b) => a + b, 0),
        deadEndEdits: [...t.edits.values()].filter((n) => n === 0).length,
        diff: uniq(t.diffs).sort(byDiff),
        facts: uniq(t.facts).sort(factOrder),
        text: t.text,
      })),
  );
}

/** Check runs (test, build, …) of included sessions after a file's last captured edit. */
export function checksAfterLastEdit(
  g: GraphEngine,
  file?: string,
): {
  file: string;
  role: string;
  lastEdit: string | null;
  after: { id: string; outcome: string; kind: string }[];
}[] {
  // Two indexed lookups, then the time comparison here: a files × runs join in
  // Cypher grows with their product.
  const files = g.run(
    `MATCH (f:File {inPr: true}) ${file ? 'WHERE f.id = $file' : ''}
     OPTIONAL MATCH (f)<-[:EDITS]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     RETURN f.id AS file, f.role AS role, max(e.t) AS lastEdit, count(e) AS edits,
            collect(CASE WHEN e.via = 'shell' THEN e.t END) AS shellTimes,
            collect(CASE WHEN e.via IS NULL THEN e.t END) AS toolTimes`,
    { file: file ?? null },
  ).rows;
  const runs = g
    .run(
      `MATCH (r:Run)-[:IN_SESSION]->(:Session {band: 'included'})
       WHERE r.t IS NOT NULL AND r.kind IN $kinds AND r.revision <> 'after later work'
       RETURN r.id AS id, r.outcome AS outcome, r.kind AS kind, r.t AS t`,
      { kinds: CHECK_KINDS },
    )
    .rows.map((r) => ({
      id: String(r.id),
      outcome: String(r.outcome),
      kind: String(r.kind),
      t: String(r.t),
    }));
  const out = new Map<
    string,
    {
      file: string;
      role: string;
      lastEdit: string | null;
      after: { id: string; outcome: string; kind: string; t: string }[];
    }
  >();
  for (const f of files) {
    const lastEdit = Number(f.edits) ? ((f.lastEdit as string | null) ?? null) : null;
    out.set(String(f.file), {
      file: String(f.file),
      role: String(f.role),
      lastEdit,
      // A run in the same command as a shell edit (sed … && bun test) shares its
      // timestamp; chained after the edit, it saw it.
      after: lastEdit
        ? runs.filter(
            (r) =>
              r.t > lastEdit ||
              (r.t === lastEdit &&
                ((f.shellTimes as string[]) ?? []).includes(lastEdit) &&
                !((f.toolTimes as string[]) ?? []).includes(lastEdit)),
          )
        : [],
    });
  }
  return [...out.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((f) => ({
      ...f,
      after: f.after
        .sort((a, b) => b.t.localeCompare(a.t) || factOrder(a.id, b.id))
        .map(({ t: _t, ...r }) => r),
    }));
}

export function unexplainedHunks(g: GraphEngine): Record<string, unknown>[] {
  return g
    .run(
      `MATCH (h:Hunk)-[:OF]->(f:File)
       WHERE f.role IN ['behavior', 'tests']
         AND NOT EXISTS { MATCH (:Session {band: 'included'})<-[:IN_SESSION]-(:Edit)-[:SURVIVES_IN]->(h) }
       OPTIONAL MATCH (c:Commit)-[:TOUCHES]->(f)
       OPTIONAL MATCH (s:Session)-[:MADE]->(c)
       RETURN h.id AS hunk, h.diff AS diff, f.id AS file, h.added AS added, h.removed AS removed,
              collect(DISTINCT c.id) AS commits, count(DISTINCT s) AS sessionCommits`,
    )
    .rows.map((r): Record<string, unknown> => ({
      ...r,
      commits: ((r.commits as string[]) ?? []).sort(),
      removalOnly: Number(r.added) === 0 || null,
    }))
    .sort((a, b) => byDiff(String(a.diff), String(b.diff)));
}

const clipText = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const refs = (xs: string[], cap: number) =>
  xs.length > cap ? [...xs.slice(0, cap), `+${xs.length - cap} more`] : xs;

const VERSION_PAIR = /\b\d+\.\d+\.\d+(?:-[\w.]+)?\b.*→.*\b\d+\.\d+\.\d+/;

/** Words too common in prose or code to tie a sentence to a hunk. */
const STOP = new Set(
  "the and for with that this from into when then than only now not are was were has have had its it's also each more most some any all can cannot will would should could does did done use used uses using make makes made add adds added new old instead so they them their there here which what who how why one two three per via over under about after before still just like same other others way ways get gets set sets run runs ran code file files line lines test tests change changes changed fix fixes fixed update updates updated but out off own our you yet too see may due end let".split(
    ' ',
  ),
);
const proseWords = (text: string) =>
  uniq(
    (text.match(/[A-Za-z][a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w)),
  );

/** Crude stem so "commands", "labeled" and "rejecting" meet `commandKey`, `label`, `reject`. */
const stem = (w: string) =>
  w.replace(/(ies|es|s|ed|ing)$/, (m) => (m === 'ies' ? 'y' : '')) || w;

/** A sentence that lists three or more behaviors ("a, b, and c") can't be placed in one file. */
export function listsSeveral(text: string): boolean {
  const parts = text
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]|\band\b/)
    .filter((p) => p.trim().split(/\s+/).length >= 2);
  return parts.length >= 3;
}

/** A commit's files the sentence names outright (`src/a.ts`, `` `a.ts` ``). */
const namedFiles = (hunks: Record<string, unknown>[], text: string): string[] =>
  uniq(hunks.map((h) => String(h.file))).filter((f) =>
    new RegExp(
      `(^|[\\s(\`'"])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s),.:;\`'"])`,
    ).test(text),
  );

const isVersionFile = (f: string) =>
  /(^|\/)(VERSION|package\.json|plugin\.json|version\.\w+)$/.test(f);
const isCodeFile = (f: string) =>
  !/(^|\/)(tests?|__tests__|spec|docs?)\/|\.(test|spec)\.\w+$|\.(md|mdx|txt)$/.test(f);
const ABOUT_TESTS_OR_DOCS = /\btests?\b|\bdocs?\b|\bguide\b|\bskill\b|\breadme\b/i;

/** A weak match (two shared words out of many) places nothing. */
const strongEnough = (hits: number, words: number) => hits >= 3 || hits >= 0.4 * words;

/**
 * The files a sentence describes, among one commit's hunks: those whose changed
 * lines and symbol names share the sentence's rarer words. Returns nothing when
 * the sentence lists several behaviors or two files fit about equally, since a
 * wrong file misleads more than none (dev14: every Terra error on pr5).
 */
export function describedHunks(hunks: Record<string, unknown>[], text: string): string[] {
  // A sentence that names one of the commit's files says where it lives.
  const named = namedFiles(hunks, text);
  if (named.length === 1) return named;
  if (listsSeveral(text)) return [];
  const { scored, words } = scoredHunks(hunks, text);
  // Best hunk per file.
  const byFile = new Map<string, { score: number; hits: number }>();
  for (const x of scored)
    if (x.score > (byFile.get(x.file)?.score ?? -1))
      byFile.set(x.file, { score: x.score, hits: x.hits });
  const ranked = [...byFile].sort((a, b) => b[1].score - a[1].score);
  if (!ranked.length) return [];
  // Two files that fit about equally: say neither rather than guess.
  if (ranked.length > 1 && ranked[1]![1].score >= ranked[0]![1].score * 0.8) return [];
  // Three words, or at least two fifths of the sentence's words, must meet the hunk.
  if (!strongEnough(ranked[0]![1].hits, words)) return [];
  return [ranked[0]![0]];
}

/**
 * The hunks a commit sentence describes, among that commit's own hunks: the
 * `→ H#` links of the neighborhood brief and the review packet. As
 * conservative as `describedHunks`: nothing when two hunks in different files
 * fit about equally or the match is weak. A sentence listing several behaviors
 * links each listed part on its own (up to three hunks); a commit with a
 * single code hunk links a sentence about code that shares its words; two
 * close hunks in one file are both linked.
 */
export function linkedHunks(hunks: Record<string, unknown>[], text: string): string[] {
  if (!hunks.length) return [];
  const named = namedFiles(hunks, text);
  if (named.length && named.length <= 2) {
    const { scored } = scoredHunks(hunks, text, { all: true });
    return named.map((f) => {
      const own = scored.filter((x) => x.file === f).sort((a, b) => b.score - a.score);
      return own[0]?.id ?? String(hunks.find((h) => String(h.file) === f)!.id);
    });
  }
  if (listsSeveral(text)) {
    const parts = text
      .replace(/\([^)]*\)/g, '')
      .split(/[,;]|\band\b/)
      .filter((p) => p.trim().split(/\s+/).length >= 2);
    return uniq(parts.flatMap((p) => linkedHunks(hunks, p).slice(0, 1))).slice(0, 3);
  }
  const version = /\bversion|\bbump/i.test(text);
  const code = hunks.filter(
    (h) => isCodeFile(String(h.file)) && (version || !isVersionFile(String(h.file))),
  );
  const { scored, words } = scoredHunks(hunks, text);
  const ranked = scored
    .filter((x) => strongEnough(x.hits, words))
    .sort((a, b) => b.score - a.score);
  // One code hunk in the commit: a sentence about code that shares words with it.
  if (
    code.length === 1 &&
    !version &&
    !ABOUT_TESTS_OR_DOCS.test(text) &&
    ranked.some((x) => x.id === String(code[0]!.id))
  )
    return [String(code[0]!.id)];
  if (!ranked.length) return [];
  if (ranked.length > 1 && ranked[1]!.score >= ranked[0]!.score * 0.8)
    return ranked[1]!.file === ranked[0]!.file ? [ranked[0]!.id, ranked[1]!.id] : [];
  return [ranked[0]!.id];
}

/**
 * Each hunk's fit to a sentence (shared by `describedHunks` and `linkedHunks`),
 * after the version and code-first filters; `all` skips those filters.
 */
function scoredHunks(
  hunks: Record<string, unknown>[],
  text: string,
  opts: { all?: boolean } = {},
): {
  scored: { id: string; file: string; score: number; hits: number }[];
  words: number;
} {
  const words = uniq(proseWords(text).map(stem));
  if (!words.length || !hunks.length) return { scored: [], words: words.length };
  const has = hunks.map((h) => new Set(((h.words as string[]) ?? []).map(stem)));
  const symbolWords = hunks.map(
    (h) =>
      new Set(
        ((h.symbols as string[]) ?? []).flatMap((x) =>
          proseWords(x.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')).map(stem),
        ),
      ),
  );
  const idf = new Map(
    words.map((w) => {
      const df = has.filter((x) => x.has(w)).length;
      return [w, df ? Math.log(1 + hunks.length / df) : 0];
    }),
  );
  // Long hunks (a file of prompt text, a fixture) share some word with any
  // sentence; scale by size, as BM25 does, so they don't win by bulk. A word
  // that is also in the name of the symbol the hunk changes counts double.
  const avg = has.reduce((n, x) => n + x.size, 0) / has.length || 1;
  let scored = hunks
    .map((h, i) => ({
      id: String(h.id),
      file: String(h.file),
      score:
        words.reduce(
          (n, w) =>
            n +
            (has[i]!.has(w) ? idf.get(w)! : 0) +
            (symbolWords[i]!.has(w) ? idf.get(w)! || 1 : 0),
          0,
        ) /
        (0.5 + (0.5 * has[i]!.size) / avg),
      hits: words.filter((w) => has[i]!.has(w) || symbolWords[i]!.has(w)).length,
    }))
    .filter((x) => x.hits >= Math.min(2, words.length));
  if (opts.all) return { scored, words: words.length };
  // Version files match any sentence with a number; they belong only to version sentences.
  if (!/\bversion|\bbump/i.test(text))
    scored = scored.filter((x) => !isVersionFile(x.file));
  // Tests and docs describe behavior too; the code that does it comes first.
  // A sentence that mentions neither is about code: a test or doc file alone
  // matching it is no placement.
  if (!ABOUT_TESTS_OR_DOCS.test(text)) scored = scored.filter((x) => isCodeFile(x.file));
  return { scored, words: words.length };
}

const planStatus = (approved: unknown) =>
  approved === true
    ? 'plan (approved)'
    : approved === false
      ? 'plan (not approved as written)'
      : 'plan';

export interface PrTurns {
  /** Prompts whose turn produced surviving edits in the PR, or a PR commit. */
  productive: Set<string>;
  /** Turns with no edits right before a productive turn: where its work was set up. */
  leadIn: Set<string>;
  /** The first prompt of the included sessions. */
  opening?: { id: string; text: string; t: string };
  /** Per included session, the time of its first productive or lead-in turn. */
  start: Map<string, string>;
  /** Included sessions, with their prompts in order. */
  prompts: Map<string, { id: string; t: string; edits: number }[]>;
}

/**
 * Which turns are this PR's: those whose edits survive in it or that made one
 * of its commits, and the edit-free turn just before each (a question, a plan).
 * A session shared with earlier work also holds that work's turns; they are
 * not this PR's history.
 */
export function thisPrTurns(g: GraphEngine): PrTurns {
  const rows = g.run(
    `MATCH (p:Prompt)-[:IN_SESSION]->(s:Session {band: 'included'})
     OPTIONAL MATCH (e:Edit)-[:IN_TURN]->(p)
     RETURN p.id AS id, p.t AS t, p.text AS text, s.id AS session, count(e) AS edits,
            sum(CASE WHEN e.surviving > 0 AND e.inPr = true THEN 1 ELSE 0 END) AS surviving`,
  ).rows;
  const made = g.run(
    `MATCH (s:Session {band: 'included'})-[:MADE]->(k:Commit) WHERE k.t IS NOT NULL
     RETURN s.id AS session, k.t AS t`,
  ).rows;
  const productive = new Set<string>();
  const leadIn = new Set<string>();
  const start = new Map<string, string>();
  const prompts = new Map<string, { id: string; t: string; edits: number }[]>();
  const bySession = new Map<string, Record<string, unknown>[]>();
  for (const r of rows)
    bySession.set(String(r.session), [...(bySession.get(String(r.session)) ?? []), r]);
  for (const [session, ps] of bySession) {
    ps.sort(
      (a, b) =>
        String(a.t ?? '').localeCompare(String(b.t ?? '')) ||
        factOrder(String(a.id), String(b.id)),
    );
    prompts.set(
      session,
      ps.map((p) => ({ id: String(p.id), t: String(p.t ?? ''), edits: Number(p.edits) })),
    );
    ps.forEach((p, i) => {
      const from = String(p.t ?? '');
      const to = ps[i + 1]?.t ? String(ps[i + 1]!.t) : '\uffff';
      const commits = made.some(
        (k) => k.session === session && from && String(k.t) >= from && String(k.t) < to,
      );
      if (Number(p.surviving) > 0 || commits) productive.add(String(p.id));
    });
    ps.forEach((p, i) => {
      const next = ps[i + 1];
      if (
        next &&
        productive.has(String(next.id)) &&
        !productive.has(String(p.id)) &&
        !Number(p.edits)
      )
        leadIn.add(String(p.id));
    });
    const first = ps.find(
      (p) => productive.has(String(p.id)) || leadIn.has(String(p.id)),
    );
    if (first?.t) start.set(session, String(first.t));
  }
  const opening = [...rows].sort((a, b) =>
    String(a.t ?? '').localeCompare(String(b.t ?? '')),
  )[0];
  return {
    productive,
    leadIn,
    opening: opening
      ? {
          id: String(opening.id),
          text: String(opening.text ?? ''),
          t: String(opening.t ?? ''),
        }
      : undefined,
    start,
    prompts,
  };
}

/** A prompt that only acknowledges or steers ("go ahead", "yes", "/clear"): never a session goal. */
const ACK =
  /^(?:\/\S+.*|y(?:es|ep|eah)?|no|ok(?:ay)?|sure|thanks?(?: you)?|go(?: ahead| on| for it)?|continue|proceed|do it|lgtm|looks good|sounds good|please|approved?)[\s.!]*$/i;
const substantive = (text: unknown) => {
  const t = String(text ?? '').trim();
  return !!t && !ACK.test(t) && t.split(/\s+/).length >= 2;
};
/** Whether a session id is one of the included sessions. */
const includedSession = (g: GraphEngine, id: unknown) =>
  id != null &&
  g.run(`MATCH (s:Session {band: 'included'}) WHERE s.id = $id RETURN s.id AS id`, {
    id: String(id),
  }).rows.length > 0;
/** At most this many background rows: the goal and one plan (else decision). */
const MAX_BACKGROUND = 2;

/**
 * How the work came about, from the included sessions, when this PR's own
 * turns don't show it: each session's goal (its first substantive prompt) and
 * the plans and decisions of earlier turns, which `requests` leaves out because
 * they didn't produce this PR's edits. Facts the writer covers in a sentence
 * on why the work started, attributed to the session (the first request is
 * the session's, which this PR's own turns may have narrowed); refs already
 * in `requests` are skipped. At most two rows, one motive sentence's worth:
 * the goal, then the latest earlier plan (else decision).
 */
export function backgroundRows(
  g: GraphEngine,
  turns: PrTurns,
  exclude: Set<string>,
): Record<string, unknown>[] {
  const prompts = g.run(
    `MATCH (p:Prompt)-[:IN_SESSION]->(s:Session {band: 'included'})
     RETURN p.id AS id, p.t AS t, p.text AS text, s.id AS session`,
  ).rows;
  const promptSession = new Map(prompts.map((p) => [String(p.id), String(p.session)]));
  const promptTime = new Map(prompts.map((p) => [String(p.id), String(p.t ?? '')]));
  const byTime = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.t ?? '').localeCompare(String(b.t ?? '')) ||
    factOrder(String(a.id ?? a.ref), String(b.id ?? b.ref));
  const goals: Record<string, unknown>[] = [];
  for (const session of [...turns.prompts.keys()].sort()) {
    const first = prompts
      .filter((p) => String(p.session) === session)
      .sort(byTime)
      .find((p) => substantive(p.text));
    if (!first || exclude.has(String(first.id))) continue;
    goals.push({
      ref: String(first.id),
      kind: "why this work started: the session's first request",
      text: clipText(String(first.text ?? '').trim(), 600),
      t: first.t,
    });
  }
  // Per session, the last turn that produced this PR's edits or commits:
  // plans and decisions before it are "earlier in the session".
  const lastProductive = new Map<string, string>();
  for (const id of turns.productive) {
    const s = promptSession.get(id);
    const t = promptTime.get(id) ?? '';
    if (s && t > (lastProductive.get(s) ?? '')) lastProductive.set(s, t);
  }
  // A plan or decision with no turn came before the first prompt the log
  // captured. In a session with no captured prompt at all (its opening request
  // cut off or redacted) it is the only record of how the work started, so it
  // is shown; before a captured prompt it is the tail of earlier work.
  const withPrompts = new Set(promptSession.values());
  const earlier = g
    .run(
      `MATCH (x) WHERE x:Plan OR x:Decision
       OPTIONAL MATCH (x)-[:IN_TURN]->(p:Prompt)
       OPTIONAL MATCH (x)-[:IN_SESSION]->(s:Session)
       RETURN x.id AS id, labels(x)[0] AS label, x.approved AS approved, x.t AS t,
              coalesce(x.answers, x.excerpt, x.text) AS text, p.id AS turn, p.t AS turnT,
              coalesce(s.id, x.session) AS session`,
    )
    .rows.filter((x) => {
      if (exclude.has(String(x.id))) return false;
      if (x.turn == null)
        return !withPrompts.has(String(x.session)) && includedSession(g, x.session);
      const turn = String(x.turn);
      const session = promptSession.get(turn);
      const until = session ? lastProductive.get(session) : undefined;
      return !!until && !turns.productive.has(turn) && String(x.turnT ?? '') < until;
    })
    .sort(byTime)
    .map((x) => ({
      ref: String(x.id),
      kind:
        x.turn == null
          ? x.label === 'Plan'
            ? `${planStatus(x.approved)} in the session (the prompt before it wasn't captured)`
            : "decision in the session (the prompt before it wasn't captured)"
          : x.label === 'Plan'
            ? `earlier ${planStatus(x.approved)} in the session`
            : 'earlier decision in the session',
      text: clipText(String(x.text ?? '').trim(), 400),
      t: x.t,
    }));
  // One motive sentence's worth: the goal, then the latest earlier plan (its
  // approval or rejection says how the work was steered), else the latest decision.
  const goalRows = goals.slice(0, MAX_BACKGROUND - 1);
  const room = MAX_BACKGROUND - goalRows.length;
  const plans = earlier.filter((x) => x.kind.includes('plan'));
  const others = earlier.filter((x) => !x.kind.includes('plan'));
  const factRows =
    room > 0
      ? [...plans.slice(-room), ...others.slice(-room)].slice(0, room).sort(byTime)
      : [];
  return [...goalRows, ...factRows].map(({ ref, kind, text }) => ({ ref, kind, text }));
}

/**
 * A change's conditions, quoted from its code hunks: changed conditions first,
 * then added branches and fallbacks with a literal (thresholds, defaults),
 * then the others, then removed conditions. At most four, each with its file.
 */
export function behaviorOf(hunks: Record<string, unknown>[]): string[] {
  const rank = (x: string) =>
    !/^[+-] /.test(x)
      ? 0
      : x.startsWith('- ')
        ? 4
        : /[<>]=?\s*-?\d|[=!]==?\s*(?:-?\d|['"`])|\?\?\s*(?:-?\d|['"`])/.test(x)
          ? 1
          : /\?\?|\bcatch\b|\bexcept\b|\bdefault\b|\belse\b/.test(x)
            ? 2
            : 3;
  const items = [...hunks]
    .sort((a, b) => byDiff(String(a.diff), String(b.diff)))
    .flatMap((h) =>
      ((h.conds as string[]) ?? []).map((c) => ({
        text: clipText(`${String(h.file).split('/').pop()}: ${c}`, 160),
        rank: rank(c),
      })),
    );
  return uniq(
    items
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.text),
  ).slice(0, 4);
}

/**
 * How the work was done, as recorded: each session's part, whether a plan or
 * decision was recorded, each check kind's runs over this PR's turns, and
 * failed commands. Counts and ids only; no judgments.
 */
function processRows(
  g: GraphEngine,
  turns: PrTurns,
  checkRuns: Record<string, unknown>[],
  background: Set<string> = new Set(),
  /** A `limits` row already says no pass came after the last commit. */
  noPassLimit = false,
  /** A `tracetoon check` receipt passed on the submitted content: "no pass after the last commit" no longer holds. */
  receiptPass = false,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (kind: string, fact: string, cites: string[] = []) =>
    out.push({ ref: `PR${out.length + 1}`, kind, fact, cites });
  const sessions = g
    .run(
      `MATCH (s:Session)
       OPTIONAL MATCH (e:Edit)-[:IN_SESSION]->(s)
       RETURN s.id AS id, s.agent AS agent, s.band AS band, s.failedCommands AS failed,
              s.failedCommand AS failedCommand, count(e) AS edits,
              sum(CASE WHEN e.surviving > 0 AND e.inPr = true THEN 1 ELSE 0 END) AS surviving`,
    )
    .rows.sort(
      (a, b) =>
        Number(a.band !== 'included') - Number(b.band !== 'included') ||
        String(a.id).localeCompare(String(b.id)),
    );
  const made = new Map<string, string[]>();
  for (const r of g.run(
    'MATCH (s:Session)-[:MADE]->(k:Commit) RETURN s.id AS session, k.id AS commit',
  ).rows)
    made.set(String(r.session), [
      ...(made.get(String(r.session)) ?? []),
      String(r.commit),
    ]);
  if (!sessions.length) add('session', 'No agent session was matched to this PR.');
  for (const s of sessions.slice(0, 6)) {
    const id = String(s.id);
    const commits = (made.get(id) ?? []).sort();
    const edits = Number(s.edits);
    const surviving = Number(s.surviving);
    const role =
      s.band !== 'included'
        ? 'ambiguous'
        : commits.length
          ? 'made commits'
          : surviving
            ? 'edits survive'
            : edits
              ? "edits didn't survive"
              : 'no edits captured';
    const asked = (turns.prompts.get(id) ?? [])
      .filter((p) => turns.productive.has(p.id))
      .map((p) => p.id);
    add(
      'session',
      // The role and the turns, not an inventory of edit counts.
      `${String(s.agent)} session, ${role}${commits.length ? ` (${commits.join(', ')})` : ''}${s.band !== 'included' ? '; matched ambiguously, so not used as evidence' : ''}${asked.length ? `; turns that produced this PR's edits or commits: ${refs(asked, 6).join(', ')}` : ''}.`,
      [id, ...commits],
    );
  }
  if (sessions.length > 6)
    add('session', `${sessions.length - 6} more session(s) not listed.`);

  // Plans and decisions of this PR's turns (and the edit-free turn before each).
  const inScope = (turn: unknown) =>
    !!turn && (turns.productive.has(String(turn)) || turns.leadIn.has(String(turn)));
  const facts = g
    .run(
      `MATCH (x)-[:IN_TURN]->(p:Prompt) WHERE x:Plan OR x:Decision
       RETURN x.id AS id, labels(x)[0] AS label, x.approved AS approved, x.t AS t,
              x.text AS title, x.truncated AS truncated, p.id AS turn`,
    )
    .rows.filter((x) => inScope(x.turn))
    .sort(
      (a, b) =>
        String(a.t ?? '').localeCompare(String(b.t ?? '')) ||
        factOrder(String(a.id), String(b.id)),
    );
  const plans = facts.filter((x) => x.label === 'Plan');
  const decisions = facts.filter((x) => x.label === 'Decision');
  // Plans and decisions the included sessions recorded outside this PR's turns
  // (earlier turns, or before the first captured prompt): `background` shows
  // them, so "none was recorded" would be wrong.
  const elsewhere = g
    .run(
      `MATCH (x) WHERE x:Plan OR x:Decision
       OPTIONAL MATCH (x)-[:IN_TURN]->(p:Prompt)
       RETURN x.id AS id, labels(x)[0] AS label, x.approved AS approved, x.t AS t, p.id AS turn`,
    )
    .rows.filter((x) => !inScope(x.turn) && background.has(String(x.id)))
    .sort(
      (a, b) =>
        String(a.t ?? '').localeCompare(String(b.t ?? '')) ||
        factOrder(String(a.id), String(b.id)),
    );
  const outside = elsewhere.map((x) =>
    x.label !== 'Plan'
      ? `${String(x.id)} (decision)`
      : x.approved === true
        ? `${String(x.id)} (approved plan)`
        : x.approved === false
          ? `${String(x.id)} (plan not approved as written)`
          : `${String(x.id)} (plan)`,
  );
  if (!plans.length)
    add(
      'plan',
      outside.length
        ? `${decisions.length ? 'No plan' : 'No plan or decision'} in this PR's own turns; the session recorded ${refs(outside, 4).join(', ')} outside them: see background.`
        : decisions.length
          ? 'No plan was recorded.'
          : 'No plan or decision was recorded.',
      elsewhere.slice(0, 4).map((x) => String(x.id)),
    );
  else
    add(
      'plan',
      `${plans.length === 1 ? 'Plan' : 'Plans, in order'}: ${plans
        .map(
          (p) =>
            `${String(p.id)} "${clipText(p.title, 80)}" ${
              p.approved === true
                ? 'approved'
                : p.approved === false
                  ? 'not approved as written'
                  : '(approval not recorded)'
            }`,
        )
        .join(' → ')}.`,
      plans.map((p) => String(p.id)),
    );
  if (decisions.length)
    add(
      'decision',
      `${decisions.length} question(s) answered by the user: ${decisions
        .map(
          (d) =>
            `${String(d.id)} (turn ${String(d.turn)})${d.truncated ? ', record cut off' : ''}`,
        )
        .join(', ')}.`,
      decisions.map((d) => String(d.id)),
    );

  // Each check kind over this PR's turns: runs, failures, the last result, and
  // whether a pass came after the last commit.
  const runSession = new Map(
    g
      .run('MATCH (r:Run)-[:IN_SESSION]->(s:Session) RETURN r.id AS id, s.id AS session')
      .rows.map((r) => [String(r.id), String(r.session)]),
  );
  const scoped = checkRuns.filter((r) => {
    const from = turns.start.get(runSession.get(String(r.id)) ?? '');
    return !from || String(r.t ?? '') >= from;
  });
  const lastCommit = g
    .run('MATCH (k:Commit) WHERE k.t IS NOT NULL RETURN k.id AS id, k.t AS t')
    .rows.sort((a, b) => String(b.t).localeCompare(String(a.t)))[0];
  const quiet: { text: string; cites: string[] }[] = [];
  for (const kind of CHECK_KINDS) {
    const rs = scoped.filter((r) => r.kind === kind);
    if (!rs.length) continue;
    const ids = (xs: Record<string, unknown>[]) =>
      refs(
        xs.map((r) => String(r.id)),
        4,
      );
    const failed = rs.filter((r) => r.outcome === 'failed');
    const unknown = rs.filter((r) => r.outcome !== 'passed' && r.outcome !== 'failed');
    const last = rs.at(-1)!;
    const after = lastCommit
      ? rs.filter(
          (r) => r.outcome === 'passed' && String(r.t ?? '') > String(lastCommit.t),
        )
      : [];
    // Runs that ended differently, in order: "failed twice, then passed".
    const history = HISTORY_KINDS.includes(kind) ? runHistory(rs) : undefined;
    if (history) {
      add(
        kind,
        [
          history.text,
          ...(lastCommit && !noPassLimit && (after.length > 0 || !receiptPass)
            ? [
                after.length
                  ? `a passing run came after the last commit (${ids(after).join(', ')})`
                  : 'no passing run recorded after the last commit',
              ]
            : []),
        ].join('; ') + '.',
        uniq([...history.cites, ...after.slice(0, 2).map((r) => String(r.id))]),
      );
      continue;
    }
    // A kind that never failed: one clause in a shared row.
    if (!failed.length) {
      quiet.push({
        text: `${kind} (${rs.length} run(s), last ${String(last.id)} ${last.outcome === 'passed' ? 'passed' : last.outcome === 'failed' ? 'failed' : 'no result captured'}${
          lastCommit && !noPassLimit && (after.length > 0 || !receiptPass)
            ? after.length
              ? `, passed after the last commit (${ids(after).join(', ')})`
              : ', no pass after the last commit'
            : ''
        })`,
        cites: uniq([last, ...after.slice(0, 1)].map((r) => String(r.id))),
      });
      continue;
    }
    add(
      kind,
      [
        `${rs.length} ${kind} run(s)`,
        failed.length
          ? `${failed.length} failed (${ids(failed).join(', ')})`
          : 'none failed',
        ...(unknown.length ? [`${unknown.length} with no captured result`] : []),
        `last ${String(last.id)} ${String(last.outcome === 'unknown' ? 'result not captured' : last.outcome)}`,
        ...(lastCommit && !noPassLimit && (after.length > 0 || !receiptPass)
          ? [
              after.length
                ? `a passing run came after the last commit (${ids(after).join(', ')})`
                : 'no passing run recorded after the last commit',
            ]
          : []),
      ].join('; ') + '.',
      uniq([...failed.slice(0, 4), last, ...after.slice(0, 2)].map((r) => String(r.id))),
    );
  }

  if (quiet.length)
    add(
      'checks',
      `No failures: ${quiet.map((q) => q.text).join('; ')}.`,
      quiet.flatMap((q) => q.cites),
    );
  for (const s of sessions)
    if (s.band === 'included' && Number(s.failed) > 0)
      add(
        'commands',
        `${Number(s.failed)} failed non-check command(s) recorded in the ${String(s.agent)} session${s.failedCommand ? `, e.g. \`${String(s.failedCommand)}\`` : ''}.`,
        [String(s.id)],
      );
  return out;
}

/**
 * Everything a description needs, in the order it is written: the change units
 * (with the symbols that own them), why each was made, what checked it and when,
 * how the work went (recorded process facts) and what the evidence does not
 * establish. Each row cites
 * its evidence; nothing in it is inferred beyond the graph.
 */
export function brief(g: GraphEngine, opts: { freshPass?: boolean } = {}): Section[] {
  return briefParts(g, opts).sections;
}

/**
 * The brief plus what `render` needs to write the Validation section itself:
 * behavior or test files with no recorded passing check after their last
 * captured edit.
 */
export function briefParts(
  g: GraphEngine,
  opts: {
    layout?: BriefLayout;
    /**
     * A `tracetoon check` receipt in the run folder passed on the content as
     * it is now (checks.ts `passOnSubmittedContent`), read when the brief is
     * read: the graph may predate the check.
     */
    freshPass?: boolean;
  } = {},
): {
  sections: Section[];
  unchecked: string[];
  branchy: string[];
  /** Commit-message row ref → the hunks it describes (`→ H#`), whatever the layout. */
  hunkLinks: Record<string, string[]>;
  /** Changed source functions and what the graph ties to each (render's review-pointer check). */
  owners: FnProfile[];
  /** A check passed on the submitted content (a V receipt here, or one in the run folder). */
  freshPass: boolean;
} {
  const changes = g
    .run(
      `MATCH (c:Change)
       RETURN c.id AS id, c.key AS key, c.files AS files, c.roles AS roles, c.symbols AS symbols,
              c.added AS added, c.removed AS removed, c.branches AS branches`,
    )
    .rows.sort((a, b) => Number(String(a.id).slice(2)) - Number(String(b.id).slice(2)));
  const hunkRows = g.run(
    `MATCH (c:Change)-[:HAS]->(h:Hunk)
     OPTIONAL MATCH (h)<-[:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (h)<-[:INTRODUCED]-(k:Commit)
     RETURN c.id AS change, h.id AS hunk, h.file AS file, h.diff AS diff, h.scope AS scope,
            h.touched AS symbols, h.branches AS branches, h.fresh AS fresh, h.pairs AS pairs,
            h.conds AS conds,
            h.tests AS tests, h.words AS words, count(DISTINCT e) AS edits,
            collect(DISTINCT k.id) AS commits`,
  ).rows;
  const fileRole = new Map(
    g
      .run('MATCH (f:File {inPr: true}) RETURN f.id AS id, f.role AS role')
      .rows.map((r) => [String(r.id), String(r.role)]),
  );
  const asked = g.run(
    `MATCH (c:Change)-[a:ASKED_BY]->(p:Prompt)
     OPTIONAL MATCH (x)-[:IN_TURN]->(p) WHERE x:Decision OR x:Plan
     RETURN c.id AS change, p.id AS id, p.text AS text, p.pushback AS pushback, a.how AS how,
            collect(DISTINCT x.id) AS facts`,
  ).rows;
  // Plans and decisions with the turn they were made in.
  const turnFacts = new Map(
    g
      .run(
        `MATCH (x) WHERE x:Decision OR x:Plan
         OPTIONAL MATCH (x)-[:IN_TURN]->(p:Prompt)
         RETURN x.id AS id, labels(x)[0] AS label, x.approved AS approved, x.t AS t,
                coalesce(x.answers, x.excerpt, x.text) AS text, x.text AS title,
                x.truncated AS truncated, p.id AS turn`,
      )
      .rows.map((r) => [String(r.id), r]),
  );
  const turns = thisPrTurns(g);
  const said = g.run(
    `MATCH (c:Change)-[:EXPLAINED_BY]->(k:Commit)
     OPTIONAL MATCH (k)-[:SAYS]->(m:CommitClaim)
     RETURN c.id AS change, k.id AS commit, k.subject AS subject,
            collect(DISTINCT {id: m.id, text: m.text, result: m.assertsResult}) AS claims`,
  ).rows;

  const changeRows = changes.map((c) => {
    const hs = hunkRows
      .filter((h) => h.change === c.id)
      .sort((a, b) => byDiff(String(a.diff), String(b.diff)));
    const files = (c.files as string[]) ?? [];
    const where = files.map((f) => {
      const syms = uniq(
        hs.filter((h) => h.file === f).flatMap((h) => (h.symbols as string[]) ?? []),
      ).slice(0, 6);
      return syms.length ? `${f} (${syms.join(', ')})` : f;
    });
    // New code, not test helpers: a fixture's `reply` or `calls` is noise to a reviewer.
    const fresh = uniq(
      hs
        .filter((h) => fileRole.get(String(h.file)) !== 'tests')
        .flatMap((h) => (h.fresh as string[]) ?? []),
    ).slice(0, 8);
    // Each pair with its file, to quote as a code change, not to retell.
    const was = uniq(
      hs.flatMap((h) =>
        ((h.pairs as string[]) ?? []).map((p) => `${String(h.file)}: ${p}`),
      ),
    ).slice(0, 4);
    const behavior = behaviorOf(
      hs.filter(
        (h) =>
          !['tests', 'docs', 'generated'].includes(fileRole.get(String(h.file)) ?? ''),
      ),
    );
    return {
      change: c.id,
      groupedBy: String(c.key).split(':')[0],
      where,
      newSymbols: fresh,
      was,
      behavior,
      added: c.added,
      removed: c.removed,
      diff: refs(
        hs.map((h) => String(h.diff)),
        10,
      ),
      commits: uniq(hs.flatMap((h) => (h.commits as string[]) ?? [])).sort(),
      requests: uniq(
        asked.filter((a) => a.change === c.id).map((a) => String(a.id)),
      ).sort(factOrder),
    };
  });

  // Each request once; changes cite them by ref. Only this PR's turns: a
  // shared session also holds earlier PRs' requests, plans and decisions,
  // which no writer cites.
  const requests: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const factRow = (f: string, kind: string) => {
    const x = turnFacts.get(f);
    if (!x || seen.has(f)) return;
    seen.add(f);
    const plan = x.label === 'Plan';
    requests.push({
      ref: f,
      kind: plan
        ? `${planStatus(x.approved)}${kind}`
        : `decision (question asked and the answer)${kind}`,
      text: clipText(x.text, plan ? 400 : 700),
      truncated: x.truncated === true || null,
    });
  };
  for (const a of [...asked].sort((x, y) => factOrder(String(x.id), String(y.id)))) {
    if (seen.has(String(a.id))) continue;
    seen.add(String(a.id));
    requests.push({
      ref: a.id,
      kind: a.pushback
        ? 'user pushback typed in the turn that made these edits (not necessarily why they were made)'
        : 'user request',
      text: clipText(a.text, 600),
    });
    if (turns.productive.has(String(a.id)))
      for (const f of ((a.facts as string[]) ?? []).sort(factOrder))
        factRow(f, ` in the turn of ${String(a.id)}`);
  }
  // The session's opening request is the goal when its own turn produced
  // surviving edits or commits in this PR; otherwise it is earlier work.
  const opening = turns.opening;
  if (opening && turns.productive.has(opening.id)) {
    if (!seen.has(opening.id)) {
      seen.add(opening.id);
      requests.unshift({
        ref: opening.id,
        kind: 'goal: the first request of the session',
        text: clipText(opening.text, 600),
      });
    } else
      for (const r of requests)
        if (r.ref === opening.id)
          r.kind = `goal: the first request of the session; ${String(r.kind)}`;
  }
  // Plans and decisions made in turns that produced this PR's edits or commits.
  for (const [id, x] of [...turnFacts].sort((a, b) =>
    String(a[1].t ?? '').localeCompare(String(b[1].t ?? '')),
  ))
    if (x.turn && turns.productive.has(String(x.turn)))
      factRow(id, ` in the turn of ${String(x.turn)}`);

  // Which hunks each commit sentence describes: the commit's own hunks whose
  // changed lines share the sentence's rarer words. A commit listing several
  // changes doesn't say which file does what; this does, from the diff.
  const commitHunks = new Map<string, Record<string, unknown>[]>();
  for (const r of g.run(
    `MATCH (k:Commit)-[:INTRODUCED]->(h:Hunk)
     RETURN k.id AS commit, h.id AS id, h.file AS file, h.touched AS symbols, h.words AS words`,
  ).rows)
    commitHunks.set(String(r.commit), [...(commitHunks.get(String(r.commit)) ?? []), r]);
  const implementedBy = (commit: string, text: unknown): string[] =>
    describedHunks(commitHunks.get(commit) ?? [], String(text ?? ''));
  // The same at hunk level: the neighborhood brief's and the review packet's `→ H#`.
  const hunkLinks: Record<string, string[]> = {};
  const link = (ref: string, commit: string, text: unknown) => {
    const hs = linkedHunks(commitHunks.get(commit) ?? [], String(text ?? '')).sort(byNum);
    if (hs.length) hunkLinks[ref] = hs;
  };

  // One row for each commit's subject (ref: its short sha) and one for each
  // sentence of its message (ref: <sha>#n).
  const commitText: Record<string, unknown>[] = [];
  const commitsSeen = new Set<string>();
  for (const k of [...said].sort((x, y) =>
    String(x.commit).localeCompare(String(y.commit)),
  )) {
    if (commitsSeen.has(String(k.commit))) continue;
    commitsSeen.add(String(k.commit));
    commitText.push({
      ref: String(k.commit),
      text: k.subject,
      implementedBy: implementedBy(String(k.commit), k.subject),
    });
    link(String(k.commit), String(k.commit), k.subject);
    for (const m of ((k.claims as { id: string; text: string; result: boolean }[]) ?? [])
      .filter((m) => m.id && !m.result)
      .sort((x, y) => Number(x.id.split('#')[1]) - Number(y.id.split('#')[1]))) {
      commitText.push({
        ref: m.id,
        text: m.text,
        implementedBy: implementedBy(String(k.commit), m.text),
      });
      link(m.id, String(k.commit), m.text);
    }
  }
  // Search links (TIED_TO) fill what the structural links leave empty.
  fillSearchLinks(g, commitText, hunkLinks);
  const hunkSection = isNeighborhood(opts.layout)
    ? hunkRowsFor(g, changeRows, hunkRows, hunkLinks, seen, fileRole)
    : [];
  for (const r of changeRows) {
    const links = asked.filter((a) => a.change === r.change);
    (r as Record<string, unknown>).requests = links
      .sort((x, y) => factOrder(String(x.id), String(y.id)))
      .map((a) =>
        a.how === 'its edits survive here'
          ? String(a.id)
          : `${String(a.id)} (${String(a.how)})`,
      );
  }

  const receipts = g
    .run(
      'MATCH (v:Receipt) RETURN v.id AS id, v.kind AS kind, v.outcome AS outcome, v.summary AS summary, v.when AS when, v.cmd AS cmd',
    )
    .rows.sort((a, b) => factOrder(String(a.id), String(b.id)));
  const runs = g
    .run(
      `MATCH (r:Run)-[:IN_SESSION]->(:Session {band: 'included'})
       WHERE r.kind IN $kinds
       OPTIONAL MATCH (r)-[:LATER_EDIT]->(f:File)
       RETURN r.id AS id, r.kind AS kind, r.outcome AS outcome, r.summary AS summary,
              r.when AS when, r.cmd AS cmd, r.t AS t, r.revision AS revision,
              collect(DISTINCT f.id) AS later`,
      { kinds: CHECK_KINDS },
    )
    .rows.filter((r) => r.revision !== 'after later work')
    .sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
  // This PR's runs: in a shared session, runs before this PR's first turn
  // checked other work (a pass there "is not a run for this branch").
  const runSession = new Map(
    g
      .run('MATCH (r:Run)-[:IN_SESSION]->(s:Session) RETURN r.id AS id, s.id AS session')
      .rows.map((r) => [String(r.id), String(r.session)]),
  );
  const scopedRuns = runs.filter((r) => {
    const from = turns.start.get(runSession.get(String(r.id)) ?? '');
    return !from || String(r.t ?? '') >= from;
  });
  // The last run of each command is what the session ended on; earlier ones are history.
  const lastOf = new Map(lastRunOfEach(scopedRuns).map((r) => [shownCommand(r.cmd), r]));
  const current = (r: Record<string, unknown>) =>
    r.revision === 'no later edits seen' && !((r.later as string[]) ?? []).length;
  // One run per kind, only one whose result can be checked exactly (see
  // runHistory.ts). A kind Tracetoon checked itself on the submitted content
  // (a V receipt) needs no log run.
  const receiptKinds = new Set(receipts.map((v) => String(v.kind)));
  // Edits after a run that only touched files no check reads as code (a
  // version bump, docs, config) leave it on the final code for choosing; the
  // row still names those files.
  const MINOR_ROLES = new Set(['version', 'docs', 'generated', 'config']);
  const minorLater = (r: Record<string, unknown>) => {
    const later = (r.later as string[]) ?? [];
    return later.length > 0 && later.every((f) => MINOR_ROLES.has(pathRole(f)));
  };
  const chosen = selectValidationRuns(scopedRuns, {
    skip: receiptKinds,
    current,
    minorLater,
  });
  // An earlier failure of the kind before the chosen pass, said in one clause
  // (the process row has the whole history).
  const earlierOf = (r: Record<string, unknown>): string | null => {
    const f = earlierFailure(scopedRuns, r);
    if (!f) return null;
    const cmd = shownCommand(f.cmd);
    if (!cmd || /‹withheld›|<withheld>/.test(cmd)) return null;
    const summary = ((f.summary as string[]) ?? []).filter(Boolean).join(', ');
    return `\`${cmd}\` failed${summary ? ` (${summary})` : ''}`;
  };
  const validation: Record<string, unknown>[] = (
    [
      ...receipts.map((v) => ({ ...v, editedAfter: [] as string[] })),
      ...[...chosen]
        .sort((a, b) => factOrder(String(a.id), String(b.id)))
        .map((r) => ({
          ...r,
          editedAfter: refs(((r.later as string[]) ?? []).sort(), 5),
        })),
    ] as Record<string, unknown>[]
  ).map((r) => ({
    check: r.id,
    kind: r.kind,
    outcome: r.outcome,
    result: ((r.summary as string[]) ?? []).join('; ') || null,
    when: (r.editedAfter as string[]).length
      ? 'before later edits to the files in editedAfter'
      : r.when,
    editedAfter: r.editedAfter,
    cmd: r.cmd,
    earlier: /^V\d/.test(String(r.id ?? '')) ? null : earlierOf(r),
  }));

  for (const m of g
    .run(
      'MATCH (m:CommitClaim {assertsResult: true}) RETURN m.id AS id, m.commit AS commit, m.text AS text',
    )
    .rows.sort((a, b) => String(a.id).localeCompare(String(b.id))))
    validation.push({
      check: m.id,
      kind: 'commit message',
      outcome: 'asserted',
      result: null,
      when: `not a run: commit ${String(m.commit)} says so`,
      editedAfter: [],
      cmd: m.text,
      earlier: null,
    });

  const checks = new Map(checksAfterLastEdit(g).map((c) => [c.file, c]));
  // A file no captured edit explains still has a last-change time: its commits'.
  const committed = new Map<string, string>();
  for (const r of g.run(
    `MATCH (k:Commit)-[:TOUCHES]->(f:File) WHERE k.t IS NOT NULL RETURN f.id AS file, max(k.t) AS t`,
  ).rows)
    committed.set(String(r.file), String(r.t));
  const passedAfter = (t: string) =>
    runs
      .filter((r) => r.outcome === 'passed' && String(r.t ?? '') > t)
      .map((r) => String(r.id));
  const freshPass = receipts
    .filter((v) => v.outcome === 'passed')
    .map((v) => String(v.id));
  const limits: Record<string, unknown>[] = [];
  const uncheckedAll: string[] = [];
  const branchy: string[] = [];
  for (const c of changes) {
    const hs = hunkRows.filter((h) => h.change === c.id);
    const behavior = ((c.files as string[]) ?? []).filter((f) =>
      ['behavior', 'tests'].includes(fileRole.get(f) ?? ''),
    );
    const unchecked = behavior.filter((f) => {
      const k = checks.get(f);
      if (k?.lastEdit) return !k.after.some((x) => x.outcome === 'passed');
      const t = committed.get(f);
      return !t || !passedAfter(t).length;
    });
    uncheckedAll.push(...unchecked);
    if (unchecked.length)
      limits.push({
        change: c.id,
        kind: 'open',
        limit: freshPass.length
          ? `No logged passing check after the last captured edit of ${unchecked.join(', ')}; fresh ${freshPass.join(', ')} passed on the submitted code, which shows the suite passes, not that it exercises this change.`
          : `No recorded passing test, build, lint or typecheck run after the last captured edit of ${unchecked.join(', ')}.`,
      });
    // Symbols with conditional paths, for render's check of "always", "only"…
    if (Number(c.branches) > 0)
      branchy.push(
        ...hs
          .filter((h) => Number(h.branches) > 0)
          .map((h) => String(((h.symbols as string[]) ?? [])[0] ?? h.file)),
      );
  }
  // Changes no captured request covers: one open point for all of them.
  const unasked = changes
    .filter((c) => !asked.some((a) => a.change === c.id))
    .map((c) => String(c.id));
  if (unasked.length)
    limits.push({
      change: unasked,
      kind: 'open',
      limit: `No user request was recorded for ${unasked.length === changes.length ? (unasked.length === 1 ? 'this change' : 'any of these changes') : unasked.join(', ')}.`,
    });

  // Open points a reviewer should hear about, each worth a sentence in the PR.
  for (const m of g
    .run(
      'MATCH (m:CommitClaim {assertsResult: true}) RETURN m.id AS id, m.commit AS commit, m.text AS text',
    )
    .rows.sort((a, b) => String(a.id).localeCompare(String(b.id))))
    limits.push({
      change: null,
      kind: 'open',
      limit: `"${clipText(m.text, 140)}" comes only from commit ${String(m.commit)}'s message: attribute it to that message, and don't say what any run did or didn't show.`,
    });
  // The last run of a command with no captured result is open when it is what
  // the session ended on (no later edits) or the last run of its kind. An
  // earlier result of the same command doesn't close it: the code changed since.
  const lastOfKind = new Map(scopedRuns.map((r) => [String(r.kind), r]));
  for (const v of [...lastOf.values()].filter(
    (r) =>
      !receiptKinds.has(String(r.kind)) &&
      (current(r) || lastOfKind.get(String(r.kind)) === r),
  ))
    if (
      v.outcome === 'unknown' &&
      ['test', 'typecheck', 'lint'].includes(String(v.kind))
    ) {
      const earlier = scopedRuns.some(
        (r) => r !== v && shownCommand(r.cmd) === shownCommand(v.cmd),
      );
      limits.push({
        change: null,
        kind: 'open',
        limit: earlier
          ? `The last run of \`${shownCommand(v.cmd)}\` (${String(v.id)}) has no result in the logs Tracetoon read; an earlier run's result doesn't cover the code it ran on.`
          : `\`${shownCommand(v.cmd)}\` ran, but no result for it was captured in the logs Tracetoon read.`,
      });
    }
  // (No "earlier failures weren't recorded" point: Tracetoon keeps only result
  // lines, so it can't tell whether a failure's output was recorded, and the
  // claim was judged false where it was (dev16).)
  // Open points the other rows only imply: no pass after the last commit, a
  // failed publishing command, remote-call branches no run shows live.
  // A check that passed on the submitted content (a receipt) answers it: the
  // writer's Validation section lists that pass, and the row read as a
  // contradiction next to it (r21, 5 judgments).
  const receiptPass = freshPass.length > 0 || !!opts.freshPass;
  const noPass = receiptPass ? undefined : noPassAfterCommitRow(g, scopedRuns);
  limits.splice(
    0,
    limits.length,
    ...capLimits(
      limits,
      [...(noPass ? [noPass] : []), ...failedPublishRows(g)],
      remotePathRows(hunkRows, fileRole, scopedRuns, liveEvidence(g)),
    ),
  );
  limits.forEach((l, i) => (l.ref = `L${i + 1}`));

  // What the added tests check, by their titles.
  const tests: Record<string, unknown>[] = [];
  const testsByFile = new Map<string, string[]>();
  for (const h of [...hunkRows].sort((a, b) => byDiff(String(a.diff), String(b.diff))))
    for (const t of (h.tests as string[]) ?? [])
      testsByFile.set(
        String(h.file),
        uniq([...(testsByFile.get(String(h.file)) ?? []), t]),
      );
  for (const [file, titles] of testsByFile)
    // Titles in full: a "+N more" marker was read as a count of tests (smoke15).
    tests.push({ ref: `T${tests.length + 1}`, file, titles: titles.slice(0, 8) });

  // Version bumps and generated files: one sentence covers them.
  const housekeeping: Record<string, unknown>[] = [];
  const versionFiles = uniq(
    hunkRows
      .filter(
        (h) =>
          fileRole.get(String(h.file)) === 'version' ||
          ((h.pairs as string[]) ?? []).some((x) => VERSION_PAIR.test(x)),
      )
      .map((h) => String(h.file)),
  ).sort();
  const bump = uniq(
    hunkRows.flatMap((h) =>
      ((h.pairs as string[]) ?? []).filter((x) => VERSION_PAIR.test(x)),
    ),
  ).sort((a, b) => a.length - b.length); // the shortest reads best: `1.0.0-rc.5 → 1.0.0-rc.6`
  if (versionFiles.length)
    housekeeping.push({
      ref: 'HK1',
      what: bump.length ? `version ${bump[0]}` : 'version files changed',
      files: refs(versionFiles, 6),
    });
  const generated = [...fileRole]
    .filter(([, r]) => r === 'generated')
    .map(([f]) => f)
    .sort();
  if (generated.length)
    housekeeping.push({
      ref: `HK${housekeeping.length + 1}`,
      what: 'generated files changed (not hand-edited)',
      files: refs(generated, 6),
    });

  const background = backgroundRows(
    g,
    turns,
    new Set(requests.map((r) => String(r.ref))),
  );
  const process = processRows(
    g,
    turns,
    scopedRuns,
    new Set(background.map((r) => String(r.ref))),
    !!noPass,
    receiptPass,
  );
  // Where to start reading: the changed function that owns the behavior.
  const links = {
    sentences: commitText.map((r) => ({
      ref: String(r.ref),
      text: String(r.text ?? ''),
    })),
    links: hunkLinks,
  };
  const entry = entryRow(g, links);
  if (entry) process.push({ ref: `PR${process.length + 1}`, ...entry });
  // Where each behavior lives: commit sentences → the function that does it.
  const owners = ownerRows(g, links);

  // Open points first: writers often read only the head of the output.
  const sections: Section[] = [
    section('limits', ['ref', 'change', 'kind', 'limit'], limits),
    section(
      'changes',
      [
        'change',
        'groupedBy',
        'where',
        'newSymbols',
        'was',
        'behavior',
        'added',
        'removed',
        'diff',
        'commits',
        'requests',
      ],
      changeRows,
    ),
    // Only when it has rows: most PRs have no unit where owners get mixed up.
    ...(owners.length
      ? [section('owners', ['change', 'behavior', 'function', 'file', 'cites'], owners)]
      : []),
    section('process', ['ref', 'kind', 'fact', 'cites'], process),
    section('requests', ['ref', 'kind', 'text', 'truncated'], requests),
    section('background', ['ref', 'kind', 'text'], background),
    section('commitMessages', ['ref', 'text', 'implementedBy'], commitText),
    ...(isNeighborhood(opts.layout)
      ? [
          section(
            'hunks',
            [
              'ref',
              'change',
              'file',
              'lines',
              'scope',
              'code',
              'why',
              'sentences',
              'weight',
              'role',
            ],
            hunkSection,
          ),
        ]
      : []),
    section('tests', ['ref', 'file', 'titles'], tests),
    section('housekeeping', ['ref', 'what', 'files'], housekeeping),
    section(
      'validation',
      ['check', 'kind', 'outcome', 'result', 'when', 'editedAfter', 'cmd', 'earlier'],
      validation,
    ),
  ];
  // The head tree: stale mentions of removed names, and callers of changed ones.
  const hunkChange = new Map(hunkRows.map((h) => [String(h.hunk), String(h.change)]));
  const scan = headScanRows(g, hunkChange);
  // The entry row is the place to start; the head scan's top row is a count.
  if (entry)
    for (const r of scan)
      if (String(r.kind).startsWith('most referenced')) r.kind = 'most referenced';
  sections.push(section('headScan', ['ref', 'kind', 'text', 'change'], scan));
  // What not to say, from the rows above, right after the open points.
  sections.splice(
    1,
    0,
    section('doNotSay', DO_NOT_SAY_COLUMNS, doNotSayRows(sections, uniq(branchy).sort())),
  );
  // Key code lines under commit sentences, and commit-vs-code doNotSay rows.
  addSearchEvidence(g, sections, hunkLinks, { codeCells: !isNeighborhood(opts.layout) });
  return {
    sections,
    unchecked: uniq(uncheckedAll).sort(),
    branchy: uniq(branchy).sort(),
    hunkLinks,
    owners: [...functionProfiles(g, links).values()],
    freshPass: receiptPass,
  };
}

/** At most this many head-scan rows of each kind (stale mentions, references). */
const MAX_HEAD_ROWS = 3;

/**
 * The brief's `headScan` rows from HeadRef nodes (headScan.ts): docs or config
 * that still mention a removed name or old value, then the changed symbols
 * most referenced elsewhere, the top one marked as a place to start.
 */
export function headScanRows(
  g: GraphEngine,
  hunkChange: Map<string, string>,
): Record<string, unknown>[] {
  const refs = g
    .run(
      `MATCH (x:HeadRef) RETURN x.id AS id, x.kind AS kind, x.term AS term, x.termKind AS termKind,
              x.hunk AS hunk, x.refs AS refs, x.count AS count, x.files AS files, x.fresh AS fresh`,
    )
    .rows.sort((a, b) => factOrder(String(a.id), String(b.id)));
  const out: Record<string, unknown>[] = [];
  const more = (n: number, shown: number) => (n > shown ? ` and ${n - shown} more` : '');
  for (const r of refs
    .filter((x) => x.kind === 'still mentions')
    .slice(0, MAX_HEAD_ROWS)) {
    const at = (r.refs as string[]) ?? [];
    out.push({
      kind: 'still mentions',
      text: `${r.termKind === 'value' ? 'old value' : 'removed name'} \`${String(r.term)}\` is still in ${at.join(', ')}${more(Number(r.count), at.length)} at the head commit`,
      change: hunkChange.get(String(r.hunk)) ?? null,
    });
  }
  const counted = refs.filter((x) => x.kind !== 'still mentions');
  const top = counted.find((x) => x.kind === 'most referenced');
  for (const r of [...(top ? [top] : []), ...counted.filter((x) => x !== top)].slice(
    0,
    MAX_HEAD_ROWS,
  )) {
    const files = (r.refs as string[]) ?? [];
    out.push({
      kind: r === top ? 'most referenced (a place to start)' : 'references',
      text: `${r.fresh ? 'new ' : ''}\`${String(r.term)}\` is named in ${Number(r.files)} other file(s): ${files.join(', ')}${more(Number(r.files), files.length)}`,
      change: null,
    });
  }
  return out.map((r, i) => ({ ref: `HS${i + 1}`, ...r }));
}

const byNum = (a: string, b: string) =>
  Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);

/**
 * Neighborhood layout only: each hunk as a citable row with its key changed
 * lines, the requests whose edits survive in it, and the commit sentences that
 * point to it (hunk level, as conservative as implementedBy).
 */
function hunkRowsFor(
  g: GraphEngine,
  changeRows: { change: unknown }[],
  hunkRows: Record<string, unknown>[],
  hunkLinks: Record<string, string[]>,
  shownRequests: Set<string>,
  fileRole: Map<string, string>,
): Record<string, unknown>[] {
  const sentences = new Map<string, string[]>();
  for (const [ref, hs] of Object.entries(hunkLinks))
    for (const h of hs) sentences.set(h, [...(sentences.get(h) ?? []), ref]);
  const survival = new Map<
    string,
    { lines: number; edits: Set<string>; prompts: Set<string> }
  >();
  for (const r of g.run(
    `MATCH (h:Hunk)<-[s:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
     RETURN h.id AS hunk, e.id AS edit, s.lines AS lines, p.id AS prompt`,
  ).rows) {
    const x = survival.get(String(r.hunk)) ?? {
      lines: 0,
      edits: new Set<string>(),
      prompts: new Set<string>(),
    };
    if (!x.edits.has(String(r.edit))) {
      x.edits.add(String(r.edit));
      x.lines += Number(r.lines ?? 0);
    }
    // Only requests the brief lists: a shared session's earlier turns aren't this PR's.
    if (r.prompt && shownRequests.has(String(r.prompt))) x.prompts.add(String(r.prompt));
    survival.set(String(r.hunk), x);
  }
  const info = new Map(
    g
      .run(
        'MATCH (h:Hunk) RETURN h.id AS id, h.start AS start, h.end AS end, h.code AS code',
      )
      .rows.map((r) => [String(r.id), r]),
  );
  const out: Record<string, unknown>[] = [];
  for (const c of changeRows)
    for (const h of hunkRows
      .filter((x) => x.change === c.change)
      .sort((a, b) => byDiff(String(a.diff), String(b.diff)))) {
      const id = String(h.hunk);
      const hi = info.get(id);
      const sv = survival.get(id);
      const start = Number(hi?.start ?? 0);
      const end = Number(hi?.end ?? start);
      out.push({
        ref: id,
        change: c.change,
        file: h.file,
        lines: end > start ? `L${start}-${end}` : `L${start}`,
        scope: uniq((h.symbols as string[]) ?? []).slice(0, 3),
        code: (hi?.code as string[]) ?? [],
        why: [...(sv?.prompts ?? [])].sort(factOrder),
        sentences: sentences.get(id) ?? [],
        weight: sv?.lines ?? 0,
        role: fileRole.get(String(h.file)) ?? null,
      });
    }
  return out;
}

export const QUERIES: NamedQuery[] = [
  {
    name: 'brief',
    args: '',
    help: 'Start here. The PR as a reviewer needs it: change units with the symbols that own them, why each was made (requests, plans, commit-message sentences scoped to their commit), checks with when they ran, how the work went (sessions, plans, check runs) and the open points the evidence leaves.',
    run: (g) => brief(g),
  },
  {
    name: 'schema',
    args: '',
    help: 'Node labels, relationships and properties, for writing your own --cypher.',
    run: () => [
      section(
        'nodes',
        ['label', 'properties'],
        Object.entries(SCHEMA_DOC.nodes).map(([label, properties]) => ({
          label,
          properties,
        })),
      ),
      section(
        'relationships',
        ['type', 'pattern'],
        Object.entries(SCHEMA_DOC.relationships).map(([type, pattern]) => ({
          type,
          pattern,
        })),
      ),
      section(
        'notes',
        ['note'],
        SCHEMA_DOC.notes.map((note) => ({ note })),
      ),
    ],
  },
  {
    name: 'outline',
    args: '',
    help: 'Every changed file: role, size, hunks, the prompts whose edits survive in it, the commits that touched it, and checks run after its last edit; then every commit, marking those with a message body to expand.',
    run: (g) => {
      const rows = g.run(
        `MATCH (f:File {inPr: true})
         OPTIONAL MATCH (h:Hunk)-[:OF]->(f)
         WITH f, count(h) AS hunks
         OPTIONAL MATCH (f)<-[:EDITS]-(e:Edit)-[:IN_TURN]->(p:Prompt)
           WHERE e.surviving > 0 AND EXISTS { MATCH (e)-[:IN_SESSION]->(:Session {band: 'included'}) }
         WITH f, hunks, collect(DISTINCT p.id) AS prompts
         OPTIONAL MATCH (c:Commit)-[:TOUCHES]->(f)
         RETURN f.id AS file, f.role AS role, f.added AS added, f.removed AS removed, f.unmatched AS unmatched,
                hunks, prompts, collect(DISTINCT c.id) AS commits`,
      ).rows;
      const checks = new Map(checksAfterLastEdit(g).map((c) => [c.file, c]));

      const rank = (role: unknown) => ({ behavior: 0, tests: 1 })[String(role)] ?? 2;
      return [
        section(
          'files',
          [
            'file',
            'role',
            'added',
            'removed',
            'hunks',
            'unmatched',
            'prompts',
            'commits',
            'checksAfterLastEdit',
          ],
          rows
            .sort(
              (a, b) =>
                rank(a.role) - rank(b.role) ||
                Number(b.added) - Number(a.added) ||
                String(a.file).localeCompare(String(b.file)),
            )
            .map((r) => {
              const c = checks.get(String(r.file));
              return {
                ...r,
                prompts: ((r.prompts as string[]) ?? []).sort(factOrder),
                commits: ((r.commits as string[]) ?? []).sort(),
                checksAfterLastEdit: !c?.lastEdit
                  ? 'no captured edit'
                  : c.after.length
                    ? c.after.slice(0, 3).map((x) => `${x.id}:${x.outcome}`)
                    : 'none',
              };
            }),
        ),
        section(
          'commits',
          ['commit', 'subject', 'hasBody'],
          g
            .run(
              'MATCH (c:Commit) RETURN c.id AS commit, c.subject AS subject, c.body AS body',
            )
            .rows.sort((a, b) => String(a.commit).localeCompare(String(b.commit)))
            .map((r) => ({
              ...r,
              hasBody: r.body ? `yes; tracetoon expand commit:${String(r.commit)}` : null,
            })),
        ),
      ];
    },
  },
  {
    name: 'why',
    args: '<path|path:line|H#|diff:N>',
    help: 'Where a file or hunk came from: the prompts whose edits survive in it (with diff refs and the decisions/plans of that turn), every hunk with whether a captured edit explains it, and the commits that touched it with their message bodies.',
    run: (g, [raw]) => {
      const t = target(g, raw);
      const file =
        t.file ??
        String(
          g.run('MATCH (h:Hunk {id: $id}) RETURN h.file AS f', { id: t.hunk }).rows[0]?.f,
        );
      const out = [turnsInto(g, t)];
      // Every hunk of the target, not only those a captured edit explains: an
      // unexplained hunk still has to be read in the patch.
      out.push(
        section(
          'hunks',
          ['hunk', 'diff', 'added', 'removed', 'prompts', 'explained'],
          g
            .run(
              `MATCH (h:Hunk)-[:OF]->(:File {id: $file})
               ${t.hunk ? 'WHERE h.id = $hunk' : ''}
               OPTIONAL MATCH (h)<-[:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
               OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
               RETURN h.id AS hunk, h.diff AS diff, h.added AS added, h.removed AS removed,
                      collect(DISTINCT p.id) AS prompts, count(e) AS edits`,
              { file, hunk: t.hunk ?? null },
            )
            .rows.map((r): Record<string, unknown> => ({
              ...r,
              prompts: ((r.prompts as string[]) ?? []).sort(factOrder),
              explained:
                Number(r.edits) > 0
                  ? 'captured edit'
                  : 'no captured edit; read the patch',
            }))
            .sort((a, b) => byDiff(String(a.diff), String(b.diff))),
        ),
      );
      out.push(
        section(
          'commits',
          ['commit', 'subject', 'madeInSession', 'body'],
          g
            .run(
              `MATCH (c:Commit)-[:TOUCHES]->(:File {id: $file})
               OPTIONAL MATCH (s:Session)-[:MADE]->(c)
               RETURN c.id AS commit, c.subject AS subject, s.id AS madeInSession, c.body AS body`,
              { file },
            )
            .rows.sort((a, b) => String(a.commit).localeCompare(String(b.commit))),
        ),
      );
      const c = checksAfterLastEdit(g, file)[0];
      out.push(
        section(
          'checks',
          ['file', 'lastEdit', 'after'],
          [
            {
              file,
              lastEdit: c?.lastEdit ?? 'no captured edit',
              after: c?.after.map((x) => `${x.id}:${x.kind}:${x.outcome}`) ?? [],
            },
          ],
        ),
      );
      return out;
    },
  },
  {
    name: 'verified',
    args: '[path]',
    help: 'Per changed file: its last captured edit and the check runs after it (latest first). Log evidence only; never proof the submitted content passes.',
    run: (g, [raw]) => {
      const file = raw ? target(g, raw).file : undefined;
      return [
        section(
          'files',
          ['file', 'role', 'lastEdit', 'checksAfter'],
          checksAfterLastEdit(g, file).map((c) => ({
            file: c.file,
            role: c.role,
            lastEdit: c.lastEdit ?? 'no captured edit',
            checksAfter: c.after.map((x) => `${x.id}:${x.kind}:${x.outcome}`),
          })),
        ),
      ];
    },
  },
  {
    name: 'unverified',
    args: '',
    help: 'Behavior and test files with no passing check after their last captured edit, or with no captured edit at all.',
    run: (g) => [
      section(
        'files',
        ['file', 'role', 'lastEdit', 'why'],
        checksAfterLastEdit(g)
          .filter((c) => ['behavior', 'tests'].includes(c.role))
          .filter((c) => !c.lastEdit || !c.after.some((x) => x.outcome === 'passed'))
          .map((c) => ({
            file: c.file,
            role: c.role,
            lastEdit: c.lastEdit ?? null,
            why: !c.lastEdit
              ? 'no captured edit (shell, another tool or by hand)'
              : c.after.length
                ? `only ${c.after.map((x) => `${x.id}:${x.outcome}`).join(', ')} after the last edit`
                : 'no check ran after the last edit',
          })),
      ),
    ],
  },
  {
    name: 'unexplained',
    args: '',
    help: 'Behavior and test hunks no captured agent edit survives in, with the commits that touched their file.',
    run: (g) => [
      section(
        'hunks',
        [
          'hunk',
          'diff',
          'file',
          'added',
          'removed',
          'removalOnly',
          'commits',
          'sessionCommits',
        ],
        unexplainedHunks(g),
      ),
    ],
  },
  {
    name: 'turn',
    args: '<S#>',
    help: 'What one prompt led to: files and hunks its edits survive in, dead-end edits, and the decisions, plans and runs of that turn.',
    run: (g, [id]) => {
      if (!id || !/^S\d+$/.test(id)) throw new GraphError('Give a prompt id such as S3.');
      const p = g.run(
        'MATCH (p:Prompt {id: $id}) RETURN p.text AS text, p.pushback AS pushback, p.t AS t',
        { id },
      ).rows[0];
      if (!p) throw new GraphError(`No prompt ${id} in this run's evidence graph.`);
      const edits = g.run(
        `MATCH (e:Edit)-[:IN_TURN]->(:Prompt {id: $id})
         OPTIONAL MATCH (e)-[:SURVIVES_IN]->(h:Hunk)
         RETURN e.file AS file, e.id AS edit, e.surviving AS surviving, collect(h.diff) AS diffs`,
        { id },
      ).rows;
      const files = new Map<
        string,
        {
          file: string;
          edits: number;
          surviving: number;
          deadEnds: number;
          diff: string[];
        }
      >();
      for (const e of edits) {
        const f = files.get(String(e.file)) ?? {
          file: String(e.file),
          edits: 0,
          surviving: 0,
          deadEnds: 0,
          diff: [],
        };
        f.edits++;
        f.surviving += Number(e.surviving ?? 0);
        if (!Number(e.surviving)) f.deadEnds++;
        f.diff.push(...((e.diffs as string[]) ?? []));
        files.set(f.file, f);
      }
      const facts = g.run(
        `MATCH (x)-[:IN_TURN]->(:Prompt {id: $id}) WHERE x:Decision OR x:Plan OR x:Run
         RETURN x.id AS id, labels(x)[0] AS kind, coalesce(x.text, x.cmd) AS text, x.outcome AS outcome`,
        { id },
      ).rows;
      return [
        section(
          'prompt',
          ['id', 't', 'pushback', 'text'],
          [{ id, ...p, pushback: p.pushback || null }],
        ),
        section(
          'files',
          ['file', 'edits', 'surviving', 'deadEnds', 'diff'],
          [...files.values()]
            .sort((a, b) => a.file.localeCompare(b.file))
            .map((f) => ({ ...f, diff: uniq(f.diff).sort(byDiff) })),
        ),
        section(
          'facts',
          ['id', 'kind', 'outcome', 'text'],
          facts.sort((a, b) => factOrder(String(a.id), String(b.id))),
        ),
      ];
    },
  },
  {
    name: 'stale',
    args: '<R#>',
    help: 'The PR files a session edited after a run, so that run did not see them.',
    run: (g, [id]) => {
      if (!id || !/^R\d+$/.test(id)) throw new GraphError('Give a run id such as R2.');
      const r = g.run(
        'MATCH (r:Run {id: $id}) RETURN r.cmd AS cmd, r.outcome AS outcome, r.revision AS revision, r.t AS t',
        { id },
      ).rows[0];
      if (!r) throw new GraphError(`No run ${id} in this run's evidence graph.`);
      const files = g.run(
        'MATCH (:Run {id: $id})-[:LATER_EDIT]->(f:File) RETURN f.id AS file, f.role AS role',
        { id },
      ).rows;
      return [
        section('run', ['id', 'cmd', 'outcome', 'revision', 't'], [{ id, ...r }]),
        section(
          'editedAfter',
          ['file', 'role'],
          files.sort((a, b) => String(a.file).localeCompare(String(b.file))),
        ),
      ];
    },
  },
  {
    name: 'dead-ends',
    args: '',
    help: 'Edits none of whose lines survive in the PR, by file and prompt: abandoned approaches and rewritten code.',
    run: (g) => [
      section(
        'edits',
        ['file', 'prompt', 'edits', 'linesAdded'],
        g
          .run(
            `MATCH (e:Edit) WHERE e.surviving = 0 AND e.added > 0
             OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
             RETURN e.file AS file, p.id AS prompt, count(e) AS edits, sum(e.added) AS linesAdded`,
          )
          .rows.sort(
            (a, b) =>
              String(a.file).localeCompare(String(b.file)) ||
              factOrder(String(a.prompt ?? ''), String(b.prompt ?? '')),
          ),
      ),
    ],
  },
  {
    name: 'pushback',
    args: '',
    help: 'Prompts typed while rejecting the agent’s action, with the files edited in that turn and the next prompt.',
    run: (g) => {
      const rows = g.run(
        `MATCH (p:Prompt {pushback: true})
         OPTIONAL MATCH (e:Edit)-[:IN_TURN]->(p)
         OPTIONAL MATCH (p)-[:NEXT]->(n:Prompt)
         RETURN p.id AS prompt, p.text AS text, collect(DISTINCT e.file) AS files, n.id AS next`,
      ).rows;
      return [
        section(
          'prompts',
          ['prompt', 'files', 'next', 'text'],
          rows
            .map((r): Record<string, unknown> => ({
              ...r,
              files: ((r.files as string[]) ?? []).sort(),
            }))
            .sort((a, b) => factOrder(String(a.prompt), String(b.prompt))),
        ),
      ];
    },
  },
];

export function findQuery(name: string): NamedQuery | undefined {
  return QUERIES.find((q) => q.name === name);
}

/** A raw read query from an agent. The database is in memory and per command, but keep it read-only. */
export function rawQuery(
  g: GraphEngine,
  cypher: string,
  params: Record<string, unknown> = {},
): Section[] {
  if (
    /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV)\b/i.test(
      cypher.replace(/'[^']*'|"[^"]*"/g, "''"),
    )
  )
    throw new GraphError('Only read queries are allowed (MATCH … RETURN).');
  const r = g.run(cypher, params);
  return [section('rows', r.columns, r.rows)];
}
