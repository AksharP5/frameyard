import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { createWorld } from 'koota';
      export { Geometry, Computed, Cache, Keyframe, KeyframeTrack, Paint, Color, ChildOf, Effect } from './traits';
      export { createRuntimeWorld } from './world/create-world';
      export { motionSystem } from './systems/motion';
    `,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('koota'), 'createWorld'>
  & Pick<typeof import('../../../packages/runtime/src/traits'), 'Geometry' | 'Computed' | 'Cache' | 'Keyframe' | 'KeyframeTrack' | 'Paint' | 'Color' | 'ChildOf' | 'Effect'>
  & Pick<typeof import('../../../packages/runtime/src/world/create-world'), 'createRuntimeWorld'>
  & Pick<typeof import('../../../packages/runtime/src/systems/motion'), 'motionSystem'>
};
runInThisContext(`(function(module,exports){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports);
const { createWorld, Geometry, Computed, Cache, Keyframe, KeyframeTrack, motionSystem, createRuntimeWorld, Paint, Color, ChildOf, Effect } = module.exports;

function fixture(frames: { time: number; value: number; easing?: string }[]) {
  const world = createWorld();
  const node = world.spawn(Geometry, Computed({ visibility: 1 }), Cache);
  const keyframes = frames.map(frame => world.spawn(Keyframe(frame)));
  const track = world.spawn(KeyframeTrack({ property: 'position.x', target: node }), Cache({ keyframes }));
  node.set(Cache, { keyframeTracks: [track] });
  const sample = (frame: number) => {
    node.set(Computed, { localTime: frame });
    motionSystem(world);
    return node.get(Computed)!.positionX;
  };
  return { world, node, track, keyframes, sample };
}

test('dense tracks seek without walking all preceding keyframes', () => {
  const count = 4096;
  const f = fixture(Array.from({ length: count }, (_, i) => ({ time: i * 2, value: i * 10 })));
  let reads = 0;
  f.track.set(Cache, { keyframes: new Proxy(f.keyframes, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  }) });
  try {
    assert.equal(f.sample(8001), 40005);
    assert.ok(reads < 40, `sampling read ${reads} keyframes for one frame`);
    assert.equal(f.sample(1), 5, 'backward seeking does not retain the prior interval');
  } finally { f.world.destroy(); }
});

test('sampling preserves endpoints, duplicate timestamps and outgoing easing', () => {
  const f = fixture([
    { time: 0, value: 0 },
    { time: 10, value: 10 },
    { time: 10, value: 30, easing: 'steps(2)' },
    { time: 20, value: 50 },
  ]);
  try {
    assert.equal(f.sample(-1), 0);
    assert.equal(f.sample(5), 5);
    assert.equal(f.sample(10), 10, 'an exact interior boundary uses the first keyframe at that time');
    assert.equal(f.sample(12), 30, 'the segment after a duplicate uses the final keyframe at that time');
    assert.equal(f.sample(15), 40);
    assert.equal(f.sample(20), 50);
    assert.equal(f.sample(21), 50);
    f.keyframes[2].set(Keyframe, { value: 70 });
    assert.equal(f.sample(12), 70, 'sampling observes edited values without a stale result cache');
  } finally { f.world.destroy(); }
});


for (const removal of ['destroy', 'detach', 'trait'] as const) test(`removing a paint track via ${removal} restores authored color and clears its owner cache`, () => {
  const world = createRuntimeWorld('paint-track-removal');
  try {
    const node = world.spawn(Geometry, Computed({ visibility: 1, localTime: 5 }), Cache);
    const paint = world.spawn(Paint, Color({ value: 0xff0000 }), Computed, Cache, ChildOf(node));
    const track = world.spawn(KeyframeTrack({ property: 'color' }), Computed, Cache, ChildOf(paint));
    world.spawn(Keyframe({ time: 0, value: 0x000000 }), Computed, Cache, ChildOf(track));
    world.spawn(Keyframe({ time: 10, value: 0xffffff }), Computed, Cache, ChildOf(track));
    motionSystem(world);
    assert.equal(paint.get(Computed)!.color, 0x808080);
    if (removal === 'destroy') track.destroy();
    if (removal === 'detach') track.remove(ChildOf(paint));
    if (removal === 'trait') track.remove(KeyframeTrack);
    assert.deepEqual(node.get(Cache)!.keyframeTracks, []);
    assert.equal(paint.get(Computed)!.color, 0xff0000);
    motionSystem(world);
    assert.equal(paint.get(Computed)!.color, 0xff0000);
  } finally { world.destroy(); }
});


test('removing an effect track restores the authored effect amount', () => {
  const world = createRuntimeWorld('effect-track-removal');
  try {
    const node = world.spawn(Geometry, Computed({ visibility: 1, localTime: 5 }), Cache);
    const effect = world.spawn(Effect({ value: 0.25 }), Computed, Cache, ChildOf(node));
    const track = world.spawn(KeyframeTrack({ property: 'effect.value' }), Computed, Cache, ChildOf(effect));
    world.spawn(Keyframe({ time: 0, value: 0 }), Computed, Cache, ChildOf(track));
    world.spawn(Keyframe({ time: 10, value: 1 }), Computed, Cache, ChildOf(track));
    motionSystem(world);
    assert.equal(effect.get(Computed)!.value, 0.5);
    track.destroy();
    assert.equal(effect.get(Computed)!.value, 0.25);
  } finally { world.destroy(); }
});
