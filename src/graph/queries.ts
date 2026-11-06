/**
 * Named questions agents ask the evidence graph. Each runs Cypher on the loaded
 * graph; TypeScript only groups and orders rows so results are deterministic and
 * compact. Results are sections of rows, printed as TOON by `tracetoon query`.
 */
import { GraphError, type GraphEngine } from './engine.ts';
import { SCHEMA_DOC } from './model.ts';

export interface Section {
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface NamedQuery {
  name: string;
  args: string;
  help: string;
  run(g: GraphEngine, args: string[]): Section[];
}

const CHECK_KINDS = ['test', 'build', 'typecheck', 'lint', 'eval'];
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const byDiff = (a: string, b: string) =>
  Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
const factOrder = (a: string, b: string) =>
  a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a.localeCompare(b);
const section = (title: string, columns: string[], rows: Record<string, unknown>[]) => ({
  title,
  columns,
  rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))),
});

/** Resolve a target to a file path or hunk id; accepts `path`, `path:line`, `H3`, `diff:120`. */
function target(
  g: GraphEngine,
  raw: string | undefined,
): { file?: string; hunk?: string } {
  if (!raw)
    throw new GraphError('Give a file path, a hunk (H3) or a diff line (diff:120).');
  if (/^H\d+$/.test(raw)) return { hunk: raw };
  const diff = /^diff:(\d+)/.exec(raw);
  const line = diff ? undefined : /^(.+?):(\d+)$/.exec(raw);
  if (diff || line) {
    const hunks = g.run(
      'MATCH (h:Hunk) RETURN h.id AS id, h.diff AS diff, h.file AS file, h.start AS start, h.end AS end',
    ).rows;
    const n = Number((diff ?? line)![diff ? 1 : 2]);
    const hit = hunks.find((h) => {
      if (diff) {
        const [a, b] = String(h.diff).slice(5).split('-').map(Number);
        return n >= a! && n <= (b ?? a!);
      }
      return h.file === line![1] && n >= Number(h.start) && n <= Number(h.end);
    });
    if (!hit) throw new GraphError(`No hunk at ${raw}.`);
    return { hunk: String(hit.id) };
  }
  const path = raw.replace(/^\.\//, '');
  const found = g.run(
    'MATCH (f:File) WHERE f.id = $p OR f.id ENDS WITH $s RETURN f.id AS id',
    {
      p: path,
      s: `/${path}`,
    },
  ).rows;
  if (!found.length) throw new GraphError(`No file ${raw} in this run's evidence graph.`);
  if (found.length > 1)
    throw new GraphError(
      `${raw} matches ${found.map((f) => f.id).join(', ')}; give the full path.`,
    );
  return { file: String(found[0]!.id) };
}

/** Per prompt: the turn's surviving edits into the target, its decisions and plans. */
function turnsInto(g: GraphEngine, t: { file?: string; hunk?: string }): Section {
  const rows = g.run(
    `${t.hunk ? 'MATCH (h0:Hunk {id: $id})<-[:SURVIVES_IN]-(e:Edit)' : 'MATCH (:File {id: $id})<-[:EDITS]-(e:Edit)'}-[:IN_SESSION]->(:Session {band: 'included'})
     OPTIONAL MATCH (e)-[s:SURVIVES_IN]->(h:Hunk)
     OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
     OPTIONAL MATCH (x)-[:IN_TURN]->(p) WHERE x:Decision OR x:Plan
     RETURN p.id AS prompt, p.text AS text, p.pushback AS pushback, e.id AS edit,
            e.surviving AS surviving, h.diff AS diff, h.file AS hfile, collect(DISTINCT x.id) AS facts`,
    { id: t.hunk ?? t.file },
  ).rows;
  type Turn = {
    prompt: string;
    text: string;
    pushback: boolean;
    edits: Map<string, number>;
    diffs: string[];
    facts: string[];
  };
  const turns = new Map<string, Turn>();
  for (const r of rows) {
    const key = String(r.prompt ?? '(no prompt)');
    const turn: Turn = turns.get(key) ?? {
      prompt: key,
      text: String(r.text ?? ''),
      pushback: !!r.pushback,
      edits: new Map(),
      diffs: [],
      facts: [],
    };
    turn.edits.set(String(r.edit), Number(r.surviving ?? 0));
    if (r.diff && (!t.file || r.hfile === t.file)) turn.diffs.push(String(r.diff));
    turn.facts.push(...((r.facts as string[]) ?? []));
    turns.set(key, turn);
  }
  return section(
    'turns',
    [
      'prompt',
      'pushback',
      'edits',
      'survivingLines',
      'deadEndEdits',
      'diff',
      'facts',
      'text',
    ],
    [...turns.values()]
      .sort((a, b) => factOrder(a.prompt, b.prompt))
      .map((t) => ({
        prompt: t.prompt,
        pushback: t.pushback || null,
        edits: t.edits.size,
        survivingLines: [...t.edits.values()].reduce((a, b) => a + b, 0),
        deadEndEdits: [...t.edits.values()].filter((n) => n === 0).length,
        diff: uniq(t.diffs).sort(byDiff),
        facts: uniq(t.facts).sort(factOrder),
        text: t.text,
      })),
  );
}

/** Check runs (test, build, …) of included sessions after a file's last captured edit. */
export function checksAfterLastEdit(
  g: GraphEngine,
  file?: string,
): {
  file: string;
  role: string;
  lastEdit: string | null;
  after: { id: string; outcome: string; kind: string }[];
}[] {
  // Two indexed lookups, then the time comparison here: a files × runs join in
  // Cypher grows with their product.
  const files = g.run(
    `MATCH (f:File {inPr: true}) ${file ? 'WHERE f.id = $file' : ''}
     OPTIONAL MATCH (f)<-[:EDITS]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
     RETURN f.id AS file, f.role AS role, max(e.t) AS lastEdit, count(e) AS edits`,
    { file: file ?? null },
  ).rows;
  const runs = g
    .run(
      `MATCH (r:Run)-[:IN_SESSION]->(:Session {band: 'included'})
       WHERE r.t IS NOT NULL AND r.kind IN $kinds AND r.revision <> 'after later work'
       RETURN r.id AS id, r.outcome AS outcome, r.kind AS kind, r.t AS t`,
      { kinds: CHECK_KINDS },
    )
    .rows.map((r) => ({
      id: String(r.id),
      outcome: String(r.outcome),
      kind: String(r.kind),
      t: String(r.t),
    }));
  const out = new Map<
    string,
    {
      file: string;
      role: string;
      lastEdit: string | null;
      after: { id: string; outcome: string; kind: string; t: string }[];
    }
  >();
  for (const f of files) {
    const lastEdit = Number(f.edits) ? ((f.lastEdit as string | null) ?? null) : null;
    out.set(String(f.file), {
      file: String(f.file),
      role: String(f.role),
      lastEdit,
      after: lastEdit ? runs.filter((r) => r.t > lastEdit) : [],
    });
  }
  return [...out.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((f) => ({
      ...f,
      after: f.after
        .sort((a, b) => b.t.localeCompare(a.t) || factOrder(a.id, b.id))
        .map(({ t: _t, ...r }) => r),
    }));
}

export function unexplainedHunks(g: GraphEngine): Record<string, unknown>[] {
  return g
    .run(
      `MATCH (h:Hunk)-[:OF]->(f:File)
       WHERE f.role IN ['behavior', 'tests']
         AND NOT EXISTS { MATCH (:Session {band: 'included'})<-[:IN_SESSION]-(:Edit)-[:SURVIVES_IN]->(h) }
       OPTIONAL MATCH (c:Commit)-[:TOUCHES]->(f)
       OPTIONAL MATCH (s:Session)-[:MADE]->(c)
       RETURN h.id AS hunk, h.diff AS diff, f.id AS file, h.added AS added, h.removed AS removed,
              collect(DISTINCT c.id) AS commits, count(DISTINCT s) AS sessionCommits`,
    )
    .rows.map((r): Record<string, unknown> => ({
      ...r,
      commits: ((r.commits as string[]) ?? []).sort(),
      removalOnly: Number(r.added) === 0 || null,
    }))
    .sort((a, b) => byDiff(String(a.diff), String(b.diff)));
}

export const QUERIES: NamedQuery[] = [
  {
    name: 'schema',
    args: '',
    help: 'Node labels, relationships and properties, for writing your own --cypher.',
    run: () => [
      section(
        'nodes',
        ['label', 'properties'],
        Object.entries(SCHEMA_DOC.nodes).map(([label, properties]) => ({
          label,
          properties,
        })),
      ),
      section(
        'relationships',
        ['type', 'pattern'],
        Object.entries(SCHEMA_DOC.relationships).map(([type, pattern]) => ({
          type,
          pattern,
        })),
      ),
      section(
        'notes',
        ['note'],
        SCHEMA_DOC.notes.map((note) => ({ note })),
      ),
    ],
  },
  {
    name: 'outline',
    args: '',
    help: 'Every changed file: role, size, hunks, the prompts whose edits survive in it, the commits that touched it, and checks run after its last edit; then every commit, marking those with a message body to expand.',
    run: (g) => {
      const rows = g.run(
        `MATCH (f:File {inPr: true})
         OPTIONAL MATCH (h:Hunk)-[:OF]->(f)
         WITH f, count(h) AS hunks
         OPTIONAL MATCH (f)<-[:EDITS]-(e:Edit)-[:IN_TURN]->(p:Prompt)
           WHERE e.surviving > 0 AND EXISTS { MATCH (e)-[:IN_SESSION]->(:Session {band: 'included'}) }
         WITH f, hunks, collect(DISTINCT p.id) AS prompts
         OPTIONAL MATCH (c:Commit)-[:TOUCHES]->(f)
         RETURN f.id AS file, f.role AS role, f.added AS added, f.removed AS removed, f.unmatched AS unmatched,
                hunks, prompts, collect(DISTINCT c.id) AS commits`,
      ).rows;
      const checks = new Map(checksAfterLastEdit(g).map((c) => [c.file, c]));
      const rank = (role: unknown) => ({ behavior: 0, tests: 1 })[String(role)] ?? 2;
      return [
        section(
          'files',
          [
            'file',
            'role',
            'added',
            'removed',
            'hunks',
            'unmatched',
            'prompts',
            'commits',
            'checksAfterLastEdit',
          ],
          rows
            .sort(
              (a, b) =>
                rank(a.role) - rank(b.role) ||
                Number(b.added) - Number(a.added) ||
                String(a.file).localeCompare(String(b.file)),
            )
            .map((r) => {
              const c = checks.get(String(r.file));
              return {
                ...r,
                prompts: ((r.prompts as string[]) ?? []).sort(factOrder),
                commits: ((r.commits as string[]) ?? []).sort(),
                checksAfterLastEdit: !c?.lastEdit
                  ? 'no captured edit'
                  : c.after.length
                    ? c.after.slice(0, 3).map((x) => `${x.id}:${x.outcome}`)
                    : 'none',
              };
            }),
        ),
        section(
          'commits',
          ['commit', 'subject', 'hasBody'],
          g
            .run(
              'MATCH (c:Commit) RETURN c.id AS commit, c.subject AS subject, c.body AS body',
            )
            .rows.sort((a, b) => String(a.commit).localeCompare(String(b.commit)))
            .map((r) => ({
              ...r,
              hasBody: r.body ? `yes; tracetoon expand commit:${String(r.commit)}` : null,
            })),
        ),
      ];
    },
  },
  {
    name: 'why',
    args: '<path|path:line|H#|diff:N>',
    help: 'Where a file or hunk came from: the prompts whose edits survive in it (with diff refs and the decisions/plans of that turn), every hunk with whether a captured edit explains it, and the commits that touched it with their message bodies.',
    run: (g, [raw]) => {
      const t = target(g, raw);
      const file =
        t.file ??
        String(
          g.run('MATCH (h:Hunk {id: $id}) RETURN h.file AS f', { id: t.hunk }).rows[0]?.f,
        );
      const out = [turnsInto(g, t)];
      // Every hunk of the target, not only those a captured edit explains: an
      // unexplained hunk still has to be read in the patch.
      out.push(
        section(
          'hunks',
          ['hunk', 'diff', 'added', 'removed', 'prompts', 'explained'],
          g
            .run(
              `MATCH (h:Hunk)-[:OF]->(:File {id: $file})
               ${t.hunk ? 'WHERE h.id = $hunk' : ''}
               OPTIONAL MATCH (h)<-[:SURVIVES_IN]-(e:Edit)-[:IN_SESSION]->(:Session {band: 'included'})
               OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
               RETURN h.id AS hunk, h.diff AS diff, h.added AS added, h.removed AS removed,
                      collect(DISTINCT p.id) AS prompts, count(e) AS edits`,
              { file, hunk: t.hunk ?? null },
            )
            .rows.map((r): Record<string, unknown> => ({
              ...r,
              prompts: ((r.prompts as string[]) ?? []).sort(factOrder),
              explained:
                Number(r.edits) > 0
                  ? 'captured edit'
                  : 'no captured edit; read the patch',
            }))
            .sort((a, b) => byDiff(String(a.diff), String(b.diff))),
        ),
      );
      out.push(
        section(
          'commits',
          ['commit', 'subject', 'madeInSession', 'body'],
          g
            .run(
              `MATCH (c:Commit)-[:TOUCHES]->(:File {id: $file})
               OPTIONAL MATCH (s:Session)-[:MADE]->(c)
               RETURN c.id AS commit, c.subject AS subject, s.id AS madeInSession, c.body AS body`,
              { file },
            )
            .rows.sort((a, b) => String(a.commit).localeCompare(String(b.commit))),
        ),
      );
      const c = checksAfterLastEdit(g, file)[0];
      out.push(
        section(
          'checks',
          ['file', 'lastEdit', 'after'],
          [
            {
              file,
              lastEdit: c?.lastEdit ?? 'no captured edit',
              after: c?.after.map((x) => `${x.id}:${x.kind}:${x.outcome}`) ?? [],
            },
          ],
        ),
      );
      return out;
    },
  },
  {
    name: 'verified',
    args: '[path]',
    help: 'Per changed file: its last captured edit and the check runs after it (latest first). Log evidence only; never proof the submitted content passes.',
    run: (g, [raw]) => {
      const file = raw ? target(g, raw).file : undefined;
      return [
        section(
          'files',
          ['file', 'role', 'lastEdit', 'checksAfter'],
          checksAfterLastEdit(g, file).map((c) => ({
            file: c.file,
            role: c.role,
            lastEdit: c.lastEdit ?? 'no captured edit',
            checksAfter: c.after.map((x) => `${x.id}:${x.kind}:${x.outcome}`),
          })),
        ),
      ];
    },
  },
  {
    name: 'unverified',
    args: '',
    help: 'Behavior and test files with no passing check after their last captured edit, or with no captured edit at all.',
    run: (g) => [
      section(
        'files',
        ['file', 'role', 'lastEdit', 'why'],
        checksAfterLastEdit(g)
          .filter((c) => ['behavior', 'tests'].includes(c.role))
          .filter((c) => !c.lastEdit || !c.after.some((x) => x.outcome === 'passed'))
          .map((c) => ({
            file: c.file,
            role: c.role,
            lastEdit: c.lastEdit ?? null,
            why: !c.lastEdit
              ? 'no captured edit (shell, another tool or by hand)'
              : c.after.length
                ? `only ${c.after.map((x) => `${x.id}:${x.outcome}`).join(', ')} after the last edit`
                : 'no check ran after the last edit',
          })),
      ),
    ],
  },
  {
    name: 'unexplained',
    args: '',
    help: 'Behavior and test hunks no captured agent edit survives in, with the commits that touched their file.',
    run: (g) => [
      section(
        'hunks',
        [
          'hunk',
          'diff',
          'file',
          'added',
          'removed',
          'removalOnly',
          'commits',
          'sessionCommits',
        ],
        unexplainedHunks(g),
      ),
    ],
  },
  {
    name: 'turn',
    args: '<S#>',
    help: 'What one prompt led to: files and hunks its edits survive in, dead-end edits, and the decisions, plans and runs of that turn.',
    run: (g, [id]) => {
      if (!id || !/^S\d+$/.test(id)) throw new GraphError('Give a prompt id such as S3.');
      const p = g.run(
        'MATCH (p:Prompt {id: $id}) RETURN p.text AS text, p.pushback AS pushback, p.t AS t',
        { id },
      ).rows[0];
      if (!p) throw new GraphError(`No prompt ${id} in this run's evidence graph.`);
      const edits = g.run(
        `MATCH (e:Edit)-[:IN_TURN]->(:Prompt {id: $id})
         OPTIONAL MATCH (e)-[:SURVIVES_IN]->(h:Hunk)
         RETURN e.file AS file, e.id AS edit, e.surviving AS surviving, collect(h.diff) AS diffs`,
        { id },
      ).rows;
      const files = new Map<
        string,
        {
          file: string;
          edits: number;
          surviving: number;
          deadEnds: number;
          diff: string[];
        }
      >();
      for (const e of edits) {
        const f = files.get(String(e.file)) ?? {
          file: String(e.file),
          edits: 0,
          surviving: 0,
          deadEnds: 0,
          diff: [],
        };
        f.edits++;
        f.surviving += Number(e.surviving ?? 0);
        if (!Number(e.surviving)) f.deadEnds++;
        f.diff.push(...((e.diffs as string[]) ?? []));
        files.set(f.file, f);
      }
      const facts = g.run(
        `MATCH (x)-[:IN_TURN]->(:Prompt {id: $id}) WHERE x:Decision OR x:Plan OR x:Run
         RETURN x.id AS id, labels(x)[0] AS kind, coalesce(x.text, x.cmd) AS text, x.outcome AS outcome`,
        { id },
      ).rows;
      return [
        section(
          'prompt',
          ['id', 't', 'pushback', 'text'],
          [{ id, ...p, pushback: p.pushback || null }],
        ),
        section(
          'files',
          ['file', 'edits', 'surviving', 'deadEnds', 'diff'],
          [...files.values()]
            .sort((a, b) => a.file.localeCompare(b.file))
            .map((f) => ({ ...f, diff: uniq(f.diff).sort(byDiff) })),
        ),
        section(
          'facts',
          ['id', 'kind', 'outcome', 'text'],
          facts.sort((a, b) => factOrder(String(a.id), String(b.id))),
        ),
      ];
    },
  },
  {
    name: 'stale',
    args: '<R#>',
    help: 'The PR files a session edited after a run, so that run did not see them.',
    run: (g, [id]) => {
      if (!id || !/^R\d+$/.test(id)) throw new GraphError('Give a run id such as R2.');
      const r = g.run(
        'MATCH (r:Run {id: $id}) RETURN r.cmd AS cmd, r.outcome AS outcome, r.revision AS revision, r.t AS t',
        { id },
      ).rows[0];
      if (!r) throw new GraphError(`No run ${id} in this run's evidence graph.`);
      const files = g.run(
        'MATCH (:Run {id: $id})-[:LATER_EDIT]->(f:File) RETURN f.id AS file, f.role AS role',
        { id },
      ).rows;
      return [
        section('run', ['id', 'cmd', 'outcome', 'revision', 't'], [{ id, ...r }]),
        section(
          'editedAfter',
          ['file', 'role'],
          files.sort((a, b) => String(a.file).localeCompare(String(b.file))),
        ),
      ];
    },
  },
  {
    name: 'dead-ends',
    args: '',
    help: 'Edits none of whose lines survive in the PR, by file and prompt: abandoned approaches and rewritten code.',
    run: (g) => [
      section(
        'edits',
        ['file', 'prompt', 'edits', 'linesAdded'],
        g
          .run(
            `MATCH (e:Edit) WHERE e.surviving = 0 AND e.added > 0
             OPTIONAL MATCH (e)-[:IN_TURN]->(p:Prompt)
             RETURN e.file AS file, p.id AS prompt, count(e) AS edits, sum(e.added) AS linesAdded`,
          )
          .rows.sort(
            (a, b) =>
              String(a.file).localeCompare(String(b.file)) ||
              factOrder(String(a.prompt ?? ''), String(b.prompt ?? '')),
          ),
      ),
    ],
  },
  {
    name: 'pushback',
    args: '',
    help: 'Prompts typed while rejecting the agent’s action, with the files edited in that turn and the next prompt.',
    run: (g) => {
      const rows = g.run(
        `MATCH (p:Prompt {pushback: true})
         OPTIONAL MATCH (e:Edit)-[:IN_TURN]->(p)
         OPTIONAL MATCH (p)-[:NEXT]->(n:Prompt)
         RETURN p.id AS prompt, p.text AS text, collect(DISTINCT e.file) AS files, n.id AS next`,
      ).rows;
      return [
        section(
          'prompts',
          ['prompt', 'files', 'next', 'text'],
          rows
            .map((r): Record<string, unknown> => ({
              ...r,
              files: ((r.files as string[]) ?? []).sort(),
            }))
            .sort((a, b) => factOrder(String(a.prompt), String(b.prompt))),
        ),
      ];
    },
  },
];

export function findQuery(name: string): NamedQuery | undefined {
  return QUERIES.find((q) => q.name === name);
}

/** A raw read query from an agent. The database is in memory and per command, but keep it read-only. */
export function rawQuery(
  g: GraphEngine,
  cypher: string,
  params: Record<string, unknown> = {},
): Section[] {
  if (
    /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV)\b/i.test(
      cypher.replace(/'[^']*'|"[^"]*"/g, "''"),
    )
  )
    throw new GraphError('Only read queries are allowed (MATCH … RETURN).');
  const r = g.run(cypher, params);
  return [section('rows', r.columns, r.rows)];
}
