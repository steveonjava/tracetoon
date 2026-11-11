/** Words of identifiers and prose for graph search: identifiers split, stop words, mentions. */

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
