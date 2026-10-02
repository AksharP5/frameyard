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
      export { prepareSceneEffects, renderWithSceneEffects, snapshotScene } from './systems/scene-effects';
    `,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('koota'), 'createWorld'>
  & typeof import('../../../packages/runtime/src/traits')
  & Pick<typeof import('../../../packages/runtime/src/systems/scene-effects'), 'prepareSceneEffects' | 'renderWithSceneEffects' | 'snapshotScene'>
};
class Matrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  multiply() { return this; }
  inverse() { return this; }
}
const canvases: Canvas[] = [];
class Canvas {
  width: number;
  height: number;
  clears = 0;
  copies: Canvas[] = [];
  transforms: number[][] = [];
  ctx = {
    save() {}, restore() {}, transform() {}, getTransform: () => new Matrix(),
    setTransform: (...values: number[]) => { this.transforms.push(values); },
    clearRect: () => { this.clears++; },
    drawImage: (source: Canvas) => { this.copies.push(source); },
  };
  constructor(width = 1, height = 1) { this.width = width; this.height = height; canvases.push(this); }
  getContext() { return this.ctx; }
}
runInThisContext(`(function(module,exports,OffscreenCanvas,DOMMatrix){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports, Canvas, Matrix);
const { createWorld, Scene, Geometry, Computed, ColorGrade, LocalTransform, Mode, RenderSurface,
  prepareSceneEffects, renderWithSceneEffects, snapshotScene } = module.exports;

function fixture() {
  canvases.length = 0;
  const output = new Canvas(640, 360);
  const world = createWorld(Mode({ value: 'offline-video' }), RenderSurface({
    canvas: output as unknown as OffscreenCanvas,
    ctx: output.ctx as unknown as OffscreenCanvasRenderingContext2D,
    resolution: 1,
  }));
  const scene = world.spawn(Scene, Geometry, ColorGrade, Computed({ width: 320, height: 180 }), LocalTransform);
  prepareSceneEffects(world);
  const [sceneCanvas, source] = canvases.slice(1);
  return { world, scene, sceneCanvas, source, render: (draw = () => {}) => renderWithSceneEffects(world, scene, draw) };
}

test('scene grading retains no full-sized underlay until an effect samples it', () => {
  const f = fixture();
  try {
    for (let frame = 0; frame < 60; frame++) f.render();
    assert.deepEqual([f.source.width, f.source.height], [1, 1]);
    assert.equal(f.source.clears, 0);
    assert.equal(f.source.copies.length, 0);
    assert.equal(f.sceneCanvas.clears, 60);
  } finally { f.world.destroy(); }
});

test('each layer boundary refreshes the reused underlay exactly once', () => {
  const f = fixture();
  try {
    for (let frame = 0; frame < 60; frame++) f.render(() => {
      for (let layer = 0; layer < 2; layer++) {
        assert.equal(snapshotScene(f.world)?.canvas, f.source);
      }
    });
    assert.deepEqual([f.source.width, f.source.height], [320, 180]);
    assert.equal(f.source.clears, 120);
    assert.equal(f.source.copies.length, 120);
    assert.ok(f.source.copies.every(canvas => canvas === f.sceneCanvas));
    assert.ok(f.source.transforms.every(values => values.join(',') === '1,0,0,1,0,0'));
    assert.equal(snapshotScene(f.world), undefined);
  } finally { f.world.destroy(); }
});

test('underlays follow scene resolution on sampling and release oversized backing pixels on resize', () => {
  const f = fixture();
  const sample = () => { snapshotScene(f.world); };
  const size = () => [f.source.width, f.source.height];
  try {
    f.render(sample);
    f.world.set(RenderSurface, { resolution: 2 });
    f.render();
    assert.deepEqual(size(), [320, 180], 'an unused underlay does not grow with the scene');
    f.render(sample);
    assert.deepEqual(size(), [640, 360]);
    f.scene.set(Computed, { width: 80, height: 45 });
    f.render();
    assert.deepEqual(size(), [160, 90], 'a previously sampled underlay never exceeds the current scene');
    f.world.set(RenderSurface, { resolution: .5 });
    f.render(sample);
    assert.deepEqual(size(), [40, 23]);
    f.scene.set(Computed, { width: 321, height: 181 });
    f.render(sample);
    assert.deepEqual(size(), [161, 91]);
    assert.equal(f.source.clears, 4, 'only actual snapshots clear the underlay');
    assert.equal(f.source.copies.length, 4);
  } finally { f.world.destroy(); }
});
