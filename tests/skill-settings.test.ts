import { describe, expect, test } from 'bun:test';
import {
  parseSkillSettings,
  withSkillDefaults,
} from '../src/contribution/skillSettings.ts';

const SKILL = [
  'Some prose. `Reviewer model: sonnet.` in an example is ignored.',
  '',
  'Reviewer model: terra.',
  '',
  'Reviewer effort: xhigh.',
  '',
  'Review passes: 3.',
  '',
  'Review lenses: a, b, c.',
  '',
  'Reviewer runner: tracetoon.',
  '',
  'Review recheck: none.',
  '',
  'Brief layout: neighborhood-wide.',
  '',
  'Evidence mode: relational.',
].join('\n');

describe('skill settings', () => {
  test('reads the variant lines', () => {
    expect(parseSkillSettings(SKILL)).toEqual({
      reviewerModel: 'terra',
      reviewerEffort: 'xhigh',
      reviewPasses: '3',
      reviewLenses: 'a, b, c',
      reviewerRunner: 'tracetoon',
      reviewRecheck: 'none',
      layout: 'neighborhood-wide',
      evidenceMode: 'relational',
    });
  });
  test('explicit options win; unset ones come from the skill', () => {
    const skill = parseSkillSettings(SKILL);
    const out = withSkillDefaults({ reviewPasses: '1', layout: undefined } as any, skill);
    expect(out.reviewPasses).toBe('1');
    expect(out.layout).toBe('neighborhood-wide');
    expect(out.reviewerModel).toBe('terra');
    expect(out.reviewRecheck).toBe('none');
  });
  test('step 2b: one review command, one merged list, one edit pass, recheck per the line', async () => {
    const skill = await Bun.file('plugin/skills/tracetoon/SKILL.md').text();
    expect(skill).toMatch(/^Review recheck: once\.$/m);
    expect(skill).toContain('tracetoon review run --all --run <id>');
    expect(skill).toContain('tracetoon review merge --run <id>');
    expect(skill).toContain('ONE edit pass');
    expect(skill).toContain('--review-recheck <once|contested|none>');
    expect(skill).toMatch(/`none` → no recheck/);
  });
  test('the shipped SKILL.md parses to the defaults', async () => {
    const text = await Bun.file('plugin/skills/tracetoon/SKILL.md').text();
    expect(parseSkillSettings(text)).toEqual({
      reviewerModel: 'same as the main agent',
      reviewerEffort: 'default',
      reviewPasses: '1',
      reviewLenses: 'none',
      reviewerRunner: 'agent',
      reviewRecheck: 'once',
      layout: 'toon',
      evidenceMode: 'graph',
    });
  });
  test('step 2b: no fixed template, model and effort on every reviewer, findings checked', async () => {
    const skill = await Bun.file('plugin/skills/tracetoon/SKILL.md').text();
    const drafting = await Bun.file(
      'plugin/skills/tracetoon/references/drafting.md',
    ).text();
    // The rigid Problem / Changes / Consequences / Tests / … template is gone.
    expect(drafting).toContain('No fixed section list');
    expect(drafting).not.toMatch(/^\d\. \*\*(Problem|Tests|Open points)/m);
    expect(skill).toContain('no fixed section list');
    // Model and effort are passed together, lens and general reviewers included.
    expect(skill).toMatch(/model: "<name>"` and\s+`effort: "<level>"`/);
    expect(skill).toMatch(/each lens reviewer, each general reviewer/);
    // Findings are checked against the patch; flagged claims are fixed or rejected.
    expect(skill).toContain('never paste its wording unchecked');
    expect(skill).toMatch(/rejected with the diff\s+line/);
  });
});
