// Shape test, step 6b: blind fact-support judging of each arm's context.
//
//   bun run judge.ts --harness <prbench worktree> --cases <dataset dir> --contexts <dir> --out <dir>
//
// For each case x arm x judge: the judge sees only the context (no arm label) and
// the case's hand-checked facts (claims, context, uncertainties) and traps, in a
// fixed-seed shuffled order. Replies are cached in <out>/ratings/.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const harness = resolve(opt('--harness')!);
const casesDir = resolve(opt('--cases')!);
const contexts = resolve(opt('--contexts')!);
const out = resolve(opt('--out')!);
mkdirSync(join(out, 'ratings'), { recursive: true });

const { claudeJudge, codexJudge, extractJson } = await import(join(harness, 'src/judge/providers.ts'));
const JUDGES = [claudeJudge('claude-opus-5-5', 15 * 60_000, 'medium'), codexJudge('gpt-6.1-sol', 15 * 60_000, 'medium')];

export const RUN_FACT = /\b(test|tests|tested|run|runs|ran|pass|passed|passing|fail|failed|failing|typecheck|lint|build|suite|green|verified)\b/i;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'traps'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'support', 'reason'],
        properties: { id: { type: 'string' }, support: { enum: ['supported', 'partial', 'absent'] }, reason: { type: 'string' } },
      },
    },
    traps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'invites', 'reason'],
        properties: { id: { type: 'string' }, invites: { type: 'boolean' }, reason: { type: 'string' } },
      },
    },
  },
};

/** Deterministic shuffle (mulberry32 seeded by a string). */
function shuffle<T>(xs: T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rnd = () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function prompt(context: string, facts: { id: string; text: string }[], traps: { id: string; text: string }[]) {
  return [
    'You are auditing the evidence given to a writer who will draft a GitHub pull-request description. The CONTEXT below is the only evidence that writer receives; they cannot look anything else up.',
    '',
    'For each FACT, decide whether the context alone gives a careful writer what they need to state that fact accurately:',
    '- "supported": the context contains the fact\'s key specifics (what changed, where, why, values, names), so a writer could state it correctly.',
    '- "partial": the context contains some of it, but a writer would miss or get wrong a key specific.',
    '- "absent": the context does not contain it.',
    '',
    'For each TRAP (a mistaken claim a writer might make), decide whether the context, read alone, would lead a careful writer into that mistake, because the evidence that rules it out is missing, buried, or misleading ("invites": true), or not ("invites": false).',
    '',
    'Judge only from the context. Do not use outside knowledge. Give a one-sentence reason for each rating. Reply with JSON only, matching the schema.',
    '',
    '=== CONTEXT ===',
    context,
    '=== END CONTEXT ===',
    '',
    'FACTS:',
    ...facts.map((f) => `${f.id}: ${f.text}`),
    '',
    'TRAPS:',
    ...traps.map((t) => `${t.id}: ${t.text}`),
  ].join('\n');
}

for (const id of readdirSync(contexts).sort()) {
  const factsFile = join(casesDir, id, 'facts.json');
  if (!existsSync(factsFile)) continue;
  const f = JSON.parse(readFileSync(factsFile, 'utf8'));
  const facts = [
    ...f.claims.map((t: string, i: number) => ({ id: `C${i + 1}`, text: t })),
    ...f.context.map((t: string, i: number) => ({ id: `X${i + 1}`, text: t })),
    ...f.uncertainties.map((t: string, i: number) => ({ id: `U${i + 1}`, text: t })),
  ];
  const traps = f.traps.map((t: string, i: number) => ({ id: `T${i + 1}`, text: t }));
  for (const file of readdirSync(join(contexts, id)).filter((x) => x.endsWith('.json'))) {
    const ctx = JSON.parse(readFileSync(join(contexts, id, file), 'utf8'));
    if (!ctx.brief) continue;
    for (const judge of JUDGES) {
      const cache = join(out, 'ratings', `${id}__${ctx.arm}__${judge.id.replace(/[^\w.-]+/g, '_')}.json`);
      if (existsSync(cache)) continue;
      const p = prompt(ctx.brief, shuffle(facts, `${id}:facts`), shuffle(traps, `${id}:traps`));
      const t = performance.now();
      try {
        const reply = await judge.ask(p, SCHEMA);
        const json = extractJson(reply.text);
        writeFileSync(cache, JSON.stringify({ case: id, arm: ctx.arm, judge: judge.id, tokens: ctx.tokens, costUsd: reply.costUsd ?? null, ms: Math.round(performance.now() - t), facts, traps, reply: json }, null, 1));
        console.log(`${id.padEnd(8)} ${String(ctx.arm).padEnd(3)} ${judge.id.padEnd(34)} ok`);
      } catch (e) {
        console.log(`${id.padEnd(8)} ${String(ctx.arm).padEnd(3)} ${judge.id.padEnd(34)} ERROR ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
}
