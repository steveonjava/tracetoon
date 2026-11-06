/**
 * Build the evidence graph for one run from the redacted full digest, the ordered
 * session trails, the submitted patch and which files each commit touched.
 * Deterministic: the same inputs give byte-identical JSON.
 */
import { evidenceLine } from '../correlate/correlate.ts';
import { fileRole, type SessionTrail, type TraceDigest } from '../digest/build.ts';
import { clip } from '../digest/sanitize.ts';
import {
  GRAPH_SCHEMA,
  type EvidenceGraph,
  type GraphNode,
  type GraphRel,
  type NodeLabel,
  type Value,
} from './model.ts';

export interface PatchHunk {
  id: string;
  file: string;
  /** New-file line range. */
  start: number;
  end: number;
  added: number;
  removed: number;
  /** One-based changes.patch line range, as change-map evidence cites it. */
  diff: string;
  /** The function or section git printed after the @@ header. */
  context?: string;
  /** Normalized added lines, for matching edits. Never written out. */
  lines: Set<string>;
}

/**
 * Split a `git diff` patch into hunks with their changes.patch line ranges. Hunk
 * bodies are read by the line counts in their @@ headers, so content lines that
 * look like headers (a removed "-- comment") are never mistaken for them.
 */
export function patchHunks(patch: string): PatchHunk[] {
  const lines = patch.split(/\r?\n/);
  const hunks: PatchHunk[] = [];
  let file: string | undefined;
  let oldFile: string | undefined;
  let cur: PatchHunk | undefined;
  let first = 0;
  let last = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  const close = () => {
    if (!cur) return;
    cur.diff = last > first ? `diff:${first}-${last}` : `diff:${first}`;
    cur.end = Math.max(cur.start, newLine - 1);
    hunks.push(cur);
    cur = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (cur && line.startsWith('\\')) {
      last = n; // "\ No newline at end of file"
      continue;
    }
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === '+') {
        newLeft--;
        cur.added++;
        newLine++;
        const e = evidenceLine(line.slice(1));
        if (e) cur.lines.add(e);
      } else if (c === '-') {
        oldLeft--;
        cur.removed++;
      } else {
        oldLeft--;
        newLeft--;
        newLine++;
      }
      last = n;
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (h && file) {
      close();
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLine = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
      first = last = n;
      cur = {
        id: `H${hunks.length + 1}`,
        file,
        start: newLine,
        end: newLine,
        added: 0,
        removed: 0,
        diff: '',
        ...(h[4]?.trim() ? { context: clip(h[4].trim(), 80) } : {}),
        lines: new Set(),
      };
      continue;
    }
    close();
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('Untracked content sha256:') ||
      line.startsWith('Binary file')
    )
      file = oldFile = undefined;
    else if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      oldFile = p === '/dev/null' ? undefined : p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? oldFile : p.replace(/^b\//, '');
    }
  }
  close();
  return hunks;
}

const firstLine = (s: string) =>
  s
    .split('\n')
    .find((l) => l.trim())
    ?.replace(/^#+\s*/, '') ?? '';

export interface GraphInputs {
  full: TraceDigest;
  trails: SessionTrail[];
  patch: string;
  /** Short or full commit SHA → repo-relative paths it touched. */
  commitFiles?: Map<string, string[]>;
}

export function buildEvidenceGraph(input: GraphInputs): EvidenceGraph {
  const { full, trails } = input;
  const nodes = new Map<string, GraphNode>();
  const rels: GraphRel[] = [];
  const relSeen = new Set<string>();
  const node = (label: NodeLabel, id: string, props: Record<string, Value>) => {
    const key = `${label}|${id}`;
    const existing = nodes.get(key);
    if (existing) Object.assign(existing.props, props);
    else nodes.set(key, { label, id, props });
  };
  const rel = (
    type: GraphRel['type'],
    from: [NodeLabel, string],
    to: [NodeLabel, string],
    props?: Record<string, Value>,
  ) => {
    const key = `${type}|${from.join(':')}|${to.join(':')}`;
    if (relSeen.has(key)) return;
    relSeen.add(key);
    rels.push({
      type,
      from: { label: from[0], id: from[1] },
      to: { label: to[0], id: to[1] },
      ...(props ? { props } : {}),
    });
  };

  // Files in the PR, with their attribution from the digest.
  const prFiles = new Map(full.files.map((f) => [f.path, f]));
  for (const f of full.files)
    node('File', f.path, {
      role: f.role ?? fileRole(f.path),
      inPr: true,
      added: f.added,
      removed: f.removed,
      unmatched: f.unmatchedLines,
    });

  // Hunks of the submitted patch.
  const hunks = patchHunks(input.patch).filter((h) => prFiles.has(h.file));
  const hunksByFile = new Map<string, PatchHunk[]>();
  for (const h of hunks) {
    hunksByFile.set(h.file, [...(hunksByFile.get(h.file) ?? []), h]);
    node('Hunk', h.id, {
      file: h.file,
      start: h.start,
      end: h.end,
      added: h.added,
      removed: h.removed,
      diff: h.diff,
      context: h.context ?? null,
    });
    rel('OF', ['Hunk', h.id], ['File', h.file]);
  }

  // Sessions and their facts.
  const factSession = new Map<object, string>();
  for (const s of full.sessions) {
    node('Session', s.ref, {
      agent: s.agent,
      band: s.band,
      score: s.score,
      title: s.title ?? null,
    });
    for (const p of s.prompts) factSession.set(p, s.ref);
    for (const p of s.prompts)
      if (p.id)
        node('Prompt', p.id, {
          t: p.t ?? null,
          text: clip(p.text.replace(/\s+/g, ' '), 160),
          pushback: !!p.pushback,
          ledToEdits: p.ledToEdits,
          session: s.ref,
        });
    for (const d of s.decisions)
      if (d.id)
        node('Decision', d.id, {
          t: d.t ?? null,
          text: clip(d.text.replace(/\s+/g, ' '), 160),
          session: s.ref,
        });
    for (const p of s.plans)
      if (p.id)
        node('Plan', p.id, {
          t: p.t ?? null,
          approved: p.approved ?? null,
          text: clip(firstLine(p.excerpt), 120),
          session: s.ref,
        });
    for (const r of s.runs)
      if (r.id)
        node('Run', r.id, {
          t: r.t ?? null,
          cmd: clip(r.cmd, 120),
          kind: r.kind,
          outcome: r.outcome,
          revision: r.revision,
          session: s.ref,
        });
    for (const label of ['Prompt', 'Decision', 'Plan', 'Run'] as const) {
      const facts =
        label === 'Prompt'
          ? s.prompts
          : label === 'Decision'
            ? s.decisions
            : label === 'Plan'
              ? s.plans
              : s.runs;
      for (const f of facts)
        if (f.id) rel('IN_SESSION', [label, f.id], ['Session', s.ref]);
    }
    for (const sha of s.commitsMade) {
      const c = full.pr.commits.find(
        (x) => x.sha.startsWith(sha) || sha.startsWith(x.sha),
      );
      if (c) rel('MADE', ['Session', s.ref], ['Commit', c.sha.slice(0, 12)]);
    }
  }
  for (const r of full.verification ?? [])
    if (r.id) node('Receipt', r.id, { cmd: clip(r.cmd, 120), outcome: r.outcome });

  // Commits and the files they touched.
  for (const c of full.pr.commits) {
    const sha = c.sha.slice(0, 12);
    node('Commit', sha, {
      subject: clip(c.subject, 120),
      // The message body often holds the motivation; keep it queryable.
      body: c.body ? clip(c.body, 600) : null,
    });
    const touched =
      input.commitFiles?.get(c.sha) ??
      [...(input.commitFiles?.entries() ?? [])].find(([k]) => k.startsWith(sha))?.[1] ??
      [];
    for (const path of touched)
      if (prFiles.has(path)) rel('TOUCHES', ['Commit', sha], ['File', path]);
  }

  // Walk each session's trail: turns, edits, survival and later edits.
  let editN = 0;
  let deadEnds = 0;
  const linked = new Set<string>();
  for (const trail of trails) {
    let turn: string | undefined;
    let previousPrompt: string | undefined;
    const openRuns: string[] = [];
    for (const e of trail.events) {
      if (e.kind === 'prompt') {
        const id = e.fact.id;
        if (!id) continue;
        if (previousPrompt && previousPrompt !== id)
          rel('NEXT', ['Prompt', previousPrompt], ['Prompt', id]);
        previousPrompt = turn = id;
        continue;
      }
      if (e.kind !== 'edit') {
        const id = e.fact.id;
        if (!id) continue;
        const label =
          e.kind === 'decision' ? 'Decision' : e.kind === 'plan' ? 'Plan' : 'Run';
        if (turn) rel('IN_TURN', [label, id], ['Prompt', turn]);
        if (e.kind === 'run') openRuns.push(id);
        continue;
      }
      const id = `E${++editN}`;
      let surviving = 0;
      const into: [string, number][] = [];
      for (const h of hunksByFile.get(e.file) ?? []) {
        const n = e.lines.filter((l) => h.lines.has(l)).length;
        if (n) {
          into.push([h.id, n]);
          surviving += n;
        }
      }
      if (!surviving) deadEnds++;
      node('Edit', id, {
        t: e.t ?? null,
        file: e.file,
        added: e.added,
        removed: e.removed,
        surviving,
        inPr: e.inPr,
        via: e.via ?? null,
        session: trail.ref,
      });
      if (!nodes.has(`File|${e.file}`))
        node('File', e.file, {
          role: fileRole(e.file),
          inPr: false,
          added: 0,
          removed: 0,
          unmatched: 0,
        });
      rel('EDITS', ['Edit', id], ['File', e.file]);
      rel('IN_SESSION', ['Edit', id], ['Session', trail.ref]);
      if (turn) rel('IN_TURN', ['Edit', id], ['Prompt', turn]);
      for (const [h, n] of into) {
        rel('SURVIVES_IN', ['Edit', id], ['Hunk', h], { lines: n });
        linked.add(h);
      }
      // Every earlier run in this session did not see this edit to a PR file.
      if (e.inPr)
        for (const r of openRuns) rel('LATER_EDIT', ['Run', r], ['File', e.file]);
    }
  }

  const sorted = [...nodes.values()];
  return {
    schema: GRAPH_SCHEMA,
    nodes: sorted,
    rels,
    stats: {
      nodes: sorted.length,
      rels: rels.length,
      hunks: hunks.length,
      linkedHunks: linked.size,
      edits: editN,
      deadEndEdits: deadEnds,
    },
  };
}
