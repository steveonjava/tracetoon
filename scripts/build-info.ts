/** Stamp one identity into the skill, bundle and compiled binaries. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { prepareDependencies } from './dependencies.ts';
import { verifyRelate } from './relate.ts';

const root = resolve(import.meta.dir, '..');
export function buildManifest(check = false, stamp = true) {
  const dependencies = [prepareDependencies()];
  verifyRelate(); // the vendored graph engine must match its pin
  const recipe = JSON.parse(readFileSync(join(root, 'build.config.json'), 'utf8'));
  if (recipe.schema !== 'tracetoon.build-recipe/v1' || recipe.bunVersion !== Bun.version)
    throw new Error(`Builds require Bun ${recipe.bunVersion}; found ${Bun.version}.`);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    .version as string;
  const pluginPath = join(root, 'plugin/.claude-plugin/plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
  if ((check || !stamp) && plugin.version !== version)
    throw new Error('Plugin version differs from package.json. Run bun run bundle.');
  if (!check && stamp)
    writeFileSync(pluginPath, JSON.stringify({ ...plugin, version }, null, 2) + '\n');
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (['build.json', 'VERSION'].includes(e.name) || path.includes('/dist/')) continue;
      if (/\/bin\/tracetoon-(?:windows|linux|darwin)-/.test(path)) continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) paths.push(path);
    }
  };
  for (const dir of ['src', 'scripts', 'plugin/skills/tracetoon']) walk(dir);
  paths.push(
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'build-dependencies.json',
    'build.config.json',
    'install.sh',
    'install.ps1',
    'plugin/.claude-plugin/plugin.json',
  );
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const data = readFileSync(join(root, path));
    const text = data.toString('utf8');
    hash
      .update(path)
      .update('\0')
      .update(
        !data.includes(0) && Buffer.from(text).equals(data)
          ? text.replace(/\r\n/g, '\n')
          : data,
      )
      .update('\0');
  }
  const manifest = {
    version,
    buildId: hash
      .update(JSON.stringify({ dependencies, compiler: Bun.version, recipe }))
      .digest('hex'),
    revision: process.env.TRACETOON_BUILD_REVISION ?? process.env.GITHUB_SHA ?? null,
    protocol: 2,
    dependencies,
    compiler: { name: 'bun', version: Bun.version },
    recipe,
  };
  const file = join(root, 'plugin/skills/tracetoon/build.json');
  if (check) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (
      old.version !== version ||
      old.buildId !== manifest.buildId ||
      readFileSync(join(root, 'plugin/skills/tracetoon/VERSION'), 'utf8').trim() !==
        version
    )
      throw new Error(
        'Build identity is stale. Run bun run bundle after finalizing source and skill changes.',
      );
    const bundle = join(root, 'plugin/skills/tracetoon/dist/tracetoon.mjs'),
      receiptFile = `${bundle}.build.json`;
    if (!existsSync(receiptFile))
      throw new Error('Bundle output receipt is missing. Run bun run bundle.');
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    if (
      receipt.buildId !== manifest.buildId ||
      receipt.sha256 !== createHash('sha256').update(readFileSync(bundle)).digest('hex')
    )
      throw new Error('Bundle bytes do not match their build output receipt.');
  } else if (stamp) {
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(root, 'plugin/skills/tracetoon/VERSION'), version + '\n');
  }
  return manifest;
}
/** Output hashes bind the shared source/recipe identity to a compiler and target. */
export function recordOutput(file: string, target: string, buildId: string) {
  const receipt = {
    schema: 'tracetoon.build-output/v1',
    buildId,
    target,
    inputManifestSha256: createHash('sha256')
      .update(readFileSync(join(root, 'plugin/skills/tracetoon/build.json')))
      .digest('hex'),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    compiler: {
      version: Bun.version,
      sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
      host: `${process.platform}-${process.arch}`,
    },
  };
  writeFileSync(`${file}.build.json`, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (import.meta.main) console.log(buildManifest(process.argv.includes('--check')));
