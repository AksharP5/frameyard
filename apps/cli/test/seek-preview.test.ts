import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `
    export * from './traits';
    export { createRuntimeWorld } from './world/create-world';
    export { renderSystem } from './systems/render';
    export { setPlayhead } from './actions/playback';
    export { inputSystem } from '../../../apps/web/src/engine/input/input-system';
    export { Keys, Pointer, PointerEvents } from '../../../apps/web/src/engine/traits';
  `, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', logOverride: { 'empty-import-meta': 'silent' },
  plugins: [{ name: 'unused-input-actions', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/history|\.\/cursor|\.\/interactions)$/ }, ({ path, importer }) => {
      if (importer.endsWith('/input/input-system.ts')) return { path, namespace: 'input-action' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'input-action' }, () => ({ contents: `
      export function getEditHistory() { return { beginGesture() {}, endGesture() {} }; }
      export function getToolCursor() { return 'default'; }
      export function updateCursor() {}
      export function handleCanvasInteraction() { throw new Error('Unexpected canvas action'); }
      export function handleGeometryInteraction() { throw new Error('Unexpected geometry action'); }
    ` }));
  } }],
});
const module = { exports: {} as typeof import('../../../packages/runtime/src/traits/index.ts')
  & Pick<typeof import('../../../packages/runtime/src/world/create-world.ts'), 'createRuntimeWorld'>
  & Pick<typeof import('../../../packages/runtime/src/systems/render.ts'), 'renderSystem'>
  & Pick<typeof import('../../../packages/runtime/src/actions/playback.ts'), 'setPlayhead'>
  & Pick<typeof import('../../web/src/engine/input/input-system.ts'), 'inputSystem'>
  & Pick<typeof import('../../web/src/engine/traits.ts'), 'Keys' | 'Pointer' | 'PointerEvents'> };
runInThisContext(`(function(module,exports){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports);
const { createRuntimeWorld, Camera, Root, RenderSurface, Mode, FrameRate, Group, ChildOf, Computed, Playback, VideoDecoderHandle, Hidden, Culled, HitRegions, Keys, Pointer, PointerEvents, inputSystem, renderSystem, setPlayhead } = module.exports;

function fixture() {
  let clears = 0;
  const canvas = { width: 1280, height: 720 } as HTMLCanvasElement;
  const ctx = { clearRect() { clears++; }, setTransform() {}, fillRect() {}, save() {}, restore() {}, transform() {} } as unknown as CanvasRenderingContext2D;
  const world = createRuntimeWorld('seek-preview');
  world.add(Keys, Pointer, PointerEvents);
  world.set(RenderSurface, { canvas, ctx });
  world.set(FrameRate, { value: 60 });
  const root = world.get(Root)!;
  const scene = world.spawn(Group, Computed({ visibility: 1 }), Playback, ChildOf(root));
  const container = world.spawn(Group, Computed({ visibility: 1 }), ChildOf(scene));
  const clip = world.spawn(Group, Computed({ visibility: 1 }), ChildOf(container));
  const decoder = { errored: false, ready: false, toBitmap: () => decoder.ready ? canvas : null, dispose() {} };
  world.spawn(VideoDecoderHandle(decoder as unknown as InstanceType<typeof import('../../../packages/runtime/src/media/video.ts').VideoBuffer>), ChildOf(clip));
  return { world, root, scene, container, clip, canvas, decoder, clears: () => clears, seek: () => setPlayhead(world, scene, 600) };
}

test('a seek retains the previous canvas until incoming video exists, then resumes drawing', () => {
  const f = fixture();
  try {
    assert.equal(renderSystem(f.world), true, 'ordinary rendering does not hold on undecoded media');
    f.seek();
    assert.equal(renderSystem(f.world), false);
    assert.equal(f.clears(), 1, 'seeking must not clear the last picture');
    setPlayhead(f.world, f.scene, 1200);
    assert.equal(renderSystem(f.world), false, 'another seek keeps the picture while decoding');
    f.decoder.ready = true;
    assert.equal(renderSystem(f.world), true);
    assert.equal(f.clears(), 2);
    assert.equal(f.world.get(RenderSurface)?.pendingSeek, null);
  } finally { f.world.destroy(); }
});

test('gaps, failed or hidden video, changed views, and exports release the held preview', () => {
  const changes: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    'timeline gap': f => f.clip.set(Computed, { visibility: 0 }),
    'trimmed ancestor outside its range': f => f.container.set(Computed, { visibility: 0 }),
    'failed video': f => { f.decoder.errored = true; },
    'hidden ancestor': f => f.container.add(Hidden),
    'culled ancestor': f => f.container.add(Culled),
    'camera movement': f => f.root.set(Camera, { e: 20 }),
    'resized canvas': f => { f.canvas.width = 640; },
    'offline capture': f => f.world.set(Mode, { value: 'offline-video' }),
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = fixture();
    try {
      f.seek(); change(f);
      assert.equal(renderSystem(f.world), true, name);
      assert.equal(f.clears(), 1, name);
      assert.equal(f.world.get(RenderSurface)?.pendingSeek, null, name);
    } finally { f.world.destroy(); }
  }
});

test('a seek after input processing preserves clickable targets until the next painted frame', () => {
  const f = fixture();
  let clicks = 0;
  try {
    renderSystem(f.world);
    const regions = f.world.get(HitRegions)!.list;
    const button: typeof regions[number] = {
      target: { kind: 'hud', id: 'play', quad: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }] },
      callback: (_world, event) => { if (event.type === 'click') clicks++; },
    };
    regions.push(button);
    inputSystem(f.world);
    f.seek();
    assert.equal(renderSystem(f.world), false, 'keyboard seeks begin after input processing');
    assert.ok(regions.includes(button), 'the held picture keeps its interaction targets');

    f.world.get(PointerEvents)!.queue.push({ type: 'click', clientX: 10, clientY: 10, button: 0 });
    inputSystem(f.world);
    assert.equal(clicks, 1, 'the first click during a held frame must reach its target');
    assert.equal(renderSystem(f.world), false);

    f.decoder.ready = true;
    assert.equal(renderSystem(f.world), true);
    assert.ok(!regions.includes(button), 'a newly painted frame replaces old targets');
  } finally { f.world.destroy(); }
});
