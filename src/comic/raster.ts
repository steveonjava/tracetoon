/**
 * SVG → PNG with resvg compiled to WebAssembly: no native modules, works in Bun,
 * Node and the compiled binary. The .wasm file and fonts ship in the skill's
 * `assets/` folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { assetsDir } from '../util/assets.ts';

export { assetsDir };

let ready: Promise<void> | undefined;

async function init(dir: string): Promise<void> {
  ready ??= initWasm(readFileSync(join(dir, 'resvg.wasm'))).catch((e: Error) => {
    // initWasm may only run once per process; a second call is harmless.
    if (!/already/i.test(e.message)) throw e;
  });
  return ready;
}

export async function svgToPng(svg: string, width?: number): Promise<Uint8Array> {
  const dir = assetsDir();
  if (!dir)
    throw new Error(
      'Rendering assets (resvg.wasm, fonts) not found; set TRACETOON_ASSETS.',
    );
  await init(dir);
  const fonts = ['ComicNeue_700Bold.ttf', 'ComicNeue_400Regular.ttf']
    .map((f) => join(dir, 'fonts', f))
    .filter(existsSync)
    .map((p) => new Uint8Array(readFileSync(p)));
  const r = new Resvg(svg, {
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
    font: { fontBuffers: fonts, defaultFontFamily: 'Comic Neue', loadSystemFonts: false },
  });
  return r.render().asPng();
}
