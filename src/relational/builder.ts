/**
 * The relational/vector context builder. PLACEHOLDER: the independent designer
 * replaces this file (and may add files under src/relational/). The contract:
 *
 * - `initRelational()`: async setup, awaited once by the CLI before evidence
 *   commands (load SQLite wasm, load the local embedding model). It must work
 *   offline from the skill's assets.
 * - `buildRelationalContext(inputs, opts)`: synchronous after init. Returns
 *   the context the writer reads, packed to `opts.budgetTokens`, and the refs it
 *   may cite.
 *
 * It must not import anything from src/graph/ except the input types (no
 * EvidenceGraph, buildEvidenceGraph, queries, brief, derive, change units or
 * survival links).
 */
import type { BuildOptions, GraphInputs, RelationalContext } from './index.ts';
import { initSqlWasm } from './sqlite.ts';

export async function initRelational(): Promise<void> {
  await initSqlWasm();
}

export function buildRelationalContext(
  inputs: GraphInputs,
  opts: BuildOptions,
): RelationalContext {
  // Placeholder: the requests in order, until the designer's builder replaces it.
  const refs = inputs.full.sessions.flatMap((s) =>
    s.prompts.filter((p) => p.id).map((p) => ({ id: p.id!, text: p.text.slice(0, 400) })),
  );
  let text = refs.map((r) => `${r.id}: ${r.text}`).join('\n');
  text = text.slice(0, opts.budgetTokens * 4);
  return { text, refs, tokens: Math.ceil(text.length / 4) };
}
