/**
 * The variant lines at the end of the skill's Workflow section
 * (`Brief layout:`, `Reviewer model:`, `Reviewer effort:`, `Review passes:`,
 * `Review lenses:`, `Reviewer runner:`, `Review recheck:`, `Graph search:`), read from the SKILL.md that ships next to this runtime.
 *
 * `prepare` uses them as defaults when the agent passes no matching flag, so a
 * configured reviewer plan holds even when the agent forgets to pass it on.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assetsDir } from '../util/assets.ts';

export interface SkillSettings {
  layout?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  reviewPasses?: string;
  reviewLenses?: string;
  reviewerRunner?: string;
  reviewRecheck?: string;
  graphSearch?: string;
}

const LINES: Record<string, keyof SkillSettings> = {
  'Brief layout': 'layout',
  'Reviewer model': 'reviewerModel',
  'Reviewer effort': 'reviewerEffort',
  'Review passes': 'reviewPasses',
  'Review lenses': 'reviewLenses',
  'Reviewer runner': 'reviewerRunner',
  'Review recheck': 'reviewRecheck',
  'Graph search': 'graphSearch',
};

/** Parse the variant lines out of SKILL.md text. */
export function parseSkillSettings(text: string): SkillSettings {
  const out: SkillSettings = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][a-z]+ [a-z]+): (.+?)\.?\s*$/.exec(line);
    const key = m && LINES[m[1]!];
    if (key && out[key] === undefined) out[key] = m![2]!.trim();
  }
  return out;
}

/** The skill folder next to this runtime (SKILL.md, references/, assets/). */
export function skillDir(): string | undefined {
  const assets = assetsDir();
  return assets ? dirname(assets) : undefined;
}

/** The SKILL.md next to this runtime; `TRACETOON_SKILL_MD` overrides (tests). */
export function skillSettings(): SkillSettings {
  const path =
    process.env.TRACETOON_SKILL_MD ??
    (() => {
      const dir = skillDir();
      return dir ? join(dir, 'SKILL.md') : undefined;
    })();
  if (!path || !existsSync(path)) return {};
  try {
    return parseSkillSettings(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** Explicit options win; otherwise fill each unset option from SKILL.md. */
export function withSkillDefaults<T extends SkillSettings>(
  opts: T,
  skill = skillSettings(),
): T {
  const out = { ...opts };
  for (const key of Object.values(LINES)) {
    if ((out[key] === undefined || out[key] === '') && skill[key] !== undefined)
      (out as SkillSettings)[key] = skill[key];
  }
  return out;
}
