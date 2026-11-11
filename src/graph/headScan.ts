/**
 * A scan of the submitted head tree with `git grep -w -F`, for what the diff
 * alone can't show:
 * - names the patch removed or renamed, and old values it replaced, that docs
 *   or config files still mention (`README.md:12 still mentions oldName`);
 * - how often the changed and new symbols are referenced elsewhere: their
 *   callers (capped), and the most-referenced one as a place to start reading.
 *
 * One `git grep` at the head commit, with a timeout and caps. Only the term,
 * file:line refs and counts are kept: no line contents. Fails open: offline,
 * a missing commit or any git error gives no rows.
 */
import { fileRole } from '../digest/build.ts';
import { run } from '../util/exec.ts';
import type { EvidenceGraph, GraphNode, Value } from './model.ts';

const MAX_TERMS = 40;
const MAX_REMOVED = 16;
const MAX_CHANGED = 16;
const MAX_REFS = 5;
const MAX_CALLER_FILES = 25;
const MAX_HITS = 20_000;
const TIMEOUT_MS = 5_000;

export interface ScanTerms {
  /** Removed or renamed symbols and replaced values, with the hunk they come from. */
  removed: { term: string; kind: 'symbol' | 'value'; hunk: string }[];
  /** Changed or new symbols in behavior files, with the files that define them. */
  changed: { term: string; files: string[]; fresh: boolean }[];
}

const NAME = /^[A-Za-z_$][\w$]{3,}$/;
const COMMON = new Set(
  'this that self true false null none undefined return const function class value values data item items name names type types index result results error errors default string number object array main test tests'.split(
    ' ',
  ),
);
const usable = (t: string) => NAME.test(t) && !COMMON.has(t.toLowerCase());
/** A name a whole-word search finds only as itself: camelCase, snake_case or long. */
const distinctive = (t: string) =>
  usable(t) && (/[a-z][A-Z]|[A-Za-z]_[A-Za-z]/.test(t) || t.length >= 8);
const TOKEN = /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`|[A-Za-z_$][\w$.-]*/g;
const VERSION = /^v?\d+\.\d+\.\d+[\w.-]*$/;

/** Old values of a `pairs` entry (`old → new`): tokens of the old side the new side dropped. */
export function oldValues(pair: string): string[] {
  const [was, now] = pair.split(' → ');
  if (!was || now === undefined) return [];
  const tokens = (s: string) =>
    (s.match(TOKEN) ?? []).map((t) => t.replace(/^['"`]|['"`]$/g, ''));
  const kept = new Set(tokens(now));
  return [
    ...new Set(
      tokens(was).filter(
        (t) =>
          !kept.has(t) &&
          !t.endsWith('…') &&
          (VERSION.test(t) || (usable(t) && t.length >= 5) || /^[\w.-]{6,60}$/.test(t)),
      ),
    ),
  ];
}

/** What to look for, from the graph's hunks and file roles. */
export function scanTerms(graph: EvidenceGraph): ScanTerms {
  const role = new Map(
    graph.nodes
      .filter((n) => n.label === 'File')
      .map((n) => [n.id, String(n.props.role ?? fileRole(n.id))]),
  );
  const hunks = graph.nodes
    .filter((n) => n.label === 'Hunk')
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const arr = (v: Value | undefined) => (Array.isArray(v) ? v.map(String) : []);
  const removed: ScanTerms['removed'] = [];
  const seen = new Set<string>();
  for (const h of hunks) {
    const r = role.get(String(h.props.file)) ?? '';
    if (['generated', 'tests'].includes(r)) continue;
    for (const s of arr(h.props.dropped))
      if (usable(s) && !seen.has(s)) {
        seen.add(s);
        removed.push({ term: s, kind: 'symbol', hunk: h.id });
      }
    for (const p of arr(h.props.pairs))
      for (const v of oldValues(p))
        if (!seen.has(v)) {
          seen.add(v);
          removed.push({ term: v, kind: 'value', hunk: h.id });
        }
  }
  const changed = new Map<string, { files: Set<string>; fresh: boolean }>();
  for (const h of hunks) {
    const file = String(h.props.file);
    if (role.get(file) !== 'behavior') continue;
    const fresh = new Set(arr(h.props.fresh));
    for (const s of [...arr(h.props.fresh), ...arr(h.props.touched)]) {
      if (!distinctive(s) || seen.has(s)) continue;
      const c = changed.get(s) ?? { files: new Set<string>(), fresh: false };
      c.files.add(file);
      c.fresh ||= fresh.has(s);
      changed.set(s, c);
    }
  }
  return {
    removed: removed.slice(0, MAX_REMOVED),
    changed: [...changed]
      .map(([term, c]) => ({ term, files: [...c.files].sort(), fresh: c.fresh }))
      .slice(0, MAX_CHANGED),
  };
}

export interface GrepHit {
  file: string;
  line: number;
  term: string;
}

/** `git grep -z -n -o` output: `<rev>:<path>\0<line>\0<match>` per line. */
export function parseGrep(out: string, rev: string): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const rec of out.split('\n')) {
    if (!rec) continue;
    const [pathPart, line, term] = rec.split('\0');
    if (!pathPart || !line || term === undefined) continue;
    const file =
      rev && pathPart.startsWith(`${rev}:`) ? pathPart.slice(rev.length + 1) : pathPart;
    hits.push({ file, line: Number(line), term });
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** One fixed-string, whole-word `git grep` for every term; undefined on any failure. */
export function grepTree(
  root: string,
  rev: string | undefined,
  terms: string[],
): GrepHit[] | undefined {
  const uniqTerms = [...new Set(terms)]
    .filter((t) => t && !/[\n\0]/.test(t))
    .slice(0, MAX_TERMS);
  if (!uniqTerms.length) return [];
  const r = run(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'core.quotepath=off',
      'grep',
      '-z',
      '-n',
      '-o',
      '-w',
      '-F',
      '-I',
      '--no-color',
      ...uniqTerms.flatMap((t) => ['-e', t]),
      ...(rev ? [rev] : []),
      '--',
    ],
    { cwd: root, timeoutMs: TIMEOUT_MS },
  );
  // Exit 1 is "no match"; anything else (timeout, bad revision) is a failure.
  if (!r.ok && !(r.code === 1 && !r.stderr.trim())) return undefined;
  return parseGrep(r.stdout, rev ?? '');
}

const CHANGELOG = /(^|\/)(changelog|changes|history|news|releases?)(\.[a-z]+)?$/i;
const byLine = (a: GrepHit, b: GrepHit) =>
  a.file.localeCompare(b.file) || a.line - b.line;

/** HeadRef nodes from the hits: stale mentions first, then reference counts. */
export function headRefNodes(terms: ScanTerms, hits: GrepHit[]): GraphNode[] {
  const nodes: GraphNode[] = [];
  const add = (props: Record<string, Value>) =>
    nodes.push({ label: 'HeadRef', id: `HR${nodes.length + 1}`, props });
  const byTerm = new Map<string, GrepHit[]>();
  for (const h of hits) byTerm.set(h.term, [...(byTerm.get(h.term) ?? []), h]);
  for (const t of terms.removed) {
    // Still used in code or tests: not removed from the project, so a doc
    // mention isn't stale (a value moved, a name still defined elsewhere).
    if (
      (byTerm.get(t.term) ?? []).some((h) =>
        ['behavior', 'tests'].includes(fileRole(h.file)),
      )
    )
      continue;
    const found = (byTerm.get(t.term) ?? [])
      .filter(
        (h) => ['docs', 'config'].includes(fileRole(h.file)) && !CHANGELOG.test(h.file),
      )
      .sort(byLine);
    if (!found.length) continue;
    add({
      kind: 'still mentions',
      term: t.term,
      termKind: t.kind,
      hunk: t.hunk,
      refs: found.slice(0, MAX_REFS).map((h) => `${h.file}:${h.line}`),
      count: found.length,
    });
  }
  const counted = terms.changed
    .map((t) => {
      const own = new Set(t.files);
      const elsewhere = (byTerm.get(t.term) ?? []).filter(
        (h) => !own.has(h.file) && !['generated'].includes(fileRole(h.file)),
      );
      const files = [...new Set(elsewhere.map((h) => h.file))].sort((a, b) => {
        // Code callers before tests and docs.
        const rank = (f: string) =>
          fileRole(f) === 'behavior' ? 0 : fileRole(f) === 'tests' ? 1 : 2;
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      return { t, count: elsewhere.length, files };
    })
    // Named in very many files: a common word, not a caller list.
    .filter((x) => x.count > 0 && x.files.length <= MAX_CALLER_FILES);
  const top = [...counted].sort(
    (a, b) => b.files.length - a.files.length || b.count - a.count,
  )[0];
  // New symbols first, then by how many files name them.
  counted.sort(
    (a, b) =>
      Number(b === top) - Number(a === top) ||
      Number(b.t.fresh) - Number(a.t.fresh) ||
      b.files.length - a.files.length ||
      a.t.term.localeCompare(b.t.term),
  );
  for (const x of counted)
    add({
      kind: x === top ? 'most referenced' : 'references',
      term: x.t.term,
      fresh: x.t.fresh,
      definedIn: x.t.files,
      refs: x.files.slice(0, MAX_REFS),
      files: x.files.length,
      count: x.count,
    });
  return nodes;
}

/** Scan the head tree and add HeadRef nodes to the graph. Never throws. */
export function addHeadScan(
  graph: EvidenceGraph,
  root: string,
  rev: string | undefined,
): void {
  try {
    if (process.env.TRACETOON_HEAD_SCAN === '0') return;
    const terms = scanTerms(graph);
    const hits = grepTree(root, rev, [
      ...terms.removed.map((t) => t.term),
      ...terms.changed.map((t) => t.term),
    ]);
    if (!hits) return;
    graph.nodes.push(...headRefNodes(terms, hits));
    graph.stats.nodes = graph.nodes.length;
  } catch {
    /* the scan is optional */
  }
}
