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
import { existingSymbols, housekeepingOverclaim } from './doNotSay.ts';
import { wordsOf } from './codeEvidence.ts';

export const VALIDATION_MARKER = '<!-- tracetoon:validation -->';

export interface BriefParts {
  sections: Section[];
  unchecked: string[];
  /** Symbols (or files) whose changed lines branch or fall back. */
  branchy?: string[];
  /** Changed source functions and the stemmed words the brief ties to each (`functionProfiles`). */
  owners?: { name: string; file: string; nameWords: string[]; words: string[] }[];
  /** A `tracetoon check` receipt passed on the submitted content. */
  freshPass?: boolean;
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

/**
 * A session-log validation row render may state: a recorded result with
 * result lines, from one command. Exported for replays.
 */
export function logRunStatable(r: Record<string, unknown>): boolean {
  if (r.outcome !== 'passed' && r.outcome !== 'failed') return false;
  if (!plain(r.result)) return false;
  return !shownCommand(r.cmd).includes(' ; ');
}

/** Files edited after a run, by name: at most four, else a count with the first two. */
function editedList(xs: unknown): string {
  const all = (Array.isArray(xs) ? xs : []).map(String).filter(Boolean);
  const more = /^\+(\d+) more$/.exec(all.at(-1) ?? '');
  const names = more ? all.slice(0, -1) : all;
  const total = names.length + (more ? Number(more[1]) : 0);
  if (total <= 4) return list(names);
  return `${total} files, among them ${names.slice(0, 2).join(' and ')}`;
}

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
  // session-log runs fill the rest, one per kind with no receipt, up to three
  // lines in all. An earlier failure of a shown kind gets one clause; the
  // whole history is a process fact, not repeated here.
  const shown: { kind: string; line: string; when: string; current: boolean }[] = [];
  const perKind = new Map<string, number>();
  const rows = rowsOf(b, 'validation').filter(
    (r) => r.outcome === 'passed' || r.outcome === 'failed',
  );
  const receipts = rows.filter((r) => /^V\d/.test(String(r.check ?? '')));
  const logRuns = rows.filter((r) => !/^V\d/.test(String(r.check ?? '')));
  // Every receipt is listed, each command once: a later receipt for the same
  // command (a rerun under another check name) replaces the earlier one.
  const latest = new Map<string, (typeof receipts)[number]>();
  for (const r of receipts) {
    const cmd = shownCommand(r.cmd);
    if (!cmd || /‹withheld›|<withheld>/.test(cmd)) continue;
    latest.delete(cmd);
    latest.set(cmd, r);
  }
  for (const [cmd, r] of latest) {
    shown.push({
      kind: String(r.kind),
      line: `- \`${cmd}\`: ${String(r.outcome)}${
        r.result
          ? ` (${plain(r.result)
              .split(/\s*;\s*/)
              .map((x) => x.trim())
              .filter(Boolean)
              .join(', ')})`
          : ''
      }, run by \`tracetoon check\` on the submitted content.`,
      when: 'fresh',
      current: true,
    });
  }
  const receiptKinds = new Set(receipts.map((r) => String(r.kind)));
  for (const r of logRuns) {
    if (shown.length >= MAX_LINES) break;
    const kind = String(r.kind);
    if (!['test', 'typecheck', 'lint', 'build'].includes(kind)) continue;
    if (receiptKinds.has(kind)) continue;
    const cmd = shownCommand(r.cmd);
    if (!cmd || /‹withheld›|<withheld>/.test(cmd)) continue;
    // Only a result a reader can find in the session: result lines of its own,
    // from one command (not several sharing an output). A pass known only from
    // an exit status, or a merged output, is dropped rather than hedged.
    if (!logRunStatable(r)) continue;
    // A receipt for the same command already says more.
    if (shown.some((x) => x.current && x.line.startsWith(`- \`${cmd}\`:`))) continue;
    const n = perKind.get(kind) ?? 0;
    if (n >= 1) continue;
    perKind.set(kind, n + 1);
    // A run from the session logs is history: its own result lines, which the
    // session shows next to the command, and the files edited after it by name.
    const edited = editedList(r.editedAfter);
    // An earlier failure of the kind, in one clause (the brief's `earlier`
    // column: "`cmd` failed (4 pass, 1 fail)"), when this run passed.
    const earlier =
      r.outcome === 'passed' && typeof r.earlier === 'string' && r.earlier.trim()
        ? r.earlier
            .trim()
            .replace(/[.;]+$/, '')
            .replace(/;\s*/g, ', ')
        : '';
    shown.push({
      kind,
      // A run with later edits says so even when they aren't PR files, as
      // the claim check (digest/claims.ts) requires of a stale run.
      line: `- \`${cmd}\`: ${String(r.outcome)} (${plain(r.result).replace(/;\s*/g, ', ')}) in the session logs${edited ? `, before later edits to ${edited}` : String(r.when ?? '').startsWith('before later edits') ? ', before later edits' : ''}.${earlier ? ` An earlier run of ${earlier}.` : ''}`,
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
  // A commit's rows (`<sha>`, `<sha>#n`) also answer to `commit:<sha>` and `commit:<sha>#n`.
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

/**
 * A ref a writer may put in a tag: a brief ref (`CH1`, `S2`, `L3`), a commit
 * (`commit:<sha>#n`), a patch range (`diff:660-684`) or a session (`h:<hash>`).
 * Patch ranges and sessions are stripped like the others but never unknown.
 */
const REF = String.raw`(?:[A-Z]{1,3}\d+|(?:commit:)?[0-9a-f]{7,40}(?:#\d+)?|diff:\d+(?:-\d+)?|h:[0-9a-f]{6,40})`;
const TAG = new RegExp(
  String.raw`[ \t]?\[(${REF}(?:\s*[,;]\s*${REF}|\s+${REF})*)\s*\](?!\()`,
  'g',
);
/** Splits a tag's refs at commas, semicolons or spaces. */
const tagRefs = (inner: string) => inner.split(/\s*[,;]\s*|\s+/).filter(Boolean);
/** Patch ranges and session ids: citable without a brief row. */
const LOOSE_REF = /^(?:diff:\d+(?:-\d+)?|h:[0-9a-f]{6,40})$/;

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
 * what the evidence brief doesn't back. Without a brief the marker and the
 * tags are dropped.
 */
export function applyBrief(body: string, b: BriefParts | undefined): BriefApplied {
  if (!b)
    return {
      // Ref tags never reach readers, even when no brief could be loaded.
      text: body
        .replace(`${VALIDATION_MARKER}\n`, '')
        .replace(VALIDATION_MARKER, '')
        .replace(TAG, ''),
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
  // The same names the brief's doNotSay rows list as existing before this PR.
  const existing = new Set(existingSymbols(b.sections));
  // Names with conditional paths: from the brief's branch list, and any limit naming them.
  const limitText = [
    ...(b.branchy ?? []),
    ...rowsOf(b, 'limits').map((r) => String(r.limit ?? '')),
  ].join('\n');
  const unknown = new Set<string>();
  let tags = 0;
  const untagged: string[] = [];
  const validationClaims: string[] = [];
  const unbackedNames: BriefApplied['unbackedNames'] = [];
  const rows = refTexts(b);
  for (const unit of proseUnits(body)) {
    const found = [...unit.matchAll(TAG)];
    const clean = unit.replace(TAG, '').trim();
    if (VALIDATION_CLAIM.test(clean)) validationClaims.push(clean);
    if (!found.length) {
      // Short labels and lead-ins ("Changes:", "Start here") state nothing.
      if (clean.split(/\s+/).length >= 5 && !clean.endsWith(':')) untagged.push(clean);
      continue;
    }
    const refs = found.flatMap((m) => tagRefs(m[1]!));
    for (const ref of refs) {
      tags++;
      if (!LOOSE_REF.test(ref) && !knownRef(known, ref)) unknown.add(ref);
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
  // A review pointer that pins a behavior on the wrong function.
  for (const unit of proseUnits(body)) {
    const p = misplacedFocus(unit.replace(TAG, '').trim(), b.owners ?? []);
    if (p) flags.push(p);
  }
  // "Version bump only" / "no logic changes" while the diff changes more.
  for (const unit of proseUnits(body)) {
    const clean = unit.replace(TAG, '').trim();
    const missing = housekeepingOverclaim(clean, b.sections);
    if (missing)
      flags.push({
        sentence: clean,
        severity: 'fix',
        problem: `the diff also changes ${missing.join(', ')}: don't call it housekeeping, a version bump or "no logic changes" only; name what else changed.`,
      });
  }
  // "No passing run after the last commit" next to a Validation section that
  // lists fresh passes from `tracetoon check`: the limit held at prepare time,
  // not after the writer's own checks (r21, judged contradicted).
  const freshPass =
    !!b.freshPass ||
    rowsOf(b, 'validation').some(
      (r) => /^V\d/.test(String(r.check ?? '')) && r.outcome === 'passed',
    );
  if (freshPass)
    for (const unit of proseUnits(body)) {
      const clean = unit.replace(TAG, '').trim();
      if (staleNoPass(clean))
        flags.push({
          sentence: clean,
          severity: 'fix',
          problem:
            'the Validation section shows fresh passing checks run by `tracetoon check` on the submitted content; drop or narrow this sentence.',
        });
    }
  // Behaviors grouped under one test file that another file's titles show.
  const testRows = rowsOf(b, 'tests');
  for (const unit of proseUnits(body)) {
    const p = misattributedTests(unit.replace(TAG, '').trim(), testRows);
    if (p) flags.push(p);
  }
  // Brief refs are for render, not readers: one left in the prose (outside a tag) is noise.
  for (const unit of proseUnits(body)) {
    const clean = unit.replace(TAG, '');
    const leaked = (clean.match(/\b(?:CH|HK|PR|[STLRDPH])\d+\b/g) ?? []).filter((r) =>
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

/** "Start at / review `fn`, especially <behavior>": the behavior clause. */
const FOCUS =
  /\b(especially|particularly|in particular|(?:with a )?focus(?:ing)? on|above all|mainly)\b([^.;!?]*)/i;
const POINTER = /\b(start|starting|begin|beginning|review|reviewers?)\b/i;

/**
 * A sentence pointing reviewers at a function (`start`/`begin`/`review` and a
 * backticked function) with an "especially <behavior>" clause, where the
 * behavior's words match what the brief ties to another changed function
 * (its name counts double) better than the named one's: the writer has
 * pinned a caller's or callee's behavior on the entry point.
 */
export function misplacedFocus(
  sentence: string,
  owners: NonNullable<BriefParts['owners']>,
): BriefApplied['flags'][number] | undefined {
  if (!owners.length || !POINTER.test(sentence)) return undefined;
  const focus = FOCUS.exec(sentence);
  if (!focus) return undefined;
  const byName = new Map(owners.map((o) => [o.name, o]));
  const named = [
    ...new Set(
      [...sentence.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)].map((m) => m[1]!),
    ),
  ].filter((n) => byName.has(n));
  if (!named.length) return undefined;
  const behavior = [...wordsOf(focus[2]!.replace(/`[^`]*`/g, ' '))];
  if (!behavior.length) return undefined;
  const score = (o: NonNullable<BriefParts['owners']>[number]) =>
    behavior.reduce(
      (n, w) => n + (o.nameWords.includes(w) ? 2 : 0) + (o.words.includes(w) ? 1 : 0),
      0,
    );
  const mine = Math.max(...named.map((n) => score(byName.get(n)!)));
  const ranked = owners
    .filter((o) => !named.includes(o.name))
    .map((o) => ({ o, n: score(o) }))
    .sort((a, b) => b.n - a.n || a.o.name.localeCompare(b.o.name));
  const top = ranked[0];
  if (!top || top.n < 2 || top.n <= mine) return undefined;
  // Functions that fit equally well: name them all (at most two).
  const rivals = ranked
    .filter((r) => r.n === top.n)
    .slice(0, 2)
    .map((r) => `\`${r.o.name}\` (${r.o.file})`);
  return {
    sentence,
    severity: 'check',
    problem: `"${focus[1]}${clipped(focus[2]!).trimEnd()}": the brief ties that to ${rivals.join(' or ')}, not to ${named.map((n) => `\`${n}\``).join(', ')}. Name the function that owns it, or drop the clause.`,
  };
}

/**
 * "No passing/successful run (or check, test) … after the last commit/edit":
 * true before `tracetoon check` ran, stale once a receipt passed on the
 * submitted content.
 */
export function staleNoPass(sentence: string): boolean {
  return (
    /\bno\b[^.;!?]{0,60}?\b(?:passing|successful|green|passed)\b[^.;!?]{0,60}?\bafter\s+the\s+(?:last|latest|final)\s+(?:\w+\s+)?(?:commit|edit|change)s?\b/i.test(
      sentence,
    ) && /\b(?:runs?|checks?|tests?|suites?)\b/i.test(sentence)
  );
}

const TEST_VERB =
  /\b(?:cover(?:s|ed|ing)?|check(?:s|ed|ing)?|test(?:s|ed|ing)?|assert(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|exercis(?:e|es|ed|ing)|pin(?:s|ned)?)\b/i;
/** Words that say a test exists, not what it checks. */
const TEST_FILLER = wordsOf(
  'cover covers covered check checks checked test tests tested assert asserts verify verifies exercise exercises case cases also both these those each new',
);
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A test file's short name: `tests/summary-fix.test.ts` → `summary-fix`. */
function testStem(file: string): string {
  return (file.split('/').pop() ?? file)
    .replace(/\.[^.]+$/, '')
    .replace(/[._-](?:test|spec)s?$/i, '')
    .replace(/^test_/i, '');
}

/**
 * A sentence that names a test file (its path, its file name, or "the <name>
 * tests") and says what it covers, where a listed behavior matches another
 * test file's titles clearly better than the named file's: the writer grouped
 * behaviors from several files under one. Conservative: a behavior phrase
 * needs two words in one title of the other file, and two more than the
 * named file's best title.
 */
export function misattributedTests(
  sentence: string,
  tests: Record<string, unknown>[],
): BriefApplied['flags'][number] | undefined {
  const files = tests
    .map((r) => ({
      file: String(r.file ?? ''),
      titles: (Array.isArray(r.titles) ? r.titles : []).map((t) => wordsOf(String(t))),
    }))
    .filter((f) => f.file && f.titles.length);
  if (files.length < 2) return undefined;
  // Where each file is named.
  const mentions: { at: number; end: number; file: (typeof files)[number] }[] = [];
  for (const f of files) {
    const stem = testStem(f.file);
    const pats = [
      escRe(f.file),
      escRe(f.file.split('/').pop()!),
      ...(stem.length >= 3
        ? [
            String.raw`\b${stem
              .split(/[-_\s]+/)
              .map(escRe)
              .join(String.raw`[-_\s]`)}\s+tests?\b`,
          ]
        : []),
    ];
    for (const pat of pats)
      for (const m of sentence.matchAll(new RegExp(`\`?${pat}\`?`, 'gi')))
        if (!mentions.some((x) => m.index! < x.end && x.at < m.index! + m[0].length))
          mentions.push({ at: m.index!, end: m.index! + m[0].length, file: f });
  }
  if (!mentions.length) return undefined;
  mentions.sort((a, b) => a.at - b.at);
  const score = (f: (typeof files)[number], words: string[]) =>
    Math.max(0, ...f.titles.map((t) => words.filter((w) => t.has(w)).length));
  for (const [i, m] of mentions.entries()) {
    // The named file's part of the sentence: up to the next file named.
    const part =
      sentence.slice(i === 0 ? 0 : m.at, m.at) +
      ' ' +
      sentence.slice(m.end, mentions[i + 1]?.at ?? sentence.length);
    if (!TEST_VERB.test(part)) continue;
    for (const phrase of part.split(/[,;:()]|\band\b|\bor\b|\bplus\b/i)) {
      const words = [
        ...wordsOf(phrase.replace(/`[^`]*`/g, (c) => c.slice(1, -1))),
      ].filter((w) => !TEST_FILLER.has(w));
      if (words.length < 2) continue;
      const mine = score(m.file, words);
      const ranked = files
        .filter((f) => f !== m.file)
        .map((f) => ({ f, n: score(f, words) }))
        .sort((a, b) => b.n - a.n || a.f.file.localeCompare(b.f.file));
      const top = ranked[0];
      if (!top || top.n < 2 || top.n < mine + 2 || top.n < Math.ceil(words.length * 0.6))
        continue;
      if (ranked[1]?.n === top.n) continue; // no single better file
      return {
        sentence,
        severity: 'check',
        problem: `"${phrase.trim()}": the test titles in ${top.f.file} show that, not ${m.file.file}'s. Attribute each tested behavior to the test file whose titles show it; don't group them under one file.`,
      };
    }
  }
  return undefined;
}
