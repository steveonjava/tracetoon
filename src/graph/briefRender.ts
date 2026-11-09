/**
 * What `render` does with the evidence brief:
 *
 * - writes the Validation section itself from the brief's validation rows, at
 *   the `<!-- tracetoon:validation -->` marker, so no writer restates (and
 *   rewords) run results;
 * - removes the writer's ref tags (`[CH1, S1]`) and reports sentences with no
 *   tag or an unknown ref, tagged sentences naming code their refs don't
 *   mention, and run or test claims made outside that section.
 *
 * The checks are advisory; the text is deterministic.
 */
import type { Section } from './queries.ts';

export const VALIDATION_MARKER = '<!-- tracetoon:validation -->';

export interface BriefParts {
  sections: Section[];
  unchecked: string[];
}

export interface BriefApplied {
  text: string;
  /** The Validation section was written at the marker. */
  validation: boolean;
  /** Ref tags found and removed. */
  tags: number;
  unknownRefs: string[];
  /** Sentences that state something but carry no ref tag. */
  untagged: string[];
  /** Run, test or check claims outside the generated Validation section. */
  validationClaims: string[];
  /** Tagged sentences that name code (`fn`, a type, a file) no cited row mentions. */
  unbackedNames: { sentence: string; names: string[] }[];
  /** Brief rows no tag cites: change units, commit sentences, tests, housekeeping, the goal. */
  uncovered: string[];
  /** Sentences that overstate what the brief backs, with what to fix. */
  flags: { sentence: string; problem: string; severity: 'fix' | 'check' }[];
  /** Findings an earlier render already reported: listed, but no longer blocking. */
  repeated?: string[];
}

const rowsOf = (b: BriefParts, title: string) =>
  b.sections.find((s) => s.title === title)?.rows ?? [];

/** A command as run, without output redirections (files, /dev/null, redacted paths). */
export function shownCommand(cmd: unknown): string {
  return String(cmd ?? '')
    .replace(/\s+(\d?>>?|&>)\s*(&\d|<[^>\s]+>|"[^"]*"|'[^']*'|[^\s;|&]+)/g, '')
    .replace(/\s+([;|&]{1,2})\s*/g, ' $1 ')
    .trim();
}

const plain = (s: unknown) =>
  String(s ?? '')
    .replace(/\*\*|__|`/g, '')
    .trim()
    .replace(/[.!]+$/, '');

const list = (xs: unknown) => {
  const a = (Array.isArray(xs) ? xs : []).map(String).filter(Boolean);
  const more = /^\+(\d+) more$/.exec(a.at(-1) ?? '');
  return more ? `${a.slice(0, -1).join(', ')} and ${more[1]} more` : a.join(', ');
};

/** Most a reader needs: the test runs first, then the other checks. */
const KIND_ORDER = ['test', 'typecheck', 'lint', 'build', 'eval'];
const MAX_LINES = 3;

/**
 * The Validation section, from the brief's validation rows only: at most five
 * lines, test runs first. Rows with a withheld command, and non-test checks
 * whose result Tracetoon couldn't read, say nothing a reviewer can use and are
 * left out. The "may predate the final code" caveat is said once, at the end.
 */
export function validationSection(b: BriefParts): string {
  // Only recorded results, at most three lines: the whole suite and the latest
  // focused test run, then a typecheck or lint. Commit-message results, runs with
  // no captured result and files with no passing run after their last edit are
  // open points the prose covers (limits rows), so they aren't repeated here.
  // Every check Tracetoon ran on the submitted content (V receipts) is shown,
  // whatever its kind (a dropped `bun run bundle` receipt cost a dev19 pair);
  // session-log runs fill the rest, up to three lines in all.
  const shown: { kind: string; line: string; when: string; current: boolean }[] = [];
  const perKind = new Map<string, number>();
  const rows = rowsOf(b, 'validation').filter(
    (r) => r.outcome === 'passed' || r.outcome === 'failed',
  );
  const receipts = rows.filter((r) => /^V\d/.test(String(r.check ?? '')));
  const logRuns = rows.filter((r) => !/^V\d/.test(String(r.check ?? '')));
  for (const r of receipts.slice(0, 5)) {
    const cmd = shownCommand(r.cmd);
    if (!cmd || /‹withheld›|<withheld>/.test(cmd)) continue;
    shown.push({
      kind: String(r.kind),
      line: `- \`${cmd}\`: ${String(r.outcome)}${r.result ? ` (${plain(r.result)})` : ''}, run by \`tracetoon check\` on the submitted content.`,
      when: 'fresh',
      current: true,
    });
  }
  for (const r of logRuns) {
    if (shown.length >= MAX_LINES) break;
    const kind = String(r.kind);
    if (!['test', 'typecheck', 'lint', 'build'].includes(kind)) continue;
    const cmd = shownCommand(r.cmd);
    if (!cmd || /‹withheld›|<withheld>/.test(cmd)) continue;
    // A receipt for the same command already says more.
    if (shown.some((x) => x.current && x.line.startsWith(`- \`${cmd}\`:`))) continue;
    const n = perKind.get(kind) ?? 0;
    if (n >= (kind === 'test' ? 2 : 1)) continue;
    perKind.set(kind, n + 1);
    // A run from the session logs is history, with no counts a reader can't check.
    const editedAll = (Array.isArray(r.editedAfter) ? r.editedAfter : []).map(String);
    const edited = editedAll.length > 2 ? `${editedAll.length} files` : list(editedAll);
    shown.push({
      kind,
      line: `- \`${cmd}\`: ${String(r.outcome)} in the session logs${edited ? `, before later edits to ${edited}` : ''}.`,
      when: String(r.when ?? ''),
      current: false,
    });
  }
  const order = (k: string) =>
    KIND_ORDER.indexOf(k) < 0 ? KIND_ORDER.length : KIND_ORDER.indexOf(k);
  const lines = [
    ...shown.filter((x) => x.current),
    ...shown.filter((x) => !x.current).sort((x, y) => order(x.kind) - order(y.kind)),
  ].map((x) => x.line);
  if (!lines.length)
    lines.push(
      '- No passing or failing test, typecheck or lint run was recorded in the captured sessions.',
    );
  // Said once, and only when a shown run is dated by the logs' last edit rather
  // than checked against the submitted content.
  const predates = shown.some((x) => x.when.startsWith('after the last edit'));
  const fresh = shown.some((x) => /submitted content|fresh/i.test(x.when));
  if (predates && !fresh)
    lines.push("- Tracetoon can't tell whether these runs saw the final commit.");
  return [
    '## Validation',
    '',
    '<sub>Written by Tracetoon from the checks recorded in the session logs.</sub>',
    '',
    ...lines,
  ].join('\n');
}

/** Every ref a writer may cite. */
export function briefRefs(b: BriefParts): Set<string> {
  const out = new Set<string>();
  for (const s of b.sections)
    for (const r of s.rows)
      for (const k of ['change', 'ref', 'check'])
        if (typeof r[k] === 'string' && r[k]) out.add(r[k] as string);
  // `commit:<sha>` rows also answer to the short sha, and claim refs to `commit:<sha>#n`.
  for (const ref of [...out]) {
    const m = /^(?:commit:)?([0-9a-f]{7,40})(#\d+)?$/.exec(ref);
    if (m) {
      out.add(`commit:${m[1]}${m[2] ?? ''}`);
      out.add(`${m[1]}${m[2] ?? ''}`);
    }
  }
  return out;
}

/** The text of every row each ref names, for checking what a tagged sentence cites. */
function refTexts(b: BriefParts): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const sec of b.sections)
    for (const r of sec.rows)
      for (const k of ['change', 'ref', 'check'])
        if (typeof r[k] === 'string' && r[k])
          out.push({
            key: (r[k] as string).replace(/^commit:/, ''),
            text: JSON.stringify(r),
          });
  return out;
}

const citedText = (rows: { key: string; text: string }[], refs: string[]) =>
  refs
    .map((ref) => ref.replace(/^commit:/, ''))
    .flatMap((ref) =>
      rows.filter((r) =>
        /^[0-9a-f]{7,40}(#\d+)?$/.test(ref)
          ? r.key.startsWith(ref.split('#')[0]!) || ref.startsWith(r.key.split('#')[0]!)
          : r.key === ref,
      ),
    )
    .map((r) => r.text)
    .join('\n');

/**
 * Code a sentence names: backticked names shaped like code (`a_b`, `a.b`,
 * `src/x.ts`, `fn()`, `camelCase`, `PascalCase`) and bare lowerCamel words.
 * Plain words and product names (`pushd`, OpenAI) are not checked.
 */
function codeNames(sentence: string): string[] {
  const names = new Set<string>();
  for (const m of sentence.matchAll(/`([^`\s]+)`/g)) {
    const raw = m[1]!;
    const n = raw.replace(/\(\)$/, '');
    // Code, not URLs or versions (`file:///`, `v1.0.0-rc.10`).
    if (!/^[A-Za-z_.][\w.$/-]*$/.test(n) || /^v?\d|:\/\/|^rc\.\d/i.test(n)) continue;
    if (raw.endsWith('()') || /[_./]/.test(n) || /[a-z][A-Z]/.test(n)) names.add(n);
  }
  for (const m of sentence.replace(/`[^`]*`/g, ' ').matchAll(/\b([a-z]+[A-Z]\w*)\b/g))
    names.add(m[1]!);
  return [...names];
}

/** Known, or a 7+ character prefix of a known commit sha (`421ce02` for `commit:421ce024cc68`). */
function knownRef(known: Set<string>, ref: string): boolean {
  if (known.has(ref)) return true;
  const m = /^(?:commit:)?([0-9a-f]{7,40})(#\d+)?$/.exec(ref);
  if (!m) return false;
  for (const k of known) {
    const n = /^(?:commit:)?([0-9a-f]{7,40})(#\d+)?$/.exec(k);
    if (n && n[1]!.startsWith(m[1]!) && (n[2] ?? '') === (m[2] ?? '')) return true;
  }
  return false;
}

const REF = String.raw`(?:[A-Z]{1,3}\d+|(?:commit:)?[0-9a-f]{7,40}(?:#\d+)?)`;
const TAG = new RegExp(String.raw`\s?\[(${REF}(?:\s*[,;]\s*${REF})*)\](?!\()`, 'g');

/** Run, test or check results stated in prose. */
const VALIDATION_CLAIM =
  /\b(\d+\s*(pass|passed|fail|failed|failures?)\b|tests? (pass|passed|fail|failed|ran|run)\b|(passed|passes|passing|failed|failing)\b|untested|not tested|exercised|typecheck(s|ed)?\b|no recorded run)/i;

/** Lines of prose: skips headings, code, HTML, tables and the generated section. */
function proseUnits(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line || /^(#|<|\||-{3,}|\*{3,})/.test(line)) continue;
    const body = line.replace(/^([-*+]|\d+[.)])\s+/, '');
    for (const s of body.split(/(?<=[.!?])\s+(?=[A-Z`"(])/))
      if (s.trim()) out.push(s.trim());
  }
  return out;
}

/**
 * Removes ref tags, writes the Validation section at the marker, and reports
 * what the evidence brief doesn't back. Without a brief only the marker is
 * dropped.
 */
export function applyBrief(body: string, b: BriefParts | undefined): BriefApplied {
  if (!b)
    return {
      text: body.replace(`${VALIDATION_MARKER}\n`, '').replace(VALIDATION_MARKER, ''),
      validation: false,
      tags: 0,
      unknownRefs: [],
      untagged: [],
      validationClaims: [],
      unbackedNames: [],
      uncovered: [],
      flags: [],
    };
  const known = briefRefs(b);
  const flags: BriefApplied['flags'] = [];
  const cites = new Set<string>();
  const commitRows = rowsOf(b, 'commitMessages');
  const commitRow = (ref: string) => {
    const r = ref.replace(/^commit:/, '');
    return commitRows.find((x) => {
      const k = String(x.ref).replace(/^commit:/, '');
      const [a, an] = k.split('#');
      const [c, cn] = r.split('#');
      return (an ?? '') === (cn ?? '') && (a!.startsWith(c!) || c!.startsWith(a!));
    });
  };
  const changeRows = rowsOf(b, 'changes');
  const symbolsOf = (where: unknown) =>
    (Array.isArray(where) ? where : []).flatMap((w) => {
      const m = /\(([^)]*)\)/.exec(String(w));
      return m ? m[1]!.split(/,\s*/) : [];
    });
  // Files and symbols the brief places somewhere: naming one of these in the
  // wrong place is a misattribution; an unlisted name (a JSON field) is not.
  const placed = [
    ...changeRows.flatMap((r) => (Array.isArray(r.where) ? r.where : [])),
    ...commitRows.flatMap((r) => (Array.isArray(r.implementedBy) ? r.implementedBy : [])),
  ].map(String);
  const placedNames = new Set(
    placed.flatMap((w) => {
      const file = w.replace(/\s*\(.*$/, '');
      return [file, file.split('/').pop()!, ...symbolsOf([w])];
    }),
  );
  const fresh = new Set(changeRows.flatMap((r) => (r.newSymbols as string[]) ?? []));
  const existing = new Set(
    changeRows.flatMap((r) => symbolsOf(r.where)).filter((x) => !fresh.has(x)),
  );
  const limitText = rowsOf(b, 'limits')
    .map((r) => String(r.limit ?? ''))
    .join('\n');
  const unknown = new Set<string>();
  let tags = 0;
  const untagged: string[] = [];
  const validationClaims: string[] = [];
  const unbackedNames: BriefApplied['unbackedNames'] = [];
  const rows = refTexts(b);
  for (const unit of proseUnits(body)) {
    const found = [...unit.matchAll(TAG)];
    const clean = unit.replace(TAG, '').trim();
    // A result attributed to the commit message that states it is allowed (the
    // rules say to attribute it), so it is not a run claim.
    const attributed =
      /\bcommit messages?\b/i.test(clean) ||
      found.some((m) => /(^|[\s,;])(commit:)?[0-9a-f]{7,40}(#\d+)?\b/.test(m[1]!));
    if (VALIDATION_CLAIM.test(clean) && !attributed) validationClaims.push(clean);
    if (!found.length) {
      // Short labels and lead-ins ("Changes:", "Start here") state nothing.
      if (clean.split(/\s+/).length >= 5 && !clean.endsWith(':')) untagged.push(clean);
      continue;
    }
    const refs = found.flatMap((m) => m[1]!.split(/\s*[,;]\s*/));
    for (const ref of refs) {
      tags++;
      if (!knownRef(known, ref)) unknown.add(ref);
      cites.add(ref.replace(/^commit:/, ''));
    }
    // Where a cited commit sentence's code is known (implementedBy), names
    // must come from there; otherwise from any cited row. Citing a broad
    // change unit doesn't license pinning a commit's behavior on its files.
    const located = refs
      .map(commitRow)
      .filter(
        (r) =>
          r && Array.isArray(r.implementedBy) && (r.implementedBy as string[]).length,
      );
    // Only a located commit sentence can show a name is in the wrong place;
    // a name merely missing from the brief (its rows are capped) proves nothing.
    if (located.length) {
      const cited = located
        .map((r) => (r!.implementedBy as string[]).join('\n'))
        .join('\n');
      const names = codeNames(clean).filter(
        (n) =>
          placedNames.has(n.split('/').pop()!) &&
          !cited.includes(n) &&
          !cited.includes(n.split('/').pop()!),
      );
      if (names.length) unbackedNames.push({ sentence: clean, names });
    }
    const named = codeNames(clean);
    // "New" for code that already existed.
    {
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const old = named.filter(
        (n) =>
          existing.has(n) &&
          (new RegExp(
            `\\b(new|adds?|added|adding|introduc\\w*|creates?|created)\\s+(?:an?\\s+|the\\s+)?[^.,;:]{0,30}?\`?${esc(n)}\\b`,
            'i',
          ).test(clean) ||
            new RegExp(`\`?${esc(n)}\`?\\s+(?:is|are)\\s+(?:a\\s+)?new\\b`, 'i').test(
              clean,
            )),
      );
      if (old.length)
        flags.push({
          sentence: clean,
          severity: 'fix',
          problem: `${old.map((n) => `\`${n}\``).join(', ')} already existed (not in newSymbols): say it changed, not that it is new.`,
        });
    }
    // Universal words about code that branches.
    const universal = /\b(only|always|all|every|no longer|never)\b/i.exec(clean)?.[1];
    if (universal) {
      const branchy = named.filter((n) => limitText.includes(n));
      if (branchy.length)
        flags.push({
          sentence: clean,
          severity: 'check',
          problem: `"${universal}": ${branchy.join(', ')} has conditional paths; read them in the patch and keep "${universal}" if every path in the patch does this; otherwise qualify the sentence. Don't drop the behavior.`,
        });
    }
    // PR or issue links, and scope statements, that only a commit message makes.
    const commitOnly = refs.every((r) => /^(commit:)?[0-9a-f]{7,40}(#\d+)?$/.test(r));
    if (
      commitOnly &&
      /(#\d+|\bPR\s*\d+|\bissue\b|not part of)/i.test(clean) &&
      !/commit message/i.test(clean)
    )
      flags.push({
        sentence: clean,
        severity: 'fix',
        problem:
          'only a commit message says this: write "the commit message says…" or leave it out.',
      });
  }
  // Brief refs are for render, not readers: one left in the prose (outside a tag) is noise.
  for (const unit of proseUnits(body)) {
    const clean = unit.replace(TAG, '');
    const leaked = (clean.match(/\b(?:CH|HK|[STLRDP])\d+\b/g) ?? []).filter((r) =>
      known.has(r),
    );
    if (leaked.length)
      flags.push({
        sentence: clean.trim(),
        severity: 'fix',
        problem: `${uniqList(leaked).join(', ')} is a brief ref, not something a reader can follow: say what it refers to, and keep refs only in the [tags].`,
      });
  }
  // Brief rows nothing cites: each deserves a sentence.
  const cited = (ref: unknown) => {
    const r = String(ref ?? '').replace(/^commit:/, '');
    return [...cites].some((c) => {
      if (c === r) return true;
      const [a, an] = c.split('#');
      const [x, xn] = r.split('#');
      return (
        /^[0-9a-f]{7,}$/.test(a!) &&
        (an ?? '') === (xn ?? '') &&
        (x!.startsWith(a!) || a!.startsWith(x!))
      );
    });
  };
  const uncovered: string[] = [];
  for (const r of changeRows)
    if (!cited(r.change)) uncovered.push(`${String(r.change)}: ${list(r.where)}`);
  for (const r of commitRows) {
    const text = String(r.text ?? '');
    if (
      !String(r.ref).includes('#') ||
      text.split(/\s+/).length < 4 ||
      text.endsWith(':')
    )
      continue;
    // A sentence is covered by its own ref or by citing the whole commit.
    const whole = String(r.ref).split('#')[0];
    if (!cited(r.ref) && !cited(whole))
      uncovered.push(`${String(r.ref)}: ${clipped(text)}`);
  }
  for (const r of [...rowsOf(b, 'tests'), ...rowsOf(b, 'housekeeping')])
    if (!cited(r.ref))
      uncovered.push(`${String(r.ref)}: ${String(r.file ?? r.what ?? '')}`);
  // Open points: each deserves a sentence saying what the evidence leaves open.
  for (const r of rowsOf(b, 'limits'))
    if (r.kind === 'open' && !cited(r.ref))
      uncovered.push(`${String(r.ref)} (open point): ${clipped(String(r.limit ?? ''))}`);

  for (const r of rowsOf(b, 'requests'))
    if (String(r.kind ?? '').startsWith('goal') && !cited(r.ref))
      uncovered.push(`${String(r.ref)} (the goal): ${clipped(String(r.text ?? ''))}`);
  let text = body.replace(TAG, '');
  // The section brings its own heading: drop a writer's heading right above the marker.
  text = text.replace(
    new RegExp(String.raw`^#{1,6}[^\n]*\n(\s*\n)*(?=${VALIDATION_MARKER})`, 'm'),
    '',
  );
  const validation = text.includes(VALIDATION_MARKER);
  if (validation) text = text.replace(VALIDATION_MARKER, validationSection(b));
  return {
    text,
    validation,
    tags,
    unknownRefs: [...unknown].sort(),
    untagged,
    validationClaims,
    unbackedNames,
    uncovered,
    flags,
  };
}

const uniqList = (xs: string[]) => [...new Set(xs)];
const clipped = (s: string) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);

/**
 * Report each brief-check finding once: a finding an earlier render of this run
 * already listed moves to `repeated` and stops blocking. A finding the writer
 * can't clear (a false positive, a row with nothing to say) otherwise sends the
 * writer round render and review again and again. Returns the updated record of
 * findings seen.
 */
export function demoteRepeats(b: BriefApplied, seen: string[]): string[] {
  const before = new Set(seen);
  const now: string[] = [];
  const repeated: string[] = [];
  const keep = <T>(items: T[], kind: string, text: (x: T) => string): T[] =>
    items.filter((x) => {
      const key = `${kind}: ${text(x)}`;
      now.push(key);
      if (!before.has(key)) return true;
      repeated.push(key);
      return false;
    });
  b.untagged = keep(b.untagged, 'untagged', (x) => x);
  b.validationClaims = keep(b.validationClaims, 'run claim', (x) => x);
  b.unknownRefs = keep(b.unknownRefs, 'unknown ref', (x) => x);
  b.uncovered = keep(b.uncovered, 'uncovered', (x) => x);
  b.flags = keep(b.flags, 'flag', (f) => `${f.sentence} → ${f.problem}`);
  b.repeated = repeated;
  return [...new Set([...seen, ...now])];
}
