/** Bound concurrency while giving every test file its own OS process. */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { privateRepoPath } from '../src/util/repoFiles.ts';

// Bun 1.3.14's subprocess-heavy suites fail intermittently under concurrent
// macOS load, including with fresh processes. Keep full coverage there serial.
export const TEST_FILE_WORKERS =
  process.platform === 'darwin' ? 1 : process.platform === 'win32' ? 2 : 4;

const TIMES_FILE = 'node_modules/.cache/tracetoon-test-times.json';
export type TestTimes = Record<string, number>;

/** How long each test file took on its last passing source run (untracked). */
export function readTestTimes(root: string): TestTimes {
  try {
    const value = JSON.parse(readFileSync(join(root, TIMES_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeTestTimes(
  root: string,
  results: { file: string; ms: number; code: number }[],
): void {
  const times = readTestTimes(root);
  // A failed or interrupted file's time is not representative; keep the old one.
  for (const r of results) if (r.code === 0) times[r.file] = r.ms;
  try {
    mkdirSync(join(root, dirname(TIMES_FILE)), { recursive: true });
    writeFileSync(join(root, TIMES_FILE), JSON.stringify(times, null, 1) + '\n');
  } catch {
    /* ordering is an optimization only */
  }
}

/**
 * Longest first. Workers take files in order, and a few end-to-end files take
 * minutes, so alphabetical order could start the slowest file last and leave
 * the other workers idle. Unmeasured files fall back to their size.
 */
export function longestFirst(root: string, files: string[], times: TestTimes): string[] {
  const cost = (file: string) => {
    if (typeof times[file] === 'number') return times[file]!;
    try {
      // About 1ms per byte keeps unmeasured files comparable to measured ones.
      return readFileSync(join(root, file)).length;
    } catch {
      return 0;
    }
  };
  return [...files]
    .map((file) => ({ file, cost: cost(file) }))
    .sort((a, b) => b.cost - a.cost || a.file.localeCompare(b.file))
    .map((f) => f.file);
}

export function sourceTestFiles(root: string): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || 'Cannot discover source tests');
  const files = [
    ...new Set(
      result.stdout
        .split('\0')
        .filter(
          (file) =>
            /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
            !privateRepoPath(file) &&
            !file.split('/').includes('node_modules'),
        ),
    ),
  ].sort();
  if (!files.length) throw new Error('No source test files found');
  return files;
}

export async function runTestFiles(options: {
  root: string;
  files: string[];
  args?: string[];
  env?: NodeJS.ProcessEnv;
  workers?: number;
  reports?: string;
  quiet?: boolean;
}) {
  if (
    !options.files.length ||
    !Number.isInteger(options.workers ?? TEST_FILE_WORKERS) ||
    (options.workers ?? TEST_FILE_WORKERS) < 1
  )
    throw new Error('Test execution requires files and a positive worker count');
  let next = 0;
  const logParent = join(options.root, 'node_modules', '.cache', 'test-logs');
  mkdirSync(logParent, { recursive: true });
  const logs = mkdtempSync(join(logParent, 'run-'));
  const results: Array<{ file: string; code: number; ms: number; report?: string }> = [];
  const worker = async () => {
    while (next < options.files.length) {
      const index = next++;
      const file = options.files[index]!;
      const report = options.reports ? join(options.reports, `${index}.xml`) : undefined;
      const started = performance.now();
      const logFile = join(logs, `${index}.log`);
      writeFileSync(logFile, `Test file: ${file}\n`);
      writeFileSync(
        join(logs, 'files.json'),
        JSON.stringify(options.files, null, 2) + '\n',
      );
      const result = await new Promise<{
        file: string;
        code: number;
        ms: number;
        report?: string;
      }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            'test',
            file,
            // Many tests spawn the CLI or a fake reviewer; Bun's 5s default is too tight on
            // loaded CI runners. (bunfig.toml's `timeout` is ignored by Bun 1.3.)
            '--timeout',
            '30000',
            ...(options.args ?? []),
            ...(report ? ['--reporter=junit', '--reporter-outfile', report] : []),
          ],
          {
            cwd: options.root,
            env: options.env ?? process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        child.stdout!.on('data', (chunk) => {
          stdout += String(chunk);
          appendFileSync(logFile, chunk);
        });
        child.stderr!.on('data', (chunk) => {
          stderr += String(chunk);
          appendFileSync(logFile, chunk);
        });
        child.once('error', (error) => {
          stderr += error.message;
        });
        child.once('close', (code) => {
          if (!options.quiet) {
            process.stdout.write(stdout);
            process.stderr.write(stderr);
          }
          resolve({
            file,
            code: code ?? 1,
            ms: Math.round(performance.now() - started),
            report,
          });
        });
      });
      results[index] = result;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.workers ?? TEST_FILE_WORKERS, options.files.length) },
      worker,
    ),
  );
  writeFileSync(join(logs, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  if (!options.quiet) console.log(`Test logs: ${logs}`);
  return results;
}
