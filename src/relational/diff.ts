/**
 * Unified-diff parsing and chunking for the relational/vector arm (its own
 * parser: nothing from src/graph). A patch becomes files → hunks → chunks:
 *
 * - **Hunks** are read by the line counts in their `@@` headers, so content
 *   lines that look like headers are never mistaken for them.
 * - **Chunks** are the retrieval and citation unit (H#). A hunk with at most
 *   `CHUNK_LINES` changed lines is one chunk; a larger one (a new file, a big
 *   rewrite) is split where a top-level definition starts, so each chunk is
 *   about one function or section and embeds without being diluted.
 */
import { evidenceLine } from '../correlate/correlate.ts';
import { fileRole, type FileRole } from '../digest/build.ts';
import { STOP } from './text.ts';

export interface DiffLine {
  sign: '+' | '-' | ' ';
  text: string;
  /** New-file line number (added and context lines). */
  newNo?: number;
  /** Old-file line number (removed and context lines). */
  oldNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
  /** What git printed after the `@@` (the enclosing function or section). */
  ctx: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  role: FileRole;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

export interface Chunk {
  /** Set by the store (H1, H2… in file and position order). */
  id: string;
  file: string;
  hunk: number;
  /** New-file line range (old-file range for a pure deletion). */
  start: number;
  end: number;
  added: number;
  removed: number;
  /** Changed lines only (context dropped). */
  lines: DiffLine[];
  /** The enclosing function or section (git's @@ context or the nearest definition above). */
  scope?: string;
  /** Names defined on added lines. */
  defined: string[];
  /** Names defined on removed lines. */
  removedDefs: string[];
  /** Test titles added here. */
  tests: string[];
}

/** Changed lines per chunk before a large hunk is split at definitions. */
export const CHUNK_LINES = 40;

export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = patch.split(/\r?\n/);
  let f: DiffFile | undefined;
  let h: DiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  const start = (a: string, b: string) => {
    f = {
      path: b,
      oldPath: a !== b ? a : undefined,
      status: a !== b ? 'renamed' : 'modified',
      binary: false,
      role: fileRole(b),
      added: 0,
      removed: 0,
      hunks: [],
    };
    files.push(f);
    h = undefined;
  };
  for (const line of lines) {
    if (h && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '\\') continue;
      if (c === '+') {
        h.lines.push({ sign: '+', text: line.slice(1), newNo: newNo++ });
        newLeft--;
        f!.added++;
        continue;
      }
      if (c === '-') {
        h.lines.push({ sign: '-', text: line.slice(1), oldNo: oldNo++ });
        oldLeft--;
        f!.removed++;
        continue;
      }
      if (c === ' ' || line === '') {
        h.lines.push({ sign: ' ', text: line.slice(1), newNo: newNo++, oldNo: oldNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      // A malformed count: fall through and read the line as a header.
      oldLeft = newLeft = 0;
    }
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (git) {
      start(git[1]!, git[2]!);
      continue;
    }
    if (!f) continue;
    if (line.startsWith('new file mode')) f.status = 'added';
    else if (line.startsWith('deleted file mode')) f.status = 'deleted';
    else if (line.startsWith('rename from ')) f.oldPath = line.slice(12);
    else if (line.startsWith('rename to ')) {
      f.path = line.slice(10);
      f.role = fileRole(f.path);
      f.status = 'renamed';
    } else if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch')
      f.binary = true;
    else if (line.startsWith('+++ ') && line.slice(4) !== '/dev/null')
      f.path = line.slice(4).replace(/^b\//, '');
    else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (m) {
        h = {
          oldStart: +m[1]!,
          oldLen: m[2] === undefined ? 1 : +m[2],
          newStart: +m[3]!,
          newLen: m[4] === undefined ? 1 : +m[4],
          ctx: m[5]!.trim(),
          lines: [],
        };
        f.hunks.push(h);
        oldLeft = h.oldLen;
        newLeft = h.newLen;
        oldNo = h.oldStart;
        newNo = h.newStart;
      }
    }
  }
  return files;
}

const NOT_NAMES = new Set(
  'if for while switch catch return function else new await typeof do try with super this constructor'.split(
    ' ',
  ),
);
const DEFS = [
  /\b(?:function\*?|class|interface|enum|type|def|fn|struct|trait|module|record|object)\s+([A-Za-z_$][\w$]*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|function\b)/,
  /^\s*(?:(?:export|public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={;]+)?\{\s*$/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
];

/** The name a line defines (function, class, type, exported constant, heading), if any. */
export function definedName(line: string, doc = false): string | undefined {
  // Regexes see at most 240 characters: minified lines would backtrack for long.
  line = line.slice(0, 240);
  if (doc) return /^#{1,4}\s+(.{3,60}?)\s*#*$/.exec(line)?.[1]?.trim();
  // Comments mention definitions (`def test_…`) without making them.
  if (/^\s*(\/\/|\/\*|\*|#(?!include)|--\s)/.test(line)) return undefined;
  if (
    /^\s*(import\b|from\s+\S+\s+import\b|use\s|using\s|#\s*include\b|export\s*\{|export\s+\*)/.test(
      line,
    )
  )
    return undefined;
  for (const re of DEFS) {
    const m = re.exec(line);
    if (m?.[1] && !NOT_NAMES.has(m[1]) && !STOP.has(m[1]) && m[1].length > 1) return m[1];
  }
  return undefined;
}

const TEST_CALL =
  /\b(?:test|it|describe|suite|context|specify)(?:\.(?:only|skip|todo|concurrent|each\([^()]{0,80}\)))?\s*\(\s*(['"`])/g;
const TEST_DEF = [/\bdef\s+(test_\w+)/, /\bfunc\s+(Test\w+)/, /\bfn\s+(test_\w+)/];

/** A test title added on this line (`test('…')`, `def test_…`, `func Test…`). */
export function testTitle(line: string): string | undefined {
  line = line.slice(0, 240);
  for (const m of line.matchAll(TEST_CALL)) {
    // Scan to the closing quote (linear: no backtracking regex).
    const q = m[1]!;
    let out = '';
    for (let i = m.index! + m[0].length; i < line.length; i++) {
      const c = line[i]!;
      if (c === '\\' && i + 1 < line.length) {
        out += line[++i];
        continue;
      }
      if (c === q) return out.length >= 3 ? out : undefined;
      out += c;
    }
  }
  for (const re of TEST_DEF) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

const indentOf = (s: string) => /^\s*/.exec(s)![0].replace(/\t/g, '    ').length;

/** Split one file's hunks into chunks (ids are assigned later). */
export function chunkFile(file: DiffFile): Chunk[] {
  const out: Chunk[] = [];
  const doc = /\.(md|mdx|markdown)$/i.test(file.path);
  const def = (t: string) => definedName(t, doc);
  file.hunks.forEach((h, hi) => {
    const changed = h.lines.filter((l) => l.sign !== ' ');
    if (!changed.length) return;
    const minIndent = Math.min(
      ...changed.filter((l) => l.text.trim()).map((l) => indentOf(l.text)),
      Infinity,
    );
    // Split points: a definition at the hunk's shallowest indent, once the piece has some size.
    const pieces: DiffLine[][] = [];
    if (changed.length <= CHUNK_LINES) pieces.push(h.lines);
    else {
      let cur: DiffLine[] = [];
      let curChanged = 0;
      for (const l of h.lines) {
        const isDef =
          l.sign !== ' ' &&
          indentOf(l.text) <= minIndent &&
          (def(l.text) !== undefined || testTitle(l.text) !== undefined);
        if ((isDef && curChanged >= 8) || curChanged >= CHUNK_LINES * 2) {
          pieces.push(cur);
          cur = [];
          curChanged = 0;
        }
        cur.push(l);
        if (l.sign !== ' ') curChanged++;
      }
      if (cur.length) pieces.push(cur);
    }
    // The enclosing definition: git's @@ context, then the last shallow
    // definition (or heading) a previous piece of the hunk left open.
    let scope = h.ctx ? def(h.ctx) : undefined;
    for (const piece of pieces) {
      const ch = piece.filter((l) => l.sign !== ' ');
      if (!ch.length) continue;
      const added = ch.filter((l) => l.sign === '+');
      const nums = added.length ? added.map((l) => l.newNo!) : ch.map((l) => l.oldNo!);
      const range = nums.length ? nums : [h.newStart];
      const defined: string[] = [];
      const removedDefs: string[] = [];
      const tests: string[] = [];
      let open = scope;
      for (const l of piece) {
        const d = def(l.text);
        if (d && l.sign !== '-' && (doc || indentOf(l.text) <= minIndent)) open = d;
        if (d && l.sign === '+' && !defined.includes(d)) defined.push(d);
        if (d && l.sign === '-' && !removedDefs.includes(d)) removedDefs.push(d);
        const t = l.sign === '+' ? testTitle(l.text) : undefined;
        if (t && !tests.includes(t)) tests.push(t);
      }
      // A piece that starts with its own definition has no outer scope to name.
      const first = ch.find((l) => l.text.trim());
      const startsWithDef = !!first && def(first.text) !== undefined;
      out.push({
        id: '',
        file: file.path,
        hunk: hi,
        start: Math.min(...range),
        end: Math.max(...range),
        added: added.length,
        removed: ch.length - added.length,
        lines: ch,
        scope:
          scope && !startsWithDef && !defined.includes(scope) && file.status !== 'added'
            ? scope
            : undefined,
        defined,
        removedDefs,
        tests,
      });
      scope = open;
    }
  });
  return out;
}

/** The normalized form of a line, as session edits and commit lines carry it. */
export const normLine = (s: string) => evidenceLine(s);

/** A changed line worth showing: not blank, not just punctuation or a closing brace. */
export const informative = (s: string) =>
  /[A-Za-z0-9]{2,}/.test(s) && s.trim().length > 3;
