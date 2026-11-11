/**
 * Build the evidence graph for one run from the redacted full digest, the ordered
 * session trails, the submitted patch and which files each commit touched.
 * Deterministic: the same inputs give byte-identical JSON.
 */
import { evidenceLine } from '../correlate/correlate.ts';
import {
  commandKey,
  fileRole,
  testSegment,
  type SessionTrail,
  type TraceDigest,
} from '../digest/build.ts';
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
  /** Symbols defined on this hunk's removed lines and on no added line of the patch: removed or renamed. */
  dropped: string[];
  /**
   * Conditions, quoted from code files: a changed condition as `old → new`, an
   * added branch or fallback as `+ line`, a removed condition as `- line`.
   */
  conds: string[];
  /** Test titles added in this hunk (`test('…')`, `def test_…`, `func Test…`). */
  tests: string[];
  /**
   * Per function whose body a changed line is in (the nearest definition above
   * it): `name: word word …`, the lowercased words of those changed lines, so
   * a sentence can be matched to the function inside a hunk that holds several.
   */
  fnWords: string[];
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
  /** Raw removed and added lines, for search indexing and key lines. Never written out. */
  minus?: string[];
  plus?: string[];
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
  // Per hunk: function → its changed lines.
  const byFn = new Map<PatchHunk, Map<string, string[]>>();
  // Changed comment lines outside any body, waiting for the definition below them.
  let pendingDoc: string[] = [];
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
        // A changed doc comment right above a definition describes it.
        if (pendingDoc.length) {
          const fns = byFn.get(cur) ?? new Map<string, string[]>();
          fns.set(def, [...(fns.get(def) ?? []), ...pendingDoc]);
          byFn.set(cur, fns);
        }
        pendingDoc = [];
      } else if (text.trim() && !/^\s*(\/\/|#|\*|\/\*|@)/.test(text)) pendingDoc = [];
      if (c === '+' || c === '-') {
        touch(cur);
        const ch = changed.get(cur) ?? { minus: [], plus: [] };
        (c === '+' ? ch.plus : ch.minus).push(text);
        changed.set(cur, ch);
        if (!current && !def && /^\s*(\/\/|#|\*|\/\*)/.test(text)) pendingDoc.push(text);
        else if (current) {
          const fns = byFn.get(cur) ?? new Map<string, string[]>();
          fns.set(current, [...(fns.get(current) ?? []), text]);
          byFn.set(cur, fns);
        }
        if (c === '-' && def) {
          removedDefs.add(def);
          if (!cur.dropped.includes(def)) cur.dropped.push(def);
        }
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
      pendingDoc = [];
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
        dropped: [],
        conds: [],
        tests: [],
        fnWords: [],
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
  const addedDefs = new Set(hunks.flatMap((h) => h.symbols));
  for (const h of hunks) {
    h.fresh = h.symbols.filter((x) => !removedDefs.has(x));
    h.dropped = h.dropped.filter((x) => !addedDefs.has(x));
    const ch = changed.get(h) ?? { minus: [], plus: [] };
    h.pairs = valuePairs(ch.minus, ch.plus);
    h.conds = PROSE_FILE.test(h.file) ? [] : conditionFacts(ch.minus, ch.plus, h.pairs);
    h.tests = uniqStrings(ch.plus.flatMap(testTitles)).slice(0, 8);
    h.words = uniqStrings([...ch.minus, ...ch.plus].flatMap(wordsOf)).slice(0, 400);
    h.fnWords = [...(byFn.get(h) ?? [])].map(
      ([fn, ls]) => `${fn}: ${uniqStrings(ls.flatMap(wordsOf)).slice(0, 120).join(' ')}`,
    );
    h.code = keyCodeLines(ch.minus, ch.plus);
    h.minus = ch.minus;
    h.plus = ch.plus;
  }
  return hunks;
}

const KEY_LINES = 24;
const KEY_TOKEN = /[A-Za-z_$][\w$]*|\d[\d_.]*|'[^']*'|"[^"]*"|`[^`]*`/g;
const tokSet = (l: string) => new Set(l.match(KEY_TOKEN) ?? []);
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
    if (best >= 0 && score >= 0.5 && r.trim() !== plus[best]!.trim()) {
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
  const useful = cands.some((c) => c.rank < 3);
  return cands
    .filter((c) => c.text.length > 2 && (c.rank < 3 || !useful))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.text);
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

/** Files whose lines are prose or data, not code: an "if" there is a word. */
const PROSE_FILE =
  /\.(md|mdx|txt|rst|adoc|json|jsonc|ya?ml|toml|lock|csv|svg|html?|xml|ini|cfg)$|(^|\/)VERSION$/i;
/** A line's code with string contents blanked, so an "if" or "??" in a string doesn't count. */
const codeOnly = (l: string) =>
  l.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""');
const CONDITION = /^\s*(?:\}\s*)?(?:else\s+)?(?:if|elif|while|unless)\b\s*[(\w!]/;
const FALLBACK = /\?\?|\s\?\s[^:]+\s:\s|\|\|\s*(?:\d|['"`[{]|null|undefined|true|false)/;
const BARE =
  /^\s*(?:\}\s*)?(?:else|catch|except|finally|default\s*:)\b[^;]*$|^\s*\}?\s*catch\s*(?:\([^)]*\))?\s*\{?\s*$/;
const CATCH = /^\s*(?:\}\s*)?(?:catch|except)\b|^\s*default\s*:|^\s*case\s+[^:]+:/;
const CONDITION_TOKEN =
  /'[^']*'|"[^"]*"|`[^`]*`|\d[\d_.]*\w*|[A-Za-z_$][\w$]*(?:[.:/-][A-Za-z_$][\w$]*)*|[<>!=]=?=?|&&|\|\||\?\?/g;
const CONDITION_WORDS = new Set(
  'if elif else while unless return const let var await new catch except case default'.split(
    ' ',
  ),
);
/** The condition an `if`/`while` line tests (balanced parentheses, or up to a Python colon). */
function testOf(l: string): string {
  const c = codeOnly(l);
  const m = /\b(?:if|elif|while|unless)\b\s*/.exec(c);
  if (!m) return c.trim();
  const rest = c.slice(m.index + m[0].length);
  if (!rest.startsWith('(')) return rest.replace(/:\s*$/, '').trim();
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '(') depth++;
    else if (rest[i] === ')' && --depth === 0) return rest.slice(0, i + 1);
  }
  return rest.trim();
}
const tidy = (l: string) =>
  l
    .trim()
    .replace(/\s*\{\s*$/, '')
    .replace(/\s+/g, ' ');

/**
 * What changed in a hunk's conditions, quoted from its lines: conditions whose
 * comparison or operands changed (`if (n >= 10) → if (n >= 12)`), added
 * branches and fallbacks (`+ if (!cmd) return;`, `+ const n = opts.limit ?? 20;`)
 * and removed conditions (`- if (legacy)`). Value changes already in `pairs`
 * are not repeated. At most six, in diff order within each kind.
 */
export function conditionFacts(
  minus: string[],
  plus: string[],
  pairs: string[] = [],
): string[] {
  // Keywords match any two conditions; only operands and operators tell them apart.
  const toks = (l: string): string[] =>
    (codeOnly(l).match(CONDITION_TOKEN) ?? []).filter((t) => !CONDITION_WORDS.has(t));
  const kind = (l: string) => {
    // Conditions inside template text (`${a ? b : c}`) render output; they aren't control flow.
    if (isComment(l) || !l.trim() || l.includes('${')) return undefined;
    const c = codeOnly(l);
    if (CONDITION.test(c)) return 'if';
    if (CATCH.test(c)) return 'catch';
    // A fallback whose line breaks mid-call is a fragment, not a fact.
    if (FALLBACK.test(c) && !/[([]\s*$/.test(c)) return 'fallback';
    return undefined;
  };
  const gone = minus.map((l, i) => ({ l, i, k: kind(l) })).filter((x) => x.k);
  const added = plus.map((l, i) => ({ l, i, k: kind(l) })).filter((x) => x.k);
  const inPairs = (l: string) => pairs.some((p) => p.startsWith(clip(l.trim(), 80)));
  const changed: string[] = [];
  const used = new Set<number>();
  const paired = new Set<number>();
  for (const r of gone) {
    const rt = new Set(toks(r.l));
    let best = -1;
    let score = 0;
    for (const a of added) {
      if (used.has(a.i) || a.k !== r.k) continue;
      const at = new Set(toks(a.l));
      const j = [...rt].filter((t) => at.has(t)).length / new Set([...rt, ...at]).size;
      if (j > score) {
        score = j;
        best = a.i;
      }
    }
    if (best < 0 || score < 0.4) continue;
    used.add(best);
    paired.add(r.i);
    // Same condition, different body: not a change of condition.
    if (score >= 1 || inPairs(r.l) || testOf(r.l) === testOf(plus[best]!)) continue;
    changed.push(`${clip(tidy(r.l), 75)} → ${clip(tidy(plus[best]!), 75)}`);
  }
  const line = (l: string, i: number) => {
    // A bare `else`, `catch` or `default:` says little alone: quote what it does.
    if (!BARE.test(codeOnly(l))) return tidy(l);
    const next = plus.slice(i + 1).find((x) => x.trim() && !isComment(x));
    return next ? `${tidy(l)} { ${tidy(next)}` : tidy(l);
  };
  const literal = (l: string) =>
    /[<>]=?\s*-?\d|[=!]==?\s*(?:-?\d|['"`])|\?\?\s*(?:-?\d|['"`])/.test(l);
  const fresh = added.filter((a) => !used.has(a.i));
  const order = [
    ...fresh.filter((a) => literal(a.l)),
    ...fresh.filter((a) => !literal(a.l) && a.k !== 'if'),
    ...fresh.filter((a) => !literal(a.l) && a.k === 'if'),
  ];
  const removed = gone.filter((r) => !paired.has(r.i) && r.k === 'if');
  return uniqStrings([
    ...changed,
    ...order.map((a) => `+ ${clip(line(a.l, a.i), 150)}`),
    ...removed.map((r) => `- ${clip(tidy(r.l), 150)}`),
  ]).slice(0, 6);
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

/** A record that ends cut off: an ellipsis or a truncation marker at its end. */
const RECORD_TRUNCATED = /(?:…|\.\.\.|\[(?:truncated|…)\]|<truncated>)\s*["'”)]*\s*$/i;

/** Each question with its answer, without the questions repeated: `Q? = "A"` joined by ` / `. */
function decisionAnswers(
  d: TraceDigest['sessions'][number]['decisions'][number],
): string | null {
  if (!d.questions?.length) return null;
  return clip(
    d.questions
      .map(
        (q) =>
          `${clip(q.question.replace(/\s+/g, ' '), 200)} = ${q.answer === undefined ? '(no answer recorded)' : `"${clip(q.answer.replace(/\s+/g, ' '), 300)}"`}${q.ownWords ? ' (own words)' : ''}`,
      )
      .join(' / '),
    1200,
  );
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');

/** Code run by hand or by tooling, not shipped: `scripts/`, `tools/`, `bin/`, benchmarks, examples. */
const SCRIPT_PATH = /^(?:scripts?|tools?|bin|bench(?:marks?)?|examples?)\//i;
/** A file's part in a change unit: shipped source, a script, a test, or other (docs, config…). */
export function unitRole(
  file: string,
  role: string,
): 'src' | 'scripts' | 'tests' | 'other' {
  if (role === 'tests') return 'tests';
  if (role !== 'behavior') return 'other';
  return SCRIPT_PATH.test(file) ? 'scripts' : 'src';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether any of the names appears as a whole word in the hunks' changed lines. */
const namesIn = (names: string[], hs: PatchHunk[]) => {
  const text = hs.flatMap((h) => [...h.lines, ...h.gone, ...h.code]).join('\n');
  return names.some(
    (n) => n.length >= 3 && new RegExp(`\\b${escapeRe(n)}\\b`).test(text),
  );
};
/** Words of symbols and file names: what a test about that code would mention. */
const unitWords = (hs: PatchHunk[]) =>
  new Set(
    hs.flatMap((h) => [
      ...[...h.touched, ...h.fresh, ...h.symbols].flatMap(wordsOf),
      ...wordsOf(
        (h.file.split('/').pop() ?? '').replace(/\.[^.]+$/, '').replace(/[-_.]/g, ' '),
      ),
    ]),
  );

/**
 * One commit or request can hold a source change and an unrelated script
 * change (an eval harness pinned in the same commit). When a unit's source and
 * script hunks name none of each other's symbols, the script hunks become a
 * change of their own, and each test file goes with the side whose symbol and
 * file words its titles and lines share most (ties stay with the source).
 * Docs, config and version files stay with the source. Deterministic: the new
 * unit's key is the old key plus `|scripts`.
 */
export function splitScriptUnits(
  groups: Map<string, PatchHunk[]>,
  roleOf: (f: string) => string,
): void {
  for (const [key, hs] of [...groups]) {
    const part = (h: PatchHunk) => unitRole(h.file, roleOf(h.file));
    const src = hs.filter((h) => part(h) === 'src');
    const scripts = hs.filter((h) => part(h) === 'scripts');
    if (!src.length || !scripts.length) continue;
    const names = (xs: PatchHunk[]) => [
      ...new Set(xs.flatMap((h) => [...h.touched, ...h.fresh, ...h.symbols])),
    ];
    if (namesIn(names(src), scripts) || namesIn(names(scripts), src)) continue;
    const srcWords = unitWords(src);
    const scriptWords = unitWords(scripts);
    const toScripts = new Set<string>(scripts.map((h) => h.file));
    const testFiles = [
      ...new Set(hs.filter((h) => part(h) === 'tests').map((h) => h.file)),
    ];
    for (const f of testFiles) {
      const words = new Set(
        hs
          .filter((h) => h.file === f)
          .flatMap((h) => [...h.words, ...h.tests.flatMap(wordsOf)]),
      );
      const score = (side: Set<string>) => [...side].filter((w) => words.has(w)).length;
      if (score(scriptWords) > score(srcWords)) toScripts.add(f);
    }
    groups.set(
      key,
      hs.filter((h) => !toScripts.has(h.file)),
    );
    groups.set(
      `${key}|scripts`,
      hs.filter((h) => toScripts.has(h.file)),
    );
  }
}
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
      dropped: h.dropped,
      conds: h.conds,
      tests: h.tests,
      fnWords: h.fnWords,
      words: h.words,
      code: h.code,
    });
    rel('OF', ['Hunk', h.id], ['File', h.file]);
  }

  // Sessions and their facts.
  const factSession = new Map<object, string>();
  // Per session: each distinct command (at most 40) → its output words.
  const invocationsBy = new Map(
    trails.map((t) => {
      const m = new Map<string, Set<string>>();
      for (const x of t.invocations ?? []) {
        if (!m.has(x.cmd) && m.size >= 40) continue;
        const w = m.get(x.cmd) ?? new Set<string>();
        for (const o of x.out) if (w.size < 40) w.add(o);
        m.set(x.cmd, w);
      }
      return [t.ref, m];
    }),
  );
  for (const s of full.sessions) {
    // Failed commands other than checks (checks are Run nodes with outcomes).
    const checkKeys = new Set(
      s.runs
        .filter((r) => r.kind !== 'other')
        .map((r) => clip(commandKey(testSegment(r.cmd) ?? r.cmd), 60)),
    );
    const failing = s.commands.filter(
      (c) => c.failures > 0 && !c.isTest && !checkKeys.has(c.cmd),
    );
    node('Session', s.ref, {
      agent: s.agent,
      band: s.band,
      score: s.score,
      title: s.title ?? null,
      failedCommands: failing.reduce((n, c) => n + c.failures, 0),
      failedCommand: failing[0]?.cmd ?? null,
      failedCmds: failing
        .slice(0, 8)
        .map((c) => `${c.cmd} (failed ${c.failures} of ${c.count})`),
      // Commands other than checks that ran something (as plain words), and
      // (same position) the words of their output the PR's changed lines also contain.
      invoked: [...(invocationsBy.get(s.ref) ?? new Map()).keys()],
      invokedOut: [...(invocationsBy.get(s.ref) ?? new Map()).values()].map((w) =>
        [...w].join(' '),
      ),
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
          answers: decisionAnswers(d),
          // The record itself was cut off (not this clip): its answer may be incomplete.
          truncated:
            RECORD_TRUNCATED.test(d.text) ||
            (d.questions ?? []).some((q) => RECORD_TRUNCATED.test(q.answer ?? '')),
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
  splitScriptUnits(groups, roleOf);
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
