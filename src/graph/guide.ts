/**
 * The reviewer guide and coverage aids, derived from the evidence graph.
 *
 * Writers given the brief covered its facts but often left a reviewer without a
 * place to start or a word on what to look at, and turned the coverage check
 * into an inventory (judges' entry, feedback and economy scores). This adds:
 *
 * - `guide` rows: **start here** (the hunk most of this PR's requested,
 *   surviving work lands in, weighted by new symbols, branches and callers at
 *   the head commit), **look closely at** (open points, changed behavior whose
 *   code has callers, branching code no commit sentence describes) and
 *   **effect** rows (callers of a changed symbol and the change they now see).
 *   Citable, never required by render.
 * - `coverage` rows: what else covers a brief row (a commit sentence by the
 *   hunks it describes, a change by its hunks, a tests row by its file's hunks,
 *   one housekeeping row by another), which render's coverage check honours.
 * - one `cover` line naming the rows render requires, and how one sentence can
 *   cover several.
 *
 * TRACETOON_BRIEF_GUIDE=off leaves the brief as it was.
 */
import type { GraphEngine } from './engine.ts';
import type { Section } from './queries.ts';

type Row = Record<string, unknown>;
export const guideEnabled = () => process.env.TRACETOON_BRIEF_GUIDE !== 'off';

const str = (v: unknown) => (v == null ? '' : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
const SKIP_ROLES = new Set(['generated', 'version', 'lock', 'binary']);
const rowsOf = (sections: Section[], t: string): Row[] =>
  sections.find((s) => s.title === t)?.rows ?? [];

export interface GuideInput {
  g: GraphEngine;
  sections: Section[];
  /** briefParts' hunk rows: change, hunk, file, symbols (touched), branches, fresh. */
  hunkRows: Row[];
  /** Commit-message row ref → the hunks it describes. */
  hunkLinks: Record<string, string[]>;
  fileRole: Map<string, string>;
}

export function guideRows(input: GuideInput): Row[] {
  const { g, sections, hunkRows, hunkLinks, fileRole } = input;
  const requestRefs = new Set(rowsOf(sections, 'requests').map((r) => str(r.ref)));
  // Surviving edit lines per hunk from this PR's requests (each edit counted once).
  const surv = new Map<string, { lines: number; by: Map<string, number> }>();
  const seenEdit = new Set<string>();
  for (const r of g.run(
    `MATCH (h:Hunk)<-[s:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
     RETURN h.id AS hunk, e.id AS edit, s.lines AS lines, p.id AS prompt`,
  ).rows) {
    const key = `${str(r.hunk)}|${str(r.edit)}`;
    if (seenEdit.has(key) || !requestRefs.has(str(r.prompt))) continue;
    seenEdit.add(key);
    const x = surv.get(str(r.hunk)) ?? { lines: 0, by: new Map<string, number>() };
    x.lines += Number(r.lines ?? 0);
    x.by.set(str(r.prompt), (x.by.get(str(r.prompt)) ?? 0) + Number(r.lines ?? 0));
    surv.set(str(r.hunk), x);
  }
  // Callers at the head commit: how many other files name a symbol the hunk
  // defines or changes (HeadRef reference rows are keyed by the symbol's name).
  const termFiles = new Map<string, number>();
  try {
    for (const r of g.run(
      `MATCH (x:HeadRef) WHERE x.kind <> 'still mentions' RETURN x.term AS term, x.files AS files`,
    ).rows)
      termFiles.set(
        str(r.term),
        Math.max(termFiles.get(str(r.term)) ?? 0, Number(r.files ?? 0)),
      );
  } catch {
    // No head scan in this graph: no caller weights.
  }
  const callers = new Map<string, { files: number; term: string }>();
  for (const h of hunkRows) {
    let best: { files: number; term: string } | undefined;
    for (const t of [...list(h.fresh), ...list(h.symbols)]) {
      const n = termFiles.get(t) ?? 0;
      if (n && (!best || n > best.files)) best = { files: n, term: t };
    }
    if (best) callers.set(str(h.hunk), best);
  }
  const roleOf = (f: string) => fileRole.get(f) ?? '';
  const described = new Set(Object.values(hunkLinks).flat());
  // How many commit-message sentences describe each hunk: the code the PR's own
  // account of itself points at.
  const told = new Map<string, number>();
  for (const hs of Object.values(hunkLinks))
    for (const h of hs) told.set(h, (told.get(h) ?? 0) + 1);
  const symbolOf = (h: Row) => list(h.fresh)[0] ?? list(h.symbols)[0] ?? str(h.scope);

  const scored = hunkRows
    .filter((h) => !SKIP_ROLES.has(roleOf(str(h.file))))
    .map((h) => {
      const id = str(h.hunk);
      const s = surv.get(id);
      const c = callers.get(id);
      const role = roleOf(str(h.file));
      const score =
        Math.log2(1 + (s?.lines ?? 0)) +
        (list(h.fresh).length ? 1.5 : 0) +
        0.5 * Math.min(4, Number(h.branches ?? 0)) +
        Math.log2(1 + (c?.files ?? 0)) +
        1.2 * Math.min(3, told.get(id) ?? 0) +
        (role === 'behavior' ? 1 : role === 'tests' || role === 'docs' ? -1.5 : 0);
      return { h, id, s, c, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const out: Row[] = [];
  const top = scored[0];
  if (top) {
    const why: string[] = [];
    // The amount of requested work only, never which request: a prompt whose edits
    // land here is not necessarily why the change was made (judges counted that as
    // inviting "the user asked for…").
    if (top.s?.lines)
      why.push(`${top.s.lines} surviving edit line(s) from this PR's requests`);
    if (told.get(top.id)) why.push(`${told.get(top.id)} commit sentence(s) describe it`);
    if (list(top.h.fresh).length)
      why.push(`defines ${list(top.h.fresh).slice(0, 2).join(', ')}`);
    if (Number(top.h.branches)) why.push(`${Number(top.h.branches)} branching line(s)`);
    if (top.c?.files)
      why.push(`\`${top.c.term}\` is named in ${top.c.files} other file(s)`);
    const sym = symbolOf(top.h);
    out.push({
      kind: 'start here',
      text: `${str(top.h.file)}${sym ? ` (${sym})` : ''}: ${why.join('; ') || 'the main behavior change'}`,
      cites: [str(top.h.change)],
    });
  }

  const look: Row[] = [];
  for (const r of rowsOf(sections, 'limits'))
    if (r.kind === 'open')
      look.push({
        kind: 'look closely at',
        text: `open point: ${clip(str(r.limit), 160)}`,
        cites: [str(r.ref)],
      });
  const changes = rowsOf(sections, 'changes');
  // A change's behavior lines from the file a hunk is in (they start "<basename>:").
  const behaviorIn = (c: Row, file: string) => {
    const base = file.split('/').pop()!;
    return list(c.behavior).filter((b) => b.startsWith(`${base}:`));
  };
  const withEffect = new Set<string>();
  for (const c of changes) {
    const x = scored.find(
      (y) =>
        str(y.h.change) === str(c.change) &&
        y.c?.files &&
        behaviorIn(c, str(y.h.file)).length,
    );
    if (!x) continue;
    withEffect.add(str(c.change));
    look.push({
      kind: 'look closely at',
      text: `${clip(behaviorIn(c, str(x.h.file))[0]!, 140)} — \`${x.c!.term}\` is named in ${x.c!.files} other file(s)`,
      cites: [str(c.change)],
    });
  }
  for (const x of scored)
    if (
      Number(x.h.branches) >= 2 &&
      x !== top &&
      !described.has(x.id) &&
      roleOf(str(x.h.file)) === 'behavior'
    ) {
      const sym = symbolOf(x.h);
      look.push({
        kind: 'look closely at',
        text: `${str(x.h.file)}${sym ? ` (${sym})` : ''}: ${Number(x.h.branches)} branching line(s) no commit sentence describes; each path should be described or left unclaimed`,
        cites: [str(x.h.change)],
      });
    }
  out.push(...look.slice(0, 3));

  // Effects: callers of a changed symbol and the behavior change in its own file,
  // for changes the look-closely items above don't already name.
  const shownLook = new Set(look.slice(0, 3).map((r) => list(r.cites)[0]));
  const effects: Row[] = [];
  for (const c of changes) {
    if (shownLook.has(str(c.change)) && withEffect.has(str(c.change))) continue;
    const x = scored.find(
      (y) =>
        str(y.h.change) === str(c.change) &&
        y.c?.files &&
        behaviorIn(c, str(y.h.file)).length,
    );
    if (!x) continue;
    effects.push({
      kind: 'effect',
      text: `\`${x.c!.term}\` is named in ${x.c!.files} other file(s), which now see: ${clip(behaviorIn(c, str(x.h.file))[0]!, 140)}`,
      cites: [str(c.change)],
    });
  }
  out.push(...effects.slice(0, 2));
  return out.map((r, i) => ({ ref: `G${i + 1}`, ...r }));
}

/** What else covers a brief row, for render's coverage check. */
export function coverageRows(
  sections: Section[],
  hunkRows: Row[],
  hunkLinks: Record<string, string[]>,
): Row[] {
  const out: Row[] = [];
  for (const [ref, hs] of Object.entries(hunkLinks))
    if (hs.length) out.push({ ref, coveredBy: hs });
  for (const c of rowsOf(sections, 'changes')) {
    const hs = hunkRows
      .filter((h) => str(h.change) === str(c.change))
      .map((h) => str(h.hunk));
    if (hs.length) out.push({ ref: str(c.change), coveredBy: hs });
  }
  for (const t of rowsOf(sections, 'tests')) {
    const hs = hunkRows
      .filter((h) => str(h.file) === str(t.file))
      .map((h) => str(h.hunk));
    if (hs.length) out.push({ ref: str(t.ref), coveredBy: hs });
  }
  const hk = rowsOf(sections, 'housekeeping').map((r) => str(r.ref));
  for (const r of hk) out.push({ ref: r, coveredBy: hk.filter((x) => x !== r) });
  return out;
}

/** The rows render requires a tagged sentence for, and how to cover several at once. */
export function coverLine(sections: Section[]): string | undefined {
  const parts: string[] = [];
  const changes = rowsOf(sections, 'changes').map((r) => str(r.change));
  if (changes.length) parts.push(changes.join(' '));
  const byCommit = new Map<string, string[]>();
  for (const r of rowsOf(sections, 'commitMessages')) {
    const ref = str(r.ref);
    const text = str(r.text);
    if (!ref.includes('#') || text.split(/\s+/).length < 4 || text.endsWith(':'))
      continue;
    const [sha, n] = ref.split('#');
    byCommit.set(sha!, [...(byCommit.get(sha!) ?? []), `#${n}`]);
  }
  for (const [sha, ns] of byCommit)
    parts.push(`${sha.replace(/^commit:/, '').slice(0, 12)} ${ns.join(' ')}`);
  const tests = rowsOf(sections, 'tests').map((r) => str(r.ref));
  if (tests.length) parts.push(tests.join(' '));
  const hk = rowsOf(sections, 'housekeeping').map((r) => str(r.ref));
  if (hk.length) parts.push(hk.join(' '));
  const open = rowsOf(sections, 'limits')
    .filter((r) => r.kind === 'open')
    .map((r) => str(r.ref));
  if (open.length) parts.push(`${open.join(' ')} (open points)`);
  const goal = rowsOf(sections, 'requests')
    .filter((r) => str(r.kind).startsWith('goal'))
    .map((r) => str(r.ref));
  if (goal.length) parts.push(`${goal.join(' ')} (the goal)`);
  if (!parts.length) return undefined;
  return `Render checks that each of these is cited: ${parts.join(' · ')}. One sentence may carry several refs; citing a commit's short sha covers all its sentences, a change's hunk covers the change, and one housekeeping ref covers all housekeeping — so cover them in a few grouped sentences, not one sentence per row.`;
}
