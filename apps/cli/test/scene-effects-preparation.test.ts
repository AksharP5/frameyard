import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `
      export { createWorld } from 'koota';
      export * from './traits';
      export { prepareSceneEffects } from './systems/scene-effects';
      export { watchColorScopes } from './media/color-scopes';
    `,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('koota'), 'createWorld'>
  & typeof import('../../../packages/runtime/src/traits')
  & Pick<typeof import('../../../packages/runtime/src/systems/scene-effects'), 'prepareSceneEffects'>
  & Pick<typeof import('../../../packages/runtime/src/media/color-scopes'), 'watchColorScopes'>
};
const canvases: Canvas[] = [];
class Canvas {
  width: number;
  height: number;
  constructor(width = 1, height = 1) { this.width = width; this.height = height; canvases.push(this); }
  getContext() { return {}; }
}
runInThisContext(`(function(module,exports,OffscreenCanvas){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports, Canvas);
const { createWorld, Scene, Geometry, Group, ChildOf, Computed, Hidden, Highlight, Preset,
  LayerMaterial, ColorGrade, SceneEffects, prepareSceneEffects, watchColorScopes } = module.exports;

function fixture() {
  canvases.length = 0;
  const world = createWorld();
  const scene = world.spawn(Scene, Geometry, Computed({ width: 640, height: 360 }));
  const buffers = () => canvases.slice(-2);
  const growBuffers = () => buffers().forEach(canvas => { canvas.width = 640; canvas.height = 360; });
  const assertReleased = (owned: Canvas[]) => assert.deepEqual(owned.map(canvas => [canvas.width, canvas.height]), [[1, 1], [1, 1]]);
  return { world, scene, buffers, growBuffers, assertReleased, prepare: () => prepareSceneEffects(world) };
}

test('ordinary scenes prepare without canvas allocation or Computed snapshots', () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.world.spawn(Geometry, Computed, ChildOf(f.scene));
  const prototype = Object.getPrototypeOf(f.scene) as { get(trait: unknown): unknown };
  const get = prototype.get;
  let snapshots = 0;
  prototype.get = function (trait) {
    if (trait === Computed) snapshots++;
    return get.call(this, trait);
  };
  try {
    for (let frame = 0; frame < 60; frame++) f.prepare();
    assert.equal(canvases.length, 0);
    assert.equal(snapshots, 0, 'preparation reads the needed fields without copying the whole Computed record');
  } finally {
    prototype.get = get;
    f.world.destroy();
  }
});

test('scene effects and scope subscriptions follow live visibility and release unused buffers', () => {
  const f = fixture();
  let unsubscribe: (() => void) | undefined;
  try {
    f.scene.add(ColorGrade);
    f.prepare();
    assert.equal(canvases.length, 2);
    const graded = f.buffers();
    f.growBuffers();
    f.prepare();
    assert.equal(canvases.length, 2, 'an unchanged affected scene retains its buffers');
    f.scene.remove(ColorGrade);
    f.prepare();
    f.assertReleased(graded);

    f.scene.add(SceneEffects);
    f.prepare();
    assert.equal(canvases.length, 4);
    const effected = f.buffers();
    f.growBuffers();
    f.scene.set(Computed, { visibility: 0 });
    f.prepare();
    f.assertReleased(effected);
    f.scene.remove(SceneEffects);
    f.scene.set(Computed, { visibility: 1, bloom: .5 });
    f.prepare();
    assert.equal(canvases.length, 6, 'sampled effects also prepare a scene without an authored effect trait');
    const sampled = f.buffers();
    f.growBuffers();
    f.scene.set(Computed, { bloom: 0 });
    f.prepare();
    f.assertReleased(sampled);

    unsubscribe = watchColorScopes(f.world, f.scene, () => {}, () => {});
    f.prepare();
    assert.equal(canvases.length, 9, 'one readback canvas and two scene buffers serve the visible scope');
    const scoped = f.buffers();
    f.growBuffers();
    f.scene.add(Hidden);
    f.prepare();
    f.assertReleased(scoped);
    f.scene.remove(Hidden);
    f.prepare();
    assert.equal(canvases.length, 11);
    const restored = f.buffers();
    f.growBuffers();
    unsubscribe();
    unsubscribe = undefined;
    f.prepare();
    f.assertReleased(restored);
  } finally {
    unsubscribe?.();
    f.world.destroy();
  }
});

test('descendant effects respect hidden ancestors and live visibility, including optional ancestor Computed', () => {
  const f = fixture();
  try {
    const group = f.world.spawn(Group, Computed, ChildOf(f.scene));
    const effect = f.world.spawn(Geometry, Computed, ChildOf(group));
    for (const trait of [Highlight, Preset, LayerMaterial]) {
      const before = canvases.length;
      effect.add(trait);
      f.prepare();
      assert.equal(canvases.length, before + 2);
      const owned = f.buffers();
      f.growBuffers();
      group.add(Hidden);
      f.prepare();
      f.assertReleased(owned);
      group.remove(Hidden);
      effect.set(Computed, { visibility: 0 });
      f.prepare();
      assert.equal(canvases.length, before + 2);
      effect.set(Computed, { visibility: 1 });
      f.prepare();
      assert.equal(canvases.length, before + 4);
      effect.remove(trait);
      f.prepare();
    }

    effect.set(Computed, { backdropBlur: 8 });
    const before = canvases.length;
    f.prepare();
    assert.equal(canvases.length, before + 2, 'sampled layer material values prepare the containing scene');
    const owned = f.buffers();
    f.growBuffers();
    group.set(Computed, { visibility: 0 });
    f.prepare();
    f.assertReleased(owned);
    group.set(Computed, { visibility: 1 });
    const ancestor = f.world.spawn(Computed({ visibility: 0 }), ChildOf(f.scene));
    ancestor.remove(Computed);
    group.add(ChildOf(ancestor));
    f.prepare();
    assert.equal(canvases.length, before + 4, 'an ancestor without Computed ignores its removed trait store slot');
  } finally { f.world.destroy(); }
});
