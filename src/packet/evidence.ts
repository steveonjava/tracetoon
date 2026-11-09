/**
 * The graph arm's review-packet evidence: claim neighborhoods.
 *
 * For each sentence the draft tags, the packet shows what its refs resolve to
 * in the evidence graph — a commit sentence with the hunks it describes, a
 * change unit with its hunks, a hunk with its file and owning symbols, a request
 * or limit verbatim — and then the diff lines of exactly those hunks. Branching
 * hunks no sentence reaches, the brief rows render found uncovered, and
 * untagged sentences are listed so the reviewer checks omissions and stray
 * claims where they can be, not across the whole patch.
 */
import { patchHunks, type PatchHunk } from '../graph/build.ts';
import { graphBriefParts, loadGraph } from '../graph/evidence.ts';
import type { Section } from '../graph/queries.ts';
import { readJson, type Run } from '../run.ts';
import {
  ASSERTION,
  lineRange,
  roleOf,
  skipped,
  type PacketEvidence,
} from '../commands/review.ts';

export interface PacketEvidenceInput {
  run: Run;
  title: string;
  /** The rendered body (body:N numbering). */
  body: string;
  /** body.md as drafted, with its ref tags. */
  draft?: string;
  patch: string;
}

const TAG =
  /\[((?:[A-Za-z]+\d+|commit:[0-9a-f]{7,40}(?:#\d+)?|[0-9a-f]{7,40}(?:#\d+)?)(?:\s*[,;]\s*(?:[A-Za-z]+\d+|commit:[0-9a-f]{7,40}(?:#\d+)?|[0-9a-f]{7,40}(?:#\d+)?))*)\]/g;
const clip = (s: unknown, n = 300) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const shaOf = (ref: string) => ref.replace(/^commit:/, '');

export function buildPacketEvidence(
  input: PacketEvidenceInput,
): PacketEvidence | undefined {
  const graph = loadGraph(input.run);
  const parts = graph ? graphBriefParts(graph)?.sections : undefined;
  if (!graph || !parts || !input.draft) return undefined; // the default packet
  const rows = (t: string) => parts.find((s: Section) => s.title === t)?.rows ?? [];
  const hunkRows = rows('hunks');
  if (!hunkRows.length) return undefined;
  const byRef = new Map<string, Record<string, unknown>>();
  for (const t of [
    'changes',
    'requests',
    'commitMessages',
    'limits',
    'tests',
    'housekeeping',
    'hunks',
  ])
    for (const r of rows(t))
      byRef.set(String(r.change && t === 'changes' ? r.change : r.ref), r);
  const sentenceHunks = new Map<string, string[]>();
  for (const h of hunkRows)
    for (const s of list(h.sentences))
      sentenceHunks.set(shaOf(s), [
        ...(sentenceHunks.get(shaOf(s)) ?? []),
        String(h.ref),
      ]);
  const changeHunks = (ch: string) =>
    hunkRows.filter((h) => h.change === ch).map((h) => String(h.ref));
  const findCommitRow = (ref: string) => {
    const r = shaOf(ref);
    for (const row of rows('commitMessages')) {
      const k = shaOf(String(row.ref));
      const [a, an] = k.split('#');
      const [b, bn] = r.split('#');
      if ((an ?? '') === (bn ?? '') && (a!.startsWith(b!) || b!.startsWith(a!)))
        return row;
    }
    return undefined;
  };

  // Rendered body lines, to give each tagged draft sentence its body:N.
  const bodyLines = input.body.split(/\r?\n/);
  const lineOf = (text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    const i = bodyLines.findIndex((l) => l.replace(/\s+/g, ' ').includes(t.slice(0, 80)));
    return i >= 0 ? i + 1 : undefined;
  };

  const patchLines = input.patch.split(/\r?\n/);
  const hunks = patchHunks(input.patch);
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const role = roleOf(graph);
  const claimLines: string[] = [];
  const reached = new Set<string>();
  const untagged: string[] = [];
  const evidenceLine = (ref: string): { text: string; hunks: string[] } | undefined => {
    if (/^CH\d+$/.test(ref)) {
      const r = byRef.get(ref);
      const hs = changeHunks(ref);
      return {
        text: `${ref}: change, ${list(r?.where).slice(0, 4).join(' · ')}${list(r?.newSymbols).length ? ` | new: ${list(r?.newSymbols).join(', ')}` : ''} → ${hs.join(' ')}`,
        hunks: hs,
      };
    }
    if (/^H\d+$/.test(ref)) {
      const r = byRef.get(ref);
      const h = hunkById.get(ref);
      return {
        text: `${ref}: ${String(r?.file ?? h?.file ?? '')} ${String(r?.lines ?? '')}${h?.touched.length ? ` (${h.touched.join(', ')})` : ''}${h?.fresh.length ? ` | new: ${h.fresh.join(', ')}` : ''}`,
        hunks: [ref],
      };
    }
    if (/^[SDP]\d+$/.test(ref)) {
      const r = byRef.get(ref);
      return r
        ? { text: `${ref}: (${clip(r.kind, 80)}) "${clip(r.text, 400)}"`, hunks: [] }
        : undefined;
    }
    if (/^L\d+$/.test(ref)) {
      const r = byRef.get(ref);
      return r
        ? { text: `${ref}: limit (${String(r.kind)}): ${clip(r.limit, 300)}`, hunks: [] }
        : undefined;
    }
    if (/^T\d+$/.test(ref)) {
      const r = byRef.get(ref);
      const hs = hunkRows.filter((h) => h.file === r?.file).map((h) => String(h.ref));
      return r
        ? {
            text: `${ref}: tests in ${String(r.file)}: ${clip(list(r.titles).join('; '), 400)}`,
            hunks: hs,
          }
        : undefined;
    }
    if (/^HK\d+$/.test(ref)) {
      const r = byRef.get(ref);
      return r
        ? { text: `${ref}: housekeeping: ${clip(r.what, 200)}`, hunks: [] }
        : undefined;
    }
    const c = findCommitRow(ref);
    if (c) {
      const hs = sentenceHunks.get(shaOf(String(c.ref))) ?? [];
      return {
        text: `${String(c.ref)}: commit message: "${clip(c.text, 300)}"${hs.length ? ` → ${hs.join(' ')}` : ' (no hunk linked)'}`,
        hunks: hs,
      };
    }
    return undefined; // validation rows and unknown refs: not packet evidence
  };

  for (const raw of input.draft.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('|'))
      continue;
    // Sentences: split on sentence ends that are followed by a capital or a tag-free start.
    for (const sent of line.split(/(?<=[.!?]\]?)\s+(?=[A-Z`"(])/)) {
      const tags = [...sent.matchAll(TAG)].flatMap((m) => m[1]!.split(/\s*[,;]\s*/));
      const clean = sent.replace(TAG, '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.split(/\s+/).length < 4) continue;
      if (!tags.length) {
        untagged.push(clean);
        continue;
      }
      const n = lineOf(clean);
      claimLines.push(
        `- ${n ? `body:${n}` : 'body'} "${clip(clean, 240)}" cites ${tags.join(', ')}`,
      );
      for (const t of tags) {
        const e = evidenceLine(t);
        if (!e) continue;
        claimLines.push(`  - ${e.text}`);
        for (const h of e.hunks) reached.add(h);
      }
    }
  }

  // Coverage gaps and stray sentences, from render's last check.
  const check = readJson<{ uncovered?: string[]; repeated?: string[] }>(
    input.run,
    'brief-check.json',
  );
  const uncovered = check?.uncovered ?? [];

  // Diff: reached hunks, plus branching hunks no sentence reaches.
  const reduce = (h: PatchHunk) => {
    const r = role(h.file);
    if (skipped(h.file, r)) return undefined;
    const [a, b] = lineRange(h.diff);
    const keep: number[] = [];
    for (let n = a; n <= b; n++) {
      const l = patchLines[n - 1] ?? '';
      if (r !== 'tests' || n === a || (l.startsWith('+') && ASSERTION.test(l)))
        keep.push(n);
    }
    return keep;
  };
  const unclaimed = hunks.filter(
    (h) => h.branches > 0 && !reached.has(h.id) && !skipped(h.file, role(h.file)),
  );
  const show = hunks.filter((h) => reached.has(h.id) || unclaimed.includes(h));
  const w = String(patchLines.length).length;
  const diff: string[] = [];
  let file: string | undefined;
  let chars = 0;
  for (const h of show) {
    const keep = reduce(h);
    if (!keep?.length) continue;
    if (h.file !== file) {
      file = h.file;
      diff.push(`### ${file}`);
    }
    if (unclaimed.includes(h))
      diff.push(
        `(${h.id}: branching, no sentence cites it: check for a missing condition)`,
      );
    for (const n of keep) {
      const l = `${String(n).padStart(w)} ${patchLines[n - 1]}`;
      chars += l.length + 1;
      diff.push(l);
    }
  }

  const index = hunks
    .filter((h) => !skipped(h.file, role(h.file)))
    .map(
      (h) =>
        `- ${h.id} ${h.file} ${h.diff}${h.touched.length ? ` | ${h.touched.slice(0, 3).join(', ')}` : ''}${h.fresh.length ? ` | new: ${h.fresh.slice(0, 3).join(', ')}` : ''}${h.branches ? ' | branches' : ''}`,
    );

  const lines = [
    '## Claims and their evidence (from the evidence graph)',
    '',
    'Each tagged sentence, then what each cited ref is: a commit-message sentence and the hunks it describes (→ H#), a change and its hunks, a hunk and its owning symbols, a request or limit verbatim.',
    '',
    ...(claimLines.length ? claimLines : ['(No tagged sentences.)']),
    '',
    '## Brief rows no sentence covers (check omissions here)',
    '',
    ...(uncovered.length
      ? uncovered.map((u) => `- ${u}`)
      : ['(None: every brief row is cited.)']),
    '',
    '## Untagged sentences (check them against the hunk index and diff)',
    '',
    ...(untagged.length ? untagged.map((u) => `- "${clip(u, 240)}"`) : ['(None.)']),
    '',
    '## Hunk index (every hunk; generated, lock and version files left out)',
    '',
    ...index,
    '',
    `## Diff: the hunks the claims cite, and branching hunks no claim cites (${chars} chars; test files reduced to assertions)`,
    '',
    ...(diff.length ? diff : ['(No hunks to show.)']),
  ];
  return {
    lines,
    mode: 'selected',
    diffChars: chars,
    shownHunks: show.map((h) => h.id),
    legend:
      'Cite: body:N (body line), diff:N (changes.patch line, left of each diff line), the refs shown below (CH#, H#, commit:<sha>#n, L#, T#, S#), or path:line. Use `tracetoon source <path> --run <id>` (at most 3 lookups) for a hunk not shown.',
  };
}
