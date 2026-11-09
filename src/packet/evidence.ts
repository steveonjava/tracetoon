/**
 * The relational arm's review-packet evidence: what the lean reviewer
 * (reviewer-lean.md) reads below the title and body. Built from the run's own
 * files only: changes.patch (re-chunked with the arm's chunker, so H ids match
 * the writer's context), relational-context.json (refs and the store's links),
 * body.md (the writer's ref tags) and brief-check.json (render's last check).
 * See docs/review-packet-design.md.
 *
 * Sections, each there for a check the reviewer makes:
 * - refs per body line: which evidence each sentence claims to rest on;
 * - requests: verbatim text for "the user asked" claims;
 * - commit messages: every sentence, what code (if any) the store ties it to,
 *   and whether it reports a result: facts only a message states;
 * - files and chunks: owning symbol, new vs redefined names, test titles,
 *   branching lines and changes.patch ranges, for "new", "where" and absolutes;
 * - coverage leads: files the body never names or cites, untagged sentences;
 * - the diff with changes.patch line numbers (whole when small; otherwise the
 *   cited chunks, test assertions, branching chunks and chunks adding names).
 *
 * Nothing here reads the evidence graph.
 */
import { ASSERTION, LOCKFILE, WHOLE_DIFF_CHARS } from '../commands/review.ts';
import type { PacketEvidence } from '../commands/review.ts';
import { readJson, type Run } from '../run.ts';
import {
  relationalVectorMode,
  type RelationalContext,
  type StoreLinks,
} from '../relational/index.ts';
import { chunkPatch, testTitle, type Chunk, type DiffFile } from '../relational/diff.ts';
import { sentenceCoverage } from '../relational/coverage.ts';
import { clip, oneLine } from '../relational/text.ts';

export interface PacketEvidenceInput {
  run: Run;
  title: string;
  /** The rendered body (body:N numbering). */
  body: string;
  /** body.md as drafted, with its ref tags. */
  draft?: string;
  patch: string;
}

/** The relational context file (src/graph/evidence.ts writes it; the name is fixed). */
export const CONTEXT_FILE = 'relational-context.json';
/** Longest diff line shown, in characters. */
const LINE_MAX = 240;
/** Context lines kept around a selected chunk's changed lines. */
const AROUND = 3;

export const LEGEND =
  'Cite: body:N (body line), diff:N or diff:N-M (changes.patch line, left of each diff line), commit:<sha>#n, S#/D#/P# (requests), or path:line. H# (chunk) and F# (file) are labels for reading: cite their diff: range instead.';

/** A changed line that branches or falls back: a path the code may or may not take. */
const BRANCH =
  /\b(if|else|elif|elsif|switch|case|catch|except|unless|guard|default|finally)\b|\?\?|\|\||&&|\s\?\s/;
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!include)|--\s|<!--)/;

/** The writer's ref tags, as render reads them. */
const REF = String.raw`(?:[A-Z]{1,3}\d+|(?:commit:)?[0-9a-f]{7,40}(?:#\d+)?)`;
const TAG = new RegExp(String.raw`\s?\[(${REF}(?:\s*[,;]\s*${REF})*)\](?!\()`, 'g');

type Ch = Chunk & { fileId: string };

const roleOf = (f: DiffFile) => (f.binary ? 'generated' : f.role);
const skippedFile = (f: DiffFile) =>
  f.binary || f.role === 'generated' || f.role === 'version' || LOCKFILE.test(f.path);
const norm = (s: string) =>
  s
    .replace(/[`*_]/g, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
const commitKey = (ref: string) => ref.replace(/^commit:/, '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (xs: string[], n: number) =>
  xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} +${xs.length - n}`;
const range = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}`);

/** Each body line's ref tags, matched from body.md (tags stripped) to the rendered body. */
export function refsByBodyLine(
  body: string,
  draft: string | undefined,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!draft) return out;
  const lines = body.split(/\r?\n/).map(norm);
  let from = 0;
  for (const raw of draft.split(/\r?\n/)) {
    const refs = [...raw.matchAll(TAG)].flatMap((m) => m[1]!.split(/\s*[,;]\s*/));
    if (!refs.length) continue;
    const clean = norm(raw.replace(TAG, ''));
    if (!clean) continue;
    let i = lines.indexOf(clean, from);
    if (i < 0) i = lines.indexOf(clean);
    if (i < 0) continue;
    from = i + 1;
    out.set(i + 1, [...new Set([...(out.get(i + 1) ?? []), ...refs])]);
  }
  return out;
}

/** Links from the context when they still describe this patch's chunks. */
function linksFor(
  ctx: RelationalContext | undefined,
  chunks: Ch[],
): StoreLinks | undefined {
  const l = ctx?.links;
  if (!l || l.v !== 1 || l.chunks.length !== chunks.length) return undefined;
  const same = l.chunks.every((c, i) => {
    const x = chunks[i]!;
    return c.id === x.id && c.file === x.file && c.start === x.start && c.end === x.end;
  });
  return same ? l : undefined;
}

export function buildPacketEvidence(
  input: PacketEvidenceInput,
): PacketEvidence | undefined {
  if (!relationalVectorMode()) return undefined;
  const ctx = readJson<RelationalContext>(input.run, CONTEXT_FILE);
  if (!ctx) return undefined;
  return relationalPacket(input, ctx);
}

/** The packet evidence from a relational context (exported for tests). */
export function relationalPacket(
  input: PacketEvidenceInput,
  ctx: RelationalContext,
): PacketEvidence {
  const { patch, body, draft, title } = input;
  const patchLines = patch.split(/\r?\n/);
  const { files, chunks } = chunkPatch(patch);
  const links = linksFor(ctx, chunks);
  const fileById = new Map(files.map((f, i) => [`F${i + 1}`, f]));
  const refText = new Map(ctx.refs.map((r) => [r.id, r.text]));
  const linkOf = new Map((links?.chunks ?? []).map((c) => [c.id, c]));

  // ---- What the body cites and names -----------------------------------
  const byLine = refsByBodyLine(body, draft);
  const tags = new Set(
    [...(draft ?? '').matchAll(TAG)].flatMap((m) => m[1]!.split(/\s*[,;]\s*/)),
  );
  const citedKey = (ref: string) => {
    const k = commitKey(ref);
    return [...tags].some((t) => {
      const c = commitKey(t);
      if (c === k) return true;
      const [a, an] = c.split('#');
      const [x, xn] = k.split('#');
      return (
        /^[0-9a-f]{7,}$/.test(a!) &&
        /^[0-9a-f]{7,}$/.test(x!) &&
        (an ?? '') === (xn ?? '') &&
        (x!.startsWith(a!) || a!.startsWith(x!))
      );
    });
  };
  const prose = `${title}\n${body}`;
  const named = (f: DiffFile) => {
    if (prose.includes(f.path)) return true;
    const base = f.path.split('/').pop()!;
    return base.includes('.') && new RegExp(`(^|[^\\w./-])${esc(base)}\\b`).test(prose);
  };
  const ticked = new Set(
    [...prose.matchAll(/`([^`\n]{2,80})`/g)].map((m) => m[1]!.replace(/\(\)$/, '')),
  );

  // ---- Per-chunk facts -----------------------------------------------------
  const removedAnywhere = new Set(chunks.flatMap((c) => c.removedDefs));
  const fileOf = (c: Ch) => fileById.get(c.fileId)!;
  const branchesOf = (c: Ch) => {
    const role = roleOf(fileOf(c));
    if (role === 'docs' || role === 'tests' || skippedFile(fileOf(c))) return 0;
    return c.lines.filter((l) => !COMMENT.test(l.text) && BRANCH.test(l.text)).length;
  };
  const branches = new Map(chunks.map((c) => [c.id, branchesOf(c)]));
  const fresh = (c: Ch) => c.defined.filter((d) => !removedAnywhere.has(d));
  const sentenceChunks = new Map(
    (links?.sentences ?? []).map((s) => [s.id, s.chunks] as const),
  );
  const coverage = links ? sentenceCoverage(links) : [];
  const cited = new Set<string>();
  for (const c of chunks) {
    const f = fileOf(c);
    if (
      tags.has(c.id) ||
      tags.has(c.fileId) ||
      named(f) ||
      c.defined.some((d) => ticked.has(d))
    )
      cited.add(c.id);
  }
  // A cited commit sentence points at the code it is tied to.
  for (const [sid, ids] of sentenceChunks)
    if (citedKey(sid)) for (const id of ids) cited.add(id);

  // ---- Which patch lines each chunk shows ----------------------------------
  const hunkOf = (c: Ch) => fileOf(c).hunks[c.hunk]!;
  const lineSet = (c: Ch): number[] => {
    const f = fileOf(c);
    const h = hunkOf(c);
    const head = h.patchNo!;
    if (roleOf(f) === 'tests') {
      const keep = c.lines
        .filter(
          (l) =>
            (l.sign === '+' && (ASSERTION.test(l.text) || testTitle(l.text))) ||
            (l.sign === '-' && ASSERTION.test(l.text)),
        )
        .map((l) => l.patchNo!);
      return keep.length ? [head, ...keep] : [];
    }
    const nums = c.lines.map((l) => l.patchNo!);
    const a = Math.min(...nums);
    const b = Math.max(...nums);
    const last = h.lines.at(-1)?.patchNo ?? b;
    const out = [head];
    for (let n = Math.max(head + 1, a - AROUND); n <= Math.min(last, b + AROUND); n++)
      out.push(n);
    return out;
  };
  const shownLines = new Map<string, number[]>();
  for (const c of chunks) if (!skippedFile(fileOf(c))) shownLines.set(c.id, lineSet(c));
  const charsOf = (ns: Iterable<number>) => {
    let n = 0;
    for (const x of ns) n += Math.min(LINE_MAX, (patchLines[x - 1] ?? '').length) + 1;
    return n;
  };
  const allLines = new Set([...shownLines.values()].flat());
  const totalChars = charsOf(allLines);
  const mode: PacketEvidence['mode'] =
    totalChars <= WHOLE_DIFF_CHARS ? 'whole' : 'selected';
  const shown = new Set<string>();
  const show = new Set<number>();
  if (mode === 'whole') {
    for (const [id, ns] of shownLines) if (ns.length) shown.add(id);
    for (const n of allLines) show.add(n);
  } else {
    // Priority: what the body cites, test assertions, branching code, new names.
    const isTest = (c: Ch) => roleOf(fileOf(c)) === 'tests';
    const tiers: Ch[][] = [
      chunks.filter((c) => cited.has(c.id)),
      chunks.filter(isTest),
      [...chunks]
        .filter((c) => branches.get(c.id)! > 0)
        .sort((a, b) => branches.get(b.id)! - branches.get(a.id)! || byId(a.id, b.id)),
      chunks.filter((c) => fresh(c).length),
    ];
    let used = 0;
    for (const tier of tiers)
      for (const c of tier) {
        const ns = shownLines.get(c.id);
        if (!ns?.length || shown.has(c.id)) continue;
        const add = charsOf(ns.filter((n) => !show.has(n)));
        if (used + add > WHOLE_DIFF_CHARS) continue;
        used += add;
        shown.add(c.id);
        for (const n of ns) show.add(n);
      }
  }

  const out: string[] = [];

  // ---- Refs per body line ----------------------------------------------------
  if (byLine.size) {
    out.push(
      "## Refs per body line (the writer's tags; an untagged line rests on nothing)",
      '',
    );
    for (const [n, refs] of [...byLine].sort((a, b) => a[0] - b[0]))
      out.push(`body:${n} ← ${refs.join(', ')}`);
    out.push('');
  }

  // ---- Requests ------------------------------------------------------------------
  const factIds = new Set<string>();
  const facts: { id: string; kind: string; labels: string[]; text: string }[] = [];
  const isFact = (id: string) => /^[SDP]\d+$/.test(id);
  for (const f of links?.facts ?? [])
    if (
      refText.has(f.id) ||
      tags.has(f.id) ||
      f.labels.some((l) => /opening request|pushback|sent back/.test(l))
    ) {
      facts.push(f);
      factIds.add(f.id);
    }
  for (const r of ctx.refs)
    if (isFact(r.id) && !factIds.has(r.id)) {
      facts.push({
        id: r.id,
        kind: r.id[0] === 'S' ? 'prompt' : r.id[0] === 'D' ? 'decision' : 'plan',
        labels: [],
        text: r.text,
      });
      factIds.add(r.id);
    }
  if (facts.length) {
    out.push('## Requests (verbatim; a "the user asked" claim must match one)', '');
    for (const f of facts) {
      const labels = f.labels.length ? f.labels : f.kind === 'prompt' ? [] : [f.kind];
      const max =
        f.kind === 'prompt' && (tags.has(f.id) || labels.includes('opening request'))
          ? 1200
          : tags.has(f.id)
            ? 600
            : 300;
      out.push(
        `${f.id}${labels.length ? ` (${labels.join('; ')})` : ''}${tags.has(f.id) ? ' [cited]' : ''}: "${clip(f.text, max)}"`,
      );
    }
    out.push('');
  }

  // ---- Commit messages -------------------------------------------------------
  const short = (id: string) => {
    const c = chunks.find((x) => x.id === id);
    return c ? `${id} ${c.file.split('/').pop()}` : id;
  };
  const coveredBy = new Map(coverage.map((r) => [r.ref, r.coveredBy]));
  const sentenceState = (sid: string) =>
    citedKey(sid) || citedKey(sid.split('#')[0]!)
      ? 'cited'
      : (coveredBy.get(sid) ?? []).some((h) => tags.has(h))
        ? 'covered by its code'
        : 'not cited';
  const commitLines: string[] = [];
  if (links) {
    for (const k of links.commits) {
      const own = k.chunks;
      commitLines.push(
        `${k.id} "${clip(k.subject, 160)}" own code: ${own.length ? names(own, 12) : '(no changed lines matched)'}`,
      );
      for (const s of links.sentences.filter((x) => x.id.startsWith(`${k.id}#`))) {
        const tie = s.chunks.length
          ? `→ ${s.chunks.map(short).join(', ')}`
          : '→ nothing tied (only the message states this)';
        commitLines.push(
          `  ${s.id.slice(k.id.length)} "${clip(s.text, 300)}" ${s.result ? '(reports a result: not a recorded run) ' : ''}${tie} | ${sentenceState(s.id)}`,
        );
      }
    }
  } else {
    for (const r of ctx.refs)
      if (/^commit:[0-9a-f]+(#\d+)?$/.test(r.id))
        commitLines.push(
          `${r.id} "${clip(r.text, 300)}"${r.id.includes('#') ? ` | ${citedKey(r.id) ? 'cited' : 'not cited'}` : ''}`,
        );
  }
  if (commitLines.length)
    out.push(
      '## Commit messages (facts only a message states; "→" = the code the store ties a sentence to, within its own commit; #n = commit:<sha>#n)',
      '',
      ...commitLines,
      '',
    );

  // A request tied to most chunks (the opening ask) says nothing about any one of them.
  const tiedTo = new Map<string, number>();
  for (const c of links?.chunks ?? [])
    for (const x of c.why) tiedTo.set(x, (tiedTo.get(x) ?? 0) + 1);
  const broad = new Set(
    [...tiedTo]
      .filter(([, n]) => chunks.length > 3 && n > chunks.length / 3)
      .map(([x]) => x),
  );

  // ---- Files and chunks --------------------------------------------------------
  out.push(
    `## Files and chunks (L: new-file lines; in: owning symbol; new: defined here, removed nowhere; redefines: existed before; branches: changed lines with if/else/case/catch/??/||/&&/default; asked in: requests whose edits or text tie to it${mode === 'selected' ? '; shown: its lines are in the diff below' : ''})`,
    '',
  );
  for (const [fid, f] of fileById) {
    const status =
      f.status === 'added'
        ? 'new'
        : f.status === 'deleted'
          ? 'deleted'
          : f.status === 'renamed'
            ? `renamed from ${f.oldPath}`
            : 'modified';
    const role = roleOf(f);
    const meta = [
      status,
      f.binary ? 'binary' : role === 'behavior' ? '' : role,
      f.binary ? '' : `+${f.added}/−${f.removed}`,
    ]
      .filter(Boolean)
      .join(', ');
    const list = chunks.filter((c) => c.fileId === fid);
    if (skippedFile(f)) {
      out.push(
        `${fid} ${f.path} (${meta}): diff not shown${list.length ? ` (${list.map((c) => `${c.id} ${diffRange(c)}`).join(', ')})` : ''}`,
      );
      continue;
    }
    out.push(`${fid} ${f.path} (${meta})`);
    const plain: string[] = [];
    for (const c of list) {
      const parts: string[] = [];
      if (c.scope) parts.push(`in ${c.scope}`);
      const nw = fresh(c);
      const re = c.defined.filter((d) => !nw.includes(d));
      if (nw.length) parts.push(`new: ${names(nw, 6)}`);
      if (re.length) parts.push(`redefines: ${names(re, 6)}`);
      const gone = c.removedDefs.filter((d) => !c.defined.includes(d));
      if (gone.length) parts.push(`removes: ${names(gone, 6)}`);
      if (c.tests.length)
        parts.push(
          `tests: ${c.tests
            .slice(0, 6)
            .map((t) => `"${clip(t, 90)}"`)
            .join('; ')}${c.tests.length > 6 ? ` +${c.tests.length - 6}` : ''}`,
        );
      const l = linkOf.get(c.id);
      if (l?.uses.length) parts.push(`uses ${l.uses.slice(0, 4).join(', ')}`);
      const b = branches.get(c.id)!;
      if (b) parts.push(`branches ${b}`);
      const asked = (l?.why ?? []).filter((x) => isFact(x) && !broad.has(x));
      if (asked.length) parts.push(`asked in ${asked.slice(0, 3).join(', ')}`);
      if (cited.has(c.id)) parts.push('cited');
      const isShown = shown.has(c.id);
      if (!parts.length && (isShown || mode === 'selected')) {
        plain.push(`${c.id} ${diffRange(c)}`);
        continue;
      }
      if (isShown) parts.push(role === 'tests' ? 'assertions shown' : 'shown');
      out.push(
        `  ${c.id} L${range(c.start, c.end)} ${diffRange(c)} +${c.added}/−${c.removed} | ${parts.join(' | ')}`,
      );
    }
    if (plain.length) out.push(`  also ${plain.join(', ')}`);
  }
  out.push('');

  // ---- Coverage leads -----------------------------------------------------------
  const leads: string[] = [];
  const silent = [...fileById].filter(
    ([fid, f]) =>
      !named(f) &&
      !tags.has(fid) &&
      !chunks.some((c) => c.fileId === fid && cited.has(c.id)),
  );
  if (silent.length)
    leads.push(
      `- files the body neither names nor cites: ${silent.map(([fid, f]) => `${fid} ${f.path}`).join(', ')}`,
    );
  const check = readJson<{
    untagged?: string[];
    flags?: { sentence: string; problem: string }[];
  }>(input.run, 'brief-check.json');
  const bodyLines = body.split(/\r?\n/).map(norm);
  const lineOf = (s: string) => {
    const n = norm(s);
    const i = bodyLines.findIndex((l) => l.includes(n));
    return i >= 0 ? `body:${i + 1}` : `"${clip(s, 80)}"`;
  };
  if (check?.untagged?.length)
    leads.push(
      `- untagged sentences (render): ${[...new Set(check.untagged.map(lineOf))].join(', ')}`,
    );
  for (const f of check?.flags ?? [])
    leads.push(`- render flag at ${lineOf(f.sentence)}: ${clip(f.problem, 200)}`);
  if (!links)
    leads.push(
      "- the store's links were not available for this patch: commit sentences show no tied code.",
    );
  if (leads.length) out.push('## Coverage leads', '', ...leads, '');

  // ---- Diff -----------------------------------------------------------------------
  const shownChars = charsOf(show);
  out.push(
    mode === 'whole'
      ? `## Diff (whole: ${shownChars} chars without generated, lock, version and binary files; test files reduced to titles and assertions)`
      : `## Diff (selected: ${shownChars} of ${totalChars} chars; the chunks the body cites, test assertions, branching chunks and chunks adding names; for others use tracetoon source <path> --run ${input.run.id})`,
    '',
  );
  const w = String(patchLines.length).length;
  const fileAt: { from: number; fid: string }[] = files
    .map((f, i) => ({ from: f.hunks[0]?.patchNo ?? Infinity, fid: `F${i + 1}` }))
    .filter((x) => Number.isFinite(x.from));
  const fidOfLine = (n: number) => {
    let cur: string | undefined;
    for (const x of fileAt) if (x.from <= n) cur = x.fid;
    return cur;
  };
  let lastFile: string | undefined;
  let prev = 0;
  for (const n of [...show].sort((a, b) => a - b)) {
    const fid = fidOfLine(n);
    if (fid !== lastFile) {
      lastFile = fid;
      out.push(`### ${fid ? `${fileById.get(fid)!.path} (${fid})` : '?'}`);
    } else if (n !== prev + 1) out.push(`${''.padStart(w)} …`);
    const text = patchLines[n - 1] ?? '';
    out.push(
      `${String(n).padStart(w)} ${text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text}`,
    );
    prev = n;
  }
  if (!show.size) out.push('(No diff lines to show.)');

  return {
    lines: out,
    mode,
    diffChars: shownChars,
    shownHunks: [...shown].sort(byId),
    legend: LEGEND,
  };

  function diffRange(c: Ch): string {
    const nums = c.lines.map((l) => l.patchNo!);
    return `diff:${range(Math.min(...nums), Math.max(...nums))}`;
  }
}

function byId(a: string, b: string): number {
  return Number(a.slice(1)) - Number(b.slice(1));
}
