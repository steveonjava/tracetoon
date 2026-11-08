/**
 * Build the evidence graph for one run from the redacted full digest, the ordered
 * session trails, the submitted patch and which files each commit touched.
 * Deterministic: the same inputs give byte-identical JSON.
 */
import { evidenceLine } from '../correlate/correlate.ts';
import { fileRole, type SessionTrail, type TraceDigest } from '../digest/build.ts';
import { clip } from '../digest/sanitize.ts';
import {
  GRAPH_SCHEMA,
  type EvidenceGraph,
  type GraphNode,
  type GraphRel,
  type NodeLabel,
  type Value,
} from './model.ts';

export interface PatchHunk {
  id: string;
  file: string;
  /** New-file line range. */
  start: number;
  end: number;
  added: number;
  removed: number;
  /** One-based changes.patch line range, as change-map evidence cites it. */
  diff: string;
  /** The function or section git printed after the @@ header. */
  context?: string;
  /** The enclosing symbol named in `context`, when one can be read from it. */
  scope?: string;
  /** Functions, classes, methods and types defined on added lines. */
  symbols: string[];
  /**
   * Symbols whose bodies the changed lines are in: the nearest definition above
   * each changed line within the hunk, else the one git names after the @@.
   */
  touched: string[];
  /** Added lines that branch or fall back (if/else, ??, ||, catch, default…). */
  branches: number;
  /** Symbols defined on added lines and on no removed line of the patch: new code. */
  fresh: string[];
  /** Changed values: a removed line and its closest added line, as `old → new` tokens. */
  pairs: string[];
  /** Test titles added in this hunk (`test('…')`, `def test_…`, `func Test…`). */
  tests: string[];
  /** Lowercased words of the changed lines (identifiers split, strings), for matching prose to code. */
  words: string[];
  /**
   * Up to 24 key changed lines, in patch order, for the neighborhood brief:
   * `- old ⇒ + new` for a removed line and its closest added line, then lines
   * that define a symbol or branch, then the rest; blank, brace-only and import
   * lines last. Each clipped to 160 characters.
   */
  code: string[];
  /** Normalized added lines, for matching edits. Never written out. */
  lines: Set<string>;
  /** Normalized removed lines, for matching commits that only delete. Never written out. */
  gone: Set<string>;
}

const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'else',
  'new',
  'await',
  'typeof',
  'do',
  'try',
  'with',
  'super',
  'this',
]);
const DEFINITIONS = [
  /\b(?:function\*?|class|interface|enum|type|def|fn|struct|trait|module|record)\s+([A-Za-z_$][\w$]*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|function\b)/,
  /^\s*(?:(?:export|public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={;]+)?\{\s*$/,
];
/** The name a line of code defines, if it defines one. */
export function definedSymbol(line: string): string | undefined {
  // Imports name types (`import { type X }`) without defining them.
  if (
    /^\s*(import\b|from\s+\S+\s+import\b|use\s|using\s|#\s*include\b|export\s*\{|export\s+\*)/.test(
      line,
    )
  )
    return undefined;
  for (const re of DEFINITIONS) {
    const m = re.exec(line);
    if (m?.[1] && !KEYWORDS.has(m[1])) return m[1];
  }
  return undefined;
}
/** Lines that add a branch or a fallback: each path deserves its own sentence. */
export const BRANCHING =
  /(\bif\s*\(|\bif\s+[^=]|\belse\b|\belif\b|\bswitch\s*\(|\bcase\s+[^:]+:|\bcatch\b|\bexcept\b|\?\?|\|\||\bdefault\s*:|\bfallback\b|\?\s*[^:?]+\s*:\s*)/;

/**
 * Split a `git diff` patch into hunks with their changes.patch line ranges. Hunk
 * bodies are read by the line counts in their @@ headers, so content lines that
 * look like headers (a removed "-- comment") are never mistaken for them.
 */
export function patchHunks(patch: string): PatchHunk[] {
  const lines = patch.split(/\r?\n/);
  const hunks: PatchHunk[] = [];
  let file: string | undefined;
  let oldFile: string | undefined;
  let cur: PatchHunk | undefined;
  let first = 0;
  let last = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  let current: string | undefined;
  // Indent of the line that defined `current`; a later line at or left of it ends its body.
  let currentIndent = -1;
  const removedDefs = new Set<string>();
  const changed = new Map<PatchHunk, { minus: string[]; plus: string[] }>();
  const touch = (h: PatchHunk) => {
    if (current && !h.touched.includes(current)) h.touched.push(current);
  };
  const close = () => {
    if (!cur) return;
    cur.diff = last > first ? `diff:${first}-${last}` : `diff:${first}`;
    cur.end = Math.max(cur.start, newLine - 1);
    hunks.push(cur);
    cur = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (cur && line.startsWith('\\')) {
      last = n; // "\ No newline at end of file"
      continue;
    }
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      const text = line.slice(1);
      const indent = /^\s*/.exec(text)![0].replace(/\t/g, '    ').length;
      const def = definedSymbol(text);
      // A line back at the definition's indent ends its body: a closing brace
      // still belongs to it, anything else (the next function, a comment) doesn't.
      let closes = false;
      if (current && text.trim() && !def && indent <= currentIndent) {
        if (/^\s*[}\])]/.test(text)) closes = true;
        else current = undefined;
      }
      if (def) {
        current = def;
        currentIndent = indent;
      }
      if (c === '+' || c === '-') {
        touch(cur);
        const ch = changed.get(cur) ?? { minus: [], plus: [] };
        (c === '+' ? ch.plus : ch.minus).push(text);
        changed.set(cur, ch);
        if (c === '-' && def) removedDefs.add(def);
      }
      if (closes) current = undefined;
      if (c === '+') {
        newLeft--;
        cur.added++;
        newLine++;
        const raw = line.slice(1);
        const e = evidenceLine(raw);
        if (e) cur.lines.add(e);
        const sym = definedSymbol(raw);
        if (sym && !cur.symbols.includes(sym)) cur.symbols.push(sym);
        if (BRANCHING.test(raw) && !/^\s*(\/\/|#|\*)/.test(raw)) cur.branches++;
      } else if (c === '-') {
        oldLeft--;
        cur.removed++;
        const e = evidenceLine(line.slice(1));
        if (e) cur.gone.add(e);
      } else {
        oldLeft--;
        newLeft--;
        newLine++;
      }
      last = n;
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h && file) {
      close();
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLine = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
      first = last = n;
      current = h[4]?.trim() ? definedSymbol(h[4]) : undefined;
      currentIndent = current ? /^\s*/.exec(h[4]!)![0].replace(/\t/g, '    ').length : -1;
      cur = {
        id: `H${hunks.length + 1}`,
        file,
        start: newLine,
        end: newLine,
        added: 0,
        removed: 0,
        diff: '',
        ...(h[4]?.trim() ? { context: clip(h[4].trim(), 160) } : {}),
        ...(h[4]?.trim() && definedSymbol(h[4]) ? { scope: definedSymbol(h[4]) } : {}),
        symbols: [],
        touched: [],
        branches: 0,
        fresh: [],
        pairs: [],
        tests: [],
        words: [],
        code: [],
        lines: new Set(),
        gone: new Set(),
      };
      continue;
    }
    close();
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('Untracked content sha256:') ||
      line.startsWith('Binary file')
    )
      file = oldFile = undefined;
    else if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      oldFile = p === '/dev/null' ? undefined : p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? oldFile : p.replace(/^b\//, '');
    }
  }
  close();
  for (const h of hunks) {
    h.fresh = h.symbols.filter((x) => !removedDefs.has(x));
    const ch = changed.get(h) ?? { minus: [], plus: [] };
    h.pairs = valuePairs(ch.minus, ch.plus);
    h.tests = uniqStrings(ch.plus.flatMap(testTitles)).slice(0, 8);
    h.words = uniqStrings([...ch.minus, ...ch.plus].flatMap(wordsOf)).slice(0, 400);
    h.code = keyCodeLines(ch.minus, ch.plus);
  }
  return hunks;
}

const KEY_LINES = 24;
const tokSet = (l: string) => new Set(l.match(CODE_TOKEN_KEY) ?? []);
const CODE_TOKEN_KEY = /[A-Za-z_$][\w$]*|\d[\d_.]*|'[^']*'|"[^"]*"|`[^`]*`/g;
const clipCode = (l: string) => {
  const t = l.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

/**
 * The few changed lines that say most about a hunk (see `PatchHunk.code`).
 * Exported for tests.
 */
export function keyCodeLines(minus: string[], plus: string[], max = KEY_LINES): string[] {
  type Cand = { order: number; text: string; rank: number };
  const cands: Cand[] = [];
  const low = (l: string) =>
    !l.trim() ||
    /^\s*[{}()[\];,]*\s*$/.test(l) ||
    /^\s*(import\b|from\s+\S+\s+import\b|#\s*include\b|use\s)/.test(l) ||
    isComment(l);
  // Pair each removed line with its most similar added line (shared tokens).
  const usedPlus = new Set<number>();
  const pairedMinus = new Set<number>();
  minus.forEach((r, i) => {
    if (low(r)) return;
    const rt = tokSet(r);
    if (!rt.size) return;
    let best = -1;
    let score = 0;
    plus.forEach((a, j) => {
      if (usedPlus.has(j) || low(a)) return;
      const at = tokSet(a);
      let shared = 0;
      for (const t of rt) if (at.has(t)) shared++;
      const s = shared / Math.max(rt.size, at.size);
      if (s > score) {
        score = s;
        best = j;
      }
    });
    if (best >= 0 && score >= 0.5 && minus[i]!.trim() !== plus[best]!.trim()) {
      usedPlus.add(best);
      pairedMinus.add(i);
      cands.push({
        order: best,
        text: `- ${clipCode(r)}  ⇒  + ${clipCode(plus[best]!)}`,
        rank: 0,
      });
    }
  });
  const rankOf = (l: string) =>
    low(l) ? 3 : definedSymbol(l) || (BRANCHING.test(l) && !isComment(l)) ? 1 : 2;
  plus.forEach((a, j) => {
    if (!usedPlus.has(j))
      cands.push({ order: j, text: `+ ${clipCode(a)}`, rank: rankOf(a) });
  });
  // Removed lines without a partner sort after the added lines near them.
  minus.forEach((r, i) => {
    if (!pairedMinus.has(i))
      cands.push({
        order: (i / Math.max(1, minus.length)) * plus.length + 0.5,
        text: `- ${clipCode(r)}`,
        rank: rankOf(r),
      });
  });
  const chosen = cands
    .filter((c) => c.text.length > 2)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, max)
    .filter((c) => c.rank < 3 || cands.filter((x) => x.rank < 3).length === 0);
  return chosen.sort((a, b) => a.order - b.order).map((c) => c.text);
}

const uniqStrings = (xs: string[]) => [...new Set(xs)];
const CODE_TOKEN =
  /'[^']*'|"[^"]*"|`[^`]*`|\d[\d_.]*\w*|[A-Za-z_$][\w$]*(?:[.:/-][A-Za-z_$][\w$]*)*/g;
const isComment = (l: string) => /^\s*(\/\/|#(?!\[)|\*|\/\*|--\s)/.test(l);

/**
 * Old → new values: each removed line paired with its most similar added line,
 * kept when a few tokens differ and one of them is a number or string literal
 * (`last + 30 * 60_000 → last + 5 * 60_000`).
 */
export function valuePairs(minus: string[], plus: string[]): string[] {
  const toks = (l: string): string[] => l.match(CODE_TOKEN) ?? [];
  const out: string[] = [];
  const used = new Set<number>();
  for (const r of minus) {
    if (isComment(r) || r.trim().length < 4) continue;
    const rt = toks(r);
    if (!rt.length) continue;
    let best = -1;
    let score = 0;
    plus.forEach((a, i) => {
      if (used.has(i) || isComment(a)) return;
      const at = toks(a);
      const inter = rt.filter((t) => at.includes(t)).length;
      const j = inter / new Set([...rt, ...at]).size;
      if (j > score) {
        score = j;
        best = i;
      }
    });
    if (best < 0 || score < 0.4 || score >= 1) continue;
    const added = plus[best]!;
    const at = toks(added);
    const was = rt.filter((t) => !at.includes(t));
    const now = at.filter((t) => !rt.includes(t));
    // A changed value, not a rename or a rewrite: few tokens differ, and a
    // number or string literal is among them.
    const literal = (t: string) => /^(\d|['"`])/.test(t);
    if (!was.length || !now.length || was.length > 4 || now.length > 4) continue;
    if (!was.some(literal) && !now.some(literal)) continue;
    used.add(best);
    out.push(`${clip(r.trim(), 80)} → ${clip(added.trim(), 80)}`);
  }
  return uniqStrings(out).slice(0, 4);
}

/** Test titles a line adds: `test('…')`, `it("…")`, `describe(…)`, `def test_x`, `func TestX`. */
export function testTitles(line: string): string[] {
  const m =
    /\b(?:test|it|describe|context)(?:\.\w+)?\s*\(\s*(['"`])((?:(?!\1).){3,140})\1/.exec(
      line,
    ) ??
    /\bdef\s+(test_\w+)/.exec(line) ??
    /\bfunc\s+(Test\w+)/.exec(line);
  if (!m) return [];
  return [String(m[2] ?? m[1])];
}

/** Lowercased words of a code line: identifiers split at case and underscores, string contents. */
export function wordsOf(line: string): string[] {
  return (line.match(/[A-Za-z][a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 || /^\d+$/.test(w));
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .find((l) => l.trim())
    ?.replace(/^#+\s*/, '') ?? '';

export interface GraphInputs {
  full: TraceDigest;
  trails: SessionTrail[];
  patch: string;
  /** Short or full commit SHA → repo-relative paths it touched. */
  commitFiles?: Map<string, string[]>;
  /** Full commit SHA → file → normalized lines the commit added (its own patch); removed lines are prefixed with "-". */
  commitLines?: Map<string, Map<string, string[]>>;
}

/** Commit-message sentences that report a result rather than explain a change. */
const RESULT_CLAIM =
  /(\b\d+\s*\/\s*\d+\b|\b\d+\s+(?:pass|passed|passing|fail|failed|failing|tests?|checks?|cases?)\b|\b(?:tests?|checks?|suite|evals?|build|ci)\s+(?:now\s+)?(?:pass|passes|passed|green|succeed|succeeds)\b|\ball\s+(?:tests|checks)\b|\bverified\b|\bconfirmed\b)/i;

/** A commit body as separate sentences or bullets, each attributable on its own. */
export function commitSentences(body: string): string[] {
  return (
    body
      .split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)
      .flatMap((para) =>
        para
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
          .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/),
      )
      .map((x) => x.trim())
      // Trailers (Co-Authored-By: …, Signed-off-by: …) are not explanations.
      .filter(
        (x) => x.length > 3 && !/^[A-Za-z][\w-]*-[Bb]y:\s|^[A-Z][\w-]+:\s*\S+@/.test(x),
      )
  );
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const RUN_WHEN: Record<string, string> = {
  'no later edits seen':
    'after the last edit the logs captured (edits outside the logs are not ruled out)',
  'before later edits': 'before later edits (stale for the files edited after it)',
  'after later work': 'after later work (tested code that is not this PR)',
  unknown: 'unknown',
};

export function buildEvidenceGraph(input: GraphInputs): EvidenceGraph {
  const { full, trails } = input;
  const nodes = new Map<string, GraphNode>();
  const rels: GraphRel[] = [];
  const relSeen = new Set<string>();
  const node = (label: NodeLabel, id: string, props: Record<string, Value>) => {
    const key = `${label}|${id}`;
    const existing = nodes.get(key);
    if (existing) Object.assign(existing.props, props);
    else nodes.set(key, { label, id, props });
  };
  const rel = (
    type: GraphRel['type'],
    from: [NodeLabel, string],
    to: [NodeLabel, string],
    props?: Record<string, Value>,
  ) => {
    const key = `${type}|${from.join(':')}|${to.join(':')}`;
    if (relSeen.has(key)) return;
    relSeen.add(key);
    rels.push({
      type,
      from: { label: from[0], id: from[1] },
      to: { label: to[0], id: to[1] },
      ...(props ? { props } : {}),
    });
  };

  // Files in the PR, with their attribution from the digest.
  const prFiles = new Map(full.files.map((f) => [f.path, f]));
  for (const f of full.files)
    node('File', f.path, {
      role: f.role ?? fileRole(f.path),
      inPr: true,
      added: f.added,
      removed: f.removed,
      unmatched: f.unmatchedLines,
    });

  // Hunks of the submitted patch.
  const hunks = patchHunks(input.patch).filter((h) => prFiles.has(h.file));
  const hunksByFile = new Map<string, PatchHunk[]>();
  for (const h of hunks) {
    hunksByFile.set(h.file, [...(hunksByFile.get(h.file) ?? []), h]);
    node('Hunk', h.id, {
      file: h.file,
      start: h.start,
      end: h.end,
      added: h.added,
      removed: h.removed,
      diff: h.diff,
      context: h.context ?? null,
      scope: h.scope ?? null,
      symbols: h.symbols,
      touched: h.touched,
      branches: h.branches,
      fresh: h.fresh,
      pairs: h.pairs,
      tests: h.tests,
      words: h.words,
      code: h.code,
    });
    rel('OF', ['Hunk', h.id], ['File', h.file]);
  }

  // Sessions and their facts.
  const factSession = new Map<object, string>();
  for (const s of full.sessions) {
    node('Session', s.ref, {
      agent: s.agent,
      band: s.band,
      score: s.score,
      title: s.title ?? null,
    });
    for (const p of s.prompts) factSession.set(p, s.ref);
    for (const p of s.prompts)
      if (p.id)
        node('Prompt', p.id, {
          t: p.t ?? null,
          text: clip(p.text.replace(/\s+/g, ' '), 1500),
          pushback: !!p.pushback,
          ledToEdits: p.ledToEdits,
          session: s.ref,
        });
    for (const d of s.decisions)
      if (d.id)
        node('Decision', d.id, {
          t: d.t ?? null,
          text: clip(d.text.replace(/\s+/g, ' '), 600),
          session: s.ref,
        });
    for (const p of s.plans)
      if (p.id)
        node('Plan', p.id, {
          t: p.t ?? null,
          approved: p.approved ?? null,
          text: clip(firstLine(p.excerpt), 120),
          excerpt: clip(p.excerpt.replace(/\s+/g, ' '), 600),
          session: s.ref,
        });
    for (const r of s.runs)
      if (r.id)
        node('Run', r.id, {
          t: r.t ?? null,
          cmd: clip(r.cmd, 120),
          kind: r.kind,
          outcome: r.outcome,
          revision: r.revision,
          summary: r.summary.slice(0, 3),
          when: RUN_WHEN[r.revision] ?? r.revision,
          session: s.ref,
        });
    for (const label of ['Prompt', 'Decision', 'Plan', 'Run'] as const) {
      const facts =
        label === 'Prompt'
          ? s.prompts
          : label === 'Decision'
            ? s.decisions
            : label === 'Plan'
              ? s.plans
              : s.runs;
      for (const f of facts)
        if (f.id) rel('IN_SESSION', [label, f.id], ['Session', s.ref]);
    }
    for (const sha of s.commitsMade) {
      const c = full.pr.commits.find(
        (x) => x.sha.startsWith(sha) || sha.startsWith(x.sha),
      );
      if (c) rel('MADE', ['Session', s.ref], ['Commit', c.sha.slice(0, 12)]);
    }
  }
  for (const r of full.verification ?? [])
    if (r.id)
      node('Receipt', r.id, {
        cmd: clip(r.cmd, 120),
        kind: r.kind,
        outcome: r.outcome,
        summary: r.summary.slice(0, 3),
        when: 'fresh: run on the submitted content',
      });

  // Commits, the files they touched, the hunks their own lines survive in, and
  // their messages split into sentences that can each be attributed on their own.
  const hunkCommits = new Map<string, Map<string, number>>();
  const lookup = <T>(m: Map<string, T> | undefined, sha: string): T | undefined =>
    m?.get(sha) ??
    [...(m?.entries() ?? [])].find(([k]) => k.startsWith(sha.slice(0, 12)))?.[1];
  for (const c of full.pr.commits) {
    const sha = c.sha.slice(0, 12);
    node('Commit', sha, {
      subject: clip(c.subject, 120),
      // The message body often holds the motivation; keep it queryable.
      body: c.body ? clip(c.body, 4000) : null,
      t: c.time ?? null,
    });
    for (const path of lookup(input.commitFiles, c.sha) ?? [])
      if (prFiles.has(path)) rel('TOUCHES', ['Commit', sha], ['File', path]);
    for (const [path, added] of lookup(input.commitLines, c.sha) ?? []) {
      const set = new Set(added);
      for (const h of hunksByFile.get(path) ?? []) {
        let n = 0;
        for (const l of h.lines) if (set.has(l)) n++;
        for (const l of h.gone) if (set.has(`-${l}`)) n++;
        if (n) {
          rel('INTRODUCED', ['Commit', sha], ['Hunk', h.id], { lines: n });
          const m = hunkCommits.get(h.id) ?? new Map<string, number>();
          m.set(sha, (m.get(sha) ?? 0) + n);
          hunkCommits.set(h.id, m);
        }
      }
    }
    commitSentences(c.body ?? '').forEach((text, i) => {
      const id = `${sha}#${i + 1}`;
      node('CommitClaim', id, {
        commit: sha,
        text: clip(text, 400),
        assertsResult: RESULT_CLAIM.test(text),
      });
      rel('SAYS', ['Commit', sha], ['CommitClaim', id]);
    });
  }
  // Requests typed in an included session between the previous commit and this
  // one: what the user asked for while this commit's change was being made, even
  // when no captured edit links them (shell edits, edits by another tool).
  const included = full.sessions.filter((s) => s.band === 'included');
  const timed = full.pr.commits
    .filter((c) => c.time)
    .sort((a, b) => a.time!.localeCompare(b.time!));
  timed.forEach((c, i) => {
    const after = i ? timed[i - 1]!.time! : '';
    for (const s of included) {
      if (s.span.start && s.span.start > c.time!) continue;
      for (const p of s.prompts)
        if (p.id && p.t && p.t > after && p.t <= c.time!)
          rel('ASKED_BEFORE', ['Prompt', p.id], ['Commit', c.sha.slice(0, 12)]);
    }
  });

  // Walk each session's trail: turns, edits, survival and later edits.
  let editN = 0;
  let deadEnds = 0;
  const band = new Map(full.sessions.map((s) => [s.ref, s.band]));
  /** Hunk → prompt → surviving lines, from included sessions only. */
  const hunkPrompts = new Map<string, Map<string, number>>();
  /** File → prompts of included turns that edited it at all (surviving or not). */
  const fileTurns = new Map<string, Set<string>>();
  const linked = new Set<string>();
  for (const trail of trails) {
    let turn: string | undefined;
    let previousPrompt: string | undefined;
    const openRuns: { id: string; t?: string }[] = [];
    for (const e of trail.events) {
      if (e.kind === 'prompt') {
        const id = e.fact.id;
        if (!id) continue;
        if (previousPrompt && previousPrompt !== id)
          rel('NEXT', ['Prompt', previousPrompt], ['Prompt', id]);
        previousPrompt = turn = id;
        continue;
      }
      if (e.kind !== 'edit') {
        const id = e.fact.id;
        if (!id) continue;
        const label =
          e.kind === 'decision' ? 'Decision' : e.kind === 'plan' ? 'Plan' : 'Run';
        if (turn) rel('IN_TURN', [label, id], ['Prompt', turn]);
        if (e.kind === 'run') openRuns.push({ id, t: e.fact.t });
        continue;
      }
      const id = `E${++editN}`;
      let surviving = 0;
      const into: [string, number][] = [];
      for (const h of hunksByFile.get(e.file) ?? []) {
        const n = e.lines.filter((l) => h.lines.has(l)).length;
        if (n) {
          into.push([h.id, n]);
          surviving += n;
        }
      }
      if (!surviving) deadEnds++;
      node('Edit', id, {
        t: e.t ?? null,
        file: e.file,
        added: e.added,
        removed: e.removed,
        surviving,
        inPr: e.inPr,
        via: e.via ?? null,
        session: trail.ref,
      });
      if (!nodes.has(`File|${e.file}`))
        node('File', e.file, {
          role: fileRole(e.file),
          inPr: false,
          added: 0,
          removed: 0,
          unmatched: 0,
        });
      rel('EDITS', ['Edit', id], ['File', e.file]);
      rel('IN_SESSION', ['Edit', id], ['Session', trail.ref]);
      if (turn) rel('IN_TURN', ['Edit', id], ['Prompt', turn]);
      for (const [h, n] of into) {
        rel('SURVIVES_IN', ['Edit', id], ['Hunk', h], { lines: n });
        linked.add(h);
        if (turn && band.get(trail.ref) === 'included') {
          const m = hunkPrompts.get(h) ?? new Map<string, number>();
          m.set(turn, (m.get(turn) ?? 0) + n);
          hunkPrompts.set(h, m);
        }
      }
      if (turn && e.inPr && band.get(trail.ref) === 'included')
        fileTurns.set(e.file, (fileTurns.get(e.file) ?? new Set()).add(turn));
      // Every earlier run in this session did not see this edit to a PR file. A
      // shell edit made by the run's own command (sed … && prettier --check)
      // shares its timestamp and can't be ordered against it; it is not later.
      if (e.inPr)
        for (const r of openRuns)
          if (!(e.via === 'shell' && r.t && r.t === e.t))
            rel('LATER_EDIT', ['Run', r.id], ['File', e.file]);
    }
  }

  // Change units: the hunks that belong to one idea. Commits are the author's own
  // grouping, so with several commits a hunk joins the commit whose lines it
  // holds most; otherwise the request turn whose edits it holds most; otherwise
  // its directory. Ordered behavior first, by size.
  const top = (m: Map<string, number> | undefined) =>
    m && [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const committing = new Set([...hunkCommits.values()].flatMap((m) => [...m.keys()]));
  const groups = new Map<string, PatchHunk[]>();
  for (const h of hunks) {
    const commit = committing.size > 1 ? top(hunkCommits.get(h.id)) : undefined;
    const prompt = top(hunkPrompts.get(h.id));
    const key = commit
      ? `commit:${commit}`
      : prompt
        ? `prompt:${prompt}`
        : `dir:${dirOf(h.file)}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const roleOf = (f: string) => String(nodes.get(`File|${f}`)?.props.role ?? 'other');
  // One commit and one request can still hold several ideas. A group with many
  // behavior files splits by module; its tests, docs and version files form one
  // supporting change, so behavior is described apart from bookkeeping.
  const MAX_BEHAVIOR_FILES = 4;
  for (const [key, hs] of [...groups]) {
    const behaviorFiles = new Set(
      hs.filter((h) => roleOf(h.file) === 'behavior').map((h) => h.file),
    );
    if (behaviorFiles.size <= MAX_BEHAVIOR_FILES) continue;
    groups.delete(key);
    for (const h of hs) {
      const sub =
        roleOf(h.file) === 'behavior' ? `${key}|${dirOf(h.file)}` : `${key}|supporting`;
      groups.set(sub, [...(groups.get(sub) ?? []), h]);
    }
  }
  const weight = (hs: PatchHunk[]) =>
    hs
      .filter((h) => roleOf(h.file) === 'behavior')
      .reduce((a, h) => a + h.added + h.removed, 0);
  const ordered = [...groups.entries()].sort(
    (a, b) =>
      weight(b[1]) - weight(a[1]) ||
      b[1].reduce((n, h) => n + h.added, 0) - a[1].reduce((n, h) => n + h.added, 0) ||
      a[0].localeCompare(b[0]),
  );
  ordered.forEach(([key, hs], i) => {
    const id = `CH${i + 1}`;
    const files = [...new Set(hs.map((h) => h.file))];
    const roles = [...new Set(files.map(roleOf))].sort();
    const symbols = [...new Set(hs.flatMap((h) => h.touched))].slice(0, 16);
    node('Change', id, {
      key,
      files,
      roles,
      symbols,
      added: hs.reduce((n, h) => n + h.added, 0),
      removed: hs.reduce((n, h) => n + h.removed, 0),
      branches: hs.reduce((n, h) => n + h.branches, 0),
    });
    const commits = new Set<string>();
    const asked = new Map<string, string>();
    for (const h of hs) {
      rel('HAS', ['Change', id], ['Hunk', h.id]);
      for (const c of hunkCommits.get(h.id)?.keys() ?? []) commits.add(c);
      for (const p of hunkPrompts.get(h.id)?.keys() ?? [])
        asked.set(p, 'its edits survive here');
    }
    for (const c of commits) rel('EXPLAINED_BY', ['Change', id], ['Commit', c]);
    // Weaker links only when nothing survives line for line.
    if (!asked.size)
      for (const f of files)
        for (const p of fileTurns.get(f) ?? [])
          asked.set(p, 'its turn edited these files');
    if (!asked.size)
      for (const r of rels)
        if (r.type === 'ASKED_BEFORE' && commits.has(r.to.id))
          asked.set(r.from.id, 'typed before the commit that made it');
    for (const [p, how] of asked) rel('ASKED_BY', ['Change', id], ['Prompt', p], { how });
  });

  const sorted = [...nodes.values()];
  return {
    schema: GRAPH_SCHEMA,
    nodes: sorted,
    rels,
    stats: {
      nodes: sorted.length,
      rels: rels.length,
      hunks: hunks.length,
      linkedHunks: linked.size,
      edits: editN,
      deadEndEdits: deadEnds,
      changes: ordered.length,
    },
  };
}
