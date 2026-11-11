/**
 * Stand-in for `codex exec` / `codex exec resume` in `tracetoon review run`
 * tests. Never calls a model. It logs each call to FAKE_CODEX_LOG, writes a
 * rollout under $CODEX_HOME/sessions with a turn_context model, writes the
 * findings to the -o file and prints Codex-style JSON events.
 *
 * FAKE_REVIEW_OUTPUT: the reply text (default: no findings).
 * FAKE_REVIEW_ROLLOUT_MODEL: the model the rollout records (default: the -m value).
 * FAKE_REVIEW_NO_ROLLOUT=1: write no rollout.
 * FAKE_REVIEW_EXIT: exit with this code after printing an error.
 * FAKE_REVIEW_FAIL_IF: exit 4 when the prompt contains this text (one pass of several fails).
 * FAKE_REVIEW_DELAY_MS: wait this long before replying (calls log start and end times).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const start = Date.now();
const delay = Number(process.env.FAKE_REVIEW_DELAY_MS) || 0;
if (delay) await new Promise((r) => setTimeout(r, delay));
if (process.env.FAKE_CODEX_LOG)
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args, prompt, start, end: Date.now() }) + '\n',
  );
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.FAKE_REVIEW_FAIL_IF && prompt.includes(process.env.FAKE_REVIEW_FAIL_IF)) {
  console.error('fake codex: this pass failed');
  process.exit(4);
}
if (process.env.FAKE_REVIEW_EXIT) {
  console.error('fake codex: something went wrong');
  process.exit(Number(process.env.FAKE_REVIEW_EXIT));
}
const resume = args[0] === 'exec' && args[1] === 'resume';
// `exec resume [opts] <id> -`: the id is the argument before the trailing "-".
const session = resume
  ? args[args.length - 2]!
  : `0199${Math.floor(Math.random() * 1e8)
      .toString(16)
      .padStart(8, '0')}-fake-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
const model = process.env.FAKE_REVIEW_ROLLOUT_MODEL ?? flag('-m') ?? 'gpt-default';
if (!process.env.FAKE_REVIEW_NO_ROLLOUT) {
  const dir = join(process.env.CODEX_HOME!, 'sessions', '2026', '11', '08');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-11-08T10-00-00-${session}.jsonl`);
  const lines = [
    ...(resume
      ? []
      : [{ type: 'session_meta', payload: { id: session, cwd: process.cwd() } }]),
    { type: 'turn_context', payload: { model, turn_id: `t-${Date.now()}` } },
  ];
  appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const reply =
  process.env.FAKE_REVIEW_OUTPUT ??
  JSON.stringify({
    v: 1,
    reviewer: { agentId: 'codex-exec' },
    coldRead: { change: 'Greets by name.', start: 'src/greet.ts' },
    findings: [],
  });
const out = flag('-o');
if (out) writeFileSync(out, reply);
if (!resume) console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: reply },
  }),
);
console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
