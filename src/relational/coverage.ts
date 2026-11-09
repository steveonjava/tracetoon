/**
 * Which diff chunks stand for each commit-message sentence, from the store's
 * own links (relational-context.json `links`), so `render` counts a sentence
 * covered when the body cites the code it describes.
 */
import type { StoreLinks } from './index.ts';

/** A commit with at most this many chunks of its own lends them to sentences search tied to nothing. */
export const SMALL_COMMIT_CHUNKS = 3;

/**
 * Coverage rows `{ref, coveredBy}`: each sentence is covered by the chunks
 * hybrid search tied it to within its own commit; a sentence tied to none, in a
 * commit whose own lines are in at most three chunks, by those chunks. `rowRefs`
 * are the refs render's commit rows use (a sentence's row may name its commit by
 * a shorter sha): a row keyed by one of them replaces the store's own id.
 */
export function sentenceCoverage(
  links: StoreLinks,
  rowRefs: string[] = [],
): { ref: string; coveredBy: string[] }[] {
  const parse = (ref: string) => /^(?:commit:)?([0-9a-f]{7,40})#(\d+)$/.exec(ref);
  const rowFor = (id: string) => {
    const m = parse(id);
    if (!m) return id;
    const hit = rowRefs.find((r) => {
      const x = parse(r);
      return !!x && x[2] === m[2] && (x[1]!.startsWith(m[1]!) || m[1]!.startsWith(x[1]!));
    });
    return hit ?? id;
  };
  const commitChunks = new Map(links.commits.map((c) => [c.id, c.chunks]));
  const out: { ref: string; coveredBy: string[] }[] = [];
  for (const s of links.sentences) {
    const own = commitChunks.get(s.id.split('#')[0]!) ?? [];
    const by = s.chunks.length ? s.chunks : own.length <= SMALL_COMMIT_CHUNKS ? own : [];
    if (by.length) out.push({ ref: rowFor(s.id), coveredBy: [...by] });
  }
  return out;
}
