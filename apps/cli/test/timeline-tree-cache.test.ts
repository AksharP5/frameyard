import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const compiled = await build({
  stdin: {
    contents: `
      export { createWorld } from 'koota';
      export { ChildOf, Geometry, Group, Sequential, Expanded, ItemIndex, KeyframeTrack, Keyframe, Paint, IsMask, Selected, Computed } from './packages/runtime/src/traits';
      export { buildTimelineLayers } from './packages/runtime/src/queries/timeline-index';
    `,
    resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', logOverride: { 'empty-import-meta': 'silent' },
});

type API = Pick<typeof import('koota'), 'createWorld'>
  & Pick<typeof import('@diffusionstudio/runtime'), 'ChildOf' | 'Geometry' | 'Group' | 'Sequential' | 'Expanded' | 'ItemIndex' | 'KeyframeTrack' | 'Keyframe' | 'Paint' | 'IsMask' | 'Selected' | 'Computed' | 'buildTimelineLayers'>;
const module = { exports: {} as API };
runInThisContext(`(function(module,exports){"use strict";${compiled.outputFiles[0].text}\n})`)(module, module.exports);
const a = module.exports;

test('unchanged timeline reads do no hierarchy queries during playback or selection', (t) => {
  const world = a.createWorld();
  t.after(() => world.destroy());
  const scene = world.spawn();
  const sequence = world.spawn(a.Group, a.Sequential, a.Expanded, a.ChildOf(scene));
  for (let i = 0; i < 1000; i++) {
    const clip = world.spawn(a.Geometry, a.ItemIndex({ value: i }), a.ChildOf(sequence));
    world.spawn(a.Paint, a.ChildOf(clip));
  }
  const tree = a.buildTimelineLayers(world, scene);
  const query = t.mock.method(world, 'query');
  scene.add(a.Computed);
  for (let frame = 0; frame < 120; frame++) {
    scene.set(a.Computed, { localTime: frame });
    scene.add(a.Selected);
    scene.remove(a.Selected);
    assert.equal(a.buildTimelineLayers(world, scene), tree);
  }
  assert.equal(query.mock.callCount(), 0);
});

test('timeline trees follow reorder, expansion, reparenting, type changes, and deletion', (t) => {
  const world = a.createWorld();
  t.after(() => world.destroy());
  const first = world.spawn();
  const second = world.spawn();
  const group = world.spawn(a.Group, a.ItemIndex({ value: 0 }), a.ChildOf(first));
  const clip = world.spawn(a.Geometry, a.ItemIndex({ value: 1 }), a.ChildOf(first));
  const nested = world.spawn(a.Geometry, a.ChildOf(group));
  const layers = (scene = first) => a.buildTimelineLayers(world, scene);
  assert.deepEqual(layers().map((node) => node.entity), [clip, group]);
  assert.equal(layers()[1].expandable, true);
  assert.deepEqual(layers()[1].children, []);
  group.set(a.ItemIndex, { value: 2 });
  assert.deepEqual(layers().map((node) => node.entity), [group, clip]);
  group.add(a.Expanded);
  assert.equal(layers()[0].children[0].entity, nested);
  nested.add(a.ChildOf(second));
  assert.equal(layers()[0].expandable, false);
  assert.equal(layers(second)[0].entity, nested);
  group.add(a.IsMask);
  assert.deepEqual(layers().map((node) => node.entity), [clip, group]);
  clip.remove(a.Geometry);
  assert.deepEqual(layers().map((node) => node.entity), [group]);
  nested.destroy();
  assert.deepEqual(layers(second), []);
});

test('sequences update their rows when keyframe tracks appear or disappear', (t) => {
  const world = a.createWorld();
  t.after(() => world.destroy());
  const sequence = world.spawn(a.Group, a.Sequential);
  const clip = world.spawn(a.Geometry, a.Expanded, a.ChildOf(sequence));
  const fill = world.spawn(a.Paint, a.Expanded, a.ChildOf(clip));
  assert.deepEqual(a.buildTimelineLayers(world, sequence), []);
  const track = world.spawn(a.KeyframeTrack, a.ChildOf(fill));
  assert.equal(a.buildTimelineLayers(world, sequence)[0].children[0].children[0].entity, track);
  track.destroy();
  assert.deepEqual(a.buildTimelineLayers(world, sequence), []);
  sequence.remove(a.Sequential);
  assert.equal(a.buildTimelineLayers(world, sequence)[0].entity, clip);
  clip.add(a.Keyframe);
  assert.deepEqual(a.buildTimelineLayers(world, sequence), []);
});
