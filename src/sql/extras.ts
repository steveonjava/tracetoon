/**
 * SQLite-only evidence (the sqlite arm's extras): what the agent read, how much
 * each turn and change cost, which edits turned a failing check into a passing
 * one, and full-text search over the "why" text. The tables are always loaded;
 * the brief shows them only with TRACETOON_SQLITE_EXTRAS=1, so the flag-off
 * sqlite arm writes the same brief as the graph arm.
 */
import { shownCommand } from '../graph/briefRender.ts';
import type { EvidenceDb } from '../graph/db.ts';
import type { EvidenceGraph } from '../graph/model.ts';
import type { Section } from '../graph/queries.ts';

interface Exec {
  exec(sql: string): void;
  prepare(sql: string): { all(params?: Record<string, unknown>): unknown[] };
}

export const extrasOn = () => process.env.TRACETOON_SQLITE_EXTRAS === '1';

const CHECK_KINDS = `('test', 'build', 'typecheck', 'lint', 'eval')`;

export const EXTRAS_SQL = `
CREATE TABLE reads (id TEXT PRIMARY KEY, t, session, prompt, tool, file, pattern, "inPr");
CREATE INDEX reads_prompt ON reads (prompt);
CREATE INDEX reads_file ON reads (file);
CREATE TABLE usage (t, session, prompt, input, output, "cacheRead", "cacheWrite");
CREATE INDEX usage_prompt ON usage (prompt);
CREATE TABLE run_keys (run TEXT PRIMARY KEY, cmd_key);
CREATE VIRTUAL TABLE evidence_fts USING fts5(kind UNINDEXED, id UNINDEXED, text, tokenize = 'porter unicode61');

-- Per prompt turn: what it cost and what it did.
CREATE VIEW turn_effort AS
SELECT p.id AS prompt, p.session, p.t,
  (SELECT count(*) FROM usage u WHERE u.prompt = p.id) AS responses,
  (SELECT coalesce(sum(u.output), 0) FROM usage u WHERE u.prompt = p.id) AS output_tokens,
  (SELECT coalesce(sum(u.input + u."cacheRead" + u."cacheWrite"), 0) FROM usage u WHERE u.prompt = p.id) AS input_tokens,
  (SELECT max(u.t) FROM usage u WHERE u.prompt = p.id) AS last_t,
  (SELECT count(*) FROM in_turn it WHERE it.kind = 'Edit' AND it.prompt = p.id) AS edits,
  (SELECT count(*) FROM in_turn it JOIN edits e ON e.id = it.id
    WHERE it.kind = 'Edit' AND it.prompt = p.id AND e.surviving = 0) AS dead_ends,
  (SELECT count(*) FROM in_turn it WHERE it.kind = 'Run' AND it.prompt = p.id) AS runs,
  (SELECT count(*) FROM reads r WHERE r.prompt = p.id) AS reads
FROM prompts p;

-- Per change: the turns that made it, and their effort (a turn can serve several changes).
CREATE VIEW change_effort AS
SELECT c.id AS change,
  count(DISTINCT cp.prompt) AS turns,
  (SELECT count(DISTINCT eh.edit) FROM change_hunk ch JOIN edit_hunk eh ON eh.hunk = ch.hunk
    WHERE ch.change = c.id) AS surviving_edits,
  coalesce(sum(te.dead_ends), 0) AS dead_ends_in_turns,
  coalesce(sum(te.runs), 0) AS runs_in_turns,
  coalesce(sum(te.output_tokens), 0) AS output_tokens,
  coalesce(sum(te.reads), 0) AS reads_in_turns
FROM changes c
LEFT JOIN change_prompt cp ON cp.change = c.id
LEFT JOIN turn_effort te ON te.prompt = cp.prompt
GROUP BY c.id;

-- A failing check, the edits after it, and the next passing run of the same command.
-- Runs of one command in one session are split into streaks ending at each pass.
CREATE VIEW run_cycles AS
WITH seq AS (
  SELECT r.id, r.t, r.session, r.outcome, k.cmd_key, r.rowid AS rid,
    coalesce(sum(r.outcome = 'passed') OVER (
      PARTITION BY r.session, k.cmd_key ORDER BY r.t, r.rowid
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS streak
  FROM runs r JOIN run_keys k ON k.run = r.id
  WHERE r.t IS NOT NULL AND r.kind IN ${CHECK_KINDS}
), streaks AS (
  SELECT session, cmd_key, streak,
    count(*) FILTER (WHERE outcome = 'failed') AS failures,
    max(CASE WHEN outcome = 'passed' THEN id END) AS passed_run,
    max(CASE WHEN outcome = 'passed' THEN t END) AS passed_t,
    (SELECT s2.id FROM seq s2 WHERE s2.session = seq.session AND s2.cmd_key = seq.cmd_key
       AND s2.streak = seq.streak AND s2.outcome = 'failed' ORDER BY s2.t, s2.rid LIMIT 1) AS failed_run,
    min(CASE WHEN outcome = 'failed' THEN t END) AS failed_t
  FROM seq GROUP BY session, cmd_key, streak
)
SELECT s.cmd_key, s.session, s.failed_run, s.failures, s.passed_run,
  (SELECT json_group_array(id) FROM (SELECT e.id FROM edits e
     WHERE e.session = s.session AND e.t > s.failed_t AND e.t <= s.passed_t
     ORDER BY e.t, e.rowid)) AS edits,
  (SELECT json_group_array(DISTINCT e.file) FROM edits e
     WHERE e.session = s.session AND e.t > s.failed_t AND e.t <= s.passed_t AND e."inPr" = 1) AS files
FROM streaks s
WHERE s.failures > 0 AND s.passed_run IS NOT NULL;
`;

/** Fill the extras tables (inside loadEvidence's transaction). */
export function loadExtras(db: Exec, graph: EvidenceGraph): void {
  db.exec(EXTRAS_SQL);
  const ins = (sql: string) => {
    const s = db.prepare(sql);
    return (p: Record<string, unknown>) => s.all(p);
  };
  const read = ins(
    `INSERT INTO reads VALUES ($id, $t, $session, $prompt, $tool, $file, $pattern, $inPr)`,
  );
  (graph.extras?.reads ?? []).forEach((r, i) =>
    read({ ...r, id: `X${i + 1}`, inPr: Number(r.inPr) }),
  );
  const use = ins(
    `INSERT INTO usage VALUES ($t, $session, $prompt, $input, $output, $cacheRead, $cacheWrite)`,
  );
  for (const u of graph.extras?.usage ?? []) use({ ...u });
  const key = ins('INSERT OR IGNORE INTO run_keys VALUES ($run, $key)');
  const fts = ins('INSERT INTO evidence_fts VALUES ($kind, $id, $text)');
  for (const n of graph.nodes) {
    const p = n.props;
    if (n.label === 'Run') key({ run: n.id, key: shownCommand(p.cmd) });
    const text =
      n.label === 'Prompt' || n.label === 'Decision' || n.label === 'CommitClaim'
        ? p.text
        : n.label === 'Plan'
          ? p.excerpt
          : n.label === 'Commit'
            ? [p.subject, p.body].filter(Boolean).join('\n')
            : undefined;
    if (typeof text === 'string' && text) fts({ kind: n.label, id: n.id, text });
  }
}

/** FTS5 query from plain words: each word quoted, all required. */
export function ftsQuery(terms: string[]): string {
  return terms
    .flatMap((t) => t.split(/\s+/))
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(' ');
}

const refs = (xs: string[], cap: number) =>
  xs.length > cap ? [...xs.slice(0, cap), `+${xs.length - cap} more`] : xs;

/**
 * The brief's extra sections: files outside the PR the agent read for each
 * change (X#), checks that went from failing to passing and the edits between
 * (F#), and effort per change (context, not for claims).
 */
export function extraSections(g: EvidenceDb): Section[] {
  const run = (sql: string, json: string[] = []) => g.run({ cypher: '', sql, json }).rows;
  const context = run(
    `SELECT cp.change AS change,
       json_group_array(DISTINCT r.file) FILTER (WHERE r.pattern IS NULL AND r."inPr" = 0 AND r.file <> '.') AS read,
       json_group_array(DISTINCT r.pattern || ' in ' || r.file) FILTER (WHERE r.pattern IS NOT NULL) AS searched,
       json_group_array(DISTINCT r.prompt) AS turns
     FROM change_prompt cp JOIN reads r ON r.prompt = cp.prompt
     JOIN sessions s ON s.id = r.session AND s.band = 'included'
     GROUP BY cp.change ORDER BY min(cp.rowid)`,
    ['read', 'searched', 'turns'],
  )
    .filter((r) => (r.read as string[]).length || (r.searched as string[]).length)
    .map((r, i) => ({
      ref: `X${i + 1}`,
      for: r.change,
      read: refs((r.read as string[]).sort(), 8),
      searched: refs(r.searched as string[], 4),
      turns: (r.turns as string[]).sort(),
    }));
  const fixes = run(
    `SELECT c.cmd_key AS cmd, c.failed_run AS failed, c.failures AS failures, c.passed_run AS passed,
            c.edits AS edits, c.files AS files
     FROM run_cycles c JOIN sessions s ON s.id = c.session AND s.band = 'included'
     JOIN runs r ON r.id = c.passed_run ORDER BY r.t, r.rowid`,
    ['edits', 'files'],
  ).map((r, i) => ({
    ref: `F${i + 1}`,
    cmd: r.cmd,
    failed:
      Number(r.failures) > 1
        ? `${String(r.failed)} (+${Number(r.failures) - 1} more failing runs)`
        : r.failed,
    fixedBy: refs(r.edits as string[], 6),
    files: refs((r.files as string[]).sort(), 6),
    passed: r.passed,
  }));
  const effort = run(
    `SELECT change, turns, surviving_edits AS edits, dead_ends_in_turns AS deadEnds,
            runs_in_turns AS runs, reads_in_turns AS reads, output_tokens AS outputTokens
     FROM change_effort ORDER BY CAST(substr(change, 3) AS INTEGER)`,
  );
  return [
    {
      title: 'context',
      columns: ['ref', 'for', 'read', 'searched', 'turns'],
      rows: context,
    },
    {
      title: 'fixes',
      columns: ['ref', 'cmd', 'failed', 'fixedBy', 'files', 'passed'],
      rows: fixes,
    },
    {
      title: 'effort',
      columns: ['change', 'turns', 'edits', 'deadEnds', 'runs', 'reads', 'outputTokens'],
      rows: effort,
    },
  ];
}

/** Rules for the extra sections, appended to the brief's `avoid`. */
export const EXTRA_RULES = [
  'context rows (X#) are files outside the PR the agent read, and searches it ran, in the turns that made a change: use them to tell reviewers what was consulted (e.g. "checked the callers in X"), never to claim those files were changed or are covered.',
  'fixes rows (F#) show a check that failed, the edits between, and the next passing run of the same command; cite them for how a failure was fixed, and leave results to the Validation section.',
  'effort rows are context for you: never report token counts, turn counts or edit counts in the PR.',
  '`tracetoon query search <words> --run <id>` finds the prompts, decisions, plans and commit messages that mention a term, when you need the reason behind a change.',
];
