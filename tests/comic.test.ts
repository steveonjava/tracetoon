import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { composePage, wrap } from '../src/comic/compose.ts';
import { svgToPng } from '../src/comic/raster.ts';
import { decodeMeta, encodeMeta } from '../src/github/body.ts';
import { KEEP_RUNS, newRun } from '../src/run.ts';
import { git } from '../src/util/exec.ts';
import { ClaudeLog, makeRepo, tempDir } from './helpers.ts';
import { pageScript } from './pageScript.ts';

setDefaultTimeout(90_000);
// Set TRACETOON_TEST_CLI to run these against the bundled build instead of the source.
const CLI = process.env.TRACETOON_TEST_CLI ?? resolve(import.meta.dir, '../src/cli.ts');
const FAKE_GH = resolve(import.meta.dir, 'fake-gh.ts');
const FAKE_CODEX = resolve(import.meta.dir, 'fake-codex.ts');
const GREET =
  'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';
// A 1x1 PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('comic pieces', () => {
  test('balanced wrapping avoids a lonely last word', () => {
    const lines = wrap('1,326 tests green. Ship it!', 330, 30);
    expect(lines.length).toBe(2);
    expect(lines[1]!.split(' ').length).toBeGreaterThan(1);
  });

  test('builds a PNG page from panel art, with bubbles and the footer', async () => {
    const s = pageScript();
    const images = s.panels.map(() => ({ mime: 'image/png' as const, data: PIXEL }));
    const svg = composePage(s, images);
    expect(svg).toContain('made with Tracetoon');
    expect(svg).toContain('Where is this file?');
    const png = await svgToPng(svg, 800);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  });

  test('PR metadata holds only what is read back, and survives the round trip', () => {
    const meta = { v: 1 as const, style: 'film noir -- teal', contentSha: 'abc' };
    expect(decodeMeta(encodeMeta(meta))).toEqual(meta);
  });

  test(`run folders are pruned to the newest ${KEEP_RUNS}`, () => {
    const gitDir = tempDir('tracetoon-gitdir-');
    const runs = join(gitDir, 'tracetoon', 'runs');
    for (let i = 0; i < 25; i++)
      mkdirSync(join(runs, `20250101-0000${String(i).padStart(2, '0')}`), {
        recursive: true,
      });
    mkdirSync(join(runs, 'showcase-1'), { recursive: true });
    const run = newRun(gitDir);
    const left = readdirSync(runs).filter((f) => /^\d{8}-\d{6}/.test(f));
    expect(left).toHaveLength(KEEP_RUNS);
    expect(left).toContain(run.id);
    expect(left).not.toContain('20250101-000000');
    // Folders it didn't make are left alone.
    expect(existsSync(join(runs, 'showcase-1'))).toBe(true);
  });
});

describe('comic end to end', () => {
  let env: NodeJS.ProcessEnv;
  let ghLog: string;
  beforeEach(() => {
    const scratch = tempDir('tracetoon-env-');
    ghLog = join(scratch, 'gh.log');
    env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: tempDir('tracetoon-claude-'),
      CODEX_HOME: tempDir('tracetoon-codex-'),
      ANTIGRAVITY_HOME: tempDir('tracetoon-gemini-'),
      GEMINI_HOME: tempDir('tracetoon-gemini-'),
      TRACETOON_CONFIG: join(scratch, 'config.json'),
      TRACETOON_GH_SCRIPT: FAKE_GH,
      TRACETOON_REPO_WEB: 'https://github.com/acme/demo',
      FAKE_GH_LOG: ghLog,
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      // Real agent CLIs on the machine stay out of the tests.
      TRACETOON_CODEX_BIN: 'none',
      TRACETOON_AGY_BIN: 'none',
    };
  });
  const cli = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, '--json', ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    let json: any;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* not JSON */
    }
    return { code: r.status, json, stderr: r.stderr };
  };
  const ghCalls = () =>
    existsSync(ghLog)
      ? readFileSync(ghLog, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { args: string[]; body?: string })
      : [];

  function prepared() {
    const repo = makeRepo();
    const remote = tempDir('tracetoon-remote-');
    git(remote, ['init', '-q', '--bare']);
    git(repo.root, ['remote', 'add', 'origin', remote]);
    git(repo.root, ['push', '-q', 'origin', 'main']);
    new ClaudeLog(repo.root)
      .prompt('Add greeting')
      .write(join(repo.root, 'src/greet.ts'), GREET)
      .save(env.CLAUDE_CONFIG_DIR!, 's1');
    repo.commit('src/greet.ts', GREET, 'feat: greeting helper');
    const d = cli(repo.root, 'digest', '--offline');
    expect(d.code).toBe(0);
    const c = cli(repo.root, 'context', '--offline');
    expect(c.code).toBe(0);
    expect(c.json.comic).toEqual({ recentStyles: [], recentComics: [] });
    expect(c.json.cast).toBeUndefined();
    const runDir = d.json.runDir as string;
    expect(existsSync(join(runDir, 'bible.json'))).toBe(false);
    writeFileSync(join(runDir, 'comic.json'), JSON.stringify(pageScript()));
    writeFileSync(join(runDir, 'body.md'), '## Summary\nAdds a greeting helper.\n');
    writeFileSync(join(runDir, 'title.txt'), 'Add greeting helper\n');
    return { repo, remote, runDir };
  }

  test('makes the comic, puts only the image on the assets branch, and links it by commit', () => {
    const { repo, remote, runDir } = prepared();
    const draftPath = join(runDir, 'body.md');
    writeFileSync(
      draftPath,
      `${readFileSync(draftPath, 'utf8')}\n\n{{tracetoon:comic}}\n\n<img src="tracetoon-preview-comic.png" alt="author image">\n`,
    );
    expect(cli(repo.root, 'comic', 'check').code).toBe(0);
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    const art = cli(repo.root, 'comic', 'art', '--provider', 'codex', '--consent');
    expect(art.json).toMatchObject({ provider: 'codex', mode: 'page' });
    expect(existsSync(join(runDir, 'art', 'page.png'))).toBe(true);
    const rendered = cli(repo.root, 'comic', 'render');
    expect(rendered.code).toBe(0);
    expect(existsSync(join(runDir, 'out', 'comic.png'))).toBe(true);

    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.comicSha).toMatch(/^[0-9a-f]{64}$/);
    const finalBody = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(finalBody).toContain('{{tracetoon:comic-src}}');
    expect(finalBody).toContain('<summary>Comic transcript</summary>');
    expect(finalBody).toContain('**Dev:** Where is this file?');
    // The description comes first; the comic is the closing beat.
    expect(finalBody.indexOf('Adds a greeting helper')).toBeLessThan(
      finalBody.indexOf('{{tracetoon:comic-src}}'),
    );
    // Only what a later run reads back: the style, and the edit-detection hashes.
    const meta = decodeMeta(finalBody)!;
    expect(Object.keys(meta).sort()).toEqual([
      'comic',
      'contentSha',
      'style',
      'titleSha',
      'v',
    ]);
    expect(meta.comic).toMatchObject({ panelCount: 2, styleFamily: 'flat-color' });
    expect(meta.style).toBe('sunday-strip');
    // No local preview: render freezes the body, and an author's own image stays as written.
    expect(existsSync(join(runDir, 'preview.html'))).toBe(false);
    expect(finalBody).toContain(
      '<img src="tracetoon-preview-comic.png" alt="author image">',
    );
    expect(r.json.comicStatus).toEqual({ state: 'included' });
    expect(r.json.comicMode).toBe('allowed');

    // Swapping the image after rendering is refused.
    const png = readFileSync(join(runDir, 'out', 'comic.png'));
    writeFileSync(
      join(runDir, 'out', 'comic.png'),
      Buffer.concat([png, Buffer.from('x')]),
    );
    expect(cli(repo.root, 'publish', '--push').json.error).toContain('comic changed');
    writeFileSync(join(runDir, 'out', 'comic.png'), png);
    expect(ghCalls().some((c) => c.args[1] === 'create')).toBe(false);

    const ok = cli(repo.root, 'publish', '--push');
    expect(ok.code).toBe(0);
    expect(ok.json.hosting).toBe('branch');
    expect(ok.json.message).toContain('Tracetoon created PR #7');
    expect(ok.json.message).toContain('Comic: included.');
    const create = ghCalls().find((c) => c.args[1] === 'create')!;
    expect(create.body).toContain(
      '<img src="tracetoon-preview-comic.png" alt="author image">',
    );
    const m =
      /https:\/\/github\.com\/acme\/demo\/blob\/([0-9a-f]{40})\/(comics\/[^?]+comic\.png)\?raw=true/.exec(
        create.body!,
      );
    expect(m).not.toBeNull();
    const files = git(remote, ['ls-tree', '-r', '--name-only', m![1]!]).stdout;
    expect(files.trim().split('\n')).toEqual([m![2]!]);
    expect(git(remote, ['rev-parse', 'refs/heads/tracetoon-assets']).stdout.trim()).toBe(
      m![1]!,
    );
    expect(git(repo.root, ['branch', '--show-current']).stdout.trim()).toBe('feature');
  });

  test('context reads recent styles from earlier PRs only when comics are on', () => {
    const { repo } = prepared();
    env.FAKE_GH_PRS = JSON.stringify([
      { number: 4, body: encodeMeta({ v: 1, style: 'noir' }) },
      { number: 9, body: encodeMeta({ v: 1, style: 'linocut print' }) },
    ]);
    const on = cli(repo.root, 'context');
    expect(on.json.comic.recentStyles).toEqual(['linocut print', 'noir']);
    const list = ghCalls().find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'list' && c.args.includes('--search'),
    )!;
    expect(list.args[list.args.indexOf('--limit') + 1]).toBe('20');

    writeFileSync(env.TRACETOON_CONFIG!, JSON.stringify({ comic: false, theme: 'pets' }));
    writeFileSync(ghLog, '');
    const off = cli(repo.root, 'context');
    expect(off.json.comic.recentStyles).toEqual([]);
    expect(off.json.config.theme).toBeUndefined();
    expect(
      ghCalls().some(
        (c) => c.args[0] === 'pr' && c.args[1] === 'list' && c.args.includes('--search'),
      ),
    ).toBe(false);
  });

  test('no approved image route: exit 5 with the options, and the PR goes out without a comic', () => {
    const { repo, runDir } = prepared();
    const art = cli(repo.root, 'comic', 'art');
    expect(art.code).toBe(5);
    expect(art.json.error).toContain('No approved image route');
    expect(art.json.error).toContain('tracetoon comic prompts');
    expect(art.json.error).toContain('skip the comic');
    expect(
      JSON.parse(readFileSync(join(runDir, 'comic-status.json'), 'utf8')),
    ).toMatchObject({
      state: 'no-route',
      detail: expect.stringMatching(/^no image route/),
    });
    expect(cli(repo.root, 'comic', 'art', '--provider', 'builtin').json.error).toContain(
      'removed',
    );

    const comic = cli(repo.root, 'comic', 'render');
    expect(comic.code).toBe(1);
    expect(comic.json.error).toContain('No art for this comic');

    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toContain('Comic: none — no image route');
    expect(text).toContain('Next: tracetoon publish --run');
    expect(text).not.toContain('Approval code');
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.comicSha).toBeUndefined();
    expect(r.json.comicStatus).toMatchObject({
      state: 'no-route',
      detail: expect.stringMatching(/^no image route/),
    });
    const body = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(body).not.toContain('tracetoon:comic-src');
    expect(decodeMeta(body)!.style).toBeUndefined();
    const pub = cli(repo.root, 'publish', '--push');
    expect(pub.code).toBe(0);
    expect(pub.json.error).toBeUndefined();
    expect(pub.json.message).toContain('Comic: none — no image route');
    expect(pub.json.message).toContain(
      'Comics: tracetoon config set comic off|allowed|always (now: allowed)',
    );
  });

  test('art the host agent saved itself is used even with no approved route', () => {
    const { repo, runDir } = prepared();
    mkdirSync(join(runDir, 'art'), { recursive: true });
    writeFileSync(join(runDir, 'art', 'page.png'), PIXEL);
    const art = cli(repo.root, 'comic', 'art');
    expect(art.code).toBe(0);
    expect(art.json.panels).toEqual([
      { panel: 0, file: join(runDir, 'art', 'page.png'), source: 'existing' },
    ]);
    expect(cli(repo.root, 'comic', 'render').code).toBe(0);
    const prompts = cli(repo.root, 'comic', 'prompts');
    expect(prompts.json.prompts).toHaveLength(1);
    expect(prompts.json.prompts[0].prompt).toContain('Dev: a tired developer');
  });

  test('image providers need the user to agree first', () => {
    const { repo, runDir } = prepared();
    const fake = join(runDir, 'fake.png');
    writeFileSync(fake, PIXEL);
    env.GEMINI_API_KEY = 'test-key';
    env.TRACETOON_FAKE_IMAGE = fake;
    const auto = cli(repo.root, 'comic', 'art');
    expect(auto.code).toBe(5);
    expect(auto.json.error).toContain('tracetoon comic art --provider gemini --consent');
    const refused = cli(repo.root, 'comic', 'art', '--provider', 'gemini', '--force');
    expect(refused.code).toBe(4);
    const ok = cli(
      repo.root,
      'comic',
      'art',
      '--provider',
      'gemini',
      '--consent',
      '--force',
    );
    expect(ok.code).toBe(0);
    expect(ok.json.panels.map((p: any) => p.source)).toEqual(['gemini']);
    expect(JSON.parse(readFileSync(env.TRACETOON_CONFIG!, 'utf8')).imageConsent).toEqual([
      'gemini',
    ]);
    expect(cli(repo.root, 'comic', 'art', '--force').json.provider).toBe('gemini');
  });

  test("Codex draws the page in one session from the comic's own character descriptions", () => {
    const { repo } = prepared();
    const log = join(tempDir('tracetoon-codexlog-'), 'calls.jsonl');
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    env.FAKE_CODEX_LOG = log;
    const calls = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(
          (l) => JSON.parse(l) as { args: string[]; images: string[]; prompt: string },
        );

    const refused = cli(repo.root, 'comic', 'art', '--provider', 'codex');
    expect(refused.code).toBe(4);
    expect(refused.json.error).toContain('Codex login');
    expect(existsSync(log)).toBe(false);

    const art = cli(repo.root, 'comic', 'art', '--provider', 'codex', '--consent');
    expect(art.code).toBe(0);
    expect(art.json.panels.map((p: any) => p.source)).toEqual(['codex']);
    const [page] = calls();
    expect(calls()).toHaveLength(1);
    expect(page!.images).toEqual([]);
    expect(page!.prompt).toContain('A finished comic page');
    expect(page!.prompt).toContain(
      'Link: a cheerful glowing blue hyperlink with tiny arms',
    );
    expect(page!.prompt).not.toMatch(/character reference|\bKit\b|\bfox\b/i);
    expect(page!.args).toContain('--sandbox');

    // Approved once: auto picks Codex next time.
    expect(cli(repo.root, 'comic', 'art', '--force').json.provider).toBe('codex');
  });

  test('a failed image route is reported, not covered up', () => {
    const { repo, runDir } = prepared();
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    env.FAKE_CODEX_MAKE = '1';
    const panels = cli(
      repo.root,
      'comic',
      'art',
      '--provider',
      'codex',
      '--consent',
      '--lettering',
      'overlay',
    );
    expect(panels.code).toBe(1);
    expect(panels.json.error).toContain('could not draw panels 1, 2');
    expect(panels.json.error).toContain('skip the comic');
    expect(
      readdirSync(join(runDir, 'art')).filter((f) => /^panel-\d\.(png|svg)$/.test(f)),
    ).toEqual([]);
    expect(cli(repo.root, 'comic', 'art', '--provider', 'dalle').code).toBe(1);

    // A whole page that fails is reported the same way.
    env.FAKE_CODEX_MAKE = '0';
    const page = cli(repo.root, 'comic', 'art', '--force');
    expect(page.code).toBe(1);
    expect(page.json.error).toContain('could not draw the page');
    expect(existsSync(join(runDir, 'art', 'page.png'))).toBe(false);
  });

  test('a page is drawn whole with its lettering, then gets the footer bar', () => {
    const { repo, runDir } = prepared();
    const log = join(tempDir('tracetoon-codexlog-'), 'calls.jsonl');
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    env.FAKE_CODEX_LOG = log;

    const art = cli(repo.root, 'comic', 'art', '--provider', 'codex', '--consent');
    expect(art.code).toBe(0);
    expect(art.json.mode).toBe('page');
    expect(art.json.lettering).toBe('model');
    const lines = () => readFileSync(log, 'utf8').trim().split('\n');
    const page = JSON.parse(lines().at(-1)!).prompt as string;
    expect(page).toContain('"CLICK HERE, HUMAN"');
    expect(page).toContain('"file:///preview.html"');

    const out = cli(repo.root, 'comic', 'render');
    expect(out.code).toBe(0);
    expect(out.json.mode).toBe('page');
    expect(out.json.proofread).toEqual([
      'CLICK HERE, HUMAN',
      'BEFORE',
      'Where is this file?',
      'AFTER',
      'file:///preview.html',
    ]);
    const svg = readFileSync(join(runDir, 'out', 'comic.svg'), 'utf8');
    // The footer says only "made with Tracetoon": no repo, branch or PR number.
    expect(svg).toContain('made with Tracetoon');
    expect(svg).not.toMatch(/acme\/demo|feature/);

    // Overlay lettering: text-free panels, Tracetoon draws the words.
    const overlay = cli(repo.root, 'comic', 'art', '--lettering', 'overlay', '--force');
    expect(overlay.json.mode).toBe('panels');
    expect(overlay.json.panels.map((p: any) => p.source)).toEqual(['codex', 'codex']);
    expect(existsSync(join(runDir, 'art', 'page.png'))).toBe(false);
    expect(lines().at(-1)).toMatch(/no text, no letters/i);
    expect(cli(repo.root, 'comic', 'render').json.mode).toBe('panels');
    expect(readFileSync(join(runDir, 'out', 'comic.svg'), 'utf8')).toContain(
      'Where is this file?',
    );

    // Reroll: same story, a style idea not used lately, or any style given.
    const before = lines().length;
    expect(cli(repo.root, 'comic', 'reroll').code).toBe(0);
    const rerolled = JSON.parse(readFileSync(join(runDir, 'comic.json'), 'utf8'));
    expect(rerolled.style).not.toBe('sunday-strip');
    expect(lines().length).toBeGreaterThan(before);
    expect(cli(repo.root, 'comic', 'reroll', '--style', 'linocut print').code).toBe(0);
    const own = JSON.parse(readFileSync(join(runDir, 'comic.json'), 'utf8'));
    expect(own.style).toBe('linocut print');
    expect(own.palette).toBeUndefined();
    expect(JSON.parse(lines().at(-1)!).prompt).toContain('linocut print');
    expect(cli(repo.root, 'config', 'set', 'style', 'crayon drawing').code).toBe(0);
    expect(cli(repo.root, 'config', 'set', 'theme', 'pets').code).toBe(1);
  });

  test("follows the repo's AI policy: no comic when AI images are banned, its disclosure form, and a no-PR rule the user overrode", () => {
    const { repo, runDir } = prepared();
    writeFileSync(
      join(repo.root, 'AI_POLICY.md'),
      'All AI usage must be disclosed: name the tool and model and say how it was used.\n' +
        'AI-generated media (images, art, video) is not allowed for outside contributions.\n',
    );
    writeFileSync(join(repo.root, 'AGENTS.md'), 'Agents: never create a PR.\n');
    expect(
      cli(repo.root, 'context', '--offline', '--run', runDir.split(/[\\/]/).pop()!).code,
    ).toBe(0);
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    const art = cli(repo.root, 'comic', 'art', '--provider', 'codex', '--consent');
    expect(art.code).toBe(1);
    expect(art.json.error).toContain('rules forbid images in PRs');
    // A comic made before the policy was collected is also withheld at render.
    mkdirSync(join(runDir, 'out'), { recursive: true });
    writeFileSync(join(runDir, 'out', 'comic.png'), PIXEL);

    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.noPullRequests).toBe(true);
    const body = readFileSync(join(runDir, 'final-body.md'), 'utf8');
    expect(body).not.toContain('{{tracetoon:comic-src}}');
    expect(body).toContain('AI use:');
    expect(r.json.comicStatus.state).toBe('policy');
    expect(r.json.comicStatus.detail).toContain(
      "this repo's contributing rules forbid images in PRs (AI_POLICY.md:2)",
    );
    expect(existsSync(join(runDir, 'preview.html'))).toBe(false);
    expect(existsSync(join(runDir, 'evidence-notes.md'))).toBe(true);
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toContain(
      "Comic: none — this repo's contributing rules forbid images in PRs",
    );
    expect(text).toContain('The user asked for this one, so it is still posted');

    // The user asked for this PR, so the agent-instructions rule doesn't stop it.
    const posted = cli(repo.root, 'publish', '--push');
    expect(posted.code).toBe(0);
    expect(posted.json.message).toContain(
      "Comic: none — this repo's contributing rules forbid images in PRs",
    );
    const create = ghCalls().find((c) => c.args[1] === 'create')!;
    expect(create.body).not.toContain('comic.png');
  });

  test('comic off: render leaves the comic out and the comic commands refuse', () => {
    const { repo, runDir } = prepared();
    mkdirSync(join(runDir, 'out'), { recursive: true });
    writeFileSync(join(runDir, 'out', 'comic.png'), PIXEL);
    expect(cli(repo.root, 'config', 'set', 'comic', 'off').code).toBe(0);
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    for (const args of [
      ['comic', 'art', '--provider', 'codex', '--consent'],
      ['comic', 'prompts'],
      ['comic', 'render'],
      ['comic', 'reroll'],
    ]) {
      const refused = cli(repo.root, ...args);
      expect(refused.code).toBe(1);
      expect(refused.json.error).toContain('Comics are off');
    }
    expect(existsSync(join(runDir, 'art', 'page.png'))).toBe(false);
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.comicSha).toBeUndefined();
    expect(r.json.comicMode).toBe('off');
    expect(r.json.comicStatus).toEqual({
      state: 'off',
      detail: 'comic is off in your settings',
    });
    expect(readFileSync(join(runDir, 'final-body.md'), 'utf8')).not.toContain(
      'tracetoon:comic-src',
    );
    const pub = cli(repo.root, 'publish', '--push');
    expect(pub.code).toBe(0);
    expect(pub.json.message).toContain('Comic: none — comic is off in your settings.');
    expect(pub.json.message).toContain('(now: off)');
  });

  test('comic always: a repo media ban does not stop the comic', () => {
    const { repo, runDir } = prepared();
    writeFileSync(
      join(repo.root, 'AI_POLICY.md'),
      'AI-generated media (images, art, video) is not allowed for outside contributions.\n',
    );
    expect(cli(repo.root, 'config', 'set', 'comic', 'always').code).toBe(0);
    expect(
      cli(repo.root, 'context', '--offline', '--run', runDir.split(/[\\/]/).pop()!).code,
    ).toBe(0);
    env.TRACETOON_CODEX_BIN = FAKE_CODEX;
    const art = cli(repo.root, 'comic', 'art', '--provider', 'codex', '--consent');
    expect(art.code).toBe(0);
    expect(cli(repo.root, 'comic', 'render').code).toBe(0);
    const r = cli(repo.root, 'render');
    expect(r.code).toBe(0);
    expect(r.json.comicMode).toBe('always');
    expect(r.json.comicStatus).toEqual({ state: 'included' });
    expect(r.json.comicSha).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(runDir, 'final-body.md'), 'utf8')).toContain(
      '{{tracetoon:comic-src}}',
    );
    const text = spawnSync(process.execPath, [CLI, 'render'], {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    }).stdout;
    expect(text).toContain('the comic is included because the comic setting is always');
    const pub = cli(repo.root, 'publish', '--push');
    expect(pub.code).toBe(0);
    expect(pub.json.message).toContain('Comic: included.');
    expect(pub.json.message).toContain('(now: always)');
  });

  test('exports an Agent Trace record with line ranges', () => {
    const { repo } = prepared();
    const r = cli(repo.root, 'export', '--offline');
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync(r.json.path, 'utf8'));
    expect(rec.version).toBe('0.1.0');
    const file = rec.files.find((f: any) => f.path === 'src/greet.ts');
    expect(file.conversations[0]).toMatchObject({
      contributor: { type: 'ai', tool: 'Claude Code', model_id: 'claude-test-1' },
      ranges: [{ start_line: 1, end_line: 2 }],
    });
  });
});
