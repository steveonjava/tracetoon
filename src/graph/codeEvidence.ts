/**
 * Code evidence under commit sentences, and commit-vs-code conflicts.
 *
 * - `evidenceLines` (prepare time): a hunk's few lines worth quoting, best
 *   first: added code comments (consecutive lines joined), then lines carrying
 *   literal values or `- old ⇒ + new` pairs (numbers, versions, hashes, names
 *   in quotes), then condition lines, then definitions; for prose files the
 *   added lines themselves. Stored on the Hunk as `keyLines`.
 * - `codeCells` (brief time): up to two of those lines per commit sentence,
 *   from the hunks the sentence is linked to and sharing its words, prefixed
 *   with the hunk's diff ref so a writer can cite them; capped so the TOON
 *   brief grows by at most CODE_SHARE.
 * - `conflictRows`: a sentence whose linked hunk has an added comment or
 *   literal that says the opposite on an ordering or comparison word
 *   (before/after, older/newer, first/last, less/greater…), a state
 *   (enabled/disabled, true/false) or a number or version: a doNotSay row
 *   telling the writer to describe the code. Generic token heuristics, tuned
 *   for precision: both texts must name the same anchors.
 */
import { BRANCHING, keyCodeLines } from './build.ts';
import { toToon } from './toon.ts';
import type { GraphEngine } from './engine.ts';
import type { Section } from './queries.ts';

const isComment = (l: string) =>
  /^\s*(\/\/|#(?!\[|!)|\*(?!\*?\s*$)|\/\*|--\s|<!--)/.test(l);
const PROSE_FILE = /\.(md|mdx|txt|rst|adoc)$/i;
const LITERAL = /\d|'[^']+'|"[^"]+"|`[^`]+`/;
const CONDITION = /^\s*(?:\}\s*)?(?:else\s+)?(?:if|elif|while|unless|case)\b|\?\?|\s\?\s/;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Most key lines kept per hunk. */
const MAX_KEY_LINES = 8;

/** A hunk's lines worth quoting, best first (see the file comment). */
export function evidenceLines(minus: string[], plus: string[], file: string): string[] {
  if (PROSE_FILE.test(file))
    return plus
      .map((l) => l.trim())
      .filter((l) => l.split(/\s+/).length >= 4)
      .slice(0, MAX_KEY_LINES)
      .map((l) => `+ ${clip(l, 240)}`);
  const comments: string[] = [];
  let block: string[] = [];
  const flush = () => {
    const text = block
      .map((l, i) => (i ? l.replace(/^\s*(\/\/+|#+|\*+|--)\s?/, '') : l.trim()))
      .join(' ');
    // A comment worth quoting says something: three words or more.
    if (block.length && text.replace(/^\S+\s*/, '').split(/\s+/).length >= 3)
      comments.push(`+ ${clip(text, 240)}`);
    block = [];
  };
  for (const l of plus) {
    if (isComment(l) && !/^\s*(\/\/|#)\s*(eslint|prettier|@ts-|noqa|type:)/.test(l))
      block.push(l);
    else flush();
  }
  flush();
  // Changed boolean conditions: one line naming dropped and kept operands,
  // in place of the bare `- a ||` / `+ … || b` lines they are made of.
  const ops = operandChanges(minus, plus);
  const consumed = new Set(ops.flatMap((o) => o.lines).map(norm));
  const key = keyCodeLines(minus, plus, 24).filter(
    (k) =>
      !k
        .split(/\s+⇒\s+/)
        .map((x) => x.replace(/^[-+]\s/, ''))
        .some((x) => [...consumed].some((c) => c.startsWith(norm(x).replace(/…$/, '')))),
  );
  const literal: string[] = [];
  const cond: string[] = [];
  const rest: string[] = [];
  for (const k of key) {
    const code = k.replace(/^[-+]\s/, '');
    if (isComment(code)) continue;
    if (LITERAL.test(code.replace(/\b[A-Za-z_$][\w$]*\d+\w*\b/g, ''))) literal.push(k);
    else if (CONDITION.test(code) || BRANCHING.test(code)) cond.push(k);
    else rest.push(k);
  }
  return [
    ...comments.slice(0, 3),
    ...ops.slice(0, 2).map((o) => `± ${o.text}`),
    ...literal.slice(0, 3),
    ...cond.slice(0, 2),
    ...rest.slice(0, 2),
  ]
    .slice(0, MAX_KEY_LINES)
    .map((l) => clip(l, 240));
}

const norm = (l: string) => l.replace(/\s+/g, ' ').trim();

/** Chains of `&&`/`||` in a hunk's removed or added lines: one line, or lines joined at a trailing or leading operator. */
function chainsOf(lines: string[]): { text: string; lines: string[] }[] {
  const out: { text: string; lines: string[] }[] = [];
  const ends = (l: string) => /(\|\||&&)\s*$/.test(l);
  const starts = (l: string) => /^\s*(\|\||&&)/.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i]!)) continue;
    const run = [lines[i]!];
    while (
      i + 1 < lines.length &&
      !isComment(lines[i + 1]!) &&
      (ends(run.at(-1)!) || starts(lines[i + 1]!))
    )
      run.push(lines[++i]!);
    const text = norm(run.join(' '));
    if (/\|\||&&/.test(text.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""')))
      out.push({ text, lines: run });
  }
  return out;
}

/**
 * The operands of a boolean condition: split at `&&`/`||` at the shallowest
 * bracket depth they occur, inside the brackets that hold them; an `if (`,
 * `return`, `x =` or `(e) =>` head and trailing punctuation dropped.
 */
export function operandsOf(text: string, single = false): string[] {
  type Op = { at: number; depth: number };
  const ops: Op[] = [];
  const open: number[] = [];
  const pairs = new Map<number, number>();
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) open.push(i);
    else if (')]}'.includes(c)) {
      const o = open.pop();
      if (o !== undefined) pairs.set(o, i);
    } else if ((c === '|' || c === '&') && text[i + 1] === c) {
      ops.push({ at: i, depth: open.length });
      i++;
    }
  }
  if (!ops.length) {
    const one = single ? cleanOperand(text, 0) : '';
    return one ? [one] : [];
  }
  const depth = Math.min(...ops.map((o) => o.depth));
  const first = ops.find((o) => o.depth === depth)!;
  // The brackets that hold the shallowest operators.
  let lo = 0;
  let hi = text.length;
  if (depth > 0) {
    const holders = [...pairs]
      .filter(([o, c]) => o < first.at && c > first.at)
      .sort((a, b) => b[0] - a[0]);
    const unclosed = open.filter((o) => o < first.at).sort((a, b) => b - a);
    const o = Math.max(holders[0]?.[0] ?? -1, unclosed[0] ?? -1);
    lo = o + 1;
    hi = pairs.get(o) ?? text.length;
  }
  const at = ops.filter((o) => o.depth === depth && o.at >= lo && o.at < hi).map((o) => o.at);
  const parts: string[] = [];
  let from = lo;
  for (const a of at) {
    parts.push(text.slice(from, a));
    from = a + 2;
  }
  parts.push(text.slice(from, hi));
  return parts.map(cleanOperand).filter(Boolean);
}
/** An operand without a leading `if (`, `return`, `x =` or `(e) =>`, trailing punctuation or stray brackets. */
function cleanOperand(p: string, i: number): string {
  let t = norm(p);
  if (i === 0)
    t = t
      .replace(/^(?:\}\s*)?(?:else\s+)?(?:if|elif|while|unless|return)\b\s*/, '')
      .replace(/^(?:(?:const|let|var)\s+)?[\w$.]+\s*=(?![=>])\s*/, '')
      .replace(/^(?:\([\w$,\s]*\)|[\w$]+)\s*=>\s*/, '');
  t = t.replace(/[\s,;{:]+$/, '');
  // Brackets the split left unbalanced at either end.
  while (/^\(/.test(t) && !balanced(t)) t = t.slice(1).trim();
  while (/\)$/.test(t) && !balanced(t)) t = t.slice(0, -1).trim();
  while (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1)) && wraps(t)) t = t.slice(1, -1).trim();
  return t;
}

const balanced = (t: string) => {
  let d = 0;
  for (const c of t.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""')) {
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c) && --d < 0) return false;
  }
  return d === 0;
};
/** The first bracket closes at the last character. */
const wraps = (t: string) => {
  let d = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') d++;
    else if (t[i] === ')' && --d === 0) return i === t.length - 1;
  }
  return false;
};

/** An operand that reads as true/false: a comparison, a negation, a predicate call. */
const BOOLEANISH =
  /[=!]==?|[<>]=?|^!|\.(?:includes|has|some|every|startsWith|endsWith|test|match|exec)\(|\b(?:is|has|can|should|was)[A-Z]\w*\(|^(?:true|false)$/;

const tick = (s: string, n: number) => `\`${clip(s, n).replace(/`/g, "'")}\``;

/**
 * Changed boolean conditions: a removed `&&`/`||` chain and the added chain
 * sharing the most operands with it, as `was … → now …` (short ones) or the
 * operands the change dropped, kept and added. `lines` are the removed and
 * added lines the chains span.
 */
export function operandChanges(
  minus: string[],
  plus: string[],
): { text: string; lines: string[] }[] {
  // Chains, and single condition lines a chain may have become or come from.
  const sides = (lines: string[]) => {
    const chains = chainsOf(lines);
    const inChain = new Set(chains.flatMap((c) => c.lines));
    const singles = lines
      .filter((l) => !inChain.has(l) && !isComment(l) && CONDITION.test(l))
      .map((l) => ({ text: norm(l), lines: [l] }));
    return [
      ...chains.map((c) => ({ ...c, ops: operandsOf(c.text) })),
      ...singles.map((c) => ({ ...c, ops: operandsOf(c.text, true) })),
    ];
  };
  const gone = sides(minus);
  const now = sides(plus);
  const out: { text: string; lines: string[] }[] = [];
  const used = new Set<number>();
  for (const g of gone) {
    if (!g.ops.length) continue;
    let best = -1;
    let shared = 0;
    now.forEach((p, i) => {
      if (used.has(i)) return;
      const n = p.ops.filter((o) => g.ops.includes(o)).length;
      if (n > shared) {
        shared = n;
        best = i;
      }
    });
    if (best < 0) continue;
    const p = now[best]!;
    if (g.ops.length < 2 && p.ops.length < 2) continue;
    const dropped = g.ops.filter((o) => !p.ops.includes(o));
    const added = p.ops.filter((o) => !g.ops.includes(o));
    if (!dropped.length && !added.length) continue;
    // Conditions only: a value fallback (`a || 'x'`) is a value change.
    if (![...dropped, ...added].every((o) => BOOLEANISH.test(o))) continue;
    used.add(best);
    const kept = g.ops.filter((o) => p.ops.includes(o));
    const list = (xs: string[], n: number) => xs.map((x) => tick(x, n)).join(', ');
    const whole = (ops: string[], text: string) =>
      /&&/.test(text) && !/\|\|/.test(text) ? ops.join(' && ') : ops.join(' || ');
    const was = whole(g.ops, g.text);
    const is = whole(p.ops, p.text);
    const head =
      was.length <= 60 && is.length <= 60
        ? `was ${tick(was, 60)} → now ${tick(is, 60)}; `
        : 'condition changed, ';
    const parts = [
      dropped.length ? `dropped: ${list(dropped, 70)}` : '',
      added.length ? `added: ${list(added, 70)}` : '',
      kept.length ? `kept: ${list(kept, 45)}` : '',
    ].filter(Boolean);
    out.push({ text: clip(`${head}${parts.join('; ')}`, 230), lines: [...g.lines, ...p.lines] });
  }
  return out;
}

/** Number and version tokens of a hunk's changed lines, for the conflict check. */
export function literalTokens(minus: string[], plus: string[]): string[] {
  const out = new Set<string>();
  for (const l of [...minus, ...plus])
    for (const m of l.matchAll(/\bv?\d+(?:\.\d+)*(?:-[A-Za-z]+(?:\.?\d+)*)?\b/g))
      out.add(m[0].replace(/^v/, ''));
  return [...out].slice(0, 80);
}

/**
 * Crude stem, so "cases" meets `case`, "pins" meets "pinned" and "merged"
 * meets `merge`.
 */
export const stem = (w: string) =>
  (w.replace(/(ies|es|s|ed|ing)$/, (m) => (m === 'ies' ? 'y' : '')) || w)
    .replace(/(?<=..)e$/, '')
    .replace(/([^aeiou\d])\1$/, '$1');

const STOP = new Set(
  'the and for with that this from into when then than only now not are was were has have had its also each more most some any all can will would should could does did use used uses using make makes made add adds added new old instead they them their there here which what who how why one two per via over under about after before still just like same other way get gets set sets run runs ran code file files line lines test tests change changes changed fix fixes fixed update updated but out off our you yet too see may let return const true false null'.split(
    ' ',
  ),
);
export const wordsOf = (s: string) =>
  new Set(
    (
      s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .match(/[a-z][a-z0-9]{2,}|\d+(?:\.\d+)*/g) ?? []
    )
      .map(stem)
      .filter((w) => !STOP.has(w)),
  );

/** Share of the TOON brief the code cells (and conflict rows) may add. */
export const CODE_SHARE = 0.11;
/** Lines per commit sentence, and characters per line. */
const PER_ROW = 2;
const LINE_CHARS = 110;

/**
 * A key line with its direction spelled out, so a writer can't read a removed
 * line as added: `removed: …`, `added: …`, `was \`old\` → now \`new\`` for a
 * pair, and the operand line (`± …`) as it is.
 */
export function directional(l: string): string {
  if (l.startsWith('± ')) return clip(l.slice(2), OPERAND_CHARS);
  const pair = /^- (.*?)\s+⇒\s+\+ (.*)$/.exec(l);
  if (pair) {
    const side = (x: string) => clip(x, PAIR_CHARS).replace(/`/g, "'");
    return `was \`${side(pair[1]!)}\` → now \`${side(pair[2]!)}\``;
  }
  if (l.startsWith('+ ')) return `added: ${clip(l.slice(2), LINE_CHARS)}`;
  if (l.startsWith('- ')) return `removed: ${clip(l.slice(2), LINE_CHARS)}`;
  return clip(l, LINE_CHARS);
}
/** Characters of an operand line, and of each side of a pair. */
const OPERAND_CHARS = 200;
const PAIR_CHARS = 60;

interface HunkInfo {
  id: string;
  diff: string;
  file: string;
  keyLines: string[];
  literals: string[];
}

function hunkInfo(g: GraphEngine): Map<string, HunkInfo> {
  return new Map(
    g
      .run(
        'MATCH (h:Hunk) RETURN h.id AS id, h.diff AS diff, h.file AS file, h.keyLines AS keyLines, h.literals AS literals',
      )
      .rows.map((r) => [
        String(r.id),
        {
          id: String(r.id),
          diff: String(r.diff),
          file: String(r.file),
          keyLines: (r.keyLines as string[]) ?? [],
          literals: (r.literals as string[]) ?? [],
        },
      ]),
  );
}

/**
 * Add a `code` column to `commitMessages` (TOON layout): each sentence's key
 * lines from its linked hunks, best first, within CODE_SHARE of the brief.
 */
export function addCodeCells(
  g: GraphEngine,
  sections: Section[],
  hunkLinks: Record<string, string[]>,
  /** Characters the cells may add; default CODE_SHARE of the brief. */
  budgetChars?: number,
): void {
  const commits = sections.find((s) => s.title === 'commitMessages');
  if (!commits?.rows.length) return;
  const info = hunkInfo(g);
  if (![...info.values()].some((h) => h.keyLines.length)) return;
  const budget = budgetChars ?? Math.round(toToon(sections).length * CODE_SHARE);
  // Each row's candidates, best first: lines sharing the sentence's words,
  // comments before values before conditions (keyLines' own order).
  const cands = commits.rows.map((r) => {
    const words = wordsOf(String(r.text ?? ''));
    const out: { text: string; hunk: string; score: number }[] = [];
    for (const id of hunkLinks[String(r.ref)] ?? []) {
      const h = info.get(id);
      if (!h) continue;
      h.keyLines.forEach((l, i) => {
        const shared = [...wordsOf(l)].filter((w) => words.has(w)).length;
        if (shared)
          out.push({
            text: `${h.diff} ${directional(l)}`,
            hunk: id,
            // Operand lines first: they say which way a condition changed.
            score: shared * 10 - i + (l.startsWith('± ') ? 15 : 0),
          });
      });
    }
    out.sort((a, b) => b.score - a.score);
    // At most one line per hunk until every linked hunk had a turn.
    const picked: typeof out = [];
    for (const c of out) if (!picked.some((p) => p.hunk === c.hunk)) picked.push(c);
    for (const c of out) if (!picked.includes(c)) picked.push(c);
    return picked.map((c) => c.text);
  });
  const cells: string[][] = commits.rows.map(() => []);
  const shown = new Set<string>();
  let used = 0;
  // Round robin: every sentence's first line before anyone's second; a line
  // already under an earlier sentence is not repeated.
  // Sentences before subjects: a subject sums up what its sentences detail.
  const order = commits.rows
    .map((r, i) => ({ i, subject: !String(r.ref).includes('#') }))
    .sort((a, b) => Number(a.subject) - Number(b.subject) || a.i - b.i)
    .map((x) => x.i);
  for (let round = 0; round < PER_ROW; round++)
    order.forEach((i) => {
      const c = cands[i]!;
      const line = c.find((l) => !shown.has(l));
      if (!line) return;
      // The direction words (`added:`, `removed:`) cost what `+`/`-` did:
      // spelling them out never pushes a line out.
      const cost = line.length + 3 - (/^\S+ (?:added|removed): /.exec(line) ? 6 : 0);
      if (used + cost > budget) return;
      used += cost;
      shown.add(line);
      cells[i]!.push(line);
    });
  if (!used) return;
  commits.columns = [...commits.columns, 'code'];
  commits.rows.forEach((r, i) => (r.code = cells[i]!.join(' ‖ ')));
}

// --- Commit-vs-code conflicts ---------------------------------------------

const OPPOSITE: Record<string, string> = {
  before: 'after',
  after: 'before',
  earlier: 'later',
  later: 'earlier',
  older: 'newer',
  newer: 'older',
  first: 'last',
  last: 'first',
  less: 'greater',
  greater: 'less',
  lower: 'higher',
  higher: 'lower',
  smaller: 'larger',
  larger: 'smaller',
  below: 'above',
  above: 'below',
};
const STATE: Record<string, string> = {
  enabled: 'disabled',
  disabled: 'enabled',
  true: 'false',
  false: 'true',
};

/** Tokens of a text: words, identifiers, versions and numbers. */
const tokensOf = (s: string) =>
  (
    s.match(
      /[A-Za-z_$][\w$]*(?:[.-][\w$]+)*|v?\d+(?:\.\d+)*(?:-[A-Za-z]+(?:\.?\d+)*)?/g,
    ) ?? []
  ).map((t) => t.replace(/^v(?=\d)/, ''));
/** A token distinctive enough to anchor a comparison: has a digit, or is code-shaped. */
const isAnchor = (t: string) => /\d/.test(t) || /[a-z][A-Z]|_|\./.test(t);
/** Same anchor: equal, or one is the other's dotted/dashed suffix (1.0.0-rc.10 ~ rc.10). */
const sameAnchor = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (
    x === y ||
    x.endsWith(`-${y}`) ||
    y.endsWith(`-${x}`) ||
    x.endsWith(`.${y}`) ||
    y.endsWith(`.${x}`)
  );
};

interface Triple {
  a: string;
  rel: string;
  b: string;
}
/** `A … before … B` within a few tokens, for each ordering word in the text. */
export function orderTriples(text: string): Triple[] {
  const toks = tokensOf(text);
  const out: Triple[] = [];
  toks.forEach((t, i) => {
    const rel = t.toLowerCase();
    if (!OPPOSITE[rel]) return;
    const a = toks
      .slice(Math.max(0, i - 4), i)
      .reverse()
      .find(isAnchor);
    const b = toks.slice(i + 1, i + 5).find(isAnchor);
    if (a && b && !sameAnchor(a, b)) out.push({ a, rel, b });
  });
  return out;
}

/** The sentence and the code say opposite things about the same two anchors. */
export function orderConflict(sentence: string, code: string): boolean {
  const s = orderTriples(sentence);
  const c = orderTriples(code);
  return s.some((x) =>
    c.some(
      (y) =>
        (sameAnchor(x.a, y.a) && sameAnchor(x.b, y.b) && OPPOSITE[x.rel] === y.rel) ||
        (sameAnchor(x.a, y.b) && sameAnchor(x.b, y.a) && x.rel === y.rel),
    ),
  );
}

/** States (enabled/disabled, true/false) the text gives a code-shaped name. */
function states(text: string, code: boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (code)
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(true|false)\b/g))
      out.set(m[1]!.toLowerCase(), m[2]! === 'true' ? 'enabled' : 'disabled');
  const toks = tokensOf(text);
  toks.forEach((t, i) => {
    const st = STATE[t.toLowerCase()] ? t.toLowerCase() : undefined;
    if (!st) return;
    const near = [...toks.slice(Math.max(0, i - 3), i), ...toks.slice(i + 1, i + 3)].find(
      (x) => /[a-z][A-Z]|_/.test(x),
    );
    if (near)
      out.set(
        near.toLowerCase(),
        st === 'true' ? 'enabled' : st === 'false' ? 'disabled' : st,
      );
  });
  return out;
}
export function stateConflict(
  sentence: string,
  code: string,
  isCodeLine: boolean,
): boolean {
  const s = states(sentence, false);
  const c = states(code, isCodeLine);
  for (const [name, st] of s) if (c.has(name) && c.get(name) === STATE[st]) return true;
  return false;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z]+(?:\.?\d+)*)?$/;
/**
 * A number next to the same noun in both texts with different values
 * (`fetch 30 releases` vs `per page: 100 releases`), when the hunk's lines never
 * carry the sentence's number; or a version the hunk never mentions while its
 * lines carry exactly one other version.
 */
export function numberConflict(
  sentence: string,
  line: string,
  hunkLiterals: string[],
): boolean {
  if (/\b(?:from|was|were|previously|used to)\s+v?\d/i.test(sentence)) return false;
  const has = new Set(hunkLiterals);
  const sToks = tokensOf(sentence);
  const versions = sToks.filter((t) => VERSION.test(t));
  const hunkVersions = hunkLiterals.filter((t) => VERSION.test(t));
  for (const v of versions)
    if (
      !has.has(v) &&
      hunkVersions.length === 1 &&
      tokensOf(line).includes(hunkVersions[0]!)
    )
      return true;
  const pairs = (toks: string[]) => {
    const out = new Map<string, string>();
    toks.forEach((t, i) => {
      if (!/^\d+$/.test(t)) return;
      const noun = toks[i + 1];
      if (noun && /^[a-z]{4,}$/i.test(noun) && !STOP.has(noun.toLowerCase()))
        out.set(noun.toLowerCase().replace(/s$/, ''), t);
    });
    return out;
  };
  const s = pairs(sToks);
  const c = pairs(tokensOf(line));
  for (const [noun, n] of s) {
    const m = c.get(noun);
    if (m && m !== n && !has.has(n)) return true;
  }
  return false;
}

/**
 * doNotSay rows for commit sentences contradicted by an added comment or
 * literal in a hunk they are linked to. At most one row per sentence.
 */
export function conflictRows(
  g: GraphEngine,
  sections: Section[],
  hunkLinks: Record<string, string[]>,
  max = 3,
): Record<string, unknown>[] {
  const commits = sections.find((s) => s.title === 'commitMessages')?.rows ?? [];
  const info = hunkInfo(g);
  const out: Record<string, unknown>[] = [];
  for (const r of commits) {
    const text = String(r.text ?? '');
    let found: { line: string; diff: string; comment: boolean } | undefined;
    for (const id of hunkLinks[String(r.ref)] ?? []) {
      const h = info.get(id);
      if (!h || PROSE_FILE.test(h.file)) continue;
      for (const l of h.keyLines) {
        // Operand lines restate conditions; they carry no new comment or value.
        if (l.startsWith('± ')) continue;
        const body = l.replace(/^[-+]\s/, '');
        // Only what the change adds: a `- old ⇒ + new` pair speaks for its new side.
        const added = /\s⇒\s+\+ /.test(body)
          ? body.split(/\s⇒\s+\+ /)[1]!
          : l.startsWith('- ')
            ? ''
            : body;
        if (!added) continue;
        const comment = isComment(added);
        if (
          (comment &&
            (orderConflict(text, added) || stateConflict(text, added, false))) ||
          (!comment && stateConflict(text, added, true)) ||
          numberConflict(text, added, h.literals)
        ) {
          found = { line: added, diff: h.diff, comment };
          break;
        }
      }
      if (found) break;
    }
    if (!found) continue;
    out.push({
      kind: 'commit vs code',
      text: `The commit message says "${clip(text, 110)}"; the code${found.comment ? ' comment' : ''} says "${clip(found.line.replace(/^\s*(\/\/+|#+|\/\*+|\*+|--)\s*/, ''), 120)}" (${found.diff}): describe the code, not the message.`,
      cites: `${String(r.ref)} ${found.diff}`,
    });
    if (out.length >= max) break;
  }
  return out;
}
