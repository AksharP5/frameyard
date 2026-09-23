import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `
    export { PreviewControls } from './components/canvas/preview-controls';
    export { createWorld } from 'koota';
    export { Active, AudioPlayback, ChildOf, Computed, Culled, FrameRate, Geometry, Group, Hidden, Playback, VideoBuffer, VideoDecoderHandle } from '@diffusionstudio/runtime';
  `, resolveDir: fileURLToPath(new URL('../../web/src/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view',
  logOverride: { 'empty-import-meta': 'silent' },
  plugins: [{ name: 'preview-controls-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(solid-js|@diffusionstudio\/koota-solid|@\/|somoto)/ }, ({ path }) => ({ path, external: true }));
  } }],
});
type Runtime = Pick<typeof import('../../../packages/runtime/src/index.ts'), 'Active' | 'AudioPlayback' | 'ChildOf' | 'Computed' | 'Culled' | 'FrameRate' | 'Geometry' | 'Group' | 'Hidden' | 'Playback' | 'VideoBuffer' | 'VideoDecoderHandle'>
  & Pick<typeof import('koota'), 'createWorld'>
  & typeof import('../../web/src/components/canvas/preview-controls.tsx');

let tick = () => {};
let stats: { fps: number; skipped: number; late: boolean } | undefined;
let now = 1000;
let world: ReturnType<Runtime['createWorld']>;
const dependencies: Record<string, unknown> = {
  'solid-js': {
    createEffect: (effect: () => void) => { tick = effect; },
    untrack: (read: () => void) => read(),
    createSignal: (initial: unknown) => {
      let value = initial;
      return [() => value, (next: typeof stats) => { value = next; if (initial === undefined) stats = next; }];
    },
  },
  '@diffusionstudio/koota-solid': { useWorld: () => world },
  '@/engine': { useEngineContext: () => ({ frame() {} }) },
  '@/engine/project-config': { useProjectConfig: () => () => undefined },
};
const module = { exports: {} as Runtime };
runInThisContext(`(function(require,module,exports,view,performance){"use strict";${built.outputFiles[0].text}\n})`)(
  (name: string) => dependencies[name] ?? {}, module, module.exports, () => {}, { now: () => now },
);
const runtime = module.exports;

function fixture() {
  stats = undefined; now = 1000;
  world = runtime.createWorld(runtime.FrameRate({ value: 30 }));
  const scene = world.spawn(runtime.Group, runtime.Active, runtime.Playback({ playing: true }), runtime.AudioPlayback({ wasPlaying: true }), runtime.Computed);
  runtime.PreviewControls();
  return { ...runtime, world, scene, stats: () => stats, sample(frame: number, elapsed = 1000 / 30) {
    now += elapsed;
    scene.set(runtime.Computed, { localTime: frame });
    tick();
  } };
}

test('short loops, seeks and buffering restart the cadence sample without counting intentional jumps', () => {
  const f = fixture();
  try {
    for (let frame = 0; frame < 30; frame++) f.sample(frame);
    assert.equal(f.stats()?.skipped, 0);
    f.scene.set(f.Playback, { buffering: true });
    f.sample(0);
    assert.equal(f.stats(), undefined, 'a short loop entering buffering must not retain a false skipped count');
    f.scene.set(f.Playback, { buffering: false });
    f.scene.set(f.AudioPlayback, { contextOffsetInSeconds: 2 });
    for (let frame = 0; frame < 20; frame++) f.sample(frame);
    assert.equal(f.stats()?.skipped, 0);
    f.scene.set(f.AudioPlayback, { contextOffsetInSeconds: 3, timelineOffsetInSeconds: 1.2 });
    f.sample(36);
    assert.equal(f.stats(), undefined, 'a forward seek smaller than two seconds starts a new cadence sample');
    for (let frame = 37; frame < 60; frame++) f.sample(frame);
    assert.equal(f.stats()?.skipped, 0);
    f.sample(63, 4000 / 30);
    for (let frame = 64; frame < 82; frame++) f.sample(frame);
    assert.equal(f.stats()?.skipped, 3, 'a real uninterrupted four-frame advance still reports the three missing frames');
  } finally { f.world.destroy(); }
});

test('reverse and accelerated shuttle playback do not report intentional skipped frames', () => {
  const f = fixture();
  try {
    for (const speed of [-1, 2, 4]) {
      f.scene.set(f.Playback, { speed });
      for (let tick = 0; tick < 20; tick++) f.sample(120 + tick * speed);
      assert.equal(f.stats(), undefined, `${speed}x shuttle is outside normal playback cadence`);
    }
    f.scene.set(f.Playback, { speed: 1 });
    for (let frame = 120; frame < 140; frame++) f.sample(frame);
    assert.equal(f.stats()?.skipped, 0);
  } finally { f.world.destroy(); }
});

test('only visible video in the active scene can report decoding late', () => {
  const f = fixture();
  const decoder = Object.create(f.VideoBuffer.prototype) as InstanceType<typeof f.VideoBuffer>;
  let covering: number | undefined;
  Object.defineProperty(decoder, 'pendingFrame', { value: 10 });
  Object.defineProperty(decoder, 'cache', { value: { findCovering: () => covering } });
  decoder.renderedFrame = 0;
  const group = f.world.spawn(f.Group, f.Computed, f.ChildOf(f.scene));
  const clip = f.world.spawn(f.Geometry, f.Computed({ visibility: 0 }), f.VideoDecoderHandle(decoder), f.ChildOf(group));
  let frame = 0;
  const sample = () => { for (let count = 0; count < 20; count++) f.sample(frame++); };
  try {
    sample();
    assert.equal(f.stats()?.late, false, 'a hidden clip cannot inherit its visible parent status');
    clip.set(f.Computed, { visibility: 1 });
    sample();
    assert.equal(f.stats()?.late, true);
    covering = 0; sample();
    assert.equal(f.stats()?.late, false, 'a picture covering several project frames is ready, even when its start is earlier');
    covering = undefined;
    for (const trait of [f.Hidden, f.Culled]) {
      group.add(trait); sample();
      assert.equal(f.stats()?.late, false, 'hidden or culled ancestors hide their video');
      group.remove(trait);
    }
    clip.remove(f.VideoDecoderHandle);
    const fill = f.world.spawn(f.VideoDecoderHandle(decoder), f.ChildOf(clip));
    sample();
    assert.equal(f.stats()?.late, true, 'video fills use their owning clip visibility');
    fill.add(f.Hidden); sample();
    assert.equal(f.stats()?.late, false);
    fill.remove(f.Hidden);
    group.remove(f.ChildOf(f.scene)); sample();
    assert.equal(f.stats()?.late, false, 'other scenes cannot flag the active scene as late');
  } finally { f.world.destroy(); }
});
