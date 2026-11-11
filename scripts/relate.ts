// The vendored graph engine: Relate compiled to WebAssembly, pinned in
// build-dependencies.json by tag, revision and the SHA-256 of every vendored file.
//
//   bun scripts/relate.ts check                 verify the vendored bytes (builds run this)
//   bun scripts/relate.ts rebuild [--source DIR] rebuild from the pinned revision and verify
//   bun scripts/relate.ts rebuild --update ...   after bumping tag/revision: record new hashes
//
// A rebuild needs Relate's WebAssembly toolchain (rustup with the
// wasm32-unknown-unknown target, wasm-bindgen-cli and binaryen at the versions
// recorded in the lock; see Relate's scripts/install-wasm-bindgen.sh and
// install-binaryen.sh). Release builds are byte-reproducible, so a rebuild must
// match the recorded hashes. --source points at a local clone; the pinned
// revision is exported from it with git archive and built in a temp directory,
// so the clone is never modified.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '..');
const lockPath = join(root, 'build-dependencies.json');

interface Lock {
  repository: string;
  tag: string;
  revision: string;
  files: Record<string, string>;
}

const WASM = 'plugin/skills/tracetoon/assets/relate.wasm';
const VENDOR = 'src/graph/vendor/';

/** Where a vendored file comes from in Relate's wasm-bindgen output. */
const sourceOf = (file: string) =>
  file === WASM ? 'relate_bg.wasm' : file.slice(VENDOR.length);

/** The vendored files of a fresh build: the module, its glue and the glue's snippets. */
function builtFiles(out: string): string[] {
  const files = [WASM, `${VENDOR}relate.js`, `${VENDOR}relate.d.ts`];
  const snippets = join(out, 'snippets');
  if (existsSync(snippets))
    for (const f of readdirSync(snippets, { recursive: true, encoding: 'utf8' }))
      if (f.endsWith('.js')) files.push(`${VENDOR}snippets/${f.split(sep).join('/')}`);
  return files;
}

const sha = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

function lock(): Lock {
  const l = JSON.parse(readFileSync(lockPath, 'utf8')).relate as Lock | undefined;
  if (!l || !/^[a-f0-9]{40}$/.test(l.revision) || !l.files)
    throw new Error('build-dependencies.json has no valid relate pin.');
  return l;
}

/** Throws unless every vendored file matches its pinned hash. */
export function verifyRelate(): Lock {
  const l = lock();
  for (const [file, want] of Object.entries(l.files)) {
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`Vendored Relate file missing: ${file}`);
    const got = sha(path);
    if (got !== want)
      throw new Error(
        `Vendored Relate file ${file} differs from build-dependencies.json (${got.slice(0, 12)} != ${want.slice(0, 12)}). Run bun scripts/relate.ts rebuild.`,
      );
  }
  return l;
}

/** Relate's [target.wasm32-unknown-unknown] rustflags (its wasm stack size). */
function wasmRustflags(src: string): string[] {
  const config = readFileSync(join(src, '.cargo', 'config.toml'), 'utf8');
  const section =
    /\[target\.wasm32-unknown-unknown\]([\s\S]*?)(?:\n\[|$)/.exec(config)?.[1] ?? '';
  const list = /rustflags\s*=\s*\[([^\]]*)\]/.exec(section)?.[1];
  if (!list)
    throw new Error(
      "Relate's .cargo/config.toml has no wasm32 rustflags; update the rebuild script.",
    );
  return [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

function rebuild(source: string | undefined, update: boolean): void {
  const l = lock();
  const work = mkdtempSync(join(tmpdir(), 'tracetoon-relate-'));
  try {
    const src = join(work, 'src');
    mkdirSync(src);
    // Export the pinned tree; never build inside (or modify) a checkout.
    const repo = source ?? join(work, 'repo');
    if (!source)
      run('git', ['clone', '--quiet', '--no-checkout', l.repository, repo], work);
    const archive = spawnSync(
      'git',
      ['-C', repo, 'archive', '--format=tar', l.revision],
      {
        maxBuffer: 1 << 30,
      },
    );
    if (archive.status !== 0) throw new Error(`Cannot export Relate ${l.revision}.`);
    writeFileSync(join(work, 'src.tar'), archive.stdout);
    run('tar', ['-xf', join(work, 'src.tar'), '-C', src], work);
    const out = join(work, 'pkg');
    run('bash', ['scripts/build-wasm.sh', '--mode', 'release'], src, {
      ...process.env,
      CARGO_TARGET_DIR: join(work, 'target'),
      BUILD_WASM_OUT_DIR: out,
      // Same bytes wherever the build runs: keep Relate's own wasm rustflags
      // (an env value replaces them) and strip the build's absolute paths.
      CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: [
        ...wasmRustflags(src),
        `--remap-path-prefix=${src}=/relate`,
        `--remap-path-prefix=${process.env.CARGO_HOME ?? join(homedir(), '.cargo')}=/cargo`,
      ].join(' '),
    });
    const files: Record<string, string> = {};
    const wanted = update ? builtFiles(out) : Object.keys(l.files);
    for (const file of wanted) {
      const from = sourceOf(file);
      const built = join(out, from);
      files[file] = sha(built);
      if (!update && files[file] !== l.files[file])
        throw new Error(
          `Rebuilt ${from} does not match the pinned hash; the build is not reproducible here.`,
        );
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(built, join(root, file));
    }
    if (update) {
      const all = JSON.parse(readFileSync(lockPath, 'utf8'));
      all.relate.files = files;
      writeFileSync(lockPath, JSON.stringify(all, null, 2) + '\n');
    }
    console.log(
      `Relate ${l.tag} (${l.revision.slice(0, 12)}) vendored and verified.`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'check') {
    const l = verifyRelate();
    console.log(
      `Relate ${l.tag}: ${Object.keys(l.files).length} vendored files match.`,
    );
  } else if (cmd === 'rebuild') rebuild(flag('--source'), rest.includes('--update'));
  else {
    console.error(
      'usage: bun scripts/relate.ts check | rebuild [--source DIR] [--update]',
    );
    process.exit(2);
  }
}
