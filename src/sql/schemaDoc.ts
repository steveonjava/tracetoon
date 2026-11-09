/** The SQLite evidence tables as agents see them (`tracetoon query schema`). */
export const SQL_SCHEMA_DOC = {
  tables: {
    sessions: 'id (hashed ref), agent, band (included|ambiguous), score, title',
    prompts:
      'id (S#), t, text (up to 1500 chars; expand for full), pushback (0/1), ledToEdits, session',
    decisions: 'id (D#), t, text, session',
    plans: 'id (P#), t, approved (0/1/null), text (first line), excerpt, session',
    runs: 'id (R#), t, cmd, kind (test|build|lint|typecheck|eval|other), outcome (passed|failed|unknown), revision, summary (JSON list of result lines), "when" (relative to the edits), session',
    receipts:
      'id (V#), cmd, kind, outcome, summary (JSON list), "when": a check run on the submitted content',
    edits:
      'id (E#), t, file, added, removed, surviving (lines still in the PR), "inPr" (0/1), via (shell when made by a command), session',
    files:
      'id (repo-relative path), role (behavior|tests|docs|config|generated|version), "inPr" (0/1), added, removed, unmatched',
    hunks:
      'id (H#), file, start, "end" (new-file lines), added, removed, diff (changes.patch lines, e.g. diff:120-141), context, scope (symbol git names after @@), symbols, touched, fresh, pairs, tests, words (JSON lists), branches (count)',
    commits: 'id (short SHA), subject, body (null when none), t',
    commit_claims:
      'id (<sha>#n), "commit", text (one sentence of the message), "assertsResult" (0/1: reports a result; a commit-message assertion, not a run)',
    changes:
      'id (CH#), "key" (commit:<sha> | prompt:S# | dir:<path>), files, roles, symbols (JSON lists), added, removed, branches',
  },
  links: {
    in_session:
      "(kind, id, session): a Prompt/Decision/Plan/Run/Edit row and its session (also each table's session column)",
    in_turn:
      '(kind, id, prompt): a Decision/Plan/Run/Edit made while answering that prompt',
    prompt_next: '(prompt, next): the following prompt in the same session',
    edit_file: '(edit, file)',
    edit_hunk: '(edit, hunk, lines): lines of the edit still in that hunk',
    hunk_file: '(hunk, file)',
    run_later_edit:
      '(run, file): the session edited this PR file after the run (the run did not see that edit)',
    session_commit: '(session, "commit"): the session made the commit',
    commit_file: '("commit", file)',
    commit_hunk:
      '("commit", hunk, lines): lines from the commit\'s own patch still in the hunk',
    commit_claim: '("commit", claim)',
    prompt_commit:
      '(prompt, "commit"): typed in an included session after the previous commit and before this one',
    change_hunk: '(change, hunk)',
    change_prompt: '(change, prompt, how)',
    change_commit: '(change, "commit"): commits whose lines are in the change',
    facts:
      'view: decisions and plans together (kind, id, t, text, approved, excerpt, session)',
    turn_facts: 'view: (kind, id, prompt) for decisions and plans in a turn',
  },
  notes: [
    'SQLite; one read-only SELECT per --sql. Quote camelCase or reserved columns: "inPr", "when", "end", "commit", "key".',
    'JSON list columns: read with json_each, e.g. SELECT c.id, j.value FROM changes c, json_each(c.files) j.',
    'Timestamps (t) are ISO strings; compare them as strings.',
    'A missing link row means it was not captured, not that it did not happen.',
    'Cite facts by id (S1, D1, R1, V1) and hunks by their diff ref; expand ids for full text.',
  ],
} as const;
