/**
 * An advisory check of a PR description against the captured evidence. It never
 * blocks publishing: logs are incomplete (other terminals, CI, manual checks,
 * commands we don't parse), so missing evidence is not contradicting evidence.
 *
 * Each consequential claim gets one of four states:
 *  - observed: a captured fact supports it (within its scope);
 *  - author-reported: the author said so (author.md, or attributed in the text);
 *  - not established: nothing captured supports it (a gentle note, never "false");
 *  - contradicted: captured evidence conflicts with it (worth fixing).
 *
 * The checks are deliberately shallow: verification claims, attributions of
 * decisions, and references to files. Semantic truth ("adds rate limiting") is
 * not judged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, TraceDigest } from './build.ts';

export type ClaimState =
  'observed' | 'author-reported' | 'not established' | 'contradicted';

export interface ClaimFinding {
  /** The sentence the finding is about, as it appears in the text. */
  quote: string;
  kind: 'verification' | 'attribution' | 'reference';
  state: ClaimState;
  /** What the evidence shows, in plain words. */
  detail: string;
  /** Ids of the facts consulted (R3, D1…). */
  evidence: string[];
}

export interface ClaimInput {
  title: string;
  /** The description markdown (without the comic block or disclosure). */
  body: string;
  digest: Pick<TraceDigest, 'sessions' | 'files' | 'pr' | 'verification'>;
  /** Repository root, to tell a stale reference from a file outside the diff. */
  root?: string;
  /** Things the author told Tracetoon (author.md), treated as author-reported. */
  authorText?: string;
}

// ------------------------------------------------------------------ text

/** Sentences of prose, skipping code blocks, headings markup and HTML comments. */
export function sentences(markdown: string): string[] {
  const code: string[] = [];
  const prose = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, (literal) => `\0${code.push(literal) - 1}\0`)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return prose
    .split(/\n\s*\n|\n(?=\s*[-*]\s|\s*\d+\.\s|#)/)
    .flatMap((block) =>
      block
        .replace(/^\s*(#+|[-*]|\d+\.)\s*/gm, '')
        .replace(/\s+/g, ' ')
        // Split on sentence ends, but not inside `code` or numbers like 1.0.
        .split(/(?<=[.!?])\s+(?=[A-Z*`"(\0])/),
    )
    .map((s) => s.trim().replace(/\0(\d+)\0/g, (_, index) => code[Number(index)]!))
    .filter((s) => s.length > 3);
}

const VERIFY =
  /(`[^`]*\b(test|tests|tsc|lint|check|build|prettier|eslint|pytest|jest|vitest|cargo|bundle)\b[^`]*`[^.]{0,30}\b(pass\w*|succeed\w*|clean|green)\b)|\b(all (the )?tests? pass\w*|tests? (all )?(pass\w*|succeed\w*|(are|is|went) green)|(suite|build|ci|lint\w*|type ?check\w*|tsc|checks?)\b[^.]{0,40}\b(pass\w*|succeed\w*|clean|green)|\bpass(es|ed)? (locally|on (ci|this|the final))|\b\d+\s+(tests?|pass(es|ing)?)\b|no regressions?|verified|fully (tested|backward[- ]compatible)|works (everywhere|on all))/i;

const CHECK_SUBJECT =
  /\b(test\w*|regression|suite|build|bundle|ci|lint\w*|type ?check\w*|tsc|checks?|prettier|eslint|pytest|jest|vitest)\b/i;
const FAILED = /\b(fail(?:ed|s|ing|ures?)?|errors?)\b/i;
const RESULT =
  /\b(pass(?:ed|es|ing)?|succeed\w*|failed|fails|failing|clean|green|reports?\b[^.]{0,60}\bfailures?)\b/i;
const HISTORICAL =
  /\b(before (?:the )?(?:(?:last|final|later) )?(?:edits|changes|commit)|during (?:development|implementation)|(?:earlier|historical|recorded|captured) (?:implementation )?(?:session|run)|previously)\b/i;

/** Ignore output routing, but preserve every test target and execution flag. */
function commandIdentity(cmd: string): string {
  // Protect literals before normalizing shell syntax: spaces and redirect-like
  // text inside arguments can change which tests run.
  const literals: string[] = [];
  const masked = cmd.replace(
    /\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g,
    (literal) => `\0${literals.push(literal) - 1}\0`,
  );
  return masked
    .replace(/(?:^|[ \t])\d*>&\d+(?=[ \t]|$)/g, ' ')
    .replace(/(?:^|[ \t])\d*>{1,2}[ \t]*\S+/g, ' ')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\0(\d+)\0/g, (_, index) => literals[Number(index)]!);
}

const AUTHOR =
  /\b(reported by the author|(the )?author (reports|says|checked|tested)|manually|by hand|I (tested|checked|ran|verified|tried))\b/i;
const ATTRIBUTION =
  /\b(the user|the author|you)\s+(chose|decided|picked|selected|asked|wanted|preferred|rejected|turned down|approved)\b|\b(?:the|a|an)\s+(?:requested|desired|wanted)\s+|\bin response to\s+(?:the user|the author|your|a request)/i;
const ALTERNATIVE =
  /\b(instead of|rather than|considered|alternative|rejected|dropped|replaces?|replaced|removed|deleted|renamed|old|previously|no longer|was)\b/i;

/** Which kind of run a verification sentence is about. */
function runKindsFor(s: string): Run['kind'][] {
  const kinds: Run['kind'][] = [];
  if (/\btests?\b|\bsuite\b|\bregression\b/i.test(s)) kinds.push('test');
  if (/\bbuild\b|\bbundle\b|\bcompil/i.test(s)) kinds.push('build');
  if (/\blint|prettier|eslint|format/i.test(s)) kinds.push('lint');
  if (/\btype ?check|\btsc\b|mypy/i.test(s)) kinds.push('typecheck');
  if (/\beval|benchmark|harness/i.test(s)) kinds.push('eval');
  return kinds.length ? kinds : ['test'];
}

function allRuns(d: ClaimInput['digest']): Run[] {
  return (
    [
      ...d.sessions.filter((s) => s.band === 'included').flatMap((s) => s.runs ?? []),
      ...(d.verification ?? []),
    ]
      // Runs on later work (after the PR's last commit and further edits) say nothing about this PR.
      .filter((r) => r.revision !== 'after later work')
      .slice()
      .sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''))
  );
}

// ---------------------------------------------------------------- checks

function checkVerification(
  s: string,
  input: ClaimInput,
  runs: Run[],
): ClaimFinding | undefined {
  // Quoted text is an example, not a claim ("tests pass" when the run failed), and
  // a sentence about claims ("each sentence that claims a check passed") isn't one.
  const commandCode = (text: string) =>
    (/\s/.test(text) && CHECK_SUBJECT.test(text)) ||
    /^(tsc|pytest|jest|vitest)$/.test(text);
  const bare = s.replace(/"[^"]*"|“[^”]*”/g, '""');
  const prose = bare.replace(/`([^`]+)`/g, (code, text: string) =>
    commandCode(text.trim()) ? ' '.repeat(code.length) : code,
  );
  const hit =
    VERIFY.exec(prose) ?? (CHECK_SUBJECT.test(bare) ? RESULT.exec(prose) : null);
  const freshness =
    /\b(no (?:later|subsequent|further) (?:file |code )?(?:edits|changes) (?:were )?(?:seen|captured|observed|made)|after (?:the )?(?:last|final) (?:edits|changes) (?:seen|captured|observed))\b/i.test(
      prose,
    );
  const ciStatus =
    /\bCI\b/i.test(prose) &&
    (!!hit ||
      /\b(?:results?|status)\b[^.]{0,50}\b(not (?:yet )?available|pending)\b/i.test(
        prose,
      ));
  if (!hit && !ciStatus && !freshness) return undefined;
  if (
    /\b(claims?|claiming|says?|such as)\b/i.test(
      bare.slice(Math.max(0, (hit?.index ?? 0) - 40), hit?.index ?? 0),
    )
  )
    return undefined;
  const author = AUTHOR.test(s) || mentionedBy(input.authorText, s);
  // A named command narrows the runs: `bun test tests/x.test.ts`, `prettier --check`.
  const named = [...s.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1]!.trim())
    .filter(commandCode);
  const kinds = runKindsFor(s);
  let relevant = runs.filter((r) => kinds.includes(r.kind));
  if (named.length)
    relevant = relevant.filter((r) =>
      named.some((n) => commandIdentity(n) === commandIdentity(r.cmd)),
    );
  const historical = HISTORICAL.test(prose);
  if (historical)
    relevant = relevant.filter((r) => r.verificationBasis !== 'exact-content-receipt');
  const expected = FAILED.test(prose.replace(/\b0\s+(?:fail\w*|errors?)\b/gi, ''))
    ? 'failed'
    : 'passed';
  const scopes = named.length
    ? named.map((n) =>
        relevant.filter((r) => commandIdentity(n) === commandIdentity(r.cmd)),
      )
    : kinds.map((kind) => relevant.filter((r) => r.kind === kind));
  const results = scopes.map((scope) =>
    (historical ? scope.filter((r) => r.outcome === expected) : scope).at(-1),
  );
  const result = results.at(-1);
  const ids = relevant
    .slice(-3)
    .map((r) => r.id ?? '')
    .filter(Boolean);
  const overreach =
    /no regressions?|works (everywhere|on all)|fully (tested|backward[- ]compatible)/i.test(
      s,
    );

  if (overreach && !author)
    return finding(
      s,
      'verification',
      'not established',
      'A passing run shows what was checked, not that nothing else broke.',
      ids,
    );
  if (freshness && !author)
    return finding(
      s,
      'verification',
      'not established',
      'Historical edit markers can miss shell writes and other changes. Keep the historical result without asserting unchanged code; a current receipt can establish matching content.',
      ids,
    );
  if (ciStatus && !author)
    return finding(
      s,
      'verification',
      'not established',
      'Local checks do not establish hosted CI status. Cite a captured CI result or say no CI result was captured.',
      [],
    );
  if (
    /\b(all (?:the )?tests|full (?:test )?(?:suite|run))\b/i.test(prose) &&
    !author &&
    !relevant.some((r) =>
      /^(?:(?:bun|npm|yarn|pnpm) (?:run )?test|pytest|cargo test|go test)$/.test(
        commandIdentity(r.cmd),
      ),
    )
  )
    return finding(
      s,
      'verification',
      'not established',
      'A targeted check does not establish the full suite result. Name the captured command and its scope.',
      ids,
    );
  // A suite result cannot identify a particular unnamed regression test.
  if (
    /\bregression\b|\bfocused (?:tests?|checks?)\b/i.test(s) &&
    !named.length &&
    !author
  )
    return finding(
      s,
      'verification',
      'not established',
      'Name the regression command and its captured result; a suite pass alone does not identify this regression.',
      ids,
    );
  const contradicted = results.find(
    (r) => r && r.outcome !== 'unknown' && r.outcome !== expected,
  );
  if (contradicted && !author)
    return finding(
      s,
      'verification',
      'contradicted',
      `The last matching captured run (${contradicted.id}: ${contradicted.cmd}) ${contradicted.outcome}${contradicted.summary.length ? `: ${contradicted.summary.join(', ')}` : ''}.`,
      ids,
    );
  const counts = [
    ...prose.matchAll(
      /\b(\d+)\s+(tests?|pass(?:ed|es|ing)?|fail(?:ed|s|ing)?|errors?)\b/gi,
    ),
  ];
  if (counts.length && result && !author) {
    const shown = result.summary.join(' ');
    const missing = counts.filter((m) => {
      const label = /^pass/i.test(m[2]!)
        ? 'pass\\w*'
        : /^fail/i.test(m[2]!)
          ? 'fail\\w*'
          : m[2]!;
      return !new RegExp(`\\b${m[1]}\\s+${label}\\b`, 'i').test(shown);
    });
    if (missing.length)
      return finding(
        s,
        'verification',
        'not established',
        `The matching run does not show ${missing.map((m) => m[0]).join(', ')}; its summary shows: ${shown || 'no counts'}.`,
        ids,
      );
  }
  if (result && results.every((r) => r?.outcome === expected)) {
    const stale = results.find((r) => r?.revision === 'before later edits');
    if (stale && !historical)
      return finding(
        s,
        'verification',
        'not established',
        staleDetail(stale, expected, input.digest.files),
        ids,
      );
    const dirty =
      input.digest.pr.dirty && result.verificationBasis !== 'exact-content-receipt'
        ? ' Uncommitted changes existed, so it may have covered code outside the PR.'
        : '';
    return finding(
      s,
      'verification',
      'observed',
      results
        .map(
          (r) =>
            `${r!.id} (${r!.cmd}) ${expected}${r!.summary.length ? `: ${r!.summary.join(', ')}` : ''}${r!.verificationBasis === 'exact-content-receipt' ? '; its receipt matches the current content and environment' : '; historical log evidence; tested content unverified'}.`,
        )
        .join(' ') + dirty,
      ids,
    );
  }
  if (author)
    return finding(
      s,
      'verification',
      'author-reported',
      'Reported by the author; no captured run shows it, which is fine for checks done outside the logs.',
      ids,
    );
  return finding(
    s,
    'verification',
    'not established',
    relevant.length
      ? `No matching captured run establishes this ${expected} result.`
      : 'No matching run was captured. If it ran elsewhere (CI, another terminal), keep it and note where; otherwise reword.',
    ids,
  );
}

function checkAttribution(s: string, input: ClaimInput): ClaimFinding | undefined {
  if (!ATTRIBUTION.test(s)) return undefined;
  if (mentionedBy(input.authorText, s))
    return finding(s, 'attribution', 'author-reported', 'The author said so.', []);
  const included = input.digest.sessions.filter((x) => x.band === 'included');
  const decisions = included.flatMap((x) => x.decisions);
  const prompts = included.flatMap((x) => x.prompts);
  const words = (t: string) =>
    new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []);
  const sw = words(s);
  const overlap = (t: string) => [...words(t)].filter((w) => sw.has(w)).length;
  const support = [
    ...decisions.map((d) => ({
      id: d.id ?? 'D?',
      text: [
        d.text,
        ...(d.questions ?? []).map((q) => `${q.question} ${q.answer ?? ''}`),
      ].join(' '),
    })),
    ...prompts.map((p) => ({ id: p.id ?? 'S?', text: p.text })),
  ]
    .map((f) => ({ ...f, score: overlap(f.text) }))
    .filter((f) => f.score >= 2)
    .sort((a, b) => b.score - a.score);
  const rejects = /\b(rejected|turned down)\b/i.test(s);
  if (!support.length)
    return finding(
      s,
      'attribution',
      'not established',
      'No recorded prompt or decision says this. State it neutrally, or keep it if the author confirms.',
      [],
    );
  if (
    rejects &&
    !decisions.some((d) => d.questions?.some((q) => q.ownWords)) &&
    !prompts.some((p) => p.pushback)
  )
    return finding(
      s,
      'attribution',
      'not established',
      'A recorded choice shows what was picked; an unpicked option is not the same as a rejection with a reason.',
      support.slice(0, 2).map((f) => f.id),
    );
  const explicit =
    /\b(the user|the author|you)\s+(chose|decided|picked|selected|asked|wanted|preferred|rejected|turned down|approved)\b/i.test(
      s,
    );
  if (!explicit || /\b(asked|wanted|requested)\b/i.test(s))
    return finding(
      s,
      'attribution',
      'not established',
      'Related words are only candidate evidence. Inspect the cited prompts or decisions to establish this request; commit explanations and dogfooding do not establish user intent.',
      support.slice(0, 2).map((f) => f.id),
    );
  return finding(
    s,
    'attribution',
    'observed',
    `Matches ${support
      .slice(0, 2)
      .map((f) => f.id)
      .join(', ')}.`,
    support.slice(0, 2).map((f) => f.id),
  );
}

const FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|rs|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|ya?ml|toml|sh|ps1|cmd|bat|css|scss|html|sql|txt|lock|cfg|ini|xml|vue|svelte|wasm|png|svg)$/i;

/** Sentences that describe changing something (as opposed to mentioning it). */
const CHANGE_VERB =
  /\b(adds?|added|changes?|changed|updates?|updated|fix(es|ed)?|modif(y|ies|ied)|edits?|edited|moves?|moved|refactor\w*|rewrites?|rewrote|implements?|introduces?)\b/i;

const tracked = new Map<string, string[]>();
/**
 * Whether the repository has this file (a path, or a bare filename anywhere in
 * it), or only names it in its text: a file the code writes or reads, such as a
 * run-folder output or a config name, isn't tracked but isn't stale either.
 */
function repoHas(root: string, ref: string): 'file' | 'mentioned' | false {
  if (existsSync(join(root, ref))) return 'file';
  if (!ref.includes('/')) {
    if (!tracked.has(root)) {
      const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
      tracked.set(root, r.status === 0 ? r.stdout.split('\n') : []);
    }
    if (tracked.get(root)!.some((p) => p === ref || p.endsWith(`/${ref}`))) return 'file';
  }
  const key = `${root}|${ref}`;
  if (!mentioned.has(key)) {
    const g = spawnSync('git', ['grep', '-q', '-F', '--', ref], { cwd: root });
    mentioned.set(key, g.status === 0);
  }
  return mentioned.get(key) ? 'mentioned' : false;
}
const mentioned = new Map<string, boolean>();

function checkReferences(s: string, input: ClaimInput): ClaimFinding[] {
  const changed = new Set(input.digest.files.map((f) => f.path));
  const out: ClaimFinding[] = [];
  for (const m of s.matchAll(/`([^`\s]+)`/g)) {
    const ref = m[1]!.replace(/^\.\//, '').replace(/[:#].*$/, '');
    // Only things that look like files: a known extension, or a path with a slash
    // and an extension. Field names like `pr.dirty` and flags aren't files.
    if (
      !FILE_EXT.test(ref) ||
      /^https?:|^[a-z]+:\/\//i.test(ref) ||
      /[*?<>{}$()=,]/.test(ref)
    )
      continue;
    if (changed.has(ref) || [...changed].some((p) => p.endsWith(`/${ref}`))) continue;
    const exists = input.root ? repoHas(input.root, ref) : undefined;
    if (ALTERNATIVE.test(s)) continue; // alternatives, renames and removals may name other files
    if (exists === 'file' && CHANGE_VERB.test(s))
      out.push(
        finding(
          s,
          'reference',
          'not established',
          `\`${ref}\` exists but isn't changed in this PR; make sure the sentence doesn't describe a change to it.`,
          [],
        ),
      );
    else if (exists === false)
      out.push(
        finding(
          s,
          'reference',
          'not established',
          `\`${ref}\` isn't in this PR or the repository; possibly a stale reference.`,
          [],
        ),
      );
  }
  return out;
}

/** Which files a run did not see, from the evidence graph, so the text can qualify precisely. */
function staleDetail(
  run: Run,
  expected: string,
  files: ClaimInput['digest']['files'],
): string {
  const later = run.laterEdits ?? [];
  if (!later.length)
    return `${run.id} ${expected}, but files in the PR changed afterwards; qualify it as a historical result.`;
  const roles = later.map((p) => files.find((f) => f.path === p)?.role ?? 'behavior');
  const shown =
    later.length > 3
      ? `${later.slice(0, 3).join(', ')} and ${later.length - 3} more`
      : later.join(', ');
  const docsOnly = roles.every((r) => r === 'docs');
  return `${run.id} ${expected}, but ${shown} changed afterwards${docsOnly ? ' (documentation only)' : ''}; qualify it as a result from before ${later.length === 1 ? 'that edit' : 'those edits'}, or cite a later run.`;
}

const finding = (
  quote: string,
  kind: ClaimFinding['kind'],
  state: ClaimState,
  detail: string,
  evidence: string[],
): ClaimFinding => ({ quote, kind, state, detail, evidence });

/** Whether the author's own notes cover this sentence (shared distinctive words). */
function mentionedBy(authorText: string | undefined, s: string): boolean {
  if (!authorText?.trim()) return false;
  const words = (t: string) => t.toLowerCase().match(/[a-z0-9][a-z0-9-]{4,}/g) ?? [];
  const a = new Set(words(authorText));
  const hits = words(s).filter((w) => a.has(w)).length;
  return hits >= 2;
}

/** Check every sentence of the title and body. Never throws, never blocks. */
export function checkClaims(input: ClaimInput): ClaimFinding[] {
  const runs = allRuns(input.digest);
  const out: ClaimFinding[] = [];
  for (const s of [input.title, ...sentences(input.body)]) {
    const v = checkVerification(s, input, runs);
    if (v) out.push(v);
    const a = checkAttribution(s, input);
    if (a) out.push(a);
    out.push(...checkReferences(s, input));
  }
  return out;
}

/** Counts by state, for one-line summaries. */
export function claimSummary(findings: ClaimFinding[]): Record<ClaimState, number> {
  const c: Record<ClaimState, number> = {
    observed: 0,
    'author-reported': 0,
    'not established': 0,
    contradicted: 0,
  };
  for (const f of findings) c[f.state]++;
  return c;
}
