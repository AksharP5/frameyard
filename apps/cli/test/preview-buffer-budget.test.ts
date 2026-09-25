import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { AssetLibrary, ImageAsset, SequenceAsset, VideoAsset } from '../../../packages/assets/src/index.ts';

const built = await build({
  stdin: { contents: `
    export { createWorld } from 'koota';
    export { FrameRate, Mode, Time, Library, Root, Group, Computed, Playback, ChildOf, Geometry, Paint, Muted, Hidden, AssetId, FramePromises, ImageDecoderHandle, VideoDecoderHandle } from './traits';
    export { PaintType } from './constants';
    export { playbackSystem } from './systems/playback';
    export { resolveImageDecoder } from './media/image';
  `, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  typeof import('../../../packages/runtime/src/traits/index.ts')
  & Pick<typeof import('koota'), 'createWorld'>
  & Pick<typeof import('../../../packages/runtime/src/constants.ts'), 'PaintType'>
  & Pick<typeof import('../../../packages/runtime/src/systems/playback.ts'), 'playbackSystem'>
  & Pick<typeof import('../../../packages/runtime/src/media/image.ts'), 'resolveImageDecoder'>
};
class Canvas {
  width: number;
  height: number;
  constructor(width: number, height: number) { this.width = width; this.height = height; }
  getContext() { return {}; }
}
runInThisContext(`(function(module,exports,OffscreenCanvas){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, Canvas);
const { createWorld, FrameRate, Mode, Time, Library, Root, Group, Computed, Playback, ChildOf, Geometry, Paint, PaintType, Muted, Hidden, AssetId, FramePromises, ImageDecoderHandle, VideoDecoderHandle, playbackSystem, resolveImageDecoder } = module.exports;

function fixture(fps = 60, clipDuration = fps) {
  const asset: VideoAsset = {
    id: 'recording', path: 'recording.mp4', source: 'recording.mp4', createdAt: '', mimeType: 'video/mp4', type: 'VIDEO',
    duration: 221, width: 1920, height: 1080, frameRate: 60, bitRate: 0,
    // Hold IO so this test measures buffer ownership independently of decoder speed.
    handle: { getFile: () => new Promise<File>(() => {}) },
  };
  const world = createWorld(FrameRate({ value: fps }), Mode({ value: 'realtime' }), Time({ delta: 0 }));
  world.add(Library); world.set(Library, { get: () => asset } as unknown as AssetLibrary);
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Computed({ duration: 221 * clipDuration }), Playback, ChildOf(root));
  const group = world.spawn(Group, Computed({ start: 0, end: 221 * clipDuration, duration: 221 * clipDuration }), ChildOf(scene));
  const clips = Array.from({ length: 221 }, (_, index) => world.spawn(
    Geometry, Paint({ value: PaintType.VIDEO }), Muted, AssetId({ value: asset.id }),
    Computed({ start: index * clipDuration, end: (index + 1) * clipDuration, origin: index * clipDuration, duration: clipDuration }), ChildOf(group),
  ));
  const tick = (frame: number) => { scene.set(Computed, { localTime: frame }); playbackSystem(world); };
  const active = () => clips.flatMap((clip, index) => clip.get(VideoDecoderHandle) ? [index] : []);
  const close = () => { for (const entity of world.query(VideoDecoderHandle)) entity.get(VideoDecoderHandle)?.dispose(); world.destroy(); };
  return { world, scene, group, clips, tick, active, close };
}

function imageFixture(mode: 'realtime' | 'offline-video' = 'realtime', width = 3840, height = 2160) {
  const assets = new Map<string, ImageAsset>();
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: mode }), Time({ delta: 0 }));
  world.add(Library);
  world.set(Library, { get: (id: string) => assets.get(id) } as unknown as AssetLibrary);
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Computed({ duration: 221 }), Playback, ChildOf(root));
  const clips = Array.from({ length: 221 }, (_, index) => {
    const id = `still-${index}`;
    assets.set(id, {
      id, path: `${id}.png`, source: `${id}.png`, createdAt: '', mimeType: 'image/png', type: 'IMAGE',
      width, height,
      handle: { getFile: () => new Promise<File>(() => {}) },
    });
    return world.spawn(
      Geometry, Paint({ value: PaintType.IMAGE }), AssetId({ value: id }),
      Computed({ start: index, end: index + 1, origin: index, duration: 1 }), ChildOf(scene),
    );
  });
  const tick = (frame: number) => { scene.set(Computed, { localTime: frame }); playbackSystem(world); };
  const active = () => clips.flatMap((clip, index) => clip.get(ImageDecoderHandle) ? [index] : []);
  const close = () => { for (const entity of world.query(ImageDecoderHandle)) entity.get(ImageDecoderHandle)?.dispose(); world.destroy(); };
  return { world, scene, clips, assets, tick, active, close };
}

test('image previews keep only visible and nearest upcoming stills decoded', () => {
  const f = imageFixture();
  try {
    for (const frame of [0, 100, 220, 0]) {
      f.tick(frame);
      const expected = frame === 220
        ? Array.from({ length: 8 }, (_, index) => 213 + index)
        : Array.from({ length: 8 }, (_, index) => frame + index);
      assert.deepEqual(f.active(), expected);
    }
    f.clips[0].add(Hidden);
    f.tick(0);
    assert.deepEqual(f.active(), [1, 2, 3, 4, 5, 6, 7, 8], 'hiding a still releases its decoder');
  } finally { f.close(); }
});

test('smaller stills receive more decode lookahead under the same memory budget', () => {
  const f = imageFixture('realtime', 1920, 1080);
  try {
    f.tick(0);
    assert.deepEqual(f.active(), Array.from({ length: 32 }, (_, index) => index));
  } finally { f.close(); }
});

test('leaving a still closes its decoded bitmap', async () => {
  const f = imageFixture();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  let closed = 0;
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width: 3840, height: 2160, close: () => { closed++; } }),
  });
  try {
    for (const index of [0, 1]) {
      f.assets.get(`still-${index}`)!.handle = { getFile: async () => new File([], `still-${index}.png`) };
    }
    f.tick(0);
    await Promise.all([0, 1].map(index => f.clips[index].get(ImageDecoderHandle)!.init()));
    f.tick(100);
    assert.equal(closed, 2);
  } finally {
    f.close();
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  }
});

test('offline image export initializes the visible still without loading the rest of the timeline', () => {
  const f = imageFixture('offline-video');
  try {
    f.tick(100);
    assert.deepEqual(f.active(), [100]);
    f.tick(101);
    assert.deepEqual(f.active(), [101]);
  } finally { f.close(); }
});

test('offline export waits for an image decode that was already in flight', () => {
  const f = imageFixture('offline-video');
  try {
    f.world.add(FramePromises);
    f.world.set(FramePromises, { list: [] });
    const pending = resolveImageDecoder(f.world, f.clips[100])!.initPromise;
    f.tick(100);
    assert.ok(pending);
    assert.ok(f.world.get(FramePromises)?.list?.includes(pending));
  } finally { f.close(); }
});

test('playback buffers until the opening still is decoded', () => {
  const f = imageFixture();
  try {
    f.scene.set(Playback, { playing: true });
    f.tick(0);
    assert.equal(f.scene.get(Playback)?.buffering, true);
    assert.deepEqual(f.active(), [0, 1, 2, 3, 4, 5, 6, 7]);
  } finally { f.close(); }
});

test('preview buffers warm one and a half seconds before cuts at each frame rate and release distant clips', () => {
  for (const fps of [30, 60]) {
    const f = fixture(fps, 2 * fps);
    try {
      for (const index of [0, 100, 220, 0]) {
        const previous = f.clips.flatMap(clip => clip.get(VideoDecoderHandle) ?? []);
        f.tick(index * 2 * fps + fps / 2);
        const expected = [index - 1, index, index + 1].filter(clip => clip >= 0 && clip <= 220);
        assert.deepEqual(f.active(), expected, `${fps}fps: the next clip gets one and a half seconds to decode`);
        assert.ok(f.clips[index].get(VideoDecoderHandle), 'the visible clip must retain its buffer');
        for (const decoder of previous) assert.equal('mode' in decoder && decoder.mode, 'discarded', 'distant buffers must release their canvases and decoder');
      }
      f.tick(2 * fps);
      assert.deepEqual(f.active(), [0, 1], 'both sides of a cut remain warm');
    } finally { f.close(); }
  }
});

test('dense one-frame cuts keep warmup bounded and prioritize the next clips', () => {
  const f = fixture(60, 1);
  try {
    for (const frame of [0, 100, 220, 0]) {
      f.tick(frame);
      assert.deepEqual(f.active(), frame === 220 ? [218, 219, 220] : [frame, frame + 1, frame + 2]);
    }
  } finally { f.close(); }
});

test('playback seeks visible and warmup decoders without a frame-promise collector', () => {
  const f = fixture();
  try {
    f.tick(0);
    const seeks: number[] = [];
    for (const index of [0, 1]) {
      const decoder = f.clips[index].get(VideoDecoderHandle)!;
      decoder.seekTo = () => { seeks.push(index); return Promise.resolve(); };
    }
    f.tick(1);
    assert.deepEqual(seeks, [0, 1]);
  } finally { f.close(); }
});

test('visible layers remain available beyond the speculative warmup limit', () => {
  const f = fixture(60, 1);
  try {
    for (const clip of f.clips.slice(0, 6)) clip.set(Computed, { start: 0, end: 60, duration: 60 });
    f.tick(30);
    assert.deepEqual(f.active(), [0, 1, 2, 3, 4, 5, 30, 31, 32]);
  } finally { f.close(); }
});

test('hiding a scene, group or video fill releases its existing decoder and restores it when shown', () => {
  const f = fixture();
  const fill = f.world.spawn(Paint({ value: PaintType.VIDEO }), AssetId({ value: 'recording' }), ChildOf(f.clips[0]));
  try {
    f.tick(0);
    const original = fill.get(VideoDecoderHandle)!;
    assert.ok(original);
    fill.add(Hidden);
    f.tick(0);
    assert.equal(fill.get(VideoDecoderHandle), null);
    assert.equal('mode' in original && original.mode, 'discarded');
    fill.remove(Hidden);
    f.tick(0);
    assert.ok(fill.get(VideoDecoderHandle));
    for (const container of [f.group, f.scene]) {
      container.add(Hidden);
      f.tick(0);
      assert.deepEqual(f.active(), []);
      assert.equal(fill.get(VideoDecoderHandle), null);
      container.remove(Hidden);
      f.tick(0);
      assert.deepEqual(f.active(), [0, 1]);
      assert.ok(fill.get(VideoDecoderHandle));
    }
  } finally { f.close(); }
});


test('startup waits for prepared video but a failed decoder cannot block it forever', () => {
  for (const failed of [false, true]) {
    const f = fixture();
    try {
      f.scene.set(Playback, { playing: true });
      f.tick(0);
      assert.equal(f.scene.get(Playback)?.buffering, true, 'even muted video must prepare its first picture');
      const decoder = f.clips[0].get(VideoDecoderHandle)!;
      if (failed) decoder.errored = true;
      else {
        assert.ok('prepareForPlayback' in decoder);
        decoder.prepareForPlayback = () => true;
      }
      f.tick(0);
      assert.equal(f.scene.get(Playback)?.buffering, false);
      assert.equal(f.scene.get(Playback)?.playing, true);
    } finally { f.close(); }
  }
});

test('a retained paused picture cannot start playback before its idle decoder refills', () => {
  const f = fixture();
  try {
    f.tick(0);
    const decoder = f.clips[0].get(VideoDecoderHandle)!;
    assert.ok('canvas' in decoder);
    decoder.canvas.width = 2;
    decoder.canvas.height = 2;
    decoder.idle();
    assert.ok(decoder.toBitmap(), 'idling preserves the paused picture');
    f.scene.set(Playback, { playing: true });
    f.tick(0);
    assert.equal(f.scene.get(Playback)?.buffering, true, 'a retained canvas does not mean forward frames are ready');
  } finally { f.close(); }
});

test('a sequence initialization failure releases startup buffering', async () => {
  const f = fixture();
  const sequence: SequenceAsset = {
    id: 'recording', path: 'missing.frames', source: 'missing.frames', createdAt: '', mimeType: 'image/png', type: 'SEQUENCE',
    duration: 2, width: 2, height: 2, frameRate: 30,
    handle: { getFile: async () => new File([], 'frame.png') },
    directoryHandle: { async *entries() { throw new Error('directory missing'); } },
  };
  f.world.set(Library, { get: () => sequence } as unknown as AssetLibrary);
  try {
    f.scene.set(Playback, { playing: true });
    f.tick(0);
    assert.equal(f.scene.get(Playback)?.buffering, true);
    const decoder = f.clips[0].get(VideoDecoderHandle)!;
    await decoder.initialized;
    assert.equal(decoder.errored, true);
    f.tick(0);
    assert.equal(f.scene.get(Playback)?.buffering, false);
    assert.equal(f.scene.get(Playback)?.playing, true);
  } finally { f.close(); }
});
