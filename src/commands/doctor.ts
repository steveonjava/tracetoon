import { existsSync, readFileSync } from 'node:fs';
import { graphEngineAvailable } from '../graph/engine.ts';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { hostHome } from '@showtail/agent-traces/paths/hostHome';
import { hookStatus } from '../hook/install.ts';
import { switchState } from '../hook/switches.ts';
import { ADAPTERS, PLANNED } from '../trace/registry.ts';
import { gh, git, run } from '../util/exec.ts';
import { TOOL_VERSION, BUILD_INFO } from '../version.ts';
import { loadConfig, userConfigPath } from '../config.ts';
import { readLocal } from '../util/localJson.ts';
import { emit, type OutOpts } from './output.ts';
import { nextStep, routeStatuses } from '../comic/routes.ts';
import { resolveTarget, targetLine, type Target } from '../github/target.ts';

/**
 * Whether the signed-in gh account can push to this repo, so a 403 shows up
 * before any work instead of at publish. Undefined when it can't be told.
 */
export function pushAccess(
  cwd: string,
  repo?: string,
): { repo: string; account?: string; canPush: boolean } | undefined {
  const view = gh(cwd, [
    'repo',
    'view',
    ...(repo ? [repo] : []),
    '--json',
    'nameWithOwner,viewerPermission',
  ]);
  if (!view.ok) return undefined;
  try {
    const { nameWithOwner, viewerPermission } = JSON.parse(view.stdout) as {
      nameWithOwner?: string;
      viewerPermission?: string;
    };
    if (!nameWithOwner || !viewerPermission) return undefined;
    const who = gh(cwd, ['api', 'user', '--jq', '.login']);
    return {
      repo: nameWithOwner,
      account: who.ok ? who.stdout.trim() || undefined : undefined,
      canPush: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(viewerPermission.toUpperCase()),
    };
  } catch {
    return undefined;
  }
}

function version(out: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
}

function atLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Unknown record types in each agent's most recent sessions: early warning of format changes. */
function probe(limit = 15): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const a of ADAPTERS) {
    if (!a.home()) continue;
    const refs = a
      .discover({ roots: [], sinceMs: 0, all: true })
      .sort((x, y) => y.mtimeMs - x.mtimeMs)
      .slice(0, limit);
    const unknown: Record<string, number> = {};
    for (const ref of refs) {
      for (const [k, v] of Object.entries(a.read(ref).unknownTypes))
        unknown[k] = (unknown[k] ?? 0) + v;
    }
    out[a.id] = unknown;
  }
  return out;
}

/** How Tracetoon is running: the prebuilt binary, or the bundle under bun or node. */
export function describeRuntime(
  execPath = process.execPath,
  bunVersion: string | null = (globalThis as { Bun?: { version: string } }).Bun
    ?.version ?? null,
): string {
  // The installed binary (bin/tracetoon[.exe]) or a release binary (tracetoon-<os>-<arch>).
  if (/[\\/]tracetoon(-[a-z]+-[a-z0-9]+)?(\.exe)?$/i.test(execPath))
    return 'prebuilt binary';
  return bunVersion ? `bun ${bunVersion}` : `node ${process.version}`;
}

/** Where the installer puts the skill for each agent. */
export function skillInstalls(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): {
  agent: string;
  dir: string;
  version: string | null;
  buildId: string | null;
  matchesRuntime: boolean;
}[] {
  const gemini = env.GEMINI_HOME || join(home, '.gemini');
  const places = [
    {
      agent: 'Claude Code',
      dir: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills', 'tracetoon'),
    },
    { agent: 'Codex', dir: join(home, '.agents', 'skills', 'tracetoon') },
    { agent: 'Antigravity', dir: join(gemini, 'config', 'skills', 'tracetoon') },
    { agent: 'Gemini CLI', dir: join(gemini, 'skills', 'tracetoon') },
  ];
  return places
    .filter((p) => existsSync(join(p.dir, 'SKILL.md')))
    .map((p) => {
      let version: string | null = null;
      try {
        version = readFileSync(join(p.dir, 'VERSION'), 'utf8').trim() || null;
      } catch {
        /* older installs have no VERSION file */
      }
      const buildId =
        readLocal<{ buildId: string }>(join(p.dir, 'build.json'))?.buildId ?? null;
      return {
        ...p,
        version,
        buildId,
        matchesRuntime: buildId === BUILD_INFO.buildId && version === TOOL_VERSION,
      };
    });
}

export function doctor(
  cwd: string,
  opts: OutOpts & { probe?: boolean; strict?: boolean },
): void {
  const runtime = describeRuntime();
  const hooks = hookStatus().filter((h) => h.present);
  const hookRuntimes = hooks.map((h) => {
    const prefix = h.command?.split(/\s+hook pre-pr\b/)[0];
    const argv = prefix
      ?.match(/"[^"]*"|'[^']*'|[^\s]+/g)
      ?.map((s) => s.replace(/^["']|["']$/g, ''));
    const result = argv?.length
      ? run(argv[0]!, [...argv.slice(1), 'build-info', '--json'], { timeoutMs: 2000 })
      : undefined;
    let build: typeof BUILD_INFO | null = null;
    try {
      if (result?.ok) build = JSON.parse(result.stdout);
    } catch {
      /* legacy runtime */
    }
    return {
      agent: h.agent,
      command: h.command ?? null,
      build,
      matchesRuntime: build?.buildId === BUILD_INFO.buildId,
    };
  });
  const installs = skillInstalls();
  const gitV = version(git(cwd, ['--version']).stdout);
  const ghOut = gh(cwd, ['--version']);
  const ghV = ghOut.ok ? version(ghOut.stdout) : undefined;
  const ghAuth = ghV ? gh(cwd, ['auth', 'status']).ok : false;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const target: Target | undefined = top.ok && ghAuth ? resolveTarget(cwd) : undefined;
  const agents = ADAPTERS.map((a) => {
    const home = a.home();
    const sessions = home ? a.count() : undefined;
    return { id: a.id, label: a.label, supported: true, found: !!home, sessions };
  });
  const planned = PLANNED.map((p) => ({
    id: p.id,
    label: p.label,
    supported: false,
    found:
      existsSync(hostHome(p.envVar, p.dir)) ||
      existsSync(join(hostHome(p.envVar, p.dir), 'sessions')),
  }));
  const report = {
    tool: `tracetoon ${TOOL_VERSION}`,
    runtime,
    runtimeInfo: {
      ...BUILD_INFO,
      executable: process.execPath,
      entrypoint: process.argv[1] ?? null,
      launcher: process.env.TRACETOON_LAUNCHER ?? null,
    },
    hookRuntimes,
    lastHookError:
      readLocal(join(dirname(userConfigPath()), 'last-hook-error.json')) ?? null,
    observedHooks: readLocal(join(dirname(userConfigPath()), 'hook-health.json')) ?? {},
    git: gitV ?? null,
    gh: ghV ?? null,
    ghAuthenticated: ghAuth,
    ghAttach: atLeast(ghV, '2.99.0'),
    repo: top.ok ? top.stdout.trim() : null,
    agents: [...agents, ...planned],
    installs,
    switch: switchState(cwd),
    prHook: hooks,
    ...(opts.probe ? { unknownRecordTypes: probe() } : {}),
    imageProviders: routeStatuses(top.ok ? top.stdout.trim() : undefined),
    // The branch is pushed to origin; the PR is opened in the target repo.
    target: target ?? null,
    push:
      top.ok && ghAuth ? (pushAccess(cwd, target?.origin ?? target?.repo) ?? null) : null,
    evidenceGraph: graphEngineAvailable(),
  };
  const comics = nextStep(
    report.imageProviders,
    loadConfig(report.repo ?? undefined).comic,
  );
  emit(opts, { ...report, comics }, () => {
    const yes = (b: boolean) => (b ? 'yes' : 'no');
    const lines = [
      `${report.tool} on ${runtime}`,
      `git ${gitV ?? 'not found'} | gh ${ghV ?? 'not found'} (signed in: ${yes(ghAuth)}, --attach: ${yes(report.ghAttach)})`,
      `repo: ${report.repo ?? 'not inside a git repository'}`,
      `evidence graph: ${report.evidenceGraph.ok ? 'ready (Relate, WebAssembly)' : `unavailable: ${report.evidenceGraph.reason}`}`,
      'agents:',
      ...report.agents.map(
        (a) =>
          `  ${a.label.padEnd(14)} ${a.found ? 'logs found' : 'no logs'}${
            'sessions' in a && a.sessions !== undefined ? ` (${a.sessions} sessions)` : ''
          }${a.supported ? '' : ' (support coming soon)'}`,
      ),
    ];
    if (report.unknownRecordTypes) {
      for (const [agent, types] of Object.entries(report.unknownRecordTypes)) {
        const list = Object.entries(types).map(([k, v]) => `${k} x${v}`);
        lines.push(
          `  ${agent}: ${list.length ? `unknown record types: ${list.join(', ')}` : 'all record types recognized'}`,
        );
      }
    }
    lines.push(
      installs.length
        ? 'skill installed for:'
        : 'skill not installed for any agent (run the installer)',
      ...installs.map((i) => {
        const stale = !i.matchesRuntime
          ? ' (different or unknown build: update the runtime and skill together)'
          : '';
        return `  ${i.agent.padEnd(14)} ${i.version ?? 'unknown version'}${stale}`;
      }),
      `tracetoon here: ${report.switch.enabled ? 'on' : 'off'} (${report.switch.why})`,
      `PR hook: ${
        report.prHook
          .map(
            (h) => `${h.label} ${h.installed ? (h.problem ? 'inactive' : 'yes') : 'no'}`,
          )
          .join(', ') || 'no agents found'
      }${report.prHook.some((h) => !h.installed) ? ' (add with: tracetoon hook install)' : ''}`,
      ...report.prHook.filter((h) => h.problem).map((h) => `  ${h.label}: ${h.problem}`),
      ...hookRuntimes
        .filter((h) => !h.matchesRuntime)
        .map(
          (h) =>
            `  ${h.agent} hook runtime differs or predates build identity; update it.`,
        ),
    );
    const found = report.imageProviders.filter((p) => p.available);
    lines.push(
      `comic art: ${
        found
          .map(
            (p) =>
              `${p.id} (${p.ready === 'not ready' ? "can't draw" : p.approved ? 'approved' : 'needs your OK'})`,
          )
          .join(', ') || 'no image route'
      }`,
      `  next: ${comics.text}`,
    );
    if (top.ok && ghAuth) lines.push(targetLine(report.target ?? undefined));
    if (report.push && !report.push.canPush)
      lines.push(
        `push access: ${report.push.account ?? 'this gh account'} can't push to ${report.push.repo}. Publishing will fail: switch accounts (gh auth switch), or push to a fork.`,
      );
    if (!ghV) lines.push('Install the GitHub CLI (gh) to create or update PRs.');
    else if (!ghAuth) lines.push('Run `gh auth login` to let Tracetoon post PRs.');
    return lines.join('\n');
  });
  const unknown = report.unknownRecordTypes ?? {};
  if (opts.strict && Object.values(unknown).some((t) => Object.keys(t).length))
    process.exitCode = 5;
}
