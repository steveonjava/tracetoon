/**
 * Fetch prior PR bodies to decode metadata, then pass only compact creative
 * choices forward. Old transcripts and character descriptions are not context.
 */
import type { PrTruth } from '../git/pr.ts';
import { gh } from '../util/exec.ts';
import { repoArgs } from './target.ts';
import { decodeMeta } from './body.ts';
import {
  CAST_KINDS,
  LAYOUT_FAMILIES,
  STYLE_FAMILIES,
  type ComicSummary,
} from '../comic/types.ts';

/** How many recent PRs to look at. */
const LOOK_BACK = 20;

export function repoWeb(truth: PrTruth): string | undefined {
  if (process.env.TRACETOON_REPO_WEB) return process.env.TRACETOON_REPO_WEB;
  return truth.remote
    ? `https://github.com/${truth.remote.owner}/${truth.remote.name}`
    : undefined;
}

/** Styles of this repo's latest comics, newest first (empty offline or without gh). */
export function recentStyles(truth: PrTruth, opts: { offline?: boolean } = {}): string[] {
  return recentComics(truth, opts).flatMap((c) => (c.style ? [c.style] : []));
}

export function recentComics(
  truth: PrTruth,
  opts: { offline?: boolean } = {},
): ComicSummary[] {
  if (opts.offline) return [];
  const r = gh(truth.toplevel, [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    String(LOOK_BACK),
    '--search',
    '"tracetoon:meta" in:body',
    ...repoArgs(truth.target?.repo),
    '--json',
    'number,body',
  ]);
  if (!r.ok) return [];
  try {
    const rows = JSON.parse(r.stdout) as { number: number; body: string }[];
    return rows
      .sort((a, b) => b.number - a.number)
      .flatMap((p): ComicSummary[] => {
        const meta = decodeMeta(p.body);
        if (!meta) return [];
        const raw = meta.comic;
        const summary: ComicSummary = {};
        if (typeof meta.style === 'string' && meta.style.length <= 120)
          summary.style = meta.style;
        if (raw && typeof raw === 'object') {
          if (raw.styleFamily && STYLE_FAMILIES.includes(raw.styleFamily))
            summary.styleFamily = raw.styleFamily;
          if (raw.layoutFamily && LAYOUT_FAMILIES.includes(raw.layoutFamily))
            summary.layoutFamily = raw.layoutFamily;
          if (
            Number.isInteger(raw.panelCount) &&
            raw.panelCount! >= 1 &&
            raw.panelCount! <= 6
          )
            summary.panelCount = raw.panelCount;
          if (
            raw.titleTreatment &&
            ['none', 'integrated', 'heading'].includes(raw.titleTreatment)
          )
            summary.titleTreatment = raw.titleTreatment;
          if (
            Array.isArray(raw.castKinds) &&
            raw.castKinds.every((kind) => CAST_KINDS.includes(kind))
          )
            summary.castKinds = [...new Set(raw.castKinds)];
        }
        return Object.keys(summary).length ? [summary] : [];
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}
