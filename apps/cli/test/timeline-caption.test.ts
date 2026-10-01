import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { Asset, Transcript } from '@diffusionstudio/assets';
import type { TimelineSurfaceState } from '../../web/src/engine/timeline/surface.ts';

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld, FrameRate, Computed, Timeline, AssetId, CaptionDecoderHandle, ClassicCaptionDecoder } from '@diffusionstudio/runtime';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export { renderCaption } from './render/caption';
    `,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/timeline/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  tsconfig: fileURLToPath(new URL('../../web/tsconfig.app.json', import.meta.url)),
  logOverride: { 'empty-import-meta': 'silent' },
});
type Runtime = Pick<typeof import('@diffusionstudio/runtime'), 'createRuntimeWorld' | 'FrameRate' | 'Computed' | 'Timeline' | 'AssetId' | 'CaptionDecoderHandle' | 'ClassicCaptionDecoder'>;
const module = { exports: {} as Runtime
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>
  & typeof import('../../web/src/engine/timeline/render/caption.ts') };
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,DOMMatrix,document){${built.outputFiles[0].text}\n})`)(
  module, module.exports, Element, Element, Element, Element, { fonts: { addEventListener() {} } },
);
const { createRuntimeWorld, createRuntimeDocument, FrameRate, Computed, Timeline, AssetId, CaptionDecoderHandle, ClassicCaptionDecoder, renderCaption } = module.exports;

async function fixture(transcript: Transcript, props: Record<string, number> = {}) {
  const world = createRuntimeWorld('timeline-caption');
  world.set(FrameRate, { value: 30 });
  const document = createRuntimeDocument(world);
  const scene = document.createElement('Scene');
  document.insertNode(document.stage, scene);
  scene.entity.add(Timeline);
  scene.entity.set(Timeline, { resolution: 2, scrollX: 0 });
  const clip = document.createElement('Captions');
  for (const [key, value] of Object.entries({ sourceOut: 3600, ...props })) document.setProperty(clip, key, value);
  document.insertNode(scene, clip);
  const asset: Asset = {
    type: 'TRANSCRIPT', id: 'words', path: 'words.json', source: 'assets/words.json',
    mimeType: 'application/json', createdAt: '',
    handle: { getFile: async () => new File([JSON.stringify(transcript)], 'words.json') },
  };
  const decoder = new ClassicCaptionDecoder(asset);
  await decoder.initialized;
  decoder.styled = true;
  clip.entity.add(AssetId);
  clip.entity.set(AssetId, { value: asset.id });
  clip.entity.add(CaptionDecoderHandle);
  clip.entity.set(CaptionDecoderHandle, decoder);
  const boxes: { x: number; width: number }[] = [];
  const labels: string[] = [];
  let box = { x: 0, width: 0 };
  const ctx = {
    save() {}, restore() {}, beginPath() {}, clip() {},
    roundRect(x: number, _y: number, width: number) { box = { x, width }; },
    fill() { boxes.push(box); }, fillText(text: string) { labels.push(text); },
    measureText(text: string) { return { width: text.length * 5 }; },
  };
  const surface = { ctx, layout: { width: 600 } } as unknown as TimelineSurfaceState;
  return {
    scene, clip, surface, boxes, labels,
    draw() { boxes.length = labels.length = 0; renderCaption(world, scene.entity, surface, clip.entity, { top: 0, height: 40 }); },
    dispose() { decoder.dispose(); world.destroy(); },
  };
}

test('a long caption clip only paints visible phrases and preserves partially visible positions', async () => {
  const transcript = Array.from({ length: 3600 }, (_, i) => ({
    text: `cue${i}`, words: [{ text: `cue${i}`, start: i, end: i + 0.8 }],
  }));
  const f = await fixture(transcript);
  try {
    f.scene.entity.set(Timeline, { scrollX: 30_015 });
    f.draw();
    assert.equal(f.boxes.length, 11);
    assert.deepEqual(f.labels, transcript.slice(1000, 1011).map(segment => segment.text));
    assert.deepEqual(f.boxes[0], { x: 60_000, width: 46 }, 'scrolling clips the original phrase without moving its label');
  } finally { f.dispose(); }
});

test('caption blocks follow trimmed source timing at both faster and slower playback speeds', async () => {
  for (const playbackRate of [0.5, 2]) {
    const f = await fixture([{ text: 'now', words: [{ text: 'now', start: 2, end: 3 }] }], {
      start: 5, sourceIn: 2, sourceOut: 4, playbackRate,
    });
    try {
      const computed = f.clip.entity.get(Computed)!;
      assert.equal(computed.start, 150);
      f.draw();
      assert.deepEqual(f.labels, ['now']);
      assert.deepEqual(f.boxes, [{ x: 300, width: 60 / playbackRate - 2 }]);
    } finally { f.dispose(); }
  }
});
