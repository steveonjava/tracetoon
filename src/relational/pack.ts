/**
 * Packing: candidate items from the store, chosen greedily by value per
 * character under the token budget, then laid out in reading order.
 *
 * - Every candidate is one line of the final text with an exact cost (its
 *   characters plus a newline) and a value from its evidence: how much of the
 *   diff a request's edits survive in, how strongly search ties it to the
 *   change, the size and kind of a chunk, whether it adds new names.
 * - A line can depend on a parent (a chunk on its file, code lines on their
 *   chunk, a sentence on its commit); it becomes available once the parent is in.
 * - Values decay within a group (each further chunk of one file, sentence of
 *   one commit, request of one session is worth less): a submodular objective,
 *   so the greedy spreads the budget over the change instead of one file.
 * - Cross-references (`→ H3`, `why S2`) are resolved after selection: a link
 *   names a chunk only if it is shown, else its file, so every id in the text
 *   is one the writer can read.
 * - Upgrading a clipped line to its longer version is a candidate too, worth
 *   a share of the line, so detail and breadth compete on value per character.
 */
import type { Chunk } from './diff.ts';
import { informative } from './diff.ts';
import { clip, oneLine } from './text.ts';

export type SectionKey = 'requests' | 'commits' | 'changes' | 'tests' | 'other' | 'start';

export const SECTION_TITLES: Record<SectionKey, string> = {
  requests: '## Why: requests (the user, in session order)',
  commits: '## Why: commits (oldest first; a sentence speaks for its own commit only)',
  changes: '## What changed, by file (H lines: new-file line ranges)',
  tests: '## Tests added or changed',
  other: '## Other changed files',
  start: '## Where a reviewer could start',
};
/**
 * Diminishing returns per section: each line already chosen in a section makes
 * the next one there worth a little less, so no one kind of evidence (code
 * detail, typically) takes the whole budget.
 */
export const SECTION_DECAY: Record<SectionKey, number> = {
  requests: 0.97,
  commits: 0.985,
  changes: 0.975,
  tests: 0.96,
  other: 0.95,
  start: 1,
};
const SECTION_ORDER: SectionKey[] = [
  'requests',
  'commits',
  'changes',
  'tests',
  'other',
  'start',
];

export interface Item {
  key: string;
  section: SectionKey;
  /** Layout order within the section. */
  order: (number | string)[];
  value: number;
  /** Items with a parent are available only after the parent is chosen. */
  parent?: string;
  /** Values decay by `decay` for each item already chosen from the same group. */
  group?: string;
  decay?: number;
  /** Always included first (legend, start). */
  must?: boolean;
  /** The line(s), given which keys were chosen (for cross-references). */
  render: (chosen: Set<string>) => string;
  /** A longer version, used when budget is left over. */
  expand?: (chosen: Set<string>) => string;
}

export interface Packed {
  text: string;
  chosen: Set<string>;
  expanded: Set<string>;
}

/** An upgrade to an item's longer version is worth this share of the item. */
export const EXPAND_GAIN = 0.45;
/**
 * Requests, decisions and plans worth less than this are left out even when
 * budget remains: weak session evidence (an unrelated aside, an ambiguous
 * session's chatter) costs the writer more than the empty space does. Diff
 * and commit lines have no floor: they are the change itself.
 */
export const MIN_VALUE = 1.5;

const lineCost = (s: string) => (s ? s.length + 1 : 0);

/**
 * Greedy budgeted selection. `header` is always first; sections appear in a
 * fixed order and cost their title line when first used.
 */
export function pack(header: string, items: Item[], budgetChars: number): Packed {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const chosen = new Set<string>();
  const expanded = new Set<string>();
  const groupCount = new Map<string, number>();
  const sectionCount = new Map<SectionKey, number>();
  const sectionsUsed = new Set<SectionKey>();
  const render = () => layout(header, items, chosen, expanded);
  let used = lineCost(header);
  const cost = (it: Item) =>
    lineCost(it.render(chosen)) +
    (sectionsUsed.has(it.section) ? 0 : lineCost(SECTION_TITLES[it.section]) + 1);
  const take = (it: Item) => {
    chosen.add(it.key);
    sectionsUsed.add(it.section);
    if (it.group) groupCount.set(it.group, (groupCount.get(it.group) ?? 0) + 1);
    sectionCount.set(it.section, (sectionCount.get(it.section) ?? 0) + 1);
  };
  for (const it of items)
    if (it.must) {
      const c = cost(it);
      if (used + c <= budgetChars) {
        take(it);
        used += c;
      }
    }
  // Rounds: pick greedily on estimated costs, then re-measure the real text
  // (cross-references shrink once resolved) and continue while room is left.
  for (let round = 0; round < 6; round++) {
    let picked = 0;
    for (;;) {
      let best: Item | undefined;
      let bestUpgrade = false;
      let bestRatio = 0;
      let bestCost = 0;
      const consider = (it: Item, upgrade: boolean, v: number, c: number) => {
        if (c <= 0 || used + c > budgetChars) return;
        const ratio = v / c;
        if (ratio > bestRatio || (ratio === bestRatio && best && it.key < best.key)) {
          best = it;
          bestUpgrade = upgrade;
          bestRatio = ratio;
          bestCost = c;
        }
      };
      for (const it of items) {
        const k = it.group ? (groupCount.get(it.group) ?? 0) : 0;
        const v =
          it.value *
          (it.decay ?? 1) ** k *
          SECTION_DECAY[it.section] ** (sectionCount.get(it.section) ?? 0);
        if (chosen.has(it.key)) {
          // An upgrade to the longer version competes like any other line.
          if (it.expand && !expanded.has(it.key))
            consider(
              it,
              true,
              it.value * EXPAND_GAIN,
              lineCost(it.expand(chosen)) - lineCost(it.render(chosen)),
            );
          continue;
        }
        if (it.parent && !chosen.has(it.parent)) continue;
        if (it.section === 'requests' && it.value < MIN_VALUE) continue;
        consider(it, false, v, cost(it));
      }
      if (!best) break;
      const b = best as Item;
      if (bestUpgrade) expanded.add(b.key);
      else take(b);
      used += bestCost;
      picked++;
    }
    const real = render().length;
    if (real > budgetChars) break;
    used = real;
    if (!picked) break;
  }
  // Safety: drop the least valuable leaves until the text fits.
  let text = render();
  while (text.length > budgetChars) {
    const leaves = [...chosen]
      .map((k) => byKey.get(k)!)
      .filter(
        (it) => !it.must && ![...chosen].some((k) => byKey.get(k)!.parent === it.key),
      )
      .sort((a, b) => a.value - b.value || b.key.localeCompare(a.key));
    if (!leaves.length) {
      text = text.slice(0, budgetChars);
      break;
    }
    chosen.delete(leaves[0]!.key);
    text = render();
  }
  return { text, chosen, expanded };
}

export function layout(
  header: string,
  items: Item[],
  chosen: Set<string>,
  expanded: Set<string>,
): string {
  const out = [header];
  for (const s of SECTION_ORDER) {
    const lines = items
      .filter((i) => i.section === s && chosen.has(i.key))
      .sort((a, b) => cmpOrder(a.order, b.order) || a.key.localeCompare(b.key))
      .map((i) => (expanded.has(i.key) && i.expand ? i.expand(chosen) : i.render(chosen)))
      .filter(Boolean);
    if (lines.length) out.push('', SECTION_TITLES[s], ...lines);
  }
  return out.join('\n') + '\n';
}

function cmpOrder(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/** Content never carries something that reads as a ref tag. */
export const safe = (s: string) =>
  s.replace(
    /\[((?:[A-Z]{1,3}\d+|(?:commit:)?[0-9a-f]{7,40}(?:#\d+)?)(?:\s*[,;]\s*[^\]]*)?)\]/g,
    '($1)',
  );

/** The changed lines of a chunk most worth reading: definitions, before → after pairs, values. */
export function keyLines(c: Chunk, max: number): string[] {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_$]{2,}/g) ?? []);
  const plus = c.lines.filter((l) => l.sign === '+' && informative(l.text));
  const minus = c.lines.filter((l) => l.sign === '-' && informative(l.text));
  const out: { at: number; text: string; score: number }[] = [];
  const at = (l: Chunk['lines'][number]) => c.lines.indexOf(l);
  // Before → after: a removed line and the added line most like it.
  const paired = new Set<(typeof plus)[number]>();
  for (const m of minus) {
    const mw = words(m.text);
    let best: (typeof plus)[number] | undefined;
    let bestJ = 0;
    for (const p of plus) {
      const pw = words(p.text);
      const inter = [...mw].filter((w) => pw.has(w)).length;
      const j = inter / (mw.size + pw.size - inter || 1);
      if (j > bestJ && oneLine(p.text) !== oneLine(m.text)) {
        best = p;
        bestJ = j;
      }
    }
    if (best && bestJ >= 0.3) {
      paired.add(best);
      out.push({
        at: at(m),
        text: `- ${clip(m.text, 110)}  ⇒  + ${clip(best.text, 110)}`,
        score: 3 + bestJ,
      });
    }
  }
  for (const p of plus) {
    if (paired.has(p)) continue;
    const t = p.text;
    let score = 0;
    if (/\b(function|class|interface|type|def|fn|func|const|export)\b/.test(t))
      score += 1.5;
    if (/(['"`]).{6,}\1/.test(t)) score += 1;
    if (/\b(if|else|catch|throw|return|\?\?|\|\|)\b/.test(t)) score += 0.8;
    if (/\b(test|it|describe)\s*\(/.test(t)) score += 1.5;
    if (/^\s*(import|from|use|require)\b|^\s*[)}\]];?,?$/.test(t)) score -= 2;
    if (/^\s*(\/\/|#|\*|\/\*)/.test(t)) score += 0.3;
    if (score > 0) out.push({ at: at(p), text: `+ ${clip(t, 150)}`, score });
  }
  if (!out.length && minus.length)
    for (const m of minus.slice(0, max))
      out.push({ at: at(m), text: `- ${clip(m.text, 150)}`, score: 0.5 });
  return out
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, max)
    .sort((a, b) => a.at - b.at)
    .map((x) => safe(x.text));
}
