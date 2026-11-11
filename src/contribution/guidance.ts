/** Source discovery is local; the host researcher follows and interprets links. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRepoFile, readSubmittedFile, repoPath } from '../util/repoFiles.ts';
export { repoPath } from '../util/repoFiles.ts';
import { POLICY_FILES, findPrTemplate, type AiPolicy } from '../github/repoContext.ts';
import type { PrTruth } from '../git/pr.ts';
import { readText, writeJson, type Run } from '../run.ts';
import { git } from '../util/exec.ts';
import { count } from '../util/profile.ts';
import type {
  AgentRole,
  Guidance,
  GuidanceRequest,
  GuidanceResult,
  SourceRef,
} from './types.ts';

export const textHash = (text: string) =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
export const objectHash = (value: unknown) => textHash(JSON.stringify(value));

/** Reject symlinks that would read outside this checkout, including on Windows. */
export function readRepoSource(root: string, location: string): string {
  return readRepoFile(root, location).toString('utf8');
}

interface SubmittedCode {
  patch: string;
  headSha: string;
  sha256: string;
}
const committedSubmissions = new WeakMap<PrTruth, SubmittedCode>();
export function submission(truth: PrTruth): SubmittedCode {
  const cached = !truth.usedWorkingTree ? committedSubmissions.get(truth) : undefined;
  if (cached) {
    count('submission.reused');
    return { ...cached };
  }
  const headSha =
    truth.headSha ?? git(truth.toplevel, ['rev-parse', 'HEAD']).stdout.trim();
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-U3',
    truth.mergeBase,
  ];
  if (!truth.usedWorkingTree) args.push(headSha);
  args.push(
    '--',
    '.',
    ':(exclude,icase).showtail',
    ':(exclude,icase,glob)**/.showtail',
    ':(exclude,icase,glob)**/.showtail/**',
  );
  const result = git(truth.toplevel, args);
  if (!result.ok)
    throw new Error(`Cannot read the submitted diff: ${result.stderr.trim()}`);
  let patch = result.stdout;
  // Git diff omits untracked files, which prTruth includes for a working-tree PR.
  if (truth.usedWorkingTree) {
    const untracked = git(truth.toplevel, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    for (const path of untracked.stdout.split('\0').filter(repoPath)) {
      try {
        const data = readSubmittedFile(truth.toplevel, path);
        const hash = createHash('sha256').update(data).digest('hex');
        const text = data.toString('utf8');
        if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) {
          patch += `\nBinary file added: ${path} (${data.length} bytes, sha256 ${hash})\n`;
        } else {
          const lines = text.split(/\r?\n/);
          patch += `\nUntracked content sha256: ${hash}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((s) => `+${s}`).join('\n')}\n`;
        }
      } catch {
        /* Outside, private or unreadable untracked data is never copied. */
      }
    }
  }
  const resultCode = { patch, headSha, sha256: objectHash({ headSha, patch }) };
  if (!truth.usedWorkingTree) committedSubmissions.set(truth, { ...resultCode });
  return resultCode;
}

export function researchPacket(
  truth: PrTruth,
  offline = false,
): { request: GuidanceRequest; patch: string } {
  const changedPaths = truth.files
    .map((f) => f.path)
    .filter(repoPath)
    .sort();
  const candidates = new Map<string, string>();
  for (const path of [
    ...POLICY_FILES,
    'GEMINI.md',
    'CONTRIBUTING.rst',
    'README.md',
    'README.rst',
  ])
    candidates.set(path, '.');
  const template = findPrTemplate(truth.toplevel);
  if (template) candidates.set(template.path, '.');
  for (const file of changedPaths) {
    let dir = dirname(file).replace(/\\/g, '/');
    while (dir !== '.') {
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTRIBUTING.md']) {
        const location = `${dir}/${name}`;
        if (!candidates.has(location)) candidates.set(location, dir);
      }
      dir = dirname(dir).replace(/\\/g, '/');
    }
  }
  const workflowDir = join(truth.toplevel, '.github/workflows');
  if (existsSync(workflowDir))
    for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/i.test(f)))
      candidates.set(`.github/workflows/${file}`, '.');
  const sourceSeeds: GuidanceRequest['sourceSeeds'] = [];
  const gaps: string[] = [];
  for (const [location, scope] of [...candidates].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!existsSync(join(truth.toplevel, location))) continue;
    try {
      sourceSeeds.push({
        location,
        scope,
        sha256: textHash(readRepoSource(truth.toplevel, location)),
      });
    } catch {
      gaps.push(`Could not safely read ${location}.`);
    }
  }
  const diff = submission(truth);
  const stable = {
    offline,
    changedPaths,
    sourceSeeds,
    changesPath: 'changes.patch',
    headSha: diff.headSha,
    diffSha256: diff.sha256,
    gaps,
  };
  return {
    request: { v: 1, fingerprint: objectHash(stable), ...stable },
    patch: diff.patch,
  };
}

export function writeResearchPacket(
  run: Run,
  truth: PrTruth,
  offline = false,
): GuidanceRequest {
  const { request, patch } = researchPacket(truth, offline);
  writeFileSync(join(run.dir, 'changes.patch'), patch, 'utf8');
  writeJson(run, 'guidance-request.json', request);
  return request;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
export const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
export function checkRole(value: unknown): asserts value is AgentRole {
  requireThat(
    record(value) && ['delegated', 'inline'].includes(String(value.mode)),
    'Role must declare delegated or inline mode.',
  );
  requireThat(
    value.mode !== 'delegated' || nonempty(value.agentId),
    'Delegated roles need the actual host agentId.',
  );
  requireThat(
    value.agentId === undefined || nonempty(value.agentId),
    'Role agentId must be a nonempty string when supplied.',
  );
  requireThat(
    value.model === undefined || nonempty(value.model),
    'Role model must be a nonempty string when supplied.',
  );
}

function checkRef(
  value: unknown,
  sources: Guidance['sources'],
): asserts value is SourceRef {
  requireThat(record(value), 'A source reference must be an object.');
  const source = sources.find((s) => s.id === value.source);
  requireThat(source, `Unknown source reference: ${String(value.source)}`);
  requireThat(
    Number.isInteger(value.startLine) &&
      Number.isInteger(value.endLine) &&
      Number(value.startLine) >= 1 &&
      Number(value.endLine) >= Number(value.startLine) &&
      Number(value.endLine) <= source.content.split(/\r?\n/).length,
    `Invalid line range for ${source.id}.`,
  );
}

const RENDERING = [
  'disclosure-required',
  'disclosure-prohibited',
  'media-prohibited',
  'text-prohibited',
  'author-written-recommended',
  'no-pull-requests',
];

export function parseGuidance(raw: string): Guidance {
  const value: unknown = JSON.parse(raw);
  requireThat(
    record(value) && value.v === 1 && nonempty(value.requestFingerprint),
    'guidance.json needs v: 1 and requestFingerprint.',
  );
  checkRole(value.researcher);
  requireThat(
    Array.isArray(value.sources) &&
      Array.isArray(value.requirements) &&
      strings(value.gaps),
    'Guidance needs sources, requirements and gaps arrays.',
  );
  const ids = new Set<string>();
  for (const source of value.sources) {
    requireThat(
      record(source) && nonempty(source.id) && !ids.has(source.id),
      'Source ids must be nonempty and unique.',
    );
    ids.add(source.id);
    requireThat(
      ['repository', 'web'].includes(String(source.kind)) &&
        nonempty(source.location) &&
        typeof source.content === 'string' &&
        nonempty(source.sha256) &&
        nonempty(source.retrievedAt) &&
        Number.isFinite(Date.parse(source.retrievedAt)),
      `Invalid source ${source.id}.`,
    );
    requireThat(
      source.revision === undefined || nonempty(source.revision),
      `Invalid revision for ${source.id}.`,
    );
    requireThat(
      source.scope === '.' ||
        (typeof source.scope === 'string' && repoPath(source.scope)),
      `Invalid scope for ${source.id}.`,
    );
    requireThat(
      source.sha256 === textHash(source.content),
      `Snapshot hash mismatch for ${source.id}.`,
    );
    if (source.kind === 'repository')
      requireThat(repoPath(source.location), `Unsafe source path ${source.location}.`);
    else {
      const url = new URL(source.location);
      requireThat(
        url.protocol === 'https:' && !url.username && !url.password,
        `Source ${source.id} needs an HTTPS URL without credentials.`,
      );
    }
  }
  const guidance = value as unknown as Guidance;
  for (const source of guidance.sources)
    if (source.discoveredFrom) checkRef(source.discoveredFrom, guidance.sources);
  ids.clear();
  for (const rule of guidance.requirements) {
    requireThat(
      record(rule) && nonempty(rule.id) && !ids.has(rule.id),
      'Requirement ids must be nonempty and unique.',
    );
    ids.add(rule.id);
    requireThat(
      nonempty(rule.text) &&
        [
          'required',
          'expected',
          'prohibited',
          'recommended',
          'conditional',
          'advisory',
        ].includes(rule.strength) &&
        ['applicable', 'inapplicable', 'unknown'].includes(rule.applicability) &&
        nonempty(rule.appliesWhen) &&
        strings(rule.exceptions) &&
        strings(rule.evidenceExpected),
      `Invalid requirement ${rule.id}.`,
    );
    requireThat(
      Array.isArray(rule.sources) && rule.sources.length,
      `Requirement ${rule.id} needs source citations.`,
    );
    for (const ref of rule.sources) checkRef(ref, guidance.sources);
    requireThat(
      rule.rendering === undefined || RENDERING.includes(rule.rendering),
      `Invalid rendering rule for ${rule.id}.`,
    );
    if (rule.rendering && rule.rendering !== 'author-written-recommended') {
      const strengths =
        rule.rendering === 'disclosure-required'
          ? ['required', 'conditional']
          : ['required', 'prohibited', 'conditional'];
      requireThat(
        strengths.includes(rule.strength),
        `Mandatory rendering directive contradicts the strength of ${rule.id}.`,
      );
    }
  }
  return guidance;
}

/** This checks the handoff, not whether an agent's interpretation is correct. */
export function loadGuidance(
  run: Run,
  root: string,
  request: GuidanceRequest,
): GuidanceResult {
  let raw: string | undefined;
  try {
    raw = readText(run, 'guidance.json');
  } catch {
    return {
      status: 'invalid',
      issues: ['guidance.json could not be read.'],
      sha256: '',
    };
  }
  if (raw === undefined)
    return {
      status: 'missing',
      issues: ['Contributor guidance has not been collected.'],
      sha256: '',
    };
  const hash = textHash(raw);
  let guidance: Guidance;
  try {
    guidance = parseGuidance(raw);
  } catch (e) {
    return { status: 'invalid', issues: [(e as Error).message], sha256: hash };
  }
  const issues: string[] = [];
  const requestChanged = guidance.requestFingerprint !== request.fingerprint;
  for (const source of guidance.sources) {
    if (source.kind === 'repository') {
      try {
        if (textHash(readRepoSource(root, source.location)) !== source.sha256)
          issues.push(`Source changed: ${source.location}`);
      } catch {
        issues.push(`Source is unavailable or unsafe: ${source.location}`);
      }
    }
  }
  if (issues.length) return { status: 'stale', issues, sha256: hash };
  const seeds = new Set(request.sourceSeeds.map((s) => s.location));
  for (const source of guidance.sources) {
    // Every additional source must have a traceable chain to a repository seed.
    const visited = new Set<string>();
    let current = source;
    while (!seeds.has(current.location)) {
      if (visited.has(current.id) || !current.discoveredFrom)
        return {
          status: 'invalid',
          issues: [`Source ${source.id} has no discovery chain to this repository.`],
          sha256: hash,
        };
      visited.add(current.id);
      current = guidance.sources.find((s) => s.id === current.discoveredFrom!.source)!;
    }
  }
  issues.push(...request.gaps, ...guidance.gaps);
  if (requestChanged)
    issues.push(
      'The submitted code, offline setting or guidance seeds changed. Run context and research again. Unchanged-source restrictions remain in effect until then.',
    );
  if (request.offline)
    for (const source of guidance.sources)
      if (source.kind === 'web')
        issues.push(
          `External source cannot be refreshed in offline mode: ${source.location}`,
        );
  for (const seed of request.sourceSeeds)
    if (
      !guidance.sources.some(
        (s) => s.kind === 'repository' && s.location === seed.location,
      )
    )
      issues.push(`Source not collected: ${seed.location}`);
  return {
    status: requestChanged ? 'stale' : issues.length ? 'partial' : 'current',
    issues,
    guidance,
    sha256: hash,
  };
}

export function contributionPolicy(
  policy: AiPolicy,
  result: GuidanceResult,
): { policy: AiPolicy; disclosure?: 'required' | 'prohibited'; issues: string[] } {
  const rules =
    result.guidance?.requirements.filter((r) => r.applicability === 'applicable') ?? [];
  const has = (rendering: string) => rules.some((r) => r.rendering === rendering);
  const next = { ...policy };
  const issues: string[] = [];
  const prohibited = has('disclosure-prohibited');
  // The old detector is heuristic ("do not disclose AI" also matches DISCLOSE).
  // An explicit source-backed prohibition takes precedence over that label.
  const required = has('disclosure-required');
  let disclosure: 'required' | 'prohibited' | undefined;
  if (required && prohibited)
    issues.push(
      'Unresolved conflict: sources both require and prohibit AI attribution. Existing rendering is retained.',
    );
  else if (prohibited) {
    disclosure = 'prohibited';
    if (next.verdict === 'disclosure-required') next.verdict = 'mentioned';
    next.disclosure = undefined;
  } else if (required) disclosure = 'required';
  if (disclosure === 'required' && next.verdict !== 'prohibited')
    next.verdict = 'disclosure-required';
  if (has('media-prohibited')) {
    next.media = 'prohibited';
    // Name where the rule is, as the line check does, when it came from research.
    if (!next.mediaSource) {
      const rule = rules.find((r) => r.rendering === 'media-prohibited')!;
      const ref = rule.sources[0];
      const source = ref && result.guidance?.sources.find((s) => s.id === ref.source);
      if (ref && source)
        next.mediaSource = {
          file: source.location,
          line: ref.startLine,
          text: rule.text.slice(0, 300),
        };
    }
  }
  if (has('text-prohibited')) {
    next.text = 'prohibited';
    next.verdict = 'prohibited';
  }
  if (has('author-written-recommended') && next.text !== 'prohibited')
    next.text = 'author-written-recommended';
  if (has('no-pull-requests')) next.noPullRequests = true;
  return { policy: next, disclosure, issues };
}
