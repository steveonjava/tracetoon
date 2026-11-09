/**
 * Which evidence store a run's writer and reviewers read.
 * - `graph` (default): the evidence graph's brief (TOON or neighborhood layout).
 * - `relational`: the relational/vector store's packed context (src/relational/).
 *
 * `prepare --evidence-mode` (or the skill's `Evidence mode:` line) chooses it
 * for a run and stores it in the run folder, like the brief layout, so
 * `query brief`, `render`, `review-packet` and `review run/merge` use the same
 * arm. TRACETOON_EVIDENCE_MODE overrides the stored choice (experiments).
 */
import { readJson, writeJson, type Run } from '../run.ts';

export type EvidenceMode = 'graph' | 'relational';
export const EVIDENCE_MODES: readonly EvidenceMode[] = ['graph', 'relational'];
export const EVIDENCE_MODE_FILE = 'evidence-mode.json';

/** An `--evidence-mode` value, checked; undefined when none was given. */
export function parseEvidenceMode(value: unknown): EvidenceMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if ((EVIDENCE_MODES as readonly string[]).includes(v)) return v as EvidenceMode;
  throw new Error(
    `Unknown evidence mode "${String(value)}": use ${EVIDENCE_MODES.join(' or ')}.`,
  );
}

/** TRACETOON_EVIDENCE_MODE, when set to a known mode. */
export function envEvidenceMode(): EvidenceMode | undefined {
  const v = process.env.TRACETOON_EVIDENCE_MODE?.trim().toLowerCase();
  return v === 'graph' || v === 'relational' ? v : undefined;
}

/** The mode stored in the run folder, if any. */
export function storedEvidenceMode(run: Run): EvidenceMode | undefined {
  const v = readJson<{ mode?: string }>(run, EVIDENCE_MODE_FILE)?.mode;
  return v === 'graph' || v === 'relational' ? v : undefined;
}

/** This run's evidence mode: the env override, else what `prepare` stored, else graph. */
export function runEvidenceMode(run: Run | undefined): EvidenceMode {
  return envEvidenceMode() ?? (run && storedEvidenceMode(run)) ?? 'graph';
}

export const isRelational = (run: Run | undefined) =>
  runEvidenceMode(run) === 'relational';

export function saveRunEvidenceMode(run: Run, mode: EvidenceMode): void {
  writeJson(run, EVIDENCE_MODE_FILE, { mode });
}
