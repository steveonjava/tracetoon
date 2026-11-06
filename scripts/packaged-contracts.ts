/** Package checks exercise process/asset boundaries; pure source tests run in full separately. */
export interface PackagedContract {
  id: string;
  file: string;
  pattern: string;
  minimum: number;
}
export const PUBLICATION_CONTRACT: PackagedContract = {
  id: 'pr-creation-publication',
  file: 'tests/workflow.test.ts',
  pattern: 'requested PR to publication rehearsal',
  minimum: 1,
};
export const PASSIVE_CREATION_CONTRACT: PackagedContract = {
  id: 'passive-pr-creation',
  file: 'tests/workflow.test.ts',
  pattern: 'creation publishes without pre-coding registration or wrapped checks',
  minimum: 1,
};
export const PREPARATION_CONTRACT: PackagedContract = {
  id: 'shared-preparation-and-source',
  file: 'tests/preparation.test.ts',
  pattern:
    'shared preparation, immutable code snapshots and batch expansion preserve evidence',
  minimum: 1,
};
export const CHECK_PROGRESS_CONTRACT: PackagedContract = {
  id: 'live-check-progress',
  file: 'tests/check-progress.test.ts',
  pattern: 'CLI streams check progress while the receipt and lock still indicate running',
  minimum: 1,
};
export const EVIDENCE_GRAPH_CONTRACT: PackagedContract = {
  id: 'evidence-graph-engine',
  file: 'tests/graph.test.ts',
  pattern: 'digest links files to prompts and checks, and names later edits',
  minimum: 1,
};
export const NATIVE_CONTRACTS = [
  EVIDENCE_GRAPH_CONTRACT,
  PUBLICATION_CONTRACT,
  PASSIVE_CREATION_CONTRACT,
  PREPARATION_CONTRACT,
  CHECK_PROGRESS_CONTRACT,
];
export const BUNDLE_CONTRACTS: PackagedContract[] = [
  EVIDENCE_GRAPH_CONTRACT,
  CHECK_PROGRESS_CONTRACT,
  PREPARATION_CONTRACT,
  {
    id: 'trace-selection-and-redaction',
    file: 'tests/flow.test.ts',
    pattern: 'matches the session that wrote the code and drops other repos',
    minimum: 1,
  },
  {
    id: 'exact-render-publication',
    file: 'tests/flow.test.ts',
    pattern: 'publish creates the PR from the exact render without a code',
    minimum: 1,
  },
  {
    id: 'comic-assets-and-body',
    file: 'tests/comic.test.ts',
    pattern:
      'makes the comic, puts only the image on the assets branch, and links it by commit',
    minimum: 1,
  },
  {
    id: 'page-rendering-and-lettering',
    file: 'tests/comic.test.ts',
    pattern: 'a page is drawn whole with its lettering, then gets the footer bar',
    minimum: 1,
  },
  {
    id: 'research-review-handoff',
    file: 'tests/contribution.test.ts',
    pattern:
      'research → draft → review → correction → publish; retained text stays intact',
    minimum: 1,
  },
  {
    id: 'composition-cache-freshness',
    file: 'tests/composition.test.ts',
    pattern:
      'changed composition regenerates art and refuses stale output; format rerolls need matching beats',
    minimum: 1,
  },
  {
    id: 'hook-protocol',
    file: 'tests/hook.test.ts',
    pattern: 'the CLI reads stdin and answers like an agent hook',
    minimum: 1,
  },
  {
    id: 'code-freshness',
    file: 'tests/review.test.ts',
    pattern:
      'new commits block publishing and cannot be blessed by rendering an old digest',
    minimum: 1,
  },
  {
    id: 'runtime-selection',
    file: 'tests/runtime.test.ts',
    pattern: 'packaged runtime selection',
    minimum: 2,
  },
  PUBLICATION_CONTRACT,
  PASSIVE_CREATION_CONTRACT,
];
export const contractPattern = (cases: PackagedContract[]) =>
  cases.map((c) => `(?:${c.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('|');
const decode = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]!,
  );

/** A renamed/skipped/empty selection must fail instead of silently dropping coverage. */
export function missingContracts(xml: string, cases: PackagedContract[]): string[] {
  const passed = [
    ...xml.matchAll(/<testcase\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/testcase>)/g),
  ].flatMap((m) => {
    if (/<(?:skipped|failure|error)\b/.test(m[2] ?? '')) return [];
    const attr = (key: string) =>
      decode(new RegExp(`\\b${key}="([^"]*)"`).exec(m[1]!)?.[1] ?? '');
    return [
      {
        file: attr('file').replaceAll('\\', '/'),
        name: `${attr('classname')} ${attr('name')}`,
      },
    ];
  });
  return cases
    .filter(
      (c) =>
        passed.filter(
          (p) =>
            (p.file === c.file || p.file.endsWith('/' + c.file)) &&
            p.name.includes(c.pattern),
        ).length < c.minimum,
    )
    .map((c) => c.id);
}
