import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: {
    contents: `export { createRuntimeWorld } from './world/create-world';
      export { Geometry, Computed, Cache, Chars, TextStyle, FramePromises, Mode } from './traits';
      export { loadGoogleFonts } from './fonts/google';
      export { requestTextFonts } from './fonts/utils';`,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  supported: { 'dynamic-import': false },
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('../../../packages/runtime/src/world/create-world'), 'createRuntimeWorld'>
  & Pick<typeof import('../../../packages/runtime/src/traits'), 'Geometry' | 'Computed' | 'Cache' | 'Chars' | 'TextStyle' | 'FramePromises' | 'Mode'>
  & Pick<typeof import('../../../packages/runtime/src/fonts/google'), 'loadGoogleFonts'>
  & Pick<typeof import('../../../packages/runtime/src/fonts/utils'), 'requestTextFonts'>
};
const subsetLoads: string[] = [];
const textLoads: (string | undefined)[] = [];
class Face {
  family: string;
  source: string;
  style = 'normal';
  weight = '400';
  constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
    this.family = family;
    this.source = source;
    Object.assign(this, descriptors);
  }
  load() { subsetLoads.push(this.source); return Promise.resolve(this); }
}
const faces = new Set<Face>();
const fontSet = {
  add: (face: Face) => faces.add(face),
  [Symbol.iterator]: () => faces.values(),
  load: async (_font: string, text?: string) => { textLoads.push(text); return [...faces]; },
};
const fetchCss = async () => ({ ok: true, text: async () => `
  @font-face { src: url(latin.woff2); font-style: normal; font-weight: 400; unicode-range: U+0-FF; }
  @font-face { src: url(other.woff2); font-style: normal; font-weight: 400; unicode-range: U+100-FFFF; }
` });
class Canvas { getContext() { return {}; } }
runInThisContext(`(function(module,exports,OffscreenCanvas,FontFace,globalThis,fetch){${built.outputFiles[0].text}\n})`)(
  module, module.exports, Canvas, Face, { document: { fonts: fontSet } }, fetchCss,
);
const { createRuntimeWorld, Geometry, Computed, Cache, Chars, TextStyle, FramePromises, Mode, loadGoogleFonts, requestTextFonts } = module.exports;
await loadGoogleFonts();

async function load(mode: 'realtime' | 'offline-video') {
  const world = createRuntimeWorld('font-loading');
  world.set(Mode, { value: mode });
  world.set(FramePromises, { list: [] });
  try {
    const text = world.spawn(Geometry, Computed, Cache, Chars({ value: 'Frameyard' }), TextStyle({ fontFamily: 'Barlow Condensed' }));
    requestTextFonts(world, text);
    await Promise.all(world.get(FramePromises)!.list);
  } finally { world.destroy(); }
}

test('playback loads only requested glyphs; export warms every subset once', async () => {
  await load('realtime');
  assert.deepEqual(textLoads, ['Frameyard']);
  assert.deepEqual(subsetLoads, [], 'realtime must not explicitly download unused subsets');
  await load('offline-video');
  assert.deepEqual(subsetLoads, ['url(latin.woff2)', 'url(other.woff2)']);
  await load('offline-video');
  assert.equal(subsetLoads.length, 2, 'subsequent project exports reuse loaded faces');
});
