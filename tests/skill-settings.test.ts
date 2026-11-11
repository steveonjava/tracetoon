import { describe, expect, test } from 'bun:test';
import {
  parseSkillSettings,
  withSkillDefaults,
} from '../src/contribution/skillSettings.ts';
import {
  parseModel,
  parseRunner,
  planFromOptions,
  resolveCodexModel,
  tracetoonRuns,
} from '../src/contribution/reviewPlan.ts';
import { graphNext } from '../src/commands/digest.ts';
import { hostAgent } from '../src/util/host.ts';

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
  'Graph search: fulltext.',
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
      graphSearch: 'fulltext',
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
    expect(skill).toMatch(/^Review recheck: none\.$/m);
    expect(skill).toContain('tracetoon review run --all --run <id>');
    expect(skill).toContain('tracetoon review merge --run <id>');
    expect(skill).toContain('ONE edit pass');
    expect(skill).toContain('--review-recheck <once|contested|none>');
    expect(skill).toMatch(/`none` → no recheck/);
  });
  test('the shipped SKILL.md parses to the defaults', async () => {
    const text = await Bun.file('plugin/skills/tracetoon/SKILL.md').text();
    expect(parseSkillSettings(text)).toEqual({
      reviewerModel: 'cheap',
      reviewerEffort: 'xhigh',
      reviewPasses: '2',
      reviewLenses: 'd',
      reviewerRunner: 'auto',
      reviewRecheck: 'none',
      layout: 'toon',
      graphSearch: 'fulltext',
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

describe('shipped defaults resolve per host', () => {
  const shipped = async () =>
    withSkillDefaults(
      {},
      parseSkillSettings(await Bun.file('plugin/skills/tracetoon/SKILL.md').text()),
    );
  test('Claude Code: haiku reviewers it starts itself', async () => {
    const plan = planFromOptions(await shipped(), 'claude')!;
    expect(plan).toEqual({
      v: 1,
      passes: 2,
      lenses: ['d'],
      reviewerModel: 'haiku',
      reviewerEffort: 'xhigh',
      recheck: 'none',
    });
    const next = graphNext('R1', plan);
    expect(next).toContain('on model haiku at effort xhigh');
    expect(next).not.toContain('tracetoon review run');
  });
  test('Codex: luna, run and verified by tracetoon review run', async () => {
    const plan = planFromOptions(await shipped(), 'codex')!;
    expect(plan.reviewerModel).toBe('luna');
    expect(plan.runner).toBe('tracetoon');
    expect(tracetoonRuns(plan)).toBe(true);
    expect(resolveCodexModel(plan.reviewerModel!)).toBe('gpt-6-luna');
    expect(graphNext('R1', plan)).toContain('tracetoon review run --all --run R1');
  });
  test('unknown host: the main agent model and reviewer agents', async () => {
    const plan = planFromOptions(await shipped(), null)!;
    expect(plan.reviewerModel).toBeUndefined();
    expect(plan.runner).toBeUndefined();
    expect(plan.passes).toBe(2);
  });
  test('explicit names win over cheap and auto', () => {
    const plan = planFromOptions(
      { reviewerModel: 'sonnet', reviewerRunner: 'tracetoon' },
      'claude',
    )!;
    expect(plan.reviewerModel).toBe('sonnet');
    expect(plan.runner).toBe('tracetoon');
    expect(parseRunner('auto', 'codex')).toBe('tracetoon');
    expect(parseRunner('auto', 'claude')).toBe('agent');
    expect(parseRunner('auto', null)).toBe('agent');
    expect(parseModel('Cheap', 'claude')).toBe('haiku');
    expect(() => parseRunner('robot', 'claude')).toThrow(/agent, tracetoon or auto/);
  });
  test('the host comes from the environment its tool calls get', () => {
    expect(hostAgent({ CODEX_THREAD_ID: 't1' })).toBe('codex');
    expect(hostAgent({ CLAUDECODE: '1' })).toBe('claude');
    expect(hostAgent({ CLAUDE_CODE_SESSION_ID: 's1' })).toBe('claude');
    expect(hostAgent({})).toBeUndefined();
    expect(hostAgent({ CLAUDECODE: '1', TRACETOON_HOST_AGENT: 'codex' })).toBe('codex');
    expect(hostAgent({ CLAUDECODE: '1', TRACETOON_HOST_AGENT: 'none' })).toBeUndefined();
  });
});
