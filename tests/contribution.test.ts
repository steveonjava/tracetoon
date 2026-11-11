import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  contributionPolicy,
  loadGuidance,
  objectHash,
  parseGuidance,
  readRepoSource,
  researchPacket,
  textHash,
} from '../src/contribution/guidance.ts';
import { loadReview, reviewInput, reviewLine } from '../src/contribution/review.ts';
import type {
  ContributionReview,
  Guidance,
  GuidanceRequest,
  Requirement,
} from '../src/contribution/types.ts';
import type { TraceDigest } from '../src/digest/build.ts';
import { prTruth } from '../src/git/pr.ts';
import { git } from '../src/util/exec.ts';
import { makeRepo, tempDir } from './helpers.ts';
import { contributionSignals } from '../scripts/eval-contributions.ts';
import contributionCases from './fixtures/contribution-cases.json';

setDefaultTimeout(60_000);
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');

function fixture() {
  const root = tempDir('tracetoon-guidance-');
  const content =
    '# Contributing\nPRs must include a Testing section.\nLeave HUMAN: for the contributor.\n';
  writeFileSync(join(root, 'CONTRIBUTING.md'), content);
  const request: GuidanceRequest = {
    v: 1,
    fingerprint: 'request',
    offline: false,
    changedPaths: ['src/greet.ts'],
    sourceSeeds: [{ location: 'CONTRIBUTING.md', scope: '.', sha256: textHash(content) }],
    changesPath: 'changes.patch',
    headSha: 'abc',
    diffSha256: 'diff',
    gaps: [],
  };
  const rule: Requirement = {
    id: 'testing',
    text: 'Include a Testing section.',
    strength: 'required',
    applicability: 'applicable',
    appliesWhen: 'All PRs',
    exceptions: [],
    evidenceExpected: ['A Testing heading in the PR body'],
    sources: [{ source: 'guide', startLine: 2, endLine: 2 }],
  };
  const guidance: Guidance = {
    v: 1,
    requestFingerprint: request.fingerprint,
    researcher: { mode: 'delegated', agentId: 'researcher-1' },
    sources: [
      {
        id: 'guide',
        kind: 'repository',
        location: 'CONTRIBUTING.md',
        scope: '.',
        content,
        sha256: textHash(content),
        retrievedAt: '2026-10-24T12:00:00Z',
      },
    ],
    requirements: [rule],
    gaps: [],
  };
  const run = { id: 'test', dir: root };
  const save = () => writeFileSync(join(root, 'guidance.json'), JSON.stringify(guidance));
  save();
  const load = () => loadGuidance(run, root, request);
  return { root, request, guidance, rule, run, save, load };
}

function digest(): TraceDigest {
  return {
    v: 1,
    tool: 'test',
    generatedAt: '2026-10-24T12:00:00Z',
    repo: {},
    pr: {
      base: 'main',
      head: 'feature',
      mergeBase: 'abc',
      usedWorkingTree: false,
      commits: [],
    },
    stats: {
      filesChanged: 1,
      added: 1,
      removed: 0,
      evidenceLines: 1,
      agentMatchedPct: 0,
      unmatchedPct: 100,
      commitsMadeInSessions: 0,
      commits: 1,
    },
    sessions: [],
    files: [
      { path: 'src/greet.ts', added: 1, removed: 0, sessions: [], unmatchedLines: 1 },
    ],
    disclosure: {
      agents: ['Test Agent'],
      models: [],
      suggestedTrailers: ['Assisted-by: Test Agent'],
      existingTrailers: [],
    },
    interop: {},
    privacy: { redactions: 0, droppedForeignRecords: 0, sessionIdsHashed: true },
    linkedPrs: [],
    notes: [],
    truncated: [],
  };
}

function reviewed() {
  const f = fixture();
  const evidence = digest();
  const patch = '+export const greeting = "hi";\n';
  const inputArgs = {
    title: 'Add greeting',
    body: '## Summary\nAdds greeting.\n## Testing\nNo results captured.\n',
    guidance: f.load(),
    digest: evidence,
    diffSha256: textHash(patch),
    headSha: 'abc',
  };
  const input = reviewInput(inputArgs);
  const review: ContributionReview = {
    v: 1,
    inputFingerprint: input.fingerprint,
    drafter: { mode: 'delegated', agentId: 'drafter-1' },
    reviewer: { mode: 'delegated', agentId: 'reviewer-1' },
    assessments: [
      {
        requirement: f.rule.id,
        state: 'satisfied',
        reason: 'The exact rendered body has the required section.',
        evidence: ['body:3'],
      },
    ],
    bodyReview: {
      inferredChange: 'Adds a greeting export.',
      inferredStart: 'The greeting constant.',
      transfer: {
        state: 'satisfied',
        reason: 'The cold read matches the one-line diff.',
      },
      claims: [
        {
          at: 'body:2',
          claim: 'Adds greeting.',
          verdict: 'supported',
          evidence: ['diff:1'],
        },
      ],
      omissions: [],
    },
  };
  const saveReview = () =>
    writeFileSync(join(f.root, 'review.json'), JSON.stringify(review));
  saveReview();
  const load = (next = input) => loadReview(f.run, next, f.load(), evidence, patch);
  return {
    ...f,
    evidence,
    patch,
    inputArgs,
    input,
    review,
    saveReview,
    loadReview: load,
  };
}

describe('contributor research', () => {
  test('excludes a nested private trail even when it is a regular file', () => {
    const repo = makeRepo();
    repo.commit(
      'nested/.showtail',
      'SYNTHETIC-PRIVATE-FILE-MARKER',
      'Synthetic privacy fixture',
    );
    const packet = researchPacket(prTruth(repo.root, { noGh: true }));
    expect(packet.patch).not.toContain('SYNTHETIC-PRIVATE-FILE-MARKER');
    expect(packet.request.changedPaths).not.toContain('nested/.showtail');
  });
  test.each(['nested/.showtail', 'nested/.SHOWTAIL'])(
    'excludes tracked private trails at any depth: %s',
    (path) => {
      const repo = makeRepo();
      repo.commit(
        `${path}/private.txt`,
        'SYNTHETIC-PRIVATE-MARKER',
        'Synthetic privacy fixture',
      );
      repo.commit('change.ts', 'export const value = 1;', 'Add code');
      const packet = researchPacket(prTruth(repo.root, { noGh: true }));
      expect(packet.patch).not.toContain('SYNTHETIC-PRIVATE-MARKER');
      expect(packet.request.changedPaths).not.toContain(`${path}/private.txt`);
    },
  );

  test('untracked binary paths and byte changes invalidate research and review inputs', () => {
    const repo = makeRepo();
    const empty = researchPacket(prTruth(repo.root, { noGh: true }));
    writeFileSync(join(repo.root, 'asset.bin'), Buffer.from([0, 1, 2]));
    const first = researchPacket(prTruth(repo.root, { noGh: true }));
    writeFileSync(join(repo.root, 'asset.bin'), Buffer.from([0, 1, 3]));
    const second = researchPacket(prTruth(repo.root, { noGh: true }));
    expect(first.request.changedPaths).toContain('asset.bin');
    expect(first.request.fingerprint).not.toBe(empty.request.fingerprint);
    expect(first.request.fingerprint).not.toBe(second.request.fingerprint);
    expect(first.patch).toContain('sha256');
    expect(first.patch).not.toContain('\0');
    writeFileSync(join(repo.root, 'asset.bin'), Buffer.from([0x80]));
    const invalidUtf8First = researchPacket(prTruth(repo.root, { noGh: true }));
    writeFileSync(join(repo.root, 'asset.bin'), Buffer.from([0x81]));
    const invalidUtf8Second = researchPacket(prTruth(repo.root, { noGh: true }));
    expect(invalidUtf8First.request.fingerprint).not.toBe(
      invalidUtf8Second.request.fingerprint,
    );
    expect(invalidUtf8First.patch).not.toContain('\ufffd');
  });

  test('untracked directory links cannot copy outside data into the code packet', () => {
    const repo = makeRepo();
    const outside = tempDir();
    writeFileSync(join(outside, 'external.txt'), 'SYNTHETIC-OUTSIDE-MARKER');
    symlinkSync(outside, join(repo.root, 'linked-directory'), 'junction');
    const truth = prTruth(repo.root, { noGh: true });
    expect(truth.files.flatMap((f) => f.added).join('\n')).not.toContain(
      'SYNTHETIC-OUTSIDE-MARKER',
    );
    expect(researchPacket(truth).patch).not.toContain('SYNTHETIC-OUTSIDE-MARKER');
  });

  test('discovers root and nearest scoped guides, excludes unrelated scopes, and honors offline', () => {
    const repo = makeRepo();
    for (const [path, content] of Object.entries({
      'AGENTS.md': 'Read .ai/AGENTS.md',
      'GEMINI.md': 'Root instructions',
      'packages/ui/AGENTS.md': 'UI testing rules',
      'packages/ui/GEMINI.md': 'UI commands',
      'packages/other/AGENTS.md': 'Other package only',
    })) {
      mkdirSync(dirname(join(repo.root, path)), { recursive: true });
      writeFileSync(join(repo.root, path), content);
    }
    repo.commit('packages/ui/button.ts', 'export const button = true;', 'Add button');
    // The unrelated guide was committed in this PR, so it is itself an affected path.
    const truth = prTruth(repo.root, { noGh: true });
    truth.files = truth.files.filter((f) => f.path === 'packages/ui/button.ts');
    const { request, patch } = researchPacket(truth, true);
    expect(request.offline).toBe(true);
    expect(request.sourceSeeds.map((s) => s.location)).toContain('GEMINI.md');
    expect(request.sourceSeeds).toContainEqual(
      expect.objectContaining({
        location: 'packages/ui/AGENTS.md',
        scope: 'packages/ui',
      }),
    );
    expect(request.sourceSeeds.map((s) => s.location)).not.toContain(
      'packages/other/AGENTS.md',
    );
    expect(patch).toContain('export const button = true;');
  });

  test('working-tree packets include untracked submitted code and omit the private trail', () => {
    const repo = makeRepo();
    writeFileSync(join(repo.root, 'new.ts'), 'export const value = 1;');
    mkdirSync(join(repo.root, '.showtail'));
    writeFileSync(join(repo.root, '.showtail/private.txt'), 'private trail');
    const { request, patch } = researchPacket(prTruth(repo.root, { noGh: true }));
    expect(request.changedPaths).toContain('new.ts');
    expect(patch).toContain('export const value = 1;');
    expect(patch).not.toContain('private trail');
    expect(request.changedPaths.some((p) => p.startsWith('.showtail/'))).toBe(false);
  });

  test('validates hashes and citations, preserving conditions and exceptions', () => {
    const f = fixture();
    f.rule.strength = 'conditional';
    f.rule.appliesWhen = 'Frontend behavior changes';
    f.rule.exceptions = ['Documentation-only changes can defer checks to CI.'];
    f.save();
    expect(f.load().status).toBe('current');
    expect(f.load().guidance?.requirements[0]?.exceptions).toEqual(f.rule.exceptions);
    f.rule.sources[0]!.endLine = 200;
    f.save();
    expect(f.load().status).toBe('invalid');
  });

  test('rejects unsupported versions, duplicate ids, unsafe paths and altered snapshots', () => {
    const f = fixture();
    for (const mutate of [
      (g: any) => {
        g.v = 2;
      },
      (g: any) => {
        g.sources.push(g.sources[0]);
      },
      (g: any) => {
        g.requirements.push(g.requirements[0]);
      },
      (g: any) => {
        g.sources[0].location = '../secret';
      },
      (g: any) => {
        g.sources[0].content = 'Changed';
      },
    ]) {
      const copy = structuredClone(f.guidance);
      mutate(copy);
      expect(() => parseGuidance(JSON.stringify(copy))).toThrow();
    }
  });

  test('tracks repository and hosted indirection; rejects cycles and unrelated sources', () => {
    const f = fixture();
    const content = 'Use the canonical model source and regenerate output.';
    f.guidance.sources.push({
      id: 'canonical',
      kind: 'web',
      location: 'https://example.org/contributing',
      scope: '.',
      content,
      sha256: textHash(content),
      retrievedAt: '2026-10-24T12:00:00Z',
      discoveredFrom: { source: 'guide', startLine: 1, endLine: 1 },
    });
    f.save();
    expect(f.load().status).toBe('current');
    f.request.offline = true;
    expect(f.load().status).toBe('partial');
    expect(f.load().issues.join(' ')).toContain('offline');
    f.request.offline = false;
    f.guidance.sources[1]!.discoveredFrom!.source = 'canonical';
    f.save();
    expect(f.load().status).toBe('invalid');
    delete f.guidance.sources[1]!.discoveredFrom;
    f.save();
    expect(f.load().issues[0]).toContain('discovery chain');
  });

  test('reports missing seeds and linked documents as partial collection', () => {
    const f = fixture();
    f.request.sourceSeeds.push({ location: 'AGENTS.md', scope: '.', sha256: 'hash' });
    f.guidance.gaps.push('Linked testing guide could not be fetched.');
    f.save();
    expect(f.load().status).toBe('partial');
    expect(f.load().issues.join(' ')).toContain('Source not collected: AGENTS.md');
    expect(f.load().issues.join(' ')).toContain('testing guide');
  });

  test('changed scope or source content invalidates previously collected guidance', () => {
    const f = fixture();
    f.request.fingerprint = 'changed';
    expect(f.load().status).toBe('stale');
    f.request.fingerprint = 'request';
    writeFileSync(join(f.root, 'CONTRIBUTING.md'), 'New current notice');
    expect(f.load().status).toBe('stale');
    expect(f.load().guidance).toBeUndefined();
  });

  test('repository reads reject traversal and symlinks outside the checkout', () => {
    const f = fixture();
    expect(() => readRepoSource(f.root, '../CONTRIBUTING.md')).toThrow();
    expect(() => readRepoSource(f.root, '.git/config')).toThrow();
    const outside = join(tempDir(), 'outside.md');
    writeFileSync(outside, 'outside');
    try {
      symlinkSync(outside, join(f.root, 'escape.md'));
    } catch {
      return;
    } // Some Windows installations do not grant symlink privileges.
    expect(() => readRepoSource(f.root, 'escape.md')).toThrow();
  });
});

describe('independent contribution reviews', () => {
  test('exact-content receipts are citeable independently of historical session runs', () => {
    const f = reviewed();
    f.evidence.verification = [
      {
        id: 'V1',
        cmd: 'bun test',
        kind: 'test',
        outcome: 'passed',
        basis: 'exit status',
        summary: ['1 pass'],
        revision: 'no later edits seen',
        verificationBasis: 'exact-content-receipt',
      },
    ];
    const input = reviewInput(f.inputArgs);
    f.review.inputFingerprint = input.fingerprint;
    f.review.assessments[0]!.evidence = ['digest:V1'];
    f.saveReview();
    expect(f.loadReview(input).status).toBe('current');
    f.review.assessments[0]!.evidence = ['digest:V9'];
    f.saveReview();
    expect(f.loadReview(input).status).toBe('invalid');
  });
  test('a current review references exact rendered evidence', () => {
    const f = reviewed();
    expect(f.loadReview().status).toBe('current');
    expect(f.loadReview().mode).toBe('delegated');
    const anotherTime = reviewInput({
      ...f.inputArgs,
      digest: { ...f.evidence, generatedAt: 'later' },
    });
    expect(anotherTime.fingerprint).toBe(f.input.fingerprint);
    expect(f.loadReview(anotherTime).status).toBe('current');
  });

  test('complete evidence can supply an expanded fact absent from the compact digest', () => {
    const f = reviewed();
    const full = structuredClone(f.evidence);
    full.pr.commits.push({
      sha: 'abc123456789',
      subject: 'fix: greeting',
      body: 'A blank output prompted this change.',
      trailers: {},
    });
    writeFileSync(join(f.root, 'digest-full.json'), JSON.stringify(full));
    const input = reviewInput({ ...f.inputArgs, fullDigest: full });
    f.review.inputFingerprint = input.fingerprint;
    f.review.bodyReview!.claims[0]!.evidence = ['commit:abc1234'];
    f.saveReview();
    expect(f.loadReview(input).status).toBe('current');
    expect(input.artifacts).toContain('digest-full.json');
    expect(
      reviewInput({ ...f.inputArgs, fullDigest: { ...full, generatedAt: 'later' } })
        .fingerprint,
    ).toBe(input.fingerprint);
  });

  test.each([
    'title',
    'body',
    'diff',
    'evidence',
    'guidance',
    'author',
    'comic',
    'head',
    'map',
    'full evidence',
  ])('%s changes make the old review stale', (change) => {
    const f = reviewed();
    const next = structuredClone(f.inputArgs) as Parameters<typeof reviewInput>[0];
    if (change === 'title') next.title += ' again';
    if (change === 'body') next.body += 'Another fact.';
    if (change === 'diff') next.diffSha256 = 'new diff';
    if (change === 'evidence') next.digest.notes.push('Additional evidence');
    if (change === 'guidance') next.guidance.sha256 = 'new guidance';
    if (change === 'author') next.authorText = 'I checked it.';
    if (change === 'comic') next.comicSha256 = 'new comic';
    if (change === 'head') next.headSha = 'next commit';
    if (change === 'map') next.changeMapSha256 = textHash('new behavior checklist');
    if (change === 'full evidence')
      next.fullDigest = { ...f.evidence, notes: ['An expanded fact changed.'] };
    expect(f.loadReview(reviewInput(next)).status).toBe('stale');
  });

  test('commit-only accounts can be cited, but nonexistent commits cannot', () => {
    const f = reviewed();
    f.evidence.pr.commits.push({
      sha: 'abc123456789',
      subject: 'fix: greeting',
      body: 'The author reported blank output; see #42.',
      trailers: {},
    });
    const input = reviewInput(f.inputArgs);
    f.review.inputFingerprint = input.fingerprint;
    f.review.bodyReview!.claims[0]!.evidence = ['commit:abc1234'];
    f.saveReview();
    expect(f.loadReview(input).status).toBe('current');
    f.review.bodyReview!.claims[0]!.evidence = ['commit:fffffff'];
    f.saveReview();
    expect(f.loadReview(input).status).toBe('invalid');
  });

  test('missing assessments and source gaps never appear complete', () => {
    const f = reviewed();
    f.review.assessments = [];
    f.saveReview();
    expect(f.loadReview().status).toBe('incomplete');
    expect(f.loadReview().assessments[0]?.state).toBe('missing-evidence');
    f.guidance.gaps.push('A scoped guide remains unread.');
    f.save();
    const next = reviewInput({ ...f.inputArgs, guidance: f.load() });
    f.review.inputFingerprint = next.fingerprint;
    f.saveReview();
    expect(f.loadReview(next).status).toBe('incomplete');
  });

  test('same-agent independence, nonexistent evidence and unknown requirements are rejected', () => {
    const f = reviewed();
    f.review.reviewer.agentId = f.review.drafter.agentId;
    f.saveReview();
    expect(f.loadReview().status).toBe('invalid');
    f.review.reviewer.agentId = 'reviewer-1';
    for (const evidence of [
      'body:999',
      'digest:R999',
      'source:guide:999',
      'I ran all tests',
    ]) {
      f.review.assessments[0]!.evidence = [evidence];
      f.saveReview();
      expect(f.loadReview().status).toBe('invalid');
    }
    f.review.assessments[0]!.requirement = 'invented-coverage-threshold';
    f.saveReview();
    expect(f.loadReview().status).toBe('invalid');
  });

  test('inline fallback is visible; violations remain advisory findings', () => {
    const f = reviewed();
    f.review.drafter = { mode: 'inline' };
    f.review.reviewer = { mode: 'inline' };
    f.review.assessments[0]!.state = 'violated';
    f.saveReview();
    const result = f.loadReview();
    expect(result.status).toBe('current');
    expect(result.mode).toBe('inline');
    expect(reviewLine(result)).toContain('inline draft / self-review');
    expect(reviewLine(result)).toContain('violated');
  });

  test('new comic packets expose missing image-first assessment; old packets remain readable', () => {
    const f = reviewed();
    expect(f.loadReview().status).toBe('current');
    const input = reviewInput({
      ...f.inputArgs,
      comicSha256: 'a'.repeat(64),
      comic: { imagePath: 'out/comic.png', scriptPath: 'comic.json', panelCount: 1 },
    });
    f.review.inputFingerprint = input.fingerprint;
    f.saveReview();
    const result = f.loadReview(input);
    expect(result.status).toBe('incomplete');
    expect(result.issues.join(' ')).toContain('Comic content assessment is missing');
    expect(input.artifacts).toContain('out/comic.png');
    expect(input.artifacts).toContain('comic.json');
  });

  test('comic image identity and panel observations remain bound to the rendered packet', () => {
    const f = reviewed();
    const input = reviewInput({
      ...f.inputArgs,
      comicSha256: 'a'.repeat(64),
      comic: { imagePath: 'out/comic.png', scriptPath: 'comic.json', panelCount: 1 },
    });
    f.review.inputFingerprint = input.fingerprint;
    const value: any = f.review;
    value.comicReview = {
      imageSha256: 'a'.repeat(64),
      observedPanels: ['A single static contradiction.'],
      inferredStory: 'An interpretation.',
      perceivedJoke: 'A modest visual reversal.',
      inferredChange: 'A resource leak is fixed.',
      checks: Object.fromEntries(
        ['clarity', 'continuity', 'fidelity', 'payoff', 'readability', 'relevance'].map(
          (name) => [
            name,
            {
              state: 'uncertain',
              reason: 'A concrete concern remains visible.',
              panels: [1],
            },
          ],
        ),
      ),
    };
    f.saveReview();
    expect(f.loadReview(input).status).toBe('current');
    expect(reviewLine(f.loadReview(input))).toContain('payoff: uncertain');
    // An older report without relevance is readable but no longer complete.
    const { relevance, ...older } = value.comicReview.checks;
    value.comicReview = { ...value.comicReview, checks: older };
    delete value.comicReview.inferredChange;
    f.saveReview();
    const legacy = f.loadReview(input);
    expect(legacy.status).toBe('incomplete');
    expect(legacy.issues.join(' ')).toContain('Comic relevance is not assessed');
    value.comicReview = {
      ...value.comicReview,
      inferredChange: 'A resource leak is fixed.',
      checks: { ...older, relevance },
    };
    f.saveReview();
    expect(f.loadReview(input).status).toBe('current');
    value.comicReview.imageSha256 = 'b'.repeat(64);
    f.saveReview();
    expect(f.loadReview(input).status).toBe('stale');
    value.comicReview.imageSha256 = 'a'.repeat(64);
    value.comicReview.observedPanels.push('An unexpected extra panel.');
    f.saveReview();
    expect(f.loadReview(input).status).toBe('incomplete');
  });

  test('a missing description accuracy review leaves the packet incomplete', () => {
    const f = reviewed();
    delete f.review.bodyReview;
    f.saveReview();
    const result = f.loadReview();
    expect(result.status).toBe('incomplete');
    expect(result.issues.join(' ')).toContain('Description accuracy review is missing');
  });

  test('claim verdicts and omissions are shown; their evidence must exist', () => {
    const f = reviewed();
    const body = f.review.bodyReview!;
    body.claims.push({
      at: 'body:4',
      claim: 'No results captured.',
      verdict: 'unsupported',
      evidence: [],
      correction: 'Say which check ran, or leave it out.',
    });
    body.claims.push({
      at: 'body:2',
      claim: 'Adds greeting to every locale.',
      verdict: 'contradicted',
      evidence: ['diff:1'],
    });
    body.omissions.push({ behavior: 'The export is renamed.', evidence: ['diff:1'] });
    body.transfer = {
      state: 'needs-revision',
      reason: 'The text never says it is exported.',
    };
    f.saveReview();
    const result = f.loadReview();
    expect(result.status).toBe('current');
    const line = reviewLine(result);
    expect(line).toContain(
      '1 of 3 claim(s) supported; 1 omission(s); cold read needs-revision',
    );
    // Most serious first.
    expect(line.indexOf('contradicted (body:2)')).toBeLessThan(
      line.indexOf('unsupported (body:4)'),
    );
    expect(line).toContain('omitted: The export is renamed.');
    expect(line).toContain('The text never says it is exported.');
    for (const bad of [
      () => (body.claims[0]!.at = 'body:99'),
      () => (body.claims[0]!.evidence = ['diff:99']),
      () => (body.claims[0]!.evidence = []),
      () => (body.omissions[0]!.evidence = ['body:1']),
      () => (body.inferredChange = ''),
      () => (body.claims = []),
    ]) {
      const saved = structuredClone(body);
      bad();
      f.saveReview();
      expect(f.loadReview().status).toBe('invalid');
      Object.assign(body, structuredClone(saved));
    }
  });

  test('a change map is shared with the reviewer when the drafter wrote one', () => {
    const f = reviewed();
    expect(f.input.artifacts).not.toContain('change-map.json');
    const withMap = reviewInput({ ...f.inputArgs, changeMap: true });
    expect(withMap.artifacts).toContain('change-map.json');
    expect(withMap.fingerprint).toBe(f.input.fingerprint);
  });

  test('unknown applicability cannot silently pass', () => {
    const f = reviewed();
    f.rule.applicability = 'unknown';
    f.save();
    const next = reviewInput({ ...f.inputArgs, guidance: f.load() });
    f.review.inputFingerprint = next.fingerprint;
    f.saveReview();
    expect(f.loadReview(next).status).toBe('invalid');
  });
});

describe('source-backed composition', () => {
  test('advisory strength cannot create mandatory rendering or publishing restrictions', () => {
    const f = fixture();
    for (const strength of ['recommended', 'expected', 'advisory'] as const) {
      f.rule.strength = strength;
      for (const rendering of [
        'no-pull-requests',
        'media-prohibited',
        'text-prohibited',
        'disclosure-required',
        'disclosure-prohibited',
      ] as const) {
        f.rule.rendering = rendering;
        f.save();
        expect(f.load().status).toBe('invalid');
      }
    }
    // Old keyword labels alone do not override an explicit disclosure setting.
    expect(
      contributionPolicy(
        { verdict: 'disclosure-required', excerpts: [] },
        { status: 'missing', issues: [], sha256: '' },
      ).disclosure,
    ).toBeUndefined();
  });

  test('code-only staleness preserves restrictions from unchanged sources without a current review', () => {
    const f = fixture();
    const linked = 'No AI media. Never open a PR.';
    writeFileSync(join(f.root, 'linked.md'), linked);
    f.guidance.sources.push({
      id: 'linked',
      kind: 'repository',
      location: 'linked.md',
      scope: '.',
      content: linked,
      sha256: textHash(linked),
      retrievedAt: '2026-10-24T12:00:00Z',
      discoveredFrom: { source: 'guide', startLine: 1, endLine: 1 },
    });
    f.rule.rendering = 'media-prohibited';
    f.rule.sources = [{ source: 'linked', startLine: 1, endLine: 1 }];
    f.guidance.requirements.push({
      ...f.rule,
      id: 'no-pr',
      rendering: 'no-pull-requests',
    });
    f.save();
    expect(f.load().status).toBe('current');
    f.request.fingerprint = 'changed-submitted-code';
    const stale = f.load();
    expect(stale.status).toBe('stale');
    const policy = contributionPolicy({ verdict: 'none', excerpts: [] }, stale).policy;
    expect(policy.media).toBe('prohibited');
    // A researched ban names its source, like a ban found by the line check.
    expect(policy.mediaSource).toMatchObject({ file: 'linked.md', line: 1 });
    expect(policy.noPullRequests).toBe(true);
    expect(stale.issues.join(' ')).toContain('research again');
  });

  test('opposing attribution policies produce different composition controls', () => {
    const f = fixture();
    f.rule.rendering = 'disclosure-required';
    f.save();
    expect(
      contributionPolicy({ verdict: 'none', excerpts: [] }, f.load()).disclosure,
    ).toBe('required');
    f.rule.rendering = 'disclosure-prohibited';
    f.save();
    // The existing keyword detector can mislabel a negative disclosure sentence.
    expect(
      contributionPolicy({ verdict: 'disclosure-required', excerpts: [] }, f.load())
        .disclosure,
    ).toBe('prohibited');
  });

  test('explicit conflicts preserve the previous rendering and remain unresolved', () => {
    const f = fixture();
    f.rule.rendering = 'disclosure-required';
    f.guidance.requirements.push({
      ...f.rule,
      id: 'opposing',
      rendering: 'disclosure-prohibited',
    });
    f.save();
    const result = contributionPolicy({ verdict: 'mentioned', excerpts: [] }, f.load());
    expect(result.disclosure).toBeUndefined();
    expect(result.issues.join(' ')).toContain('Unresolved conflict');
  });

  test('inapplicable media rules do not suppress comics; explicit restrictions retain existing gates', () => {
    const f = fixture();
    f.rule.rendering = 'media-prohibited';
    f.rule.applicability = 'inapplicable';
    f.save();
    expect(
      contributionPolicy({ verdict: 'none', excerpts: [] }, f.load()).policy.media,
    ).toBeUndefined();
    f.rule.applicability = 'applicable';
    f.save();
    const next = contributionPolicy(
      { verdict: 'prohibited', excerpts: [], noPullRequests: true },
      f.load(),
    ).policy;
    expect(next.media).toBe('prohibited');
    expect(next.verdict).toBe('prohibited');
    expect(next.noPullRequests).toBe(true);
  });
});

describe('CLI contribution handoffs', () => {
  test('render honors attribution and media requirements in the final composition', () => {
    const repo = makeRepo();
    repo.commit(
      'CONTRIBUTING.md',
      '# Rules\nDisclose AI assistance when required.\nDo not include attribution when prohibited.\nNo AI-generated media.\n',
      'Document conditional rules',
    );
    const scratch = tempDir();
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: scratch,
      CODEX_HOME: scratch,
      ANTIGRAVITY_HOME: scratch,
      GEMINI_HOME: scratch,
      TRACETOON_CONFIG: join(scratch, 'config.json'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
    };
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
        cwd: repo.root,
        env,
        encoding: 'utf8',
      });
      return { code: r.status, json: JSON.parse(r.stdout) as any };
    };
    const d = cli('digest', '--offline');
    const dir = d.json.runDir as string;
    const c = cli('context', '--offline');
    const request: GuidanceRequest = c.json.contribution;
    const sources = request.sourceSeeds.map((seed, i) => ({
      ...seed,
      id: `s${i}`,
      kind: 'repository' as const,
      content: readFileSync(join(repo.root, seed.location), 'utf8'),
      retrievedAt: '2026-10-24T12:00:00Z',
    }));
    const source = sources.find((s) => s.location === 'CONTRIBUTING.md')!;
    const rule: Requirement = {
      id: 'attribution',
      text: 'Disclose assistance.',
      strength: 'conditional',
      applicability: 'applicable',
      appliesWhen: 'This synthetic contribution',
      exceptions: [],
      evidenceExpected: ['PR attribution'],
      sources: [{ source: source.id, startLine: 2, endLine: 3 }],
      rendering: 'disclosure-required',
    };
    const guidance: Guidance = {
      v: 1,
      requestFingerprint: request.fingerprint,
      researcher: { mode: 'inline' },
      sources,
      requirements: [rule],
      gaps: [],
    };
    writeFileSync(join(dir, 'guidance.json'), JSON.stringify(guidance));
    writeFileSync(join(dir, 'title.txt'), 'Explain conditional contribution rules');
    writeFileSync(join(dir, 'body.md'), 'Explains the contribution rules.');
    const context = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'));
    context.config.disclosure = 'none';
    writeFileSync(join(dir, 'context.json'), JSON.stringify(context));
    expect(cli('render').code).toBe(0);
    expect(readFileSync(join(dir, 'final-body.md'), 'utf8')).toContain(
      'description was drafted with',
    );
    // Explicit prohibition overrides the older keyword detector's disclosure label.
    rule.rendering = 'disclosure-prohibited';
    writeFileSync(join(dir, 'guidance.json'), JSON.stringify(guidance));
    cli('render');
    expect(readFileSync(join(dir, 'final-body.md'), 'utf8')).not.toContain('<sub>');
    rule.rendering = 'media-prohibited';
    rule.sources = [{ source: source.id, startLine: 4, endLine: 4 }];
    writeFileSync(join(dir, 'guidance.json'), JSON.stringify(guidance));
    mkdirSync(join(dir, 'out'));
    writeFileSync(
      join(dir, 'out/comic.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    const result = cli('render');
    expect(result.json.comicSha).toBeUndefined();
    expect(readFileSync(join(dir, 'final-body.md'), 'utf8')).not.toContain('<img');
    expect(cli('comic', 'prompts').json.error).toContain('rules forbid images in PRs');
  });

  test('research → draft → review → correction → publish; retained text stays intact', () => {
    const repo = makeRepo();
    repo.commit(
      'CONTRIBUTING.md',
      '# Contributing\nInclude a Testing section.\n',
      'Document contribution rules',
    );
    repo.commit('greet.ts', 'export const greeting = "hi";', 'Add greeting');
    // An edit must target the same branch revision that is actually on the remote.
    const remote = tempDir('tracetoon-review-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'feature']);
    const scratch = tempDir();
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: scratch,
      CODEX_HOME: scratch,
      ANTIGRAVITY_HOME: scratch,
      GEMINI_HOME: scratch,
      TRACETOON_CONFIG: join(scratch, 'config.json'),
      TRACETOON_GH_SCRIPT: resolve(import.meta.dir, 'fake-gh.ts'),
      FAKE_GH_LOG: join(scratch, 'gh.log'),
    };
    function cli(...args: string[]) {
      const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
        cwd: repo.root,
        env,
        encoding: 'utf8',
      });
      expect(result.stderr).not.toContain('SyntaxError');
      return { code: result.status, json: JSON.parse(result.stdout) as any };
    }
    const d = cli('digest', '--offline');
    expect(d.code).toBe(0);
    const runDir = d.json.runDir as string;
    const c = cli('context', '--offline');
    expect(c.code).toBe(0);
    expect(c.json.contribution.offline).toBe(true);
    const packet: GuidanceRequest = JSON.parse(
      readFileSync(join(runDir, 'guidance-request.json'), 'utf8'),
    );
    const sources = packet.sourceSeeds.map((seed, i) => ({
      id: `source${i}`,
      kind: 'repository' as const,
      ...seed,
      content: readFileSync(join(repo.root, seed.location), 'utf8'),
      retrievedAt: '2026-10-24T12:00:00Z',
    }));
    const guide = sources.find((s) => s.location === 'CONTRIBUTING.md')!;
    const requirement: Requirement = {
      id: 'testing',
      text: 'Include a Testing section.',
      strength: 'required',
      applicability: 'applicable',
      appliesWhen: 'All PRs',
      exceptions: [],
      evidenceExpected: ['A Testing section'],
      sources: [{ source: guide.id, startLine: 2, endLine: 2 }],
    };
    const guidance: Guidance = {
      v: 1,
      requestFingerprint: packet.fingerprint,
      researcher: { mode: 'delegated', agentId: 'researcher' },
      sources,
      requirements: [requirement],
      gaps: [],
    };
    writeFileSync(join(runDir, 'guidance.json'), JSON.stringify(guidance));
    expect(cli('guidance', 'check').json.status).toBe('current');
    const contextPath = join(runDir, 'context.json');
    const context = JSON.parse(readFileSync(contextPath, 'utf8'));
    context.existingPr = {
      number: 7,
      title: 'Add greeting',
      body: 'Human-written context.\n\nHUMAN: pending',
      url: 'https://github.com/acme/demo/pull/7',
    };
    writeFileSync(contextPath, JSON.stringify(context));
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting');
    writeFileSync(join(runDir, 'body.md'), '## Summary\nAdds greeting.');
    const first = cli('render');
    expect(first.json.contributionReview.status).toBe('missing');
    const report: ContributionReview = {
      v: 1,
      inputFingerprint: first.json.reviewFingerprint,
      drafter: { mode: 'delegated', agentId: 'drafter' },
      reviewer: { mode: 'delegated', agentId: 'reviewer' },
      assessments: [
        {
          requirement: 'testing',
          state: 'violated',
          reason: 'The rendered PR has no Testing section.',
          evidence: ['body:1-3'],
          correction: 'Add the required Testing section without inventing a result.',
        },
      ],
      bodyReview: {
        inferredChange: 'Adds a greeting.',
        inferredStart: 'The greeting module.',
        transfer: { state: 'satisfied', reason: 'Matches the diff.' },
        claims: [
          {
            at: 'body:1',
            claim: 'Adds greeting.',
            verdict: 'supported',
            evidence: ['diff:1'],
          },
        ],
        omissions: [],
      },
    };
    writeFileSync(join(runDir, 'review.json'), JSON.stringify(report));
    const reviewed = cli('render');
    expect(reviewed.json.contributionReview.status).toBe('current');
    expect(reviewed.json.code).toBe(first.json.code);
    writeFileSync(
      join(runDir, 'body.md'),
      '## Summary\nAdds greeting.\n\n## Testing\nNo results were captured.',
    );
    const corrected = cli('render');
    expect(corrected.json.contributionReview.status).toBe('stale');
    report.inputFingerprint = corrected.json.reviewFingerprint;
    report.assessments[0] = {
      requirement: 'testing',
      state: 'satisfied',
      reason:
        'The final body contains the section and states the evidence gap. <script>alert(1)</script>',
      evidence: ['body:9-10'],
    };
    writeFileSync(join(runDir, 'review.json'), JSON.stringify(report));
    const final = cli('render');
    expect(final.json.contributionReview.status).toBe('current');
    expect(final.json.contributionReview.assessments[0].state).toBe('satisfied');
    expect(final.json.mode).toBe('edit');
    // Human text in the existing PR is retained in the frozen body.
    const frozen = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(frozen).toContain('Human-written context.');
    expect(frozen).toContain('HUMAN: pending');
    expect(existsSync(join(runDir, 'preview.html'))).toBe(false);
    // The reviewed render reports the review to the agent, not to the PR.
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toContain(
      'Contribution review (advisory): current (independent host agents); guidance current; 0 finding(s); Reviewer model: not recorded.',
    );
    expect(text).toContain('Next: tracetoon publish --run');
    // Rendering again with nothing changed keeps the same render identity.
    expect(cli('render').json.code).toBe(final.json.code);
    const published = cli('publish');
    expect(published.code).toBe(0);
    expect(published.json.mode).toBe('edit');
    expect(published.json.message).toContain(
      'Tracetoon updated PR #7: https://github.com/acme/demo/pull/7',
    );
    const log = readFileSync(join(scratch, 'gh.log'), 'utf8');
    expect(log).toContain('HUMAN: pending');
    expect(log).not.toContain('Contributor guidance review');
    expect(log).not.toContain('alert(1)');
    expect(log).not.toContain('reviewed by the author');
    // Body-only and guidance-only revisions invalidate review, even if source hashes are valid.
    writeFileSync(
      join(repo.root, 'CONTRIBUTING.md'),
      'A new first-time contributor notice.',
    );
    expect(cli('render').json.contributionReview.guidanceStatus).toBe('stale');
    expect(cli('guidance', 'check').code).toBe(1);
  });
});

describe('evaluation probes', () => {
  test('paired title policies and invented verification produce distinct findings', () => {
    const conventional = contributionCases.find((c) => c.id === 'conventional-title')!;
    const imperative = contributionCases.find((c) => c.id === 'imperative-title')!;
    expect(
      contributionSignals(
        conventional,
        'fix: handle blank query',
        'The regression test passed.',
      ),
    ).toEqual([]);
    expect(
      contributionSignals(
        imperative,
        'fix: handle blank query',
        'The regression test passed.',
      ).length,
    ).toBe(1);
    expect(
      contributionSignals(imperative, 'Handle blank query', 'All tests pass.'),
    ).toContain('Unsupported or prohibited content: all tests pass');
  });

  test('human-only fixture catches removal or fabricated human review', () => {
    const c = contributionCases.find((c) => c.id === 'human-only')!;
    expect(
      contributionSignals(c, 'Return CSV headers for empty exports', 'HUMAN: pending'),
    ).toEqual([]);
    expect(
      contributionSignals(c, 'Return CSV headers', 'I have reviewed this.').join(' '),
    ).toContain('Existing human text');
  });
});
