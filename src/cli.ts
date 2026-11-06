#!/usr/bin/env bun
import { Command } from 'commander';
import {
  loadConfig,
  setUserConfig,
  COMIC_MODES,
  comicMode,
  DEFAULTS,
  userConfigPath,
  type Config,
} from './config.ts';
import { doctor } from './commands/doctor.ts';
import { guidanceCheckCmd } from './commands/guidance.ts';
import { imagesCmd } from './commands/images.ts';
import {
  contextCmd,
  digestCmd,
  expandCmd,
  scanCmd,
  prepareCmd,
} from './commands/digest.ts';
import { sourceCmd } from './commands/source.ts';
import { queryCmd, ROW_CAP } from './commands/query.ts';
import { emit, exitCodeOf, UserError } from './commands/output.ts';
import { publishCmd, renderCmd } from './commands/publish.ts';
import {
  comicArtCmd,
  comicRerollCmd,
  comicCheckCmd,
  comicPromptsCmd,
  comicRenderCmd,
} from './commands/comic.ts';
import { exportCmd } from './commands/export.ts';
import {
  hookInstallCmd,
  hookUninstallCmd,
  setEnabledCmd,
  statusCmd,
} from './commands/switch.ts';
import { runPrHook, type HookAgent } from './hook/prHook.ts';
import { TOOL_VERSION, BUILD_INFO } from './version.ts';
import { taskCmd, checkCmd } from './commands/workflow.ts';
import { runLifecycle, type LifecycleEvent } from './hook/lifecycle.ts';
import { assertRunOwner, findRun } from './run.ts';
import { repository } from './workflow/state.ts';
import { recordTiming } from './workflow/publication.ts';
import { saveProfile } from './util/profile.ts';

const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const cwd = process.cwd();

const program = new Command()
  .name('tracetoon')
  .description(
    'Write PR descriptions from the agent session logs already on your machine.',
  )
  .version(TOOL_VERSION)
  .option('--json', 'print machine-readable JSON');

const g = () => program.opts<{ json?: boolean }>();
let timedAction: { name: string; run?: string; started: number } | undefined;
program.hook('preAction', (_command, action) => {
  if (
    action.opts().run &&
    ['render', 'publish', 'art', 'reroll', 'prompts'].includes(action.name())
  ) {
    const repo = repository(cwd);
    assertRunOwner(findRun(repo.gitDir, action.opts().run), repo.root, repo.branch);
  }
  timedAction = {
    name: action.name(),
    run: action.opts().run,
    started: performance.now(),
  };
});

program
  .command('build-info')
  .description('runtime identity and supported workflow capabilities')
  .action(() => emit(g(), BUILD_INFO, () => JSON.stringify(BUILD_INFO)));
const task = program
  .command('task')
  .description('register and finish a cohesive local change');
for (const action of ['begin', 'complete', 'defer', 'block'] as const) {
  task
    .command(action)
    .option('--run <id>', 'resume this task')
    .option('--base <ref>', 'PR base')
    .option('--session <id>', 'actual host session id')
    .option('--transcript <path>', 'active host transcript')
    .option('--reason <text>', 'reason work is unfinished')
    .option('--checks <names>', 'comma-separated applicable check names')
    .option('--no-checks <reason>', 'explain why no local checks apply')
    .action((o) => taskCmd(cwd, action, { ...g(), ...o }));
}
program
  .command('check')
  .description('run validation and record exact tested content')
  .requiredOption('--run <id>', 'task run')
  .option('--name <name>', 'check name')
  .option('--cwd <path>', 'directory inside the repository')
  .option('--skip <reason>', 'explicit CI-only or unavailable check')
  .option('--force', 'rerun even if unchanged')
  .option(
    '--input <path>',
    'also fingerprint an ignored generated artifact (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .argument('[command...]', 'program and arguments after --')
  .action((command, o) => checkCmd(cwd, command, { ...g(), ...o }));
program
  .command('images')
  .description(
    'image routes for comics: which can draw, which are approved, and what to do next',
  )
  .option(
    '--approve <route>',
    'record the user agreed to send comic prompts to this route',
  )
  .option(
    '--test [route]',
    'draw one small test picture (no repo content) with this route',
  )
  .option('--consent', 'with --test: the user agreed to this route')
  .option('--brief', 'one line, for the installers')
  .action((o) => imagesCmd({ ...g(), ...o }));

program
  .command('doctor')
  .description('check git, gh and which agent logs are on this machine')
  .option('--probe', 'also list record types the log readers do not recognize')
  .option('--strict', 'with --probe: exit 5 if any are found')
  .action((o) => doctor(cwd, { ...g(), ...o }));

program
  .command('scan')
  .description('list agent sessions that match the current branch, with scores')
  .option('--base <ref>', 'base branch (default: the PR base or the repo default)')
  .option('--offline', 'do not ask GitHub for an existing PR')
  .action((o) => scanCmd(cwd, { ...g(), ...o }));

program
  .command('digest')
  .description('start a run: build the redacted trace digest for this branch')
  .option('--run <id>', 'refresh an existing run, preserving its description and comic')
  .option('--base <ref>', 'base branch')
  .option('--include <ids>', 'session refs or ids to include', list)
  .option('--exclude <ids>', 'session refs or ids to leave out', list)
  .option('--budget <tokens>', 'approximate token budget', Number)
  .option('--offline', 'do not ask GitHub for an existing PR')
  .action((o) => {
    digestCmd(cwd, { ...g(), ...o });
  });

program
  .command('expand <refs...>')
  .description(
    'print full redacted evidence for a session, S/D/P/R/V fact or commit:<sha>',
  )
  .option('--run <id>', 'run id (default: latest)')
  .action((ref, o) => expandCmd(cwd, ref, { ...g(), ...o }));

program
  .command('query [words...]')
  .description(
    "ask this run's evidence graph: a named query (outline, why <path|H#>, verified, unverified, unexplained, turn <S#>, stale <R#>, dead-ends, pushback, schema) or --cypher",
  )
  .option('--run <id>', 'run id (default: latest)')
  .option('--cypher <query>', 'a read-only Cypher query (MATCH ... RETURN ...)')
  .option('--params <json>', 'parameters for --cypher, as a JSON object')
  .option('--all', `print every row (default: at most ${ROW_CAP} per section)`)
  .action((words, o) => queryCmd(cwd, words ?? [], { ...g(), ...o }));

program
  .command('prepare')
  .description('prepare digest and contribution context from one repository snapshot')
  .option('--run <id>', 'refresh an existing run')
  .option('--base <ref>', 'base branch')
  .option('--include <ids>', 'session refs or ids to include', list)
  .option('--exclude <ids>', 'session refs or ids to exclude', list)
  .option('--budget <tokens>', 'approximate digest token budget', Number)
  .option('--offline', 'disable GitHub lookups and external contributor research')
  .action((o) => {
    prepareCmd(cwd, { ...g(), ...o });
  });

program
  .command('source <paths...>')
  .description('snapshot base/head source files and emit immutable review references')
  .option('--run <id>', 'run id (default: latest)')
  .option('--revision <revision>', 'prepared base or head', 'head')
  .action((paths, o) => sourceCmd(cwd, paths, { ...g(), ...o }));

program
  .command('context')
  .description(
    'prepare contributor research, the submitted diff, template, policy and PR context',
  )
  .option('--run <id>', 'run id (default: latest)')
  .option('--offline', 'disable GitHub lookups and require offline contributor research')
  .action((o) => {
    contextCmd(cwd, { ...g(), ...o });
  });

program
  .command('guidance')
  .description('contributor research handoffs')
  .command('check')
  .description('validate guidance.json citations, discovery chains and local snapshots')
  .option('--run <id>', 'run id (default: latest)')
  .action((o) => guidanceCheckCmd(cwd, { ...g(), ...o }));

program
  .command('render')
  .description(
    'freeze body.md into the final PR body, scan it, and report the review results',
  )
  .option('--run <id>', 'run id (default: latest)')
  .option(
    '--allow-findings',
    'post even though the leak scan found something (only when the user says it is fine)',
  )
  .option('--no-comic', 'leave the comic out even if one was rendered')
  .option('--retitle', 'replace a title a person chose (only after the user agrees)')
  .action((o) => {
    o.noComic = o.comic === false;
    renderCmd(cwd, { ...g(), ...o });
  });

program
  .command('publish')
  .description('create or update the PR with exactly what was rendered')
  .option('--run <id>', 'run id (default: latest)')
  .option('--push', 'push the branch if GitHub does not have the rendered revision')
  .option('--no-push', 'require the rendered revision to already be on the remote')
  .option('--draft', 'open the PR as a draft')
  .option('--hosting <how>', 'where the comic image goes: auto, branch or attach')
  .action((o) => publishCmd(cwd, { ...g(), ...o }));

const comic = program.command('comic').description("make this PR's comic");
comic
  .command('check')
  .description('check comic.json before any art is made')
  .option('--run <id>', 'run id (default: latest)')
  .action((o) => comicCheckCmd(cwd, { ...g(), ...o }));
comic
  .command('prompts')
  .description("print the page (or panel) prompts for the host agent's own image tool")
  .option('--run <id>', 'run id (default: latest)')
  .option(
    '--lettering <how>',
    'model (one whole page, default) or overlay (text-free panels)',
  )
  .action((o) => comicPromptsCmd(cwd, { ...g(), ...o }));
comic
  .command('art')
  .description(
    'make the comic art with Codex, Antigravity, OpenAI or Gemini, after consent (exit code 5: no approved route)',
  )
  .option('--run <id>', 'run id (default: latest)')
  .option('--provider <name>', 'auto, codex, antigravity, openai or gemini', 'auto')
  .option('--consent', 'the user agreed to send comic prompts to this provider')
  .option('--force', 'redraw panels that already exist')
  .option(
    '--lettering <how>',
    'model (the image model letters the page) or overlay (Tracetoon draws bubbles)',
  )
  .action((o) => comicArtCmd(cwd, { ...g(), ...o }));
comic
  .command('reroll')
  .description(
    'redraw the page in a different style (or the one given), keeping the story',
  )
  .option('--run <id>', 'run id (default: latest)')
  .option(
    '--style <style>',
    'use this style (an idea id or any description) instead of a fresh one',
  )
  .option('--format <id>', 'also switch to this format')
  .option(
    '--palette <name>',
    'also switch the palette: full-color, bw-accent, duotone, limited',
  )
  .action((o) => comicRerollCmd(cwd, { ...g(), ...o }));
comic
  .command('render')
  .description('lay out panels and speech bubbles into out/comic.png')
  .option('--run <id>', 'run id (default: latest)')
  .action((o) => comicRenderCmd(cwd, { ...g(), ...o }));

program
  .command('export')
  .description('write the PR attribution as an Agent Trace record (agent-trace.dev)')
  .option('--agent-trace', 'Agent Trace JSON (the only format today)', true)
  .option('--base <ref>', 'base branch')
  .option('--offline', 'do not ask GitHub for an existing PR')
  .action((o) => exportCmd(cwd, { ...g(), ...o }));

program
  .command('status')
  .description(
    'is Tracetoon on here, which setting decided, and which agents have the PR hook',
  )
  .action(() => statusCmd(cwd, g()));
for (const [name, on] of [
  ['on', true],
  ['off', false],
] as const) {
  program
    .command(name)
    .description(`turn Tracetoon ${name} for your PRs (default: everywhere for you)`)
    .option('--repo', 'for everyone in this repo (.github/tracetoon.json)')
    .option('--local', 'for this repo on this machine only (git config)')
    .action((o) => setEnabledCmd(cwd, on, { ...g(), ...o }));
}

const hook = program
  .command('hook')
  .description('the agent hook that routes PRs through Tracetoon');
hook
  .command('lifecycle')
  .requiredOption('--agent <agent>', 'claude, codex or antigravity')
  .requiredOption('--event <event>', 'SessionStart, PreToolUse, PostToolUse or Stop')
  .action(async (o) => {
    if (
      !['claude', 'codex', 'antigravity'].includes(o.agent) ||
      !['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'].includes(o.event)
    )
      throw new UserError('Unknown host lifecycle event.');
    await runLifecycle(o.agent as HookAgent, o.event as LifecycleEvent);
  });
hook
  .command('pre-pr')
  .description(
    'called by agents before shell commands; routes PR creation through Tracetoon',
  )
  .requiredOption('--agent <agent>', 'claude, codex or antigravity')
  .action(async (o) => runPrHook(o.agent as HookAgent));
hook
  .command('install')
  .description('register the PR hook with Claude Code, Codex and Antigravity')
  .option('--program <path>', 'program the hook should run (default: this one)')
  .action((o) => hookInstallCmd({ ...g(), ...o }));
hook
  .command('uninstall')
  .description('remove the PR hook from every agent')
  .action(() => hookUninstallCmd(g()));

const config = program.command('config').description('show or change settings');
config.command('get [key]').action((key?: keyof Config) => {
  const c = loadConfig();
  emit(g(), key ? { [key]: c[key] } : c, () =>
    key ? String(c[key]) : `${userConfigPath()}\n${JSON.stringify(c, null, 2)}`,
  );
});
config.command('set <key> <value>').action((key: string, value: string) => {
  if (!(key in DEFAULTS))
    throw new UserError(
      `Unknown setting "${key}". Known: ${Object.keys(DEFAULTS).join(', ')}`,
    );
  if (key === 'comic' && ![...COMIC_MODES, 'true', 'false'].includes(value))
    throw new UserError('comic is off, allowed or always.');
  const c = setUserConfig(
    key as keyof Config,
    key === 'comic'
      ? comicMode(value === 'true' ? true : value === 'false' ? false : value)
      : value,
  );
  emit(g(), c, () => `${key} = ${String(c[key as keyof Config])}`);
});

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const err = e as Error & { exitCode?: number };
  if (g().json) process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
  else process.stderr.write(`tracetoon: ${err.message}\n`);
  process.exitCode = exitCodeOf(err);
} finally {
  if (
    timedAction &&
    [
      'digest',
      'prepare',
      'context',
      'expand',
      'query',
      'source',
      'render',
      'publish',
      'art',
      'check',
    ].includes(timedAction.name)
  ) {
    try {
      const run = findRun(repository(cwd).gitDir, timedAction.run);
      recordTiming(run, timedAction.name, performance.now() - timedAction.started);
      saveProfile(run, timedAction.name);
    } catch {
      /* timing must not break the workflow */
    }
  }
}
