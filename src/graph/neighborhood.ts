/**
 * The neighborhood brief: the evidence graph as the writer reads it, one block
 * per change unit, instead of tables that cite each other by id.
 *
 * Each block keeps a change's neighborhood together:
 * - what the change now does (`behavior`), its new symbols and old values;
 * - the requests whose edits survive in it (full text the first time a request appears);
 * - its commits, each commit sentence with the hunks it points to (`→ H#`);
 * - its hunks, each with the requests and sentences behind it and its key changed lines.
 *
 * The blocks are packed to an evidence budget. Headers, requests, commit
 * sentences and one line per file are always shown; key code lines are then
 * added greedily by value per character. Limits stay a TOON table first;
 * process, tests, housekeeping and validation stay TOON tables after the
 * blocks, outside the budget. A `background` section, when the brief has one,
 * is shown as a "Session background" block before the change blocks.
 *
 * Uses only the brief's sections (`briefParts`), so `render`'s ref and file
 * checks see exactly the rows the writer saw.
 */
import type { Section } from './queries.ts';
import { toToon } from './toon.ts';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const refOf = (s: string) => /^([A-Z]{1,3}\d+)\b/.exec(s)?.[1];

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
  /**
   * The whole brief's size to stay within, in characters (the TOON brief's):
   * the blocks get at most what the tables around them leave.
   */
  targetChars?: number;
}

export const NEIGHBORHOOD_HEADER =
  'Evidence by change: per block its behavior, requests (why), commit sentences (→ H# = the hunks a sentence describes), then each file with its hunks [H#] and key changed lines (- old ⇒ + new). Bracketed refs are citable. Not every patch line is shown.';

export function renderNeighborhood(
  sections: Section[],
  opts: NeighborhoodOptions,
): string {
  const toon = (titles: string[]) =>
    toToon(sections.filter((s) => titles.includes(s.title) && s.rows.length)).trimEnd();
  const head = toon(['limits', 'doNotSay']);
  const tail = toon(['owners', 'process', 'tests', 'housekeeping', 'validation']);
  const around = (head ? head.length + 1 : 0) + (tail ? tail.length + 1 : 0);
  const budgetChars = Math.max(
    0,
    Math.floor(
      Math.min(
        opts.budgetTokens * 4,
        opts.targetChars === undefined ? Infinity : opts.targetChars - around,
      ),
    ),
  );
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
  return [head, out.join('\n'), tail].filter(Boolean).join('\n');
}

const clipTo = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** A row of a section this layout doesn't know (e.g. `background`), as one line. */
const genericLine = (r: Row, clip: number) => {
  const ref = str(r.ref);
  const rest = Object.entries(r)
    .filter(
      ([k, v]) =>
        k !== 'ref' && v != null && v !== '' && !(Array.isArray(v) && !v.length),
    )
    .map(([k, v]) =>
      Array.isArray(v) ? `${k}: ${v.map(String).join(', ')}` : clipTo(String(v), clip),
    );
  return `  ${ref ? `[${ref}] ` : ''}${rest.join(' · ')}`;
};

function blocksFor(sections: Section[], clip: number, compact: boolean): Line[] {
  const rows = (t: string): Row[] => sections.find((s) => s.title === t)?.rows ?? [];
  const changes = rows('changes');
  const requests = new Map(rows('requests').map((r) => [str(r.ref), r]));
  const hunks = rows('hunks');

  // Commit subject rows (ref: the bare sha) and their sentences (<sha>#n), by sha.
  const commits = new Map<string, { subject?: Row; sentences: Row[] }>();
  for (const r of rows('commitMessages')) {
    const ref = str(r.ref).replace(/^commit:/, '');
    const id = ref.split('#')[0]!;
    const c = commits.get(id) ?? { sentences: [] };
    if (ref.includes('#')) c.sentences.push(r);
    else c.subject = r;
    commits.set(id, c);
  }
  // Changes cite commits by full or short sha: find the commit either way.
  const commitOf = (k: string) => {
    if (commits.has(k)) return [k, commits.get(k)!] as const;
    for (const [id, c] of commits)
      if (id.startsWith(k) || k.startsWith(id)) return [id, c] as const;
    return undefined;
  };
  // Hunks each commit sentence points to.
  const pointsTo = new Map<string, string[]>();
  for (const h of hunks)
    for (const s of list(h.sentences))
      pointsTo.set(s, [...(pointsTo.get(s) ?? []), str(h.ref)]);
  const shortRef = (ref: string) =>
    ref.includes('#') ? `#${ref.split('#')[1]}` : 'subject';

  const fixed = (text: string): Line => ({ text });
  const shownRequests = new Set<string>();
  const requestLine = (ref: string, how?: string): string => {
    const r = requests.get(ref);
    if (!r) return `[${ref}]${how ? ` (${how})` : ''}`;
    if (shownRequests.has(ref)) return `[${ref}] (above)${how ? ` (${how})` : ''}`;
    shownRequests.add(ref);
    const text = clipTo(str(r.text), clip);
    return `[${ref}] (${str(r.kind)}${how ? `; ${how}` : ''}) ${text}${r.truncated === true && !text.endsWith('…') ? '…' : ''}`;
  };
  const sentenceLine = (indent: string, r: Row, label: string) => {
    const to = pointsTo.get(str(r.ref)) ?? [];
    const impl = list(r.implementedBy);
    return `${indent}${label} ${clipTo(str(r.text), clip)}${to.length ? ` → ${to.join(' ')}` : ''}${impl.length ? ` (implementedBy ${impl.join(' ')})` : ''}`;
  };
  const commitLines = (
    id: string,
    c: { subject?: Row; sentences: Row[] },
    indent: string,
  ) => [
    fixed(
      c.subject
        ? sentenceLine(indent, c.subject, `commit [${id}]`)
        : `${indent}commit [${id}]`,
    ),
    ...c.sentences.map((s) => fixed(sentenceLine(`${indent}  `, s, `[${str(s.ref)}]`))),
  ];

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
    const behavior = list(c.behavior);
    if (behavior.length)
      blocks.push(
        fixed(
          `  behavior: ${behavior
            .slice(0, compact ? 2 : 4)
            .map((b) => clipTo(b, clip))
            .join(' | ')}`,
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
      const found = commitOf(k);
      if (!found) continue;
      const [sha, cm] = found;
      if (shownCommits.has(sha)) {
        blocks.push(fixed(`  commit [${sha}] (above)`));
        continue;
      }
      shownCommits.add(sha);
      blocks.push(...commitLines(sha, cm, '  '));
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
    if (!shownCommits.has(k)) loose.push(...commitLines(k, cm, '  '));
  const goal: Line[] = [];
  for (const ref of requests.keys())
    if (!shownRequests.has(ref)) goal.push(fixed(`  ${requestLine(ref)}`));
  const background = rows('background').map((r) => fixed(genericLine(r, clip)));
  // Head-tree facts are optional: packed like key lines, header first, within the budget.
  const scan = rows('headScan');
  const scanLines: Line[] = scan.length
    ? [
        '## Head tree (git grep at the head commit)',
        ...scan.map((r) => genericLine(r, clip)),
      ].map((text, k) => ({ text, hunk: 'head-tree', change: 'head-tree', base: 2, k }))
    : [];
  return [
    fixed(NEIGHBORHOOD_HEADER),
    ...(goal.length
      ? [fixed('## Session requests not tied to one change'), ...goal]
      : []),
    ...(background.length ? [fixed('## Session background'), ...background] : []),
    ...blocks,
    ...(loose.length ? [fixed('## Other commits'), ...loose] : []),
    ...scanLines,
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
      const l = ls[next.get(h)!];
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
