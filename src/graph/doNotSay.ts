/**
 * The brief's `doNotSay` rows: wording the evidence rules out, shown before
 * drafting. Built from the same facts `render` checks after drafting
 * (briefRender.ts `applyBrief`), so a writer sees the trap before it is
 * flagged:
 * - names that already existed at the base (not in `newSymbols`): never
 *   "new", "adds", "introduces";
 * - symbols whose changed lines branch or fall back, with one quoted
 *   condition: "always", "only", "every", "any", "no longer" need every path;
 * - results only a commit message asserts: attribute them;
 * - the files the diff changes, so "only a version bump" or a wrong file is
 *   visibly wrong;
 * - recorded requests, plans and decisions: never "none was recorded".
 *
 * Pure over the brief's sections, capped, deterministic.
 */
import type { Section } from './queries.ts';

type Row = Record<string, unknown>;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const rowsOf = (sections: Section[], title: string): Row[] =>
  sections.find((s) => s.title === title)?.rows ?? [];

export const DO_NOT_SAY_COLUMNS = ['kind', 'text', 'cites'];
const MAX_NAMES = 5;
const MAX_FILES = 10;
const MAX_ASSERTED = 2;

/** Symbols named in `where` entries (`src/a.ts (foo, bar)`). */
export function symbolsOfWhere(where: unknown): string[] {
  return list(where).flatMap((w) => {
    const m = /\(([^)]*)\)/.exec(w);
    return m ? m[1]!.split(/,\s*/).filter(Boolean) : [];
  });
}

/** Changed symbols that existed at the base: in `where`, not in any `newSymbols`. */
export function existingSymbols(sections: Section[]): string[] {
  const changes = rowsOf(sections, 'changes');
  const fresh = new Set(changes.flatMap((r) => list(r.newSymbols)));
  return [
    ...new Set(
      changes.flatMap((r) => symbolsOfWhere(r.where)).filter((x) => !fresh.has(x)),
    ),
  ];
}

/** Files the change units and housekeeping rows cover, in brief order. */
export function diffFiles(sections: Section[]): string[] {
  return [
    ...new Set([
      ...rowsOf(sections, 'changes').flatMap((r) =>
        list(r.where).map((w) => w.replace(/\s*\(.*$/, '')),
      ),
      ...rowsOf(sections, 'housekeeping')
        .flatMap((r) => list(r.files))
        .filter((f) => !/^\+\d+ more$/.test(f)),
    ]),
  ];
}

const MANIFEST =
  /(^|\/)(package\.json|plugin\.json|Cargo\.toml|pyproject\.toml|setup\.cfg|VERSION)$/;

/**
 * Files beyond the version bump: everything but the version files and
 * manifests, code before generated files. What makes "version bump only" wrong.
 */
export function beyondVersionBump(sections: Section[]): string[] {
  const house = rowsOf(sections, 'housekeeping');
  const versionFiles = new Set(
    house
      .filter((r) => /^version/i.test(String(r.what ?? '')))
      .flatMap((r) => list(r.files)),
  );
  const generated = new Set(
    house
      .filter((r) => /generated/i.test(String(r.what ?? '')))
      .flatMap((r) => list(r.files)),
  );
  return diffFiles(sections)
    .filter((f) => !versionFiles.has(f) && !MANIFEST.test(f))
    .sort((a, b) => Number(generated.has(a)) - Number(generated.has(b)));
}

const names = (xs: string[], cap: number) => {
  const shown = xs.slice(0, cap).map((x) => `\`${x}\``);
  return xs.length > cap
    ? `${shown.join(', ')} and ${xs.length - cap} more`
    : shown.join(', ');
};

export function doNotSayRows(sections: Section[], branchy: string[] = []): Row[] {
  const out: Row[] = [];
  const changes = rowsOf(sections, 'changes');
  const changeOf = (name: string) =>
    changes
      .filter((r) =>
        list(r.where).some(
          (w) =>
            w === name || w.startsWith(`${name} `) || symbolsOfWhere([w]).includes(name),
        ),
      )
      .map((r) => String(r.change));
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  // Recorded requests, plans or decisions: writers told "no request" by a limit
  // row about one change still must not say the session recorded none.
  const recorded = [
    ...new Set(
      [
        ...rowsOf(sections, 'requests').map((r) => String(r.ref)),
        ...rowsOf(sections, 'background').map((r) => String(r.ref)),
        ...rowsOf(sections, 'process')
          .filter((r) => r.kind === 'plan' || r.kind === 'decision')
          .flatMap((r) => list(r.cites)),
      ].filter((x) => /^[SPD]\d+$/.test(x)),
    ),
  ];
  if (recorded.length) {
    const kinds = [
      recorded.some((x) => x.startsWith('S')) ? 'Requests' : '',
      recorded.some((x) => x.startsWith('P')) ? 'plans' : '',
      recorded.some((x) => x.startsWith('D')) ? 'decisions' : '',
    ].filter(Boolean);
    const what = kinds.join('/');
    out.push({
      kind: 'recorded requests',
      text: `${what[0]!.toUpperCase()}${what.slice(1)} were recorded (${recorded.slice(0, 6).join(', ')}): don't say none was recorded.`,
      cites: recorded.slice(0, 6),
    });
  }

  // Kept short: "new" for existing code is rare in judged errors.
  const existing = existingSymbols(sections).filter((x) => x.length >= 4);
  if (existing.length)
    out.push({
      kind: 'existed before this PR',
      text: `${names(existing, MAX_NAMES)}: changed, not "new" or "added".`,
      cites: [...new Set(existing.slice(0, MAX_NAMES).flatMap(changeOf))],
    });

  if (branchy.length) {
    // One quoted condition, from the first symbol's change.
    const shown = branchy.slice(0, 3);
    const mine = new Set(changeOf(shown[0]!));
    const cond =
      changes
        .filter((r) => mine.has(String(r.change)))
        .flatMap((r) => list(r.behavior))[0] ??
      changes.flatMap((r) => list(r.behavior))[0];
    out.push({
      kind: 'conditional code',
      text: `${names(shown, 3)}${branchy.length > 3 ? ` and ${branchy.length - 3} more` : ''} branch or fall back${cond ? ` (${clip(cond, 90)})` : ''}: "always", "only", "every", "no longer" only if every branch does it.`,
      cites: [...new Set(shown.flatMap(changeOf))],
    });
  }

  const asserted = rowsOf(sections, 'validation').filter((r) => r.outcome === 'asserted');
  for (const r of asserted.slice(0, MAX_ASSERTED)) {
    const sha = String(r.check ?? '').split('#')[0];
    out.push({
      kind: 'commit message only',
      text: `"${clip(String(r.cmd ?? ''), 100)}" is commit ${sha}'s claim, not a run: attribute it or leave it out.`,
      cites: [String(r.check)],
    });
  }

  if (changes.some((r) => Number(r.removed ?? 0) > 0))
    out.push({
      kind: 'old behavior',
      text: 'What the code did before: only from removed lines (`was`, `removed:`, `dropped:`) or a commit message.',
      cites: [],
    });

  // The files, by name, so a wrong file or "version bump only" is visibly wrong.
  const house = rowsOf(sections, 'housekeeping');
  const files = diffFiles(sections);
  const others = beyondVersionBump(sections);
  if (files.length) {
    const base = (f: string) => f.split('/').pop()!;
    const shown = files.slice(0, MAX_FILES).map(base).join(', ');
    out.push({
      kind: 'files in this diff',
      text: `${files.length}: ${shown}${files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : ''}.${house.length && others.length ? ` ${others.length} are beyond the version bump: never "housekeeping only", "version bump only" or "no logic changes".` : ''}`,
      cites: house.map((r) => String(r.ref)),
    });
  }
  return out;
}

/** "Version bump only", "housekeeping only", "no logic changes": a scope claim about the whole diff. */
export const HOUSEKEEPING_ONLY =
  /\b(?:only|just|purely|solely|nothing but)\b[^.;]{0,40}\b(?:version bumps?|housekeeping|bumps? (?:the )?version)\b|\b(?:version bumps?|housekeeping)\b[^.;]{0,25}\bonly\b|\bno (?:logic|behaviou?r(?:al)?|functional|code|source) changes?\b/i;

/**
 * A sentence calling the change (or a part of it) housekeeping or a version
 * bump only, while the diff changes files it doesn't name besides the version
 * files: generated bundles or code. Returns the files it leaves out (capped),
 * or undefined. The one do-not-say check precise enough for a render flag.
 */
export function housekeepingOverclaim(
  sentence: string,
  sections: Section[],
): string[] | undefined {
  if (!HOUSEKEEPING_ONLY.test(sentence)) return undefined;
  const house = rowsOf(sections, 'housekeeping');
  const lower = sentence.toLowerCase();
  const named = (f: string) => {
    const base = f.split('/').pop()!.toLowerCase();
    return lower.includes(f.toLowerCase()) || lower.includes(base);
  };
  const generatedNamed = /\b(dist|bundle|build output|generated|rebuilt)\b/i.test(
    sentence,
  );
  const generated = new Set(
    house
      .filter((r) => /generated/i.test(String(r.what ?? '')))
      .flatMap((r) => list(r.files)),
  );
  const missing = beyondVersionBump(sections).filter(
    (f) => !named(f) && !(generated.has(f) && generatedNamed),
  );
  return missing.length ? missing.slice(0, 4) : undefined;
}
