import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: {
    contents: `export { createRuntimeWorld } from './world/create-world';
      export { Geometry, Computed, Cache, Chars, TextStyle, FramePromises, Mode } from './traits';
      export { FontStyle } from './constants';
      export { loadGoogleFonts } from './fonts/google';
      export { requestTextFonts } from './fonts/utils';`,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  supported: { 'dynamic-import': false },
  logOverride: { 'empty-import-meta': 'silent' },
});
type Runtime =
  Pick<typeof import('../../../packages/runtime/src/world/create-world'), 'createRuntimeWorld'>
  & Pick<typeof import('../../../packages/runtime/src/traits'), 'Geometry' | 'Computed' | 'Cache' | 'Chars' | 'TextStyle' | 'FramePromises' | 'Mode'>
  & Pick<typeof import('../../../packages/runtime/src/constants'), 'FontStyle'>
  & Pick<typeof import('../../../packages/runtime/src/fonts/google'), 'loadGoogleFonts'>
  & Pick<typeof import('../../../packages/runtime/src/fonts/utils'), 'requestTextFonts'>;

function fixture() {
  const module = { exports: {} as Runtime };
  const subsetLoads: string[] = [];
  const textLoads: (string | undefined)[] = [];
  class Face {
    family: string;
    source: string;
    style = 'normal';
    weight = '400';
    stretch = 'normal';
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
    // A missing weight/style resolves to the regular face, as a browser does
    // for a family with only upright 400 and 200. Return its requested subset.
    load: async (_font: string, text?: string) => {
      textLoads.push(text);
      const sample = text ?? ' ';
      return [...faces].filter(face => face.weight === '400' && (
        face.source.includes('latin') ? /[\u0000-\u00ff]/.test(sample) : /[\u0400-\u04ff]/.test(sample)
      ));
    },
  };
  const fetchCss = async () => ({ ok: true, text: async () => `
    @font-face { src: url(latin.woff2); font-style: normal; font-weight: 400; unicode-range: U+0-FF; }
    @font-face { src: url(other.woff2); font-style: normal; font-weight: 400; unicode-range: U+400-4FF; }
    @font-face { src: url(unused-weight.woff2); font-style: normal; font-weight: 200; unicode-range: U+0-FFFF; }
  ` });
  class Canvas { getContext() { return {}; } }
  runInThisContext(`(function(module,exports,OffscreenCanvas,FontFace,globalThis,fetch){${built.outputFiles[0].text}\n})`)(
    module, module.exports, Canvas, Face, { document: { fonts: fontSet } }, fetchCss,
  );
  const { createRuntimeWorld, Geometry, Computed, Cache, Chars, TextStyle, FramePromises, Mode, loadGoogleFonts, requestTextFonts, FontStyle } = module.exports;

  async function load(mode: 'realtime' | 'offline-video', weight = '400', style = FontStyle.NORMAL, chars = 'Frameyard') {
    await loadGoogleFonts();
    const world = createRuntimeWorld('font-loading');
    world.set(Mode, { value: mode });
    if (mode !== 'realtime') world.set(FramePromises, { list: [] });
    try {
      const text = world.spawn(Geometry, Computed, Cache, Chars({ value: chars }), TextStyle({ fontFamily: 'Barlow Condensed', fontWeight: weight, fontStyle: style }));
      requestTextFonts(world, text);
      const pending = world.get(FramePromises)?.list;
      if (pending) await Promise.all(pending);
      else await new Promise(resolve => setImmediate(resolve));
    } finally { world.destroy(); }
  }
  return { load, FontStyle, subsetLoads, textLoads };
}

test('playback loads requested glyphs; export warms every subset once', async () => {
  const { load, subsetLoads, textLoads } = fixture();
  await load('realtime');
  assert.deepEqual(textLoads, ['Frameyard']);
  assert.deepEqual(subsetLoads, [], 'realtime does not explicitly download unused subsets');
  await load('offline-video');
  assert.deepEqual(subsetLoads, ['url(latin.woff2)', 'url(other.woff2)']);
  await load('offline-video');
  assert.equal(subsetLoads.length, 2, 'subsequent project exports reuse loaded faces');
});

test('export warms the resolved face for synthesized weights and styles', async () => {
  for (const synthetic of ['weight', 'style'] as const) {
    const { load, FontStyle, subsetLoads } = fixture();
    const weight = synthetic === 'weight' ? '700' : '400';
    const style = synthetic === 'style' ? FontStyle.ITALIC : FontStyle.NORMAL;
    await load('offline-video', weight, style, '中文');
    assert.deepEqual(subsetLoads, ['url(latin.woff2)', 'url(other.woff2)'], 'future frame subsets load without unrelated weights');
    await load('offline-video', weight, style, 'Привет');
    assert.equal(subsetLoads.length, 2, 'later captions reuse every warmed subset');
  }
});
