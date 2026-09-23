import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { createRuntimeWorld, createEntity, appendChild, Root, Cache, Group, Scene, Sequential, Geometry, GeometryType, Size, Position, Trim, Playback, Computed, Paint, PaintType, Color, ChildOf, IsMask, Hidden, Stroke, WorldTransform, getNodeChildren, getNodePaints, playbackSystem, transformSystem } from './index';`,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as Pick<typeof import('../../../packages/runtime/src/index'),
  'createRuntimeWorld' | 'createEntity' | 'appendChild' | 'Root' | 'Cache' | 'Group' | 'Scene' | 'Sequential' | 'Geometry' | 'GeometryType' | 'Size' | 'Position' | 'Trim' | 'Playback' | 'Computed' | 'Paint' | 'PaintType' | 'Color' | 'ChildOf' | 'IsMask' | 'Hidden' | 'Stroke' | 'WorldTransform' | 'getNodeChildren' | 'getNodePaints' | 'playbackSystem' | 'transformSystem'> };
runInThisContext(`(function(module,exports){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports);
const a = module.exports;

function fixture() {
  const world = a.createRuntimeWorld('runtime-traversal');
  const scene = a.createEntity(world);
  scene.add(a.Group, a.Scene, a.Size({ width: 1920, height: 1080 }), a.Playback);
  a.appendChild(world, scene, world.get(a.Root)!);
  return { world, scene };
}

test('playback and transforms reuse maintained hierarchy lists across a thousand clips', (t) => {
  const { world, scene } = fixture();
  t.after(() => world.destroy());
  for (let row = 0; row < 20; row++) {
    const sequence = a.createEntity(world);
    sequence.add(a.Group, a.Sequential);
    a.appendChild(world, sequence, scene);
    for (let column = 0; column < 50; column++) {
      const clip = a.createEntity(world);
      clip.add(a.Geometry, a.Size({ width: 100, height: 100 }), a.Trim({ start: 0, end: 30 }));
      a.appendChild(world, clip, sequence);
      const fill = a.createEntity(world);
      fill.add(a.Paint({ value: a.PaintType.SOLID }), a.Color);
      a.appendChild(world, fill, clip);
    }
  }
  for (const [index, clip] of world.query(a.Geometry).entries()) {
    const start = index % 50 * 30;
    clip.set(a.Computed, { start, end: start + 30, origin: start, duration: 30 });
  }
  a.playbackSystem(world);
  a.transformSystem(world);
  const query = t.mock.method(world, 'query');
  for (const frame of [15, 915, 15]) {
    scene.set(a.Computed, { localTime: frame });
    a.playbackSystem(world);
    a.transformSystem(world);
    assert.equal(world.query(a.Geometry).filter(clip => clip.get(a.Computed)!.visibility === 1).length, 20);
  }
  assert.ok(query.mock.callCount() < 100, `three ticks issued ${query.mock.callCount()} queries`);
});

test('cached walks retain masks, hidden descendants, stroke paints and live reparenting', (t) => {
  const { world, scene } = fixture();
  t.after(() => world.destroy());
  const first = a.createEntity(world);
  first.add(a.Group, a.WorldTransform, a.Size({ width: 300, height: 300 }), a.Position({ x: 100 }));
  a.appendChild(world, first, scene);
  const second = a.createEntity(world);
  second.add(a.Group, a.WorldTransform, a.Size({ width: 300, height: 300 }), a.Position({ x: 200 }));
  a.appendChild(world, second, scene);
  const mask = a.createEntity(world);
  mask.add(a.Geometry, a.IsMask, a.Hidden, a.WorldTransform, a.Position({ x: 5 }), a.Size({ width: 10, height: 10 }));
  a.appendChild(world, mask, first);
  const fill = a.createEntity(world);
  fill.add(a.Paint({ value: a.PaintType.SOLID }));
  a.appendChild(world, fill, mask);
  const stroke = a.createEntity(world);
  stroke.add(a.Stroke, a.Paint({ value: a.PaintType.SOLID }));
  a.appendChild(world, stroke, mask);
  scene.set(a.Computed, { localTime: 12 });
  a.playbackSystem(world);
  a.transformSystem(world);
  assert.equal(mask.get(a.Computed)!.localTime, 12, 'hidden masks retain their local clock');
  assert.equal(mask.get(a.WorldTransform)!.e, first.get(a.WorldTransform)!.e + first.get(a.WorldTransform)!.a * 5, 'masks participate in the transform walk');
  assert.deepEqual(a.getNodePaints(world, mask), [fill, stroke]);
  mask.add(a.ChildOf(second));
  a.transformSystem(world);
  assert.deepEqual(a.getNodeChildren(world, first), []);
  assert.equal(mask.get(a.WorldTransform)!.e, second.get(a.WorldTransform)!.e + second.get(a.WorldTransform)!.a * 5);
  mask.remove(a.IsMask);
  assert.deepEqual(a.getNodeChildren(world, second), [mask]);
  mask.destroy();
  assert.deepEqual(a.getNodeChildren(world, second), []);
});


test('a stage with an incidental Cache still queries its uncached children', (t) => {
  const { world, scene } = fixture();
  t.after(() => world.destroy());
  const stage = world.get(a.Root)!;
  stage.add(a.Cache);
  assert.deepEqual([...a.getNodeChildren(world, stage)], [scene]);
  const fill = a.createEntity(world);
  fill.add(a.Paint);
  a.appendChild(world, fill, stage);
  assert.deepEqual([...a.getNodePaints(world, stage)], [fill]);
});
