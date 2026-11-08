// Stage each case as prbench does and dump R's GraphInputs plus its context, using
// the frozen R source (3f05397) plus a dump hook. Analysis only.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [harness, casesDir, src, skill, out] = process.argv.slice(2) as [string, string, string, string, string];
const { loadCase, caseDirs } = await import(join(harness, 'src/schema/case.ts'));
const { createSandbox } = await import(join(harness, 'src/run/sandbox.ts'));
const { installTracetoon } = await import(join(harness, 'src/systems/tracetoon.ts'));
mkdirSync(out, { recursive: true });
for (const dir of caseDirs(casesDir) as string[]) {
  const loaded = loadCase(dir);
  const id = loaded.case.id as string;
  if (existsSync(join(out, `${id}.inputs.json`))) continue;
  const sb = createSandbox(loaded, { parent: '/var/tmp' });
  try {
    const { env } = installTracetoon(sb, 'claude-code', { skill, runtime: join(skill, 'bin', 'tracetoon-linux-x64') });
    const dump = join(out, `${id}.inputs.json`);
    const r = spawnSync('bun', [join(src, 'src/cli.ts'), '--json', 'prepare'], {
      cwd: sb.repo, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 28,
      env: { ...sb.env, ...env, PATH: process.env.PATH!, TRACETOON_DUMP_INPUTS: dump, TRACETOON_ASSETS: join(skill, 'assets') },
    });
    let brief = '';
    try { brief = JSON.parse(r.stdout).brief ?? ''; } catch { console.log(id, 'ERR', (r.stderr || r.stdout).slice(-400)); }
    writeFileSync(join(out, `${id}.brief.txt`), brief);
    console.log(id, existsSync(dump) ? 'dumped' : 'NO DUMP', brief.length);
  } finally { sb.dispose(); }
}
