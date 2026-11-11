import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { git } from '../src/util/exec.ts';
import { prHead, resolveTarget, targetLine } from '../src/github/target.ts';
import { makeRepo } from './helpers.ts';

const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');
const saved = { script: process.env.TRACETOON_GH_SCRIPT, repo: process.env.FAKE_GH_REPO };
beforeEach(() => {
  process.env.TRACETOON_GH_SCRIPT = FAKE_GH;
});
afterEach(() => {
  for (const [k, v] of [
    ['TRACETOON_GH_SCRIPT', saved.script],
    ['FAKE_GH_REPO', saved.repo],
  ] as const)
    v === undefined ? delete process.env[k] : (process.env[k] = v);
});

function forkClone(ghDefault: string) {
  const repo = makeRepo();
  git(repo.root, ['remote', 'add', 'origin', 'https://github.com/steveonjava/demo.git']);
  git(repo.root, ['remote', 'add', 'upstream', 'https://github.com/Tingsters/demo.git']);
  process.env.FAKE_GH_REPO = ghDefault;
  return repo.root;
}

describe('the target repo', () => {
  test("gh's default wins when it is one of the clone's remotes (fork to upstream)", () => {
    const t = resolveTarget(forkClone('Tingsters/demo'));
    expect(t).toEqual({
      repo: 'Tingsters/demo',
      origin: 'steveonjava/demo',
      ghDefault: 'Tingsters/demo',
    });
  });

  test('a default that matches no remote is ignored in favour of origin', () => {
    const t = resolveTarget(forkClone('stale/elsewhere'));
    expect(t?.repo).toBe('steveonjava/demo');
    expect(targetLine(t)).toContain("gh's default repo stale/elsewhere is not a remote");
  });

  test('offline never asks gh; origin is the target', () => {
    const t = resolveTarget(forkClone('Tingsters/demo'), { offline: true });
    expect(t).toMatchObject({ repo: 'steveonjava/demo', ghDefault: undefined });
  });

  test('the head names the fork owner only when the target is another repo', () => {
    expect(prHead('feat/x', 'steveonjava', 'Tingsters/demo')).toBe('steveonjava:feat/x');
    expect(prHead('feat/x', 'steveonjava', 'steveonjava/demo')).toBe('feat/x');
    expect(prHead('feat/x', 'Tingsters', 'tingsters/demo')).toBe('feat/x');
  });

  test('the target line says when the branch is pushed somewhere else', () => {
    expect(
      targetLine({
        repo: 'Tingsters/demo',
        origin: 'steveonjava/demo',
        ghDefault: 'Tingsters/demo',
      }),
    ).toBe(
      'PR target: Tingsters/demo (branch is pushed to steveonjava/demo, a different repository).',
    );
  });
});
