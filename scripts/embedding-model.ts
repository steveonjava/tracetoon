// The relational/vector arm's embedding model: minishlab/potion-code-16M-v2,
// shipped unchanged in plugin/skills/tracetoon/assets/potion-code-16M-v2/ and
// pinned in build-dependencies.json by Hugging Face revision and the SHA-256 of
// every file.
//
//   bun scripts/embedding-model.ts check   verify the shipped bytes (builds run this)
//   bun scripts/embedding-model.ts fetch   download the pinned revision and verify
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

interface Pin {
  repository: string;
  revision: string;
  files: Record<string, string>;
}

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function pin(): Pin {
  const p = JSON.parse(readFileSync(join(root, 'build-dependencies.json'), 'utf8'))
    .embeddingModel as Pin | undefined;
  if (!p || !/^[a-f0-9]{40}$/.test(p.revision) || !p.files)
    throw new Error('build-dependencies.json has no valid embeddingModel pin.');
  return p;
}

/** Throws unless every shipped model file matches its pinned hash. */
export function verifyEmbeddingModel(): Pin {
  const p = pin();
  for (const [file, want] of Object.entries(p.files)) {
    const path = join(root, file);
    if (!existsSync(path))
      throw new Error(
        `Embedding model file missing: ${file} (run bun scripts/embedding-model.ts fetch)`,
      );
    const got = sha(readFileSync(path));
    if (got !== want)
      throw new Error(
        `Embedding model file ${file} has SHA-256 ${got}; the pin is ${want}.`,
      );
  }
  return p;
}

async function fetchPinned(): Promise<void> {
  const p = pin();
  for (const [file, want] of Object.entries(p.files)) {
    const name = file.split('/').pop()!;
    const url = `${p.repository}/resolve/${p.revision}/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (sha(data) !== want) throw new Error(`${url} does not match its pinned SHA-256.`);
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), data);
    console.log(`${file}: ${data.length} bytes, verified`);
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'check') {
    const p = verifyEmbeddingModel();
    console.log(
      `embedding model @${p.revision.slice(0, 12)}: ${Object.keys(p.files).length} files match.`,
    );
  } else if (cmd === 'fetch') await fetchPinned();
  else {
    console.error('usage: bun scripts/embedding-model.ts check | fetch');
    process.exit(2);
  }
}
