// Stands in for the GitHub CLI in tests: logs each call and fakes the few
// commands Tracetoon uses.
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
const bodyIdx = args.indexOf('--body-file');
const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, 'utf8') : undefined;
if (log) appendFileSync(log, JSON.stringify({ args, body }) + '\n');

const [a, b] = args;
if (a === 'pr' && b === 'create') {
  const state = process.env.FAKE_GH_STATE;
  if (state) {
    const arg = (name: string) => args[args.indexOf(name) + 1];
    writeFileSync(
      state,
      JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/acme/demo/pull/7',
          headRefName: arg('--head'),
          baseRefName: arg('--base'),
          body,
        },
      ]),
    );
    if (process.env.FAKE_GH_FAIL_CREATE_ONCE) {
      process.stderr.write('Simulated connection lost after PR creation.');
      process.exit(1);
    }
  }
  process.stdout.write('https://github.com/acme/demo/pull/7\n');
  process.exit(0);
}
if (a === 'pr' && b === 'view') {
  if (/^\d+$/.test(args[2] ?? '') && args[args.indexOf('--json') + 1] === 'url') {
    process.stdout.write(`https://github.com/acme/demo/pull/${args[2]}\n`);
    process.exit(0);
  }
  process.exit(1); // no existing PR for discovery
}
if (a === 'pr' && b === 'list') {
  const state = process.env.FAKE_GH_STATE;
  process.stdout.write(
    state && existsSync(state)
      ? readFileSync(state, 'utf8')
      : (process.env.FAKE_GH_PRS ?? '[]'),
  );
  process.exit(0);
}
if (a === 'repo' && b === 'view' && args.some((x) => x.includes('viewerPermission'))) {
  process.stdout.write(
    JSON.stringify({
      nameWithOwner: 'acme/demo',
      viewerPermission: process.env.FAKE_GH_PERMISSION ?? 'WRITE',
    }),
  );
  process.exit(0);
}
if (a === 'repo' && b === 'view' && args.includes('nameWithOwner')) {
  process.stdout.write(`${process.env.FAKE_GH_REPO ?? 'acme/demo'}\n`);
  process.exit(0);
}
if (a === 'repo' && b === 'view') {
  process.stdout.write(`${process.env.FAKE_GH_VISIBILITY ?? 'PUBLIC'}\n`);
  process.exit(0);
}
if (a === 'api' && b === 'user') {
  process.stdout.write('octo-tester\n');
  process.exit(0);
}
if (a === '--version') {
  process.stdout.write(`gh version ${process.env.FAKE_GH_VERSION ?? '2.99.0'} (fake)\n`);
  process.exit(0);
}
process.exit(0);
