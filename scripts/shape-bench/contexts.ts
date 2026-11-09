// Shape test, step 6a: the context each arm gives its writer, per case, staged
// exactly as prbench stages a writer (sandbox, skill install, prepare), with
// no writer run.
//
//   bun run contexts.ts --harness <prbench worktree> --cases <dataset dir> --out <dir> \
//       --arm G=<skill dir> --arm R=<skill dir> [--case pr5,...]
//
// Writes <out>/<case>/<arm>.json: { case, arm, brief, tokens, ms, skill, error? }.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]!] : []));
const harness = resolve(opt('--harness')!);
const casesDir = resolve(opt('--cases')!);
const out = resolve(opt('--out')!);
const only = opt('--case')?.split(',');
const arms = all('--arm').map((s) => {
  const [name, dir] = s.split('=');
  return { name: name!, skill: resolve(dir!) };
});

const { loadCase, caseDirs } = await import(join(harness, 'src/schema/case.ts'));
const { createSandbox } = await import(join(harness, 'src/run/sandbox.ts'));
const { installTracetoon } = await import(join(harness, 'src/systems/tracetoon.ts'));

for (const dir of caseDirs(casesDir) as string[]) {
  const loaded = loadCase(dir);
  const id = loaded.case.id as string;
  if (only && !only.includes(id)) continue;
  mkdirSync(join(out, id), { recursive: true });
  for (const arm of arms) {
    const file = join(out, id, `${arm.name}.json`);
    if (existsSync(file)) continue;
    const sb = createSandbox(loaded, { parent: '/var/tmp' });
    let row: Record<string, unknown> = { case: id, arm: arm.name, skill: arm.skill };
    try {
      const { env } = installTracetoon(sb, 'claude-code', {
        skill: arm.skill,
        runtime: join(arm.skill, 'bin', 'tracetoon-linux-x64'),
      });
      const t = performance.now();
      const r = spawnSync(env.TRACETOON_BIN!, ['--json', 'prepare'], {
        cwd: sb.repo,
        env: { ...sb.env, ...env },
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 1 << 28,
      });
      const ms = Math.round(performance.now() - t);
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(r.stdout);
      } catch {
        row.error = (r.stderr || r.stdout || 'no output').slice(-500);
      }
      const brief = typeof json.brief === 'string' ? json.brief : '';
      row = { ...row, brief, tokens: Math.ceil(brief.length / 4), ms, run: json.run ?? null };
      if (!brief && !row.error) row.error = 'prepare returned no brief';
    } catch (e) {
      row.error = (e as Error).message;
    } finally {
      sb.dispose();
    }
    writeFileSync(file, JSON.stringify(row, null, 1));
    console.log(`${id.padEnd(8)} ${arm.name.padEnd(3)} ${row.error ? 'ERROR ' + String(row.error).slice(0, 120) : `${row.tokens} tokens, ${row.ms} ms`}`);
  }
}
