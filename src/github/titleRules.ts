/**
 * What a repository expects of a PR title: written rules (contribution guides,
 * agent instructions, the PR template), enforced checks (a semantic-title
 * workflow, commitlint), where the title ends up (release notes, squash commit
 * subjects), and, as weaker evidence, what recent merged titles look like.
 * Written and enforced rules win; recent titles only illustrate.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh } from '../util/exec.ts';
import { repoArgs } from './target.ts';

export interface TitleRules {
  /** Lines from the repo's own docs that talk about PR titles. */
  excerpts: { file: string; line: number; text: string }[];
  /** A Conventional Commits type is required (`feat: …`), with the allowed types if known. */
  conventional?: { types: string[]; source: string };
  /** An issue reference the title must start with, e.g. `gh-1234: `. */
  issuePrefix?: { example: string; source: string };
  /** A stated maximum length. */
  maxLength?: { value: number; source: string };
  /** Where the title is reused (release notes, commit subjects), in words. */
  destinations: string[];
  /** What recent merged PR titles look like (supporting evidence only). */
  recent?: {
    count: number;
    conventionalShare: number;
    issuePrefixShare: number;
    tagShare: number;
    medianLength: number;
    examples: string[];
  };
}

const DOC_FILES = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CONTRIBUTING.rst',
  'AGENTS.md',
  '.github/AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
];
const DEFAULT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

/** A line about PR titles, not page titles or HTML <title>. */
const ABOUT_TITLES =
  /\b(pr|pull[- ]request|merge[- ]request)s?\b[^\n]{0,60}\btitles?\b|\btitles?\b[^\n]{0,60}\b(pr|pull[- ]request)s?\b|\btitle (should|must|needs to|starts? with)\b/i;
const CONVENTIONAL_WORDS = /conventional[- ]commits?|semantic (pr|pull request) title/i;
/** `gh-1234:`, `bpo-1234:`, `[JIRA-123]`, `ABC-123: ` as a required title start. */
const ISSUE_PREFIX =
  /\b(gh-|bpo-)(?:\d+|[nN]{3,}|[xX]{3,}|<[^>]+>)|\[([A-Z][A-Z0-9]+-)(?:\d+|[nN]+|[xX]+)\]|\b([A-Z][A-Z0-9]{1,9}-)(?:\d+|[nN]{3,}|[xX]{3,})\b:?/;
const LENGTH = /\b(\d{2,3})\s*(?:characters|chars)\b/i;

function read(root: string, rel: string): string | undefined {
  const p = join(root, rel);
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function workflowFiles(root: string): { rel: string; text: string }[] {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => ({
      rel: `.github/workflows/${f}`,
      text: read(root, `.github/workflows/${f}`) ?? '',
    }));
}

/** Allowed types from a semantic-title workflow's `types:` block or a commitlint `type-enum`. */
function typesFrom(text: string): string[] | undefined {
  const block =
    /\btypes:[ \t]*\|[ \t]*\r?\n((?:[ \t]+[a-z][\w-]*[ \t]*(?:\r?\n|$))+)/i.exec(
      text,
    )?.[1];
  if (block) {
    const t = block
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (t.length) return t;
  }
  const inline = /\btypes:\s*["']?([a-z][\w-]*(?:\s*[,\s]\s*[a-z][\w-]*)+)["']?/i.exec(
    text,
  )?.[1];
  if (inline) return inline.split(/[\s,]+/).filter(Boolean);
  const enumList = /type-enum[\s\S]{0,40}?\[[\s\S]*?\[([^\]]*)\]/.exec(text)?.[1];
  if (enumList) {
    const t = [...enumList.matchAll(/["']([a-z][\w-]*)["']/g)].map((m) => m[1]!);
    if (t.length) return t;
  }
  return undefined;
}

const COMMITLINT_FILES = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yml',
  '.commitlintrc.yaml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
];

export function readTitleRules(
  root: string,
  opts: { offline?: boolean; repo?: string } = {},
): TitleRules {
  const rules: TitleRules = { excerpts: [], destinations: [] };

  // Written rules.
  for (const rel of DOC_FILES) {
    const text = read(root, rel);
    if (!text) continue;
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || !ABOUT_TITLES.test(line)) return;
      rules.excerpts.push({ file: rel, line: i + 1, text: line.slice(0, 300) });
      const where = `${rel}:${i + 1}`;
      if (CONVENTIONAL_WORDS.test(line) && !rules.conventional)
        rules.conventional = { types: typesFrom(text) ?? DEFAULT_TYPES, source: where };
      const prefix = ISSUE_PREFIX.exec(line);
      if (
        prefix &&
        /\b(must|required|should|start|prefix|begin)/i.test(line) &&
        !rules.issuePrefix
      )
        rules.issuePrefix = { example: prefix[0].replace(/:$/, ''), source: where };
      const len = LENGTH.exec(line);
      if (len && !rules.maxLength)
        rules.maxLength = { value: Number(len[1]), source: where };
    });
  }
  rules.excerpts = rules.excerpts.slice(0, 10);

  // Enforced checks.
  for (const wf of workflowFiles(root)) {
    const semantic =
      /semantic-pull-request|action-semantic-pull-request|pr-title-checker|conventional-pr-title/i.test(
        wf.text,
      ) ||
      (/commitlint/i.test(wf.text) &&
        /pull_request[\s\S]{0,400}title|title[\s\S]{0,200}commitlint/i.test(wf.text));
    if (semantic)
      rules.conventional = {
        types: typesFrom(wf.text) ?? rules.conventional?.types ?? DEFAULT_TYPES,
        source: wf.rel,
      };
    if (
      /release-drafter/i.test(wf.text) &&
      !rules.destinations.some((d) => d.includes('Release Drafter'))
    )
      rules.destinations.push(
        `Release Drafter puts PR titles into release notes (${wf.rel})`,
      );
    if (
      /release-please/i.test(wf.text) &&
      !rules.destinations.some((d) => d.includes('release-please'))
    )
      rules.destinations.push(
        `release-please builds release notes from conventional commit messages (${wf.rel})`,
      );
  }
  for (const rel of COMMITLINT_FILES) {
    const text = read(root, rel);
    if (!text || !rules.conventional) continue;
    rules.conventional.types = typesFrom(text) ?? rules.conventional.types;
  }
  if (
    read(root, '.github/release-drafter.yml') &&
    !rules.destinations.some((d) => d.includes('Release Drafter'))
  )
    rules.destinations.push(
      'Release Drafter puts PR titles into release notes (.github/release-drafter.yml)',
    );
  if (existsSync(join(root, '.changeset')))
    rules.destinations.push(
      'changesets: release notes come from changeset files, not PR titles',
    );

  if (!opts.offline && opts.repo) {
    // Whether a squash merge uses the PR title as the commit subject.
    const r = gh(root, [
      'api',
      `repos/${opts.repo}`,
      '--jq',
      '[.allow_squash_merge, .squash_merge_commit_title] | @tsv',
    ]);
    if (r.ok) {
      const [squash, title] = r.stdout.trim().split('\t');
      if (squash === 'true' && title === 'PR_TITLE')
        rules.destinations.push('squash merges use the PR title as the commit subject');
      else if (squash === 'true')
        rules.destinations.push(
          'squash merges use the PR title as the commit subject when the PR has several commits',
        );
    }
    const list = gh(root, [
      'pr',
      'list',
      '--state',
      'merged',
      ...repoArgs(opts.repo),
      '--limit',
      '20',
      '--json',
      'title',
    ]);
    if (list.ok) {
      try {
        const titles = (JSON.parse(list.stdout) as { title: string }[]).map(
          (t) => t.title,
        );
        if (titles.length) rules.recent = summarizeTitles(titles);
      } catch {
        /* not JSON */
      }
    }
  }
  return rules;
}

const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?: /;

/** Shares and examples from recent titles. */
export function summarizeTitles(titles: string[]): NonNullable<TitleRules['recent']> {
  const share = (re: RegExp) =>
    Math.round((titles.filter((t) => re.test(t)).length / titles.length) * 100) / 100;
  const lengths = titles.map((t) => t.length).sort((a, b) => a - b);
  return {
    count: titles.length,
    conventionalShare: share(CONVENTIONAL),
    issuePrefixShare: share(/^(\[?[A-Za-z]+-\d+\]?:?\s|gh-\d+:|bpo-\d+:)/),
    tagShare: share(/^\[[^\]]+\]\s|^[\w./-]+: /),
    medianLength: lengths[Math.floor(lengths.length / 2)] ?? 0,
    examples: titles.slice(0, 3),
  };
}

/** One-line summary for `tracetoon context`. */
export function describeTitleRules(r: TitleRules): string[] {
  const out: string[] = [];
  if (r.conventional)
    out.push(
      `Title: Conventional Commits type required (${r.conventional.types.join(', ')}) per ${r.conventional.source}`,
    );
  if (r.issuePrefix)
    out.push(
      `Title: start with an issue reference like ${r.issuePrefix.example} (${r.issuePrefix.source})`,
    );
  if (r.maxLength)
    out.push(`Title: at most ${r.maxLength.value} characters (${r.maxLength.source})`);
  for (const d of r.destinations) out.push(`Title use: ${d}`);
  for (const e of r.excerpts.slice(0, 3)) out.push(`  ${e.file}:${e.line}: ${e.text}`);
  if (r.recent)
    out.push(
      `Recent merged titles (${r.recent.count}): median ${r.recent.medianLength} chars; ${Math.round(r.recent.conventionalShare * 100)}% conventional; e.g. "${r.recent.examples[0] ?? ''}"`,
    );
  return out;
}
