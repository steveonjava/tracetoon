/** Text helpers for the relational/vector arm: sentences, identifiers, terms, clipping. */

/** One line, whitespace collapsed. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** At most `n` characters, cut at a word boundary when one is near, with an ellipsis. */
export function clip(s: string, n: number): string {
  const t = oneLine(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, Math.max(1, n - 1));
  const sp = cut.lastIndexOf(' ');
  return `${sp > n * 0.6 ? cut.slice(0, sp) : cut}…`;
}

/**
 * A commit body as sentences or bullets, each citable as `commit:<sha>#n`.
 * Paragraphs and list items split first, then sentences; trailers dropped. The
 * numbering matches the one `render` checks commit-sentence coverage against.
 */
export function commitSentences(body: string): string[] {
  return body
    .split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)
    .flatMap((para) =>
      para
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
        .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/),
    )
    .map((x) => x.trim())
    .filter(
      (x) => x.length > 3 && !/^[A-Za-z][\w-]*-[Bb]y:\s|^[A-Z][\w-]+:\s*\S+@/.test(x),
    );
}

/** A sentence that reports a result (counts, "tests pass", "verified") rather than explaining a change. */
export const RESULT_CLAIM =
  /(\b\d+\s*\/\s*\d+\b|\b\d+\s+(?:pass|passed|passing|fail|failed|failing|tests?|checks?|cases?)\b|\b(?:tests?|checks?|suite|evals?|build|ci)\s+(?:now\s+)?(?:pass|passes|passed|green|succeed|succeeds)\b|\ball\s+(?:tests|checks)\b|\bverified\b|\bconfirmed\b)/i;

/** Prose split into sentences (prompts, plans, decisions), lines kept apart. */
export function proseSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z`"'(\[])/))
    .map((s) => oneLine(s.replace(/^\s*(?:[-*•>#]+|\d+[.)])\s*/, '')))
    .filter((s) => s.length > 2);
}

/** camelCase, PascalCase, snake_case, kebab-case and paths as lowercase words. */
export function identWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

export const STOP = new Set(
  (
    'a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its ' +
    'me my no not now of on or our out she so than that the their them then there these they this those to too up ' +
    'us was we were what when where which who why will with would you your also just only very more most some such ' +
    'should must may might let lets please make sure use using used get got want need like one two all any each ' +
    'new add added adds const return import export from function true false null undefined void string number'
  ).split(' '),
);

/** Searchable terms of a text: identifiers split, stop words and digits-only dropped. */
export function terms(s: string): string[] {
  return identWords(s).filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
}

/** Code identifiers a text names: `backticked`, camelCase, snake_case, dotted, or call(). */
export function mentionedNames(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/`([^`\n]{2,80})`/g))
    for (const n of m[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []) if (n.length > 2) out.add(n);
  for (const m of s.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g))
    if (/[A-Z_]/.test(m[1]!.slice(1)) && m[1]!.length > 3) out.add(m[1]!);
  for (const m of s.matchAll(
    /\b([a-z]+[A-Z][\w$]*|[A-Za-z]+_[\w$]+|[A-Z][a-z]+[A-Z][\w$]*)\b/g,
  ))
    out.add(m[1]!);
  return out;
}

/** Paths a text names (`src/x.ts`, `README.md`). */
export function mentionedPaths(s: string): string[] {
  return [...s.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,6})\b/g)].map(
    (m) => m[1]!,
  );
}

/** An FTS5 query matching any of the terms (each quoted, so no operator injection). */
export function ftsOr(words: string[], max = 24): string | undefined {
  const uniq = [...new Set(words.filter((w) => /^[a-z0-9]+$/.test(w)))].slice(0, max);
  return uniq.length ? uniq.map((w) => `"${w}"`).join(' OR ') : undefined;
}

/** Short reading of a timestamp: 2026-11-05 14:02. */
export const shortTime = (t?: string) => (t ? t.slice(0, 16).replace('T', ' ') : '');
