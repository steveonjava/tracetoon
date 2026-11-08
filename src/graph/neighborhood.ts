/**
 * The neighborhood brief: the evidence graph as the writer reads it, one block
 * per change unit, instead of tables that cite each other by id.
 *
 * Each block keeps a change's neighborhood together:
 * - the requests whose edits survive in it (full text the first time a request appears);
 * - its commits, each commit sentence with the hunks it points to (`→ H#`);
 * - its hunks, each with the requests and sentences behind it and its key changed lines.
 *
 * The blocks are packed to a fixed evidence budget. Headers, requests, commit
 * sentences and one line per hunk are always shown; key code lines are then added
 * greedily by value per character. Rules, limits, tests, housekeeping and
 * validation stay TOON tables outside the budget, as before.
 *
 * Uses only the brief's sections (`briefParts`), so `render`'s ref and file
 * checks see exactly the rows the writer saw.
 */
import type { Section } from './queries.ts';
import { toToon } from './toon.ts';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const refOf = (s: string) => /^([SDP]\d+)\b/.exec(s)?.[1];

interface Line {
  text: string;
  /** Optional lines carry their hunk and a value; fixed lines are always shown. */
  hunk?: string;
  change?: string;
  base?: number;
  k?: number;
}

export interface NeighborhoodOptions {
  /** Evidence budget of the change blocks, in tokens (characters / 4). */
  budgetTokens: number;
}

export function renderNeighborhood(
  sections: Section[],
  opts: NeighborhoodOptions,
): string {
  const budgetChars = Math.max(0, Math.floor(opts.budgetTokens * 4));
  // Big PRs: clip long request and commit-sentence text until the fixed part fits.
  let lines: Line[] = [];
  for (const [clip, compact] of [
    [Infinity, false],
    [320, false],
    [200, false],
    [200, true],
    [120, true],
  ] as const) {
    lines = blocksFor(sections, clip, compact);
    const fixedChars = lines
      .filter((l) => !l.hunk)
      .reduce((n, l) => n + l.text.length + 1, 0);
    if (fixedChars <= budgetChars) break;
  }
  const chosen = pack(lines, budgetChars);
  const out = lines.filter((l) => !l.hunk || chosen.has(l)).map((l) => l.text);
  const toon = (titles: string[]) =>
    toToon(sections.filter((s) => titles.includes(s.title) && s.rows.length)).trimEnd();
  return [
    toon(['avoid', 'limits']),
    out.join('\n'),
    toon(['tests', 'housekeeping', 'validation']),
  ]
    .filter(Boolean)
    .join('\n');
}

const clipTo = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

function blocksFor(sections: Section[], clip: number, compact: boolean): Line[] {
  const rows = (t: string): Row[] => sections.find((s) => s.title === t)?.rows ?? [];
  const changes = rows('changes');
  const requests = new Map(rows('requests').map((r) => [str(r.ref), r]));
  const hunks = rows('hunks');

  // Commit subject rows and their sentences, by commit id.
  const commits = new Map<string, { subject: Row; sentences: Row[] }>();
  for (const r of rows('commitMessages')) {
    const ref = str(r.ref);
    const id = ref.startsWith('commit:') ? ref.slice(7) : ref.split('#')[0]!;
    const c = commits.get(id) ?? { subject: r, sentences: [] };
    if (ref.startsWith('commit:')) c.subject = r;
    else c.sentences.push(r);
    commits.set(id, c);
  }
  // Hunks each commit sentence points to.
  const pointsTo = new Map<string, string[]>();
  for (const h of hunks)
    for (const s of list(h.sentences))
      pointsTo.set(s, [...(pointsTo.get(s) ?? []), str(h.ref)]);
  const shortRef = (ref: string) =>
    ref.includes('#') ? `#${ref.split('#')[1]}` : 'subject';

  const shownRequests = new Set<string>();
  const requestLine = (ref: string, how?: string): string => {
    const r = requests.get(ref);
    if (!r) return `[${ref}]${how ? ` (${how})` : ''}`;
    if (shownRequests.has(ref)) return `[${ref}] (above)${how ? ` (${how})` : ''}`;
    shownRequests.add(ref);
    return `[${ref}] (${str(r.kind)}${how ? `; ${how}` : ''}) ${clipTo(str(r.text), clip)}`;
  };
  const sentenceLine = (indent: string, r: Row, label: string) => {
    const to = pointsTo.get(str(r.ref)) ?? [];
    const impl = list(r.implementedBy);
    return `${indent}${label} ${clipTo(str(r.text), clip)}${to.length ? ` → ${to.join(' ')}` : ''}${impl.length ? ` (implementedBy ${impl.join(' ')})` : ''}`;
  };

  const fixed = (text: string): Line => ({ text });
  const blocks: Line[] = [];
  const shownCommits = new Set<string>();

  for (const c of changes) {
    const id = str(c.change);
    blocks.push(
      // Files and symbols are on the per-file lines below; the header only counts them.
      fixed(
        `## ${id} · grouped by ${str(c.groupedBy)} · +${str(c.added)}/−${str(c.removed)} · ${list(c.where).length} file(s)`,
      ),
    );
    const extra = [
      list(c.newSymbols).length
        ? `newSymbols: ${list(c.newSymbols)
            .slice(0, compact ? 5 : 8)
            .join(' ')}`
        : '',
      list(c.was).length
        ? `was: ${list(c.was)
            .slice(0, compact ? 2 : 4)
            .map((w) => clipTo(w, clip))
            .join(' | ')}`
        : '',
    ].filter(Boolean);
    if (extra.length) blocks.push(fixed(`  ${extra.join(' · ')}`));
    for (const q of list(c.requests)) {
      const ref = refOf(q);
      if (!ref) {
        blocks.push(fixed(`  why: ${q}`));
        continue;
      }
      const how = /\((.*)\)$/.exec(q.slice(ref.length).trim())?.[1];
      blocks.push(fixed(`  why: ${requestLine(ref, how)}`));
      // Plans and decisions in that request's turn come right after it.
      for (const [fref, r] of requests)
        if (str(r.kind).endsWith(`in the turn of ${ref}`) && !shownRequests.has(fref))
          blocks.push(fixed(`    ${requestLine(fref)}`));
    }
    for (const k of list(c.commits)) {
      const cm = commits.get(k);
      if (!cm) continue;
      if (shownCommits.has(k)) {
        blocks.push(fixed(`  commit [commit:${k}] (above)`));
        continue;
      }
      shownCommits.add(k);
      blocks.push(fixed(sentenceLine('  ', cm.subject, `commit [commit:${k}]`)));
      for (const s of cm.sentences)
        blocks.push(fixed(sentenceLine('    ', s, `[${str(s.ref)}]`)));
    }
    // One line per file with its hunks, then each hunk's key lines (optional, packed).
    const mine = hunks.filter((x) => x.change === id);
    const files = [...new Set(mine.map((h) => str(h.file)))];
    for (const f of files) {
      const hs = mine.filter((h) => str(h.file) === f);
      const why = [...new Set(hs.flatMap((h) => list(h.why)))];
      const parts = hs.map((h) => {
        const scope = list(h.scope);
        const told = list(h.sentences).map(shortRef);
        const inner = [scope.join(', '), told.length ? `told by ${told.join(', ')}` : '']
          .filter(Boolean)
          .join('; ');
        if (compact)
          return `[${str(h.ref)}]${told.length ? ` (told by ${told.join(', ')})` : ''}`;
        return `[${str(h.ref)}] ${str(h.lines)}${inner ? ` (${inner})` : ''}`;
      });
      blocks.push(
        fixed(
          `  ${f}: ${parts.join(' · ')}${why.length ? ` · why ${why.join(', ')}` : ''}`,
        ),
      );
      for (const h of hs) {
        const role = str(h.role);
        const base =
          1 +
          Math.log2(1 + Number(h.weight ?? 0)) +
          (list(h.sentences).length ? 2 : 0) +
          (list(h.why).length ? 1 : 0) +
          (role === 'behavior'
            ? 1
            : role === 'tests'
              ? 0.3
              : role === 'version' || role === 'generated'
                ? -0.9
                : 0.5);
        list(h.code).forEach((line, k) =>
          blocks.push({
            text:
              k === 0
                ? `    ${str(h.ref)}  ${line}`
                : `${' '.repeat(6 + str(h.ref).length)}${line}`,
            hunk: str(h.ref),
            change: id,
            base,
            k,
          }),
        );
      }
    }
  }
  // Commits no change unit claims, and requests no block showed (the goal, plans).
  const loose: Line[] = [];
  for (const [k, cm] of commits)
    if (!shownCommits.has(k)) {
      loose.push(fixed(sentenceLine('  ', cm.subject, `commit [commit:${k}]`)));
      for (const s of cm.sentences)
        loose.push(fixed(sentenceLine('    ', s, `[${str(s.ref)}]`)));
    }
  const goal: Line[] = [];
  for (const ref of requests.keys())
    if (!shownRequests.has(ref)) goal.push(fixed(`  ${requestLine(ref)}`));
  return [
    fixed(
      'Evidence by change. Each block: why it was made (requests), what its commits say (→ H# = the hunks a sentence describes), then each changed file with its hunks [H#], the requests behind them and key changed lines (- old ⇒ + new). Refs in brackets are citable. Not every line of the patch is shown.',
    ),
    ...(goal.length
      ? [fixed('## Session requests not tied to one change'), ...goal]
      : []),
    ...blocks,
    ...(loose.length ? [fixed('## Other commits'), ...loose] : []),
  ];
}

/**
 * Greedy packing: fixed lines always; then optional code lines by value per
 * character, the next line of each hunk at a time, with diminishing returns per
 * hunk and per change, until the budget is spent.
 */
function pack(lines: Line[], budgetChars: number): Set<Line> {
  const chosen = new Set<Line>();
  let used = 0;
  for (const l of lines) if (!l.hunk) used += l.text.length + 1;
  const byHunk = new Map<string, Line[]>();
  for (const l of lines)
    if (l.hunk) byHunk.set(l.hunk, [...(byHunk.get(l.hunk) ?? []), l]);
  const next = new Map<string, number>([...byHunk.keys()].map((h) => [h, 0]));
  const perChange = new Map<string, number>();
  for (;;) {
    let best: Line | undefined;
    let bestScore = 0;
    for (const [h, ls] of byHunk) {
      const i = next.get(h)!;
      const l = ls[i];
      if (!l) continue;
      const cost = l.text.length + 1;
      if (used + cost > budgetChars) continue;
      const value =
        Math.max(0.05, l.base ?? 0) /
        (1 + 0.5 * (l.k ?? 0)) /
        (1 + 0.1 * (perChange.get(l.change!) ?? 0));
      const score = value / cost;
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    if (!best) break;
    chosen.add(best);
    used += best.text.length + 1;
    next.set(best.hunk!, next.get(best.hunk!)! + 1);
    perChange.set(best.change!, (perChange.get(best.change!) ?? 0) + 1);
  }
  return chosen;
}
