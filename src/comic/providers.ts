/**
 * Image models for comic art. Two kinds:
 *  - APIs (OpenAI, Gemini), when the user has a key;
 *  - agent CLIs already on the machine (Codex, Antigravity), which draw with the
 *    image tool of the user's own subscription, so no key is needed.
 * Only story beats and character descriptions are sent, never code, paths or
 * prompts from the logs, and only after the user agrees once per provider.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatById } from './formats.ts';
import { paletteText, styleById, styleLettering, styleText } from './styles.ts';
import {
  compositionPrompt,
  frameAspect,
  pageAspect,
  resolveComposition,
  visibleHeadline,
} from './composition.ts';
import {
  BEAT_MEANING,
  type Aspect,
  type ComicScript,
  type Dialogue,
  type Panel,
} from './types.ts';

export type ProviderId = 'openai' | 'gemini' | 'codex' | 'antigravity';
/** In order of preference: routes covered by a plan the user has, then paid APIs. */
export const PROVIDERS: ProviderId[] = ['codex', 'antigravity', 'openai', 'gemini'];

export interface Reference {
  mime: string;
  data: Uint8Array;
  /** What the image shows, e.g. "the first panel of this comic". */
  label?: string;
}

/** One image to make. */
export interface ImageJob {
  prompt: string;
  refs: Reference[];
  /** Image shape; default square. */
  aspect?: Aspect;
}

/** OpenAI image sizes for each page shape. */
export const OPENAI_SIZE: Record<Aspect, string> = {
  '4:3': '1536x1024',
  '16:9': '1536x1024',
  '1:1': '1024x1024',
  '3:4': '1024x1536',
};

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Where the prompts go, for the consent question. */
  sendsTo: string;
  /** Cost model, in words: covered by a plan, or billed per image. */
  cost: string;
  /** Found on this machine (program on PATH, key set). */
  available: boolean;
  /** Whether it can draw: checked for Codex; otherwise unknown until tested. */
  ready: Readiness;
  /** Why it isn't available or ready, or how it is set up. */
  detail: string;
}

export type Readiness = 'ready' | 'not ready' | 'unknown';

// ---------------------------------------------------------------- prompts

/** Things image models must avoid, on every comic. */
export const NEGATIVE =
  'fictional characters only (human characters are welcome); original character designs that do not resemble existing cartoon, film or game characters; no identifiable real-person or celebrity likenesses, no logos or brand marks, no watermarks, no signatures';

function characterLine(script: ComicScript, name: string): string {
  const c = script.characters?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return c ? `${c.name}: ${c.description}` : name;
}

function who(panel: Panel, script: ComicScript): string {
  return panel.characters
    .map(
      (pc) =>
        `${characterLine(script, pc.name)}, on the ${pc.position}${pc.expression ? `, looking ${pc.expression}` : ''}${pc.pose ? `, ${pc.pose}` : ''}`,
    )
    .join('; ');
}

/** The art style for a script, with its palette. */
export function scriptStyle(script: ComicScript): string {
  const palette = script.palette ?? styleById(script.style)?.palettes[0];
  return `${styleText(script.style)}${palette ? `; ${paletteText(palette, script.accent)}` : ''}`;
}

/** One text-free panel; Tracetoon adds the bubbles (overlay lettering). */
export function artPrompt(panel: Panel, index: number, script: ComicScript): string {
  const people = who(panel, script);
  const count = script.panels.length;
  const frame = resolveComposition(script)?.frames[index];
  return [
    `${scriptStyle(script)}.`,
    panel.beat
      ? `Panel ${index + 1} of ${count} (${BEAT_MEANING[panel.beat]}) of a comic.`
      : `Panel ${index + 1} of ${count} of a comic.`,
    `Scene: ${panel.scene}.`,
    people ? `Characters: ${people}.` : '',
    panel.camera ? `Camera: ${panel.camera} shot.` : '',
    panel.artPrompt ? `${panel.artPrompt}.` : '',
    script.composition
      ? `A ${SHAPE[frameAspect(script, index)]} panel image. Keep this normalized area plain for later lettering: ${JSON.stringify(frame?.textBox ?? { x: 0, y: 0, w: 1, h: 0.4 })}. Compose the subject outside it. No text, no letters.`
      : 'Square image. Keep the top third as plain, uncluttered background so speech bubbles can be added later. No text, no letters.',
    'If a reference image is given, keep every character and the art style consistent with it.',
    `Strictly: ${NEGATIVE}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

const SHAPE: Record<Aspect, string> = {
  '4:3': 'landscape 4:3',
  '16:9': 'wide landscape 16:9',
  '1:1': 'square',
  '3:4': 'portrait 3:4',
};

function textLine(d: Dialogue): string {
  const q = `"${d.text}"`;
  switch (d.kind) {
    case 'thought':
      return `${d.speaker} thinks (thought bubble): ${q}`;
    case 'caption':
      return `caption box: ${q}`;
    case 'sfx':
      return `big sound-effect lettering: ${q}`;
    case 'sign':
      return `written on a sign, screen or label in the scene: ${q}`;
    case 'label':
      return `a small typewriter-style callout tag with a thin leader line pointing at ${d.points?.trim() || 'the element it names'}, reading exactly ${q}`;
    default:
      return d.speaker === 'caption'
        ? `caption box: ${q}`
        : `${d.speaker} says (speech balloon): ${q}`;
  }
}

/**
 * One finished page, lettering included: the image model draws the panels, the
 * headline and every line of text, so the words are part of the art.
 */
export function pagePrompt(script: ComicScript): string {
  const format = formatById(script.format);
  const aspect = pageAspect(script);
  const headline = visibleHeadline(script);
  const cast = (script.characters ?? []).map((c) => `${c.name}: ${c.description}`);
  const panels = script.panels.map((p, i) => {
    const people = p.characters.map(
      (pc) =>
        `${pc.name} on the ${pc.position}${pc.expression ? `, looking ${pc.expression}` : ''}${pc.pose ? `, ${pc.pose}` : ''}`,
    );
    const text = (p.dialogue ?? []).map(textLine);
    return [
      `Panel ${i + 1}: ${p.scene}.`,
      people.length ? `Characters: ${people.join('; ')}.` : '',
      p.camera ? `${p.camera} shot.` : '',
      p.artPrompt ? `${p.artPrompt}.` : '',
      text.length ? `Text: ${text.join('; ')}.` : 'No text in this panel.',
    ]
      .filter(Boolean)
      .join(' ');
  });
  return [
    `A finished comic page, ${SHAPE[aspect]} image.`,
    `Art style: ${scriptStyle(script)}.`,
    !script.composition && format && format.id !== 'custom'
      ? `Format: ${format.name}. ${format.layout}.`
      : '',
    script.layout ? `Layout: ${script.layout}.` : '',
    compositionPrompt(script),
    cast.length
      ? `Characters (draw each one the same way in every panel): ${cast.join('; ')}.`
      : '',
    !script.composition
      ? `Headline, lettered big and bold as part of the design: "${headline}".`
      : '',
    `${script.panels.length === 1 ? 'The scene' : `The ${script.panels.length} panels, in reading order`}:`,
    ...panels,
    `Lettering: ${
      script.composition
        ? styleLettering(script.style)
            .split(',')
            .filter((part) => !/headline|title/i.test(part))
            .join(',') || 'clear comic lettering suited to this art'
        : styleLettering(script.style)
    }. Letter every quoted text exactly as written, spelled correctly, large enough to read on a phone.${
      script.panels.some((p) => p.dialogue?.some((d) => d.kind === 'label'))
        ? ' Callout tags are small and tidy, in a plain typewriter face that contrasts with the speech lettering, each with a thin line to the thing it names.'
        : ''
    } No words other than the quoted text above: no invented labels, no signatures, no watermarks, no made-up text.`,
    `Strictly: ${NEGATIVE}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------- availability

/** Where a program is on PATH, if anywhere. */
export function onPath(name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(
    process.platform === 'win32' ? ';' : ':',
  )) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return undefined;
}

/** An agent CLI's path: the override ("none" turns the route off), else PATH. */
const cliBin = (override: string | undefined, name: string) =>
  override === 'none' ? undefined : override || onPath(name);
export const codexBin = () => cliBin(process.env.TRACETOON_CODEX_BIN, 'codex');
const agyBin = () => cliBin(process.env.TRACETOON_AGY_BIN, 'agy');
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const openaiKey = () => process.env.OPENAI_API_KEY;

export const OPENAI_MODEL = () =>
  process.env.TRACETOON_OPENAI_MODEL || 'gpt-image-2.5-flare';
export const GEMINI_MODEL = () =>
  process.env.TRACETOON_GEMINI_MODEL || 'gemini-nano-banana-2.1';

/** Where Codex keeps its login and settings. */
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

/**
 * A model provider other than OpenAI set in Codex's config.toml (top level, or
 * in the selected profile). Codex's image tool only exists with OpenAI, so a
 * proxy such as LiteLLM can't draw.
 */
export function codexCustomProvider(toml: string): string | undefined {
  const top = toml.split(/^\s*\[/m)[0] ?? '';
  const value = (text: string, key: string) =>
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)?.[1];
  let provider = value(top, 'model_provider');
  const profile = value(top, 'profile');
  if (profile) {
    const section = new RegExp(
      `^\\s*\\[profiles\\.["']?${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`,
      'm',
    ).exec(toml)?.[1];
    provider = (section && value(section, 'model_provider')) || provider;
  }
  return provider && provider.toLowerCase() !== 'openai' ? provider : undefined;
}

const codexChecks = new Map<string, { ready: Readiness; why: string }>();
/** Whether Codex can use its image tool: signed in with ChatGPT, OpenAI as the provider. */
function codexReadiness(bin: string): { ready: Readiness; why: string } {
  const cached = codexChecks.get(bin);
  if (cached) return cached;
  let result: { ready: Readiness; why: string };
  const configPath = join(codexHome(), 'config.toml');
  const custom = existsSync(configPath)
    ? codexCustomProvider(readFileSync(configPath, 'utf8'))
    : undefined;
  if (custom) {
    result = {
      ready: 'not ready',
      why: `Codex is set to use the model provider "${custom}" (${configPath}), which has no image tool; remove model_provider there (or switch profile) and sign in with \`codex login\``,
    };
  } else {
    const script = /\.(ts|js|mjs)$/i.test(bin);
    const r = spawnSync(
      script ? process.execPath : bin,
      script ? [bin, 'login', 'status'] : ['login', 'status'],
      {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        shell: !script && process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
        input: '',
      },
    );
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    result = /logged in using chatgpt|signed in with chatgpt/i.test(said)
      ? { ready: 'ready', why: 'signed in with ChatGPT' }
      : /not logged in|not signed in/i.test(said)
        ? {
            ready: 'not ready',
            why: 'not signed in: run `codex login` and sign in with ChatGPT',
          }
        : /api key/i.test(said)
          ? {
              ready: 'not ready',
              why: 'signed in with an API key; the image tool needs a ChatGPT login: run `codex login`',
            }
          : { ready: 'unknown', why: 'could not tell whether Codex is signed in' };
  }
  codexChecks.set(bin, result);
  return result;
}

export function providerInfo(id: ProviderId): ProviderInfo {
  switch (id) {
    case 'openai': {
      const key = openaiKey();
      const proxy = process.env.OPENAI_BASE_URL;
      return {
        id,
        label: `OpenAI API (${OPENAI_MODEL()})`,
        sendsTo: 'OpenAI, with your API key',
        cost: 'billed per image to your OpenAI key',
        available: !!key,
        ready: 'unknown',
        detail: key
          ? `OPENAI_API_KEY is set${proxy ? ` (OPENAI_BASE_URL is set too, so the key may belong to ${proxy}, not OpenAI)` : ''}`
          : 'set OPENAI_API_KEY',
      };
    }
    case 'gemini': {
      const name = process.env.GEMINI_API_KEY
        ? 'GEMINI_API_KEY'
        : process.env.GOOGLE_API_KEY
          ? 'GOOGLE_API_KEY'
          : undefined;
      return {
        id,
        label: `Gemini API (${GEMINI_MODEL()})`,
        sendsTo: 'Google, with your API key',
        cost: 'billed per image to your Google key',
        available: !!geminiKey(),
        ready: 'unknown',
        detail: name ? `${name} is set` : 'set GEMINI_API_KEY',
      };
    }
    case 'codex': {
      const bin = codexBin();
      const check = bin ? codexReadiness(bin) : undefined;
      return {
        id,
        label: 'Codex CLI image tool',
        sendsTo: 'OpenAI, through your Codex login',
        cost: 'covered by your ChatGPT plan (counts toward Codex usage limits)',
        available: !!bin,
        ready: check?.ready ?? 'not ready',
        detail: bin
          ? `codex found; ${check!.why}`
          : 'install the Codex CLI and sign in with ChatGPT',
      };
    }
    case 'antigravity': {
      const bin = agyBin();
      return {
        id,
        label: 'Antigravity CLI image tool (experimental)',
        sendsTo: 'Google, through your Antigravity login',
        cost: 'covered by your Antigravity plan (counts toward its quota)',
        available: !!bin,
        ready: 'unknown',
        detail: bin ? 'agy found' : 'install and sign in to the Antigravity CLI',
      };
    }
  }
}

/** Found, and not known to be unable to draw (e.g. Codex signed out). */
export function providerAvailable(id: ProviderId): boolean {
  const info = providerInfo(id);
  return info.available && info.ready !== 'not ready';
}

/**
 * The real cause of a failed draw, with what to do about it, so a user isn't
 * left guessing (a Codex pointed at a proxy, a key for another service).
 */
export function explainFailure(id: ProviderId, message: string): string {
  if (id === 'codex' && /Codex made 0 image/.test(message))
    return `${message} Codex has no image tool here: sign in with ChatGPT (\`codex login\`), and check ${join(codexHome(), 'config.toml')} doesn't route Codex to another model provider.`;
  if (id === 'antigravity' && /made 0 of/.test(message))
    return `${message} Check that the Antigravity CLI is signed in and can generate images.`;
  if (/\b(401|403)\b/.test(message))
    return `${message} The API key was rejected: it may be wrong or expired, or belong to another service (such as a proxy) rather than ${id === 'gemini' ? 'Google' : 'OpenAI'}.`;
  if (/\b429\b|quota|billing|insufficient/i.test(message))
    return `${message} The account is out of quota or needs billing set up.`;
  return message;
}

// ---------------------------------------------------------------- APIs

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 180_000,
): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/** The first base64 image anywhere in a response, whatever the exact shape. */
export function findImageData(json: unknown): string | undefined {
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    // Interactions API: { type: "image", data }; generateContent: { inlineData: { data } }
    if (o.type === 'image' && typeof o.data === 'string') return o.data;
    for (const k of ['inlineData', 'inline_data']) {
      const d = o[k] as { data?: unknown } | undefined;
      if (d && typeof d.data === 'string') return d.data;
    }
    if (typeof o.b64_json === 'string') return o.b64_json;
    for (const child of Object.values(o).reverse()) stack.push(child);
  }
  return undefined;
}

/** Gemini image models (Nano Banana family) via the Interactions API. */
async function gemini(job: ImageJob): Promise<Uint8Array> {
  const body = {
    model: GEMINI_MODEL(),
    input: [
      { type: 'text', text: job.prompt },
      ...job.refs.slice(0, 14).map((r) => ({
        type: 'image',
        mime_type: r.mime,
        data: Buffer.from(r.data).toString('base64'),
      })),
    ],
    response_format: {
      type: 'image',
      aspect_ratio: job.aspect ?? '1:1',
      image_size: job.aspect && job.aspect !== '1:1' ? '2K' : '1K',
    },
  };
  const json = await fetchJson(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey()! },
      body: JSON.stringify(body),
    },
  );
  const data = findImageData(json);
  if (!data)
    throw new Error('Gemini returned no image (it may have declined the prompt).');
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** OpenAI image models: generations, or edits when there are reference images. */
async function openai(job: ImageJob): Promise<Uint8Array> {
  const key = openaiKey()!;
  let json: unknown;
  if (job.refs.length) {
    const form = new FormData();
    form.append('model', OPENAI_MODEL());
    form.append('prompt', job.prompt);
    form.append('size', OPENAI_SIZE[job.aspect ?? '1:1']);
    job.refs
      .slice(0, 8)
      .forEach((r, i) =>
        form.append('image[]', new Blob([r.data], { type: r.mime }), `ref${i}.png`),
      );
    json = await fetchJson('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
  } else {
    json = await fetchJson('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL(),
        prompt: job.prompt,
        size: OPENAI_SIZE[job.aspect ?? '1:1'],
        n: 1,
      }),
    });
  }
  const b64 = findImageData(json);
  if (!b64) throw new Error('OpenAI returned no image.');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------- agent CLIs

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export function runCli(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    // Script stand-ins (tests) run with this runtime. Windows .cmd shims need a
    // shell, so every argument we pass is a plain flag or a quoted path; long
    // prompts always go through stdin or a file, never the command line.
    const script = /\.(ts|js|mjs)$/i.test(bin);
    const shell = !script && process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const quoted = shell
      ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a))
      : args;
    const child = spawn(
      script ? process.execPath : bin,
      script ? [bin, ...quoted] : quoted,
      {
        cwd,
        shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolveRun({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(t);
      resolveRun({ code: -1, stdout, stderr: stderr + String(e) });
    });
  });
}

/** Write references to files an agent CLI can attach or open. */
function writeRefs(dir: string, refs: Reference[]): { path: string; label: string }[] {
  return refs.map((r, i) => {
    const ext =
      r.mime === 'image/jpeg' ? 'jpg' : r.mime === 'image/webp' ? 'webp' : 'png';
    const path = join(dir, `reference-${i + 1}.${ext}`);
    writeFileSync(path, r.data);
    return { path, label: r.label ?? `reference ${i + 1}` };
  });
}

/** The instructions an agent CLI gets: draw each prompt with its image tool, in order. */
export function agentBatchPrompt(
  jobs: ImageJob[],
  refLabels: string[],
  saveTo?: string[],
): string {
  const lines = [
    `Use your image generation tool to make ${jobs.length} separate image(s), one for each numbered prompt below, in order.`,
    refLabels.length
      ? `The attached images are references: ${refLabels.map((l, i) => `image ${i + 1} is ${l}`).join('; ')}. Keep every character exactly consistent with them, and keep the images consistent with each other.`
      : 'Keep the characters and style consistent across all images.',
    'Do not edit any files, and do not run commands other than what is needed to save the images. Put text in an image only where its prompt asks for it, exactly as written.',
    saveTo
      ? 'Save each image to the exact path given with its prompt.'
      : 'When all images are done, reply with only the absolute file path of the final image for each prompt, one per line, in prompt order. If you redrew an image, list only the version you chose.',
    '',
    ...jobs.map(
      (j, i) => `${i + 1}. ${j.prompt}${saveTo ? `\n   Save to: ${saveTo[i]}` : ''}`,
    ),
  ];
  return lines.filter((l, i) => l !== '' || i > 0).join('\n');
}

function imagesIn(dir: string, since = 0): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_EXT.test(f))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).mtimeMs >= since)
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/**
 * Which of a Codex session's images answer which prompt. Codex sometimes redraws
 * an image it isn't happy with, so the folder can hold more images than prompts,
 * in any order. Its final reply lists the chosen file per prompt, in order: use
 * that when it names one of the session's own images per prompt. Otherwise, use
 * the newest images when there are exactly as many as prompts.
 */
export function pickCodexImages(
  events: Record<string, unknown>[],
  made: string[],
  count: number,
): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const own = new Map(made.map((p) => [norm(p), p]));
  const replies = events
    .filter((e) => e.type === 'item.completed')
    .map((e) => (e.item as { type?: string; text?: string } | undefined) ?? {})
    .filter((i) => i.type === 'agent_message');
  for (const reply of replies.reverse()) {
    const named = (reply.text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^[-*\d.)\s`]+|`$/g, ''))
      .filter((l) => IMAGE_EXT.test(l))
      .map((l) => own.get(norm(l)))
      .filter((p): p is string => !!p);
    if (named.length === count && new Set(named).size === count) return named;
  }
  return made.length === count ? made : [];
}

/**
 * Codex CLI: one `codex exec` session draws every job with the built-in image
 * tool (gpt-image through the user's Codex login). Images land in
 * $CODEX_HOME/generated_images/<thread id>/.
 */
async function codexBatch(jobs: ImageJob[]): Promise<Uint8Array[]> {
  const bin = codexBin();
  if (!bin) throw new Error('The Codex CLI is not installed.');
  const work = mkdtempSync(join(tmpdir(), 'tracetoon-codex-'));
  const refs = writeRefs(work, jobs[0]?.refs ?? []);
  const prompt = agentBatchPrompt(
    jobs,
    refs.map((r) => r.label),
  );
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json'];
  for (const r of refs) args.push('--image', r.path);
  args.push('-'); // read the prompt from stdin
  const res = await runCli(bin, args, work, 20 * 60_000, prompt);
  const events = res.stdout.split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const thread = events.find((e) => e.type === 'thread.started')?.thread_id as
    string | undefined;
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const dir = thread ? join(home, 'generated_images', thread) : undefined;
  const made = dir ? imagesIn(dir) : [];
  const files = pickCodexImages(events, made, jobs.length);
  if (files.length < jobs.length) {
    const why =
      res.code === 0
        ? ''
        : ` (codex exited ${res.code}: ${res.stderr.trim().split('\n').pop() ?? ''})`;
    throw new Error(
      `Codex made ${made.length} image(s) for ${jobs.length} prompt(s)${why}.`,
    );
  }
  return files.map((f) => new Uint8Array(readFileSync(f)));
}

/**
 * Antigravity CLI (experimental): `agy -p` draws each job with its image tool
 * and saves it to a path we give, inside a scratch folder it works in.
 */
async function antigravityBatch(jobs: ImageJob[]): Promise<Uint8Array[]> {
  const bin = agyBin();
  if (!bin) throw new Error('The Antigravity CLI is not installed.');
  const work = mkdtempSync(join(tmpdir(), 'tracetoon-agy-'));
  const out = join(work, 'out');
  mkdirSync(out, { recursive: true });
  const refs = writeRefs(work, jobs[0]?.refs ?? []);
  const saveTo = jobs.map((_, i) => join(out, `image-${i + 1}.png`));
  const labels = refs.map((r) => `${r.label} (${r.path})`);
  const prompt = agentBatchPrompt(jobs, labels, saveTo);
  // agy needs permission to use its tools without a person at the keyboard;
  // it runs in an empty scratch folder with only the reference images.
  writeFileSync(join(work, 'prompt.md'), prompt, 'utf8');
  const res = await runCli(
    bin,
    [
      '-p',
      'Read prompt.md in the current folder and do exactly what it says.',
      '--dangerously-skip-permissions',
    ],
    work,
    20 * 60_000,
  );
  const files = saveTo.filter((p) => existsSync(p));
  if (files.length < jobs.length) {
    const extra = imagesIn(out).filter((p) => !files.includes(p));
    files.push(...extra);
  }
  if (files.length < jobs.length) {
    throw new Error(
      `Antigravity made ${files.length} of ${jobs.length} image(s)${res.code ? ` (agy exited ${res.code})` : ''}.`,
    );
  }
  return files.slice(0, jobs.length).map((f) => new Uint8Array(readFileSync(f)));
}

// ---------------------------------------------------------------- entry

/** Make one image per job. API providers go one by one; agent CLIs do all in one session. */
export async function generateImages(
  id: ProviderId,
  jobs: ImageJob[],
): Promise<Uint8Array[]> {
  if (!jobs.length) return [];
  // Tests replace the network with a local stand-in.
  if (process.env.TRACETOON_FAKE_IMAGE) {
    return jobs.map(
      () => new Uint8Array(readFileSync(process.env.TRACETOON_FAKE_IMAGE!)),
    );
  }
  try {
    if (id === 'codex') return await codexBatch(jobs);
    if (id === 'antigravity') return await antigravityBatch(jobs);
    const out: Uint8Array[] = [];
    for (const job of jobs)
      out.push(id === 'gemini' ? await gemini(job) : await openai(job));
    return out;
  } catch (e) {
    throw new Error(explainFailure(id, (e as Error).message));
  }
}

/** Sniff an image's type from its first bytes. */
export function imageMime(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57) return 'image/webp';
  return 'image/png';
}
