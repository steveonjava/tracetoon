/**
 * The brief's use of search links (TIED_TO, search.ts) and code evidence
 * (codeEvidence.ts). Structural links always win: search only fills what they
 * leave empty.
 *
 * - `fillSearchLinks`: a commit subject or sentence with no `→ H#` link gets
 *   its TIED_TO hunks; one whose `implementedBy` is empty gets the files of its
 *   hunk links (search or structural), each marked `~` (linked at hunk level,
 *   less certain; docs and scripts included), when they are at most three.
 * - `addSearchEvidence`: the TOON layout's `code` column under each commit
 *   sentence, and doNotSay rows where an added comment or literal contradicts
 *   the sentence.
 */
import type { GraphEngine } from './engine.ts';
import type { Section } from './queries.ts';
import { addCodeCells, conflictRows, CODE_SHARE } from './codeEvidence.ts';
import { toToon } from './toon.ts';

/** Marks a search-linked file in `implementedBy`. */
export const SEARCH_MARK = '~';
/** Files and hunks a search link may fill in. */
const MAX_FILES = 3;
const MAX_HUNKS = 3;
/** Characters of code lines a brief always gets, whatever its size. */
const MIN_CODE_CHARS = 300;

const byNum = (a: string, b: string) =>
  Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''));

/** TIED_TO links of commit subjects and sentences, strongest first per source. */
function searchLinks(
  g: GraphEngine,
): Map<string, { hunk: string; file: string; score: number }[]> {
  const out = new Map<string, { hunk: string; file: string; score: number }[]>();
  let rows: Record<string, unknown>[] = [];
  try {
    rows = g.run(
      `MATCH (x)-[t:TIED_TO]->(h:Hunk) WHERE x:Commit OR x:CommitClaim
       RETURN x.id AS src, h.id AS hunk, h.file AS file, t.score AS score`,
    ).rows;
  } catch {
    return out; // a graph from before search links
  }
  for (const r of rows) {
    const list = out.get(String(r.src)) ?? [];
    list.push({
      hunk: String(r.hunk),
      file: String(r.file),
      score: Number(r.score ?? 0),
    });
    out.set(String(r.src), list);
  }
  for (const list of out.values())
    list.sort((a, b) => b.score - a.score || byNum(a.hunk, b.hunk));
  return out;
}

/**
 * Fill empty `implementedBy` cells and missing `→ H#` links of commit rows
 * from search links. Mutates `commitRows` and `hunkLinks`.
 */
export function fillSearchLinks(
  g: GraphEngine,
  commitRows: Record<string, unknown>[],
  hunkLinks: Record<string, string[]>,
): void {
  // Graphs built with Graph search none (or before it) carry no key lines:
  // their brief stays as it was.
  const hunks = g.run(
    'MATCH (h:Hunk) RETURN h.id AS id, h.file AS file, h.keyLines AS keyLines',
  ).rows;
  if (!hunks.some((h) => Array.isArray(h.keyLines))) return;
  const links = searchLinks(g);
  const fileOf = new Map(hunks.map((h) => [String(h.id), String(h.file)]));
  for (const r of commitRows) {
    const ref = String(r.ref);
    const list = links.get(ref) ?? [];
    if (!hunkLinks[ref]?.length && list.length)
      hunkLinks[ref] = [...new Set(list.map((l) => l.hunk))]
        .slice(0, MAX_HUNKS)
        .sort(byNum);
    // A file for the sentence from its hunk links (the `→ H#` the structural
    // match or the search found), when the file-level match placed none.
    if (!((r.implementedBy as string[] | undefined) ?? []).length) {
      const files = [
        ...new Set(
          (hunkLinks[ref] ?? [])
            .map((h) => fileOf.get(h))
            .filter((f): f is string => !!f),
        ),
      ];
      if (files.length && files.length <= MAX_FILES)
        r.implementedBy = files.map((f) => `${f}${SEARCH_MARK}`);
    }
  }
}

/**
 * Code lines under commit sentences (TOON layout only: the neighborhood
 * layouts already show each hunk's key lines) and commit-vs-code doNotSay rows.
 */
export function addSearchEvidence(
  g: GraphEngine,
  sections: Section[],
  hunkLinks: Record<string, string[]>,
  opts: { codeCells: boolean },
): void {
  try {
    // One budget for both: CODE_SHARE of the brief as it was.
    // The owners rows don't widen it: they are code pointers already.
    let budget = Math.round(
      toToon(sections.filter((s) => s.title !== 'owners')).length * CODE_SHARE,
    );
    const conflicts = conflictRows(g, sections, hunkLinks);
    const dns = sections.find((s) => s.title === 'doNotSay');
    if (dns && conflicts.length) {
      dns.rows.push(...conflicts);
      budget -= toToon([{ ...dns, rows: conflicts }]).length - dns.title.length;
    }
    // A few lines always fit: a small brief has the most room to grow.
    if (opts.codeCells)
      addCodeCells(g, sections, hunkLinks, Math.max(MIN_CODE_CHARS, budget));
  } catch {
    // Evidence extras never break the brief.
  }
}
