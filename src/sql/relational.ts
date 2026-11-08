/**
 * The relational arm: SQLite as a plain evidence database for PR writing, with
 * no graph brief. The writer gets the same facts as tables, full-text search
 * and a read-only SQL tool, and decides what to look up. `prepare` prints this
 * guide instead of the brief; `render` still writes the Validation section and
 * checks ref tags against database ids. TRACETOON_EVIDENCE_MODE=brief restores
 * the graph-style brief on this branch.
 */
import type { BriefParts } from '../graph/briefRender.ts';
import type { EvidenceDb } from '../graph/db.ts';
import { briefParts, type Section } from '../graph/queries.ts';
import { SQL_SCHEMA_DOC } from './schemaDoc.ts';

export const relationalMode = () => process.env.TRACETOON_EVIDENCE_MODE !== 'brief';

/** The writing rules both arms follow, worded for tables instead of brief rows. */
export const RELATIONAL_RULES = [
  'These rules are instructions for you, not content for the PR: never copy their wording into the description.',
  "Don't write test, build, lint or typecheck results yourself: put the line `<!-- tracetoon:validation -->` where the validation section belongs, and `render` writes it from the runs and receipts tables.",
  'Tag each sentence that states a fact with the ids of the rows it rests on, e.g. `[CH1, S1]`, `[commit:<sha>#2]`, `[H3]` (any id in the tables: changes, prompts, decisions, plans, commits, commit_claims, hunks, runs); `render` removes the tags and lists sentences with no tag or an unknown id.',
  "Line matching (files.unmatched, edits.surviving, session_commit) is not authorship: don't report who wrote what as percentages or counts.",
  'A commit_claims sentence speaks for its own commit only: never generalize it to other commits.',
  'commit_claims rows with assertsResult = 1 report a result in a commit message, not a run: attribute them to that commit message or leave them out.',
  "A run with run_later_edit rows did not see those files' later edits: don't present it as testing the final code.",
  'A run after the last captured edit ran after the last edit the logs show, not necessarily on the final code: never say "on the final code" or "after all changes".',
  'Absence of a recorded run is not evidence a check was never run or that code is untested: write "no recorded run", never "not tested", "not exercised" or "never ran".',
  'Point reviewers at files, not at functions, and not at the largest file.',
  'Name a file for a commit-message sentence only when its hunks show it; otherwise describe the behavior without naming where it lives.',
  'Call a symbol new, added or introduced only if it is in hunks.fresh; others already existed and were changed.',
  'hunks.pairs lines are code, not history: quote one only verbatim, as `old` → `new` in its file; never describe what the old code did beyond that.',
  "Words a commit message puts in parentheses or asides ('local only', 'experimental') are that commit's own remark: attribute them or leave them out.",
];

/** Queries that answer what a description needs, as a starting point. */
const STARTERS: [string, string][] = [
  [
    'change units (one idea each)',
    `SELECT id, key, files, symbols, added, removed FROM changes ORDER BY CAST(substr(id, 3) AS INTEGER)`,
  ],
  [
    'the hunks of a change: new symbols, old → new values, test titles',
    `SELECT h.id, h.file, h.diff, h.fresh, h.pairs, h.tests FROM change_hunk ch JOIN hunks h ON h.id = ch.hunk WHERE ch.change = 'CH1'`,
  ],
  [
    'commits and their message sentences',
    `SELECT c.id, c.subject, m.id AS claim, m.text, m."assertsResult" FROM commits c LEFT JOIN commit_claims m ON m."commit" = c.id ORDER BY c.t`,
  ],
  [
    'the requests behind each change',
    `SELECT cp.change, p.id, p.text, cp.how FROM change_prompt cp JOIN prompts p ON p.id = cp.prompt`,
  ],
  [
    'the goal: the first request of the work',
    `SELECT p.id, p.text FROM prompts p JOIN sessions s ON s.id = p.session AND s.band = 'included' ORDER BY p.t LIMIT 1`,
  ],
  [
    'plans and decisions',
    `SELECT kind, id, coalesce(excerpt, text) AS text, approved FROM facts ORDER BY t`,
  ],
  [
    'checks and when they ran',
    `SELECT id, kind, outcome, summary, "when", cmd FROM runs WHERE kind <> 'other' ORDER BY t`,
  ],
  [
    'what the agent read before the edits of a change',
    `SELECT DISTINCT r.file, r.pattern FROM reads r JOIN in_turn it ON it.prompt = r.prompt JOIN edit_hunk eh ON eh.edit = it.id JOIN change_hunk ch ON ch.hunk = eh.hunk WHERE ch.change = 'CH1'`,
  ],
];

const count = (g: EvidenceDb, table: string) =>
  Number(
    g.run({ cypher: '', sql: `SELECT count(*) AS n FROM ${table}` }).rows[0]?.n ?? 0,
  );

/** What `prepare` prints in place of the brief. */
export function relationalGuide(g: EvidenceDb, run: string): string {
  const size = [
    'commits',
    'changes',
    'hunks',
    'prompts',
    'decisions',
    'plans',
    'runs',
    'reads',
  ]
    .map((t) => `${count(g, t)} ${t}`)
    .join(', ');
  const files = Number(
    g.run({ cypher: '', sql: `SELECT count(*) AS n FROM files WHERE "inPr" = 1` }).rows[0]
      ?.n ?? 0,
  );
  return [
    'Evidence database for this PR (SQLite). The facts are in tables; nothing is selected for you: look up what the description needs.',
    `Size: ${files} changed files, ${size}.`,
    '',
    'Ask it:',
    `  tracetoon query --sql "SELECT …" --run ${run}    read-only, one statement; JSON lists read with json_each`,
    `  tracetoon query search <words> --run ${run}      full text over prompts, decisions, plans, commit messages and changed-line words`,
    '  tracetoon query schema                           every table and column',
    '',
    'Tables:',
    ...Object.entries(SQL_SCHEMA_DOC.tables).map(([t, cols]) => `  ${t}: ${cols}`),
    ...Object.entries(SQL_SCHEMA_DOC.links).map(([t, cols]) => `  ${t}: ${cols}`),
    '',
    'Starter queries:',
    ...STARTERS.map(([what, sql]) => `  ${what}:\n    ${sql}`),
    '',
    'Rules:',
    ...RELATIONAL_RULES.map((r) => `  - ${r}`),
  ].join('\n');
}

export function relationalNext(run: string): string {
  return `take the lean path with the evidence database: write title.txt and body.md yourself, looking up what you need with \`tracetoon query --sql\` and \`tracetoon query search\` (the guide below lists the tables and starter queries). Body, in this order: (1) the problem: the goal request, what was wrong or missing before, and what triggered the change, as the request or commit message says it (a hunks.pairs line may be quoted verbatim as \`old\` → \`new\` in its file, never retold); (2) one short part per change unit covering each of its commit-message sentences; (3) the tests added, from hunks.tests; (4) consequences and what the evidence leaves open; (5) which files a reviewer should start with (files, not functions); (6) PR or issue links the commits give; (7) one line for version bumps and rebuilt files. Give a reason only as the request or commit message states it, attributed. End every factual sentence with the ids of the rows it rests on, like [CH1, commit:<sha>#2]. Write no test or check results: put the line <!-- tracetoon:validation --> where they belong and render writes them. Follow the rules in the guide; never copy their wording. Then \`tracetoon render --lean --json --run ${run}\`: fix every sentence it lists and cover every commit-message sentence it lists, render again (up to three rounds) until it reports nothing left to fix, and publish.`;
}

/**
 * What `render` checks a relational draft against: the Validation section (the
 * same rows the graph arm writes it from),
 * every commit-message sentence (each should be cited), and every id in the database (a tag must name a real row; names in a sentence
 * are checked against the rows it cites). No brief rows: no change-unit,
 * placement or goal coverage, which come from the graph's curation.
 */
export function relationalParts(g: EvidenceDb): BriefParts {
  const full = briefParts(g);
  const validation = full.sections.find((s) => s.title === 'validation')!;
  // Commit subjects and message sentences, as the graph brief lists them: render asks
  // for every sentence (four words or more) to be cited, itself or by its commit.
  const commits = g.run({
    cypher: '',
    sql: `SELECT 'commit:' || c.id AS ref, c.subject AS text, c.t AS t, 0 AS n FROM commits c
          WHERE c.id IN (SELECT "commit" FROM commit_hunk)
          UNION ALL
          SELECT m.id, m.text, c.t, CAST(substr(m.id, instr(m.id, '#') + 1) AS INTEGER) FROM commit_claims m
          JOIN commits c ON c.id = m."commit" WHERE m."assertsResult" = 0
          ORDER BY t, n`,
  }).rows;
  const ids = g.run({
    cypher: '',
    sql: `SELECT id, json_object('id', id, 'files', files, 'symbols', symbols) AS text FROM changes
          UNION ALL SELECT id, json_object('id', id, 'file', file, 'symbols', symbols, 'touched', touched, 'tests', tests) FROM hunks
          UNION ALL SELECT id, json_object('id', id, 'text', text) FROM prompts
          UNION ALL SELECT id, json_object('id', id, 'text', coalesce(excerpt, text)) FROM facts
          UNION ALL SELECT id, json_object('id', id, 'text', text) FROM commit_claims
          UNION ALL SELECT 'commit:' || id, json_object('id', id, 'subject', subject, 'body', body) FROM commits
          UNION ALL SELECT id, json_object('id', id, 'cmd', cmd) FROM runs
          UNION ALL SELECT id, json_object('id', id, 'cmd', cmd) FROM receipts`,
  }).rows;
  const sections: Section[] = [
    {
      title: 'commitMessages',
      columns: ['ref', 'text'],
      rows: commits.map((c) => ({ ref: c.ref, text: c.text })),
    },
    {
      title: 'ids',
      columns: ['ref', 'row'],
      rows: ids.map((r) => ({ ref: r.id, row: r.text })),
    },
    validation,
  ];
  return { sections, unchecked: full.unchecked };
}
