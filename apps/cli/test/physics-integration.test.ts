import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `
    export * as runtime from '@diffusionstudio/runtime';
    export { createRuntimeDocument, authoredTree } from '@diffusionstudio/reconciler';
    export { SOURCE_ATTR } from '@diffusionstudio/jsx';
    export { getDocumentEditor } from './apps/web/src/engine/editor';
    export { getEditHistory } from './apps/web/src/engine/history';
    export { transformPoint3D } from './packages/runtime/src/math/spatial';
  `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'], logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as { runtime: typeof import('@diffusionstudio/runtime') }
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument' | 'authoredTree'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../../packages/runtime/src/math/spatial'), 'transformPoint3D'> };
class Element {}
runInThisContext(`(function(module,exports,require,HTMLCanvasElement,HTMLElement,Element){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, createRequire(import.meta.url), Element, Element, Element);
const { runtime: api, createRuntimeDocument, SOURCE_ATTR, getDocumentEditor, getEditHistory, authoredTree, transformPoint3D } = module.exports;

function fixture(fps = 30) {
  const world = api.createRuntimeWorld('physics-integration');
  world.set(api.FrameRate, { value: fps });
  const document = createRuntimeDocument(world);
  let id = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `physics.tsx:${++id}`);
    for (const [name, value] of Object.entries(props)) document.setProperty(node, name, value);
    document.insertNode(parent, node);
    return node;
  };
  const scene = add('Scene', { width: 800, height: 600, end: 6, physics: true });
  const sample = (seconds: number) => {
    api.setPlayhead(world, scene.entity, seconds * fps);
    api.playbackSystem(world); api.motionSystem(world); api.transformSystem(world);
  };
  return { world, document, add, scene, sample };
}

function close(actual: number, expected: number, tolerance = 0.001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('capture waits for physics before its first exported frame and repeated transforms cannot advance time', async t => {
  const f = fixture();
  t.after(() => f.world.destroy());
  const body = f.add('Rect', { width: 20, height: 20, x: 30, y: 0, end: 6, rigidBody: true }, f.scene);
  f.world.set(api.FramePromises, { list: [] });
  api.setPlayhead(f.world, f.scene.entity, 15);
  api.playbackSystem(f.world);
  const pending = f.world.get(api.FramePromises)!.list!;
  assert.ok(pending.length > 0, 'physics readiness joins the encoder barrier during playback');
  await Promise.all(pending);
  api.motionSystem(f.world); api.transformSystem(f.world);
  const first = body.entity.get(api.Computed)!;
  close(first.positionX, 30);
  close(first.positionY, 122.5, 1.1);
  api.transformSystem(f.world); api.transformSystem(f.world);
  assert.equal(body.entity.get(api.Computed)!.positionY, first.positionY);
  assert.equal(body.props.y, 0);
  assert.equal(body.entity.get(api.Position)!.y, 0);
});

test('tilted native bodies retain their initial matrix under static rotated parents and gravity stays in scene space', t => {
  const f = fixture();
  t.after(() => f.world.destroy());
  const scene = f.add('Scene3d', { width: 800, height: 600, end: 6, physics: true }, f.scene);
  const group = f.add('Group', { x: 100, y: 120, z: 30, width: 400, height: 300, rotationX: 15, rotationY: 30, rotation: 25, end: 6 }, scene);
  const body = f.add('Mesh', { x: 90, y: 30, z: 20, width: 80, height: 40, depth: 30, scale: 1.5, rotationX: 25, rotationY: 35, rotation: 65, anchorX: .2, anchorY: .8, end: 6 }, group);
  f.sample(0);
  const initial = api.spatialNode(f.world, body.entity)!.model;
  const initialCenter = transformPoint3D(initial, 40, 20, 0);
  f.document.setProperty(body, 'rigidBody', true);
  f.sample(0);
  const actual = api.spatialNode(f.world, body.entity)!.model;
  actual.forEach((value, index) => close(value, initial[index]!, 0.001));
  f.sample(.5);
  const center = transformPoint3D(api.spatialNode(f.world, body.entity)!.model, 40, 20, 0);
  close(center.x, initialCenter.x, .001);
  close(center.z, initialCenter.z, .001);
  close(center.y - initialCenter.y, 122.5, 1.1);
});

test('source edits and undo replace initial conditions while scrubbing remains deterministic', t => {
  const f = fixture();
  t.after(() => f.world.destroy());
  const body = f.add('Ellipse', { x: 50, y: 20, width: 20, height: 20, end: 6, rigidBody: { shape: { type: 'sphere', radius: 10 } } }, f.scene);
  f.sample(1);
  const original = body.entity.get(api.Computed)!.positionY;
  const editor = getDocumentEditor(f.world), history = getEditHistory(f.world);
  editor.editProperty(body.entity, 'y', 100);
  f.sample(1);
  close(body.entity.get(api.Computed)!.positionY - original, 80, .001);
  history.undo(); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, original, .001);
  f.sample(.2); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, original, .001);
  editor.editProperty(f.scene.entity, 'physics', { gravity: [0, 0, 0] });
  f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, 20);
  history.undo(); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, original, .001);
  assert.equal(authoredTree(f.world, body.entity)!.props.y, 20);
  f.document.setProperty(body, 'rigidBody', false); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, 20);
  f.document.setProperty(body, 'rigidBody', true); f.sample(1);
  assert.ok(body.entity.get(api.Computed)!.positionY > 500);
  f.document.setProperty(f.scene, 'physics', false); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, 20);
  const track = f.add('KeyframeTrack', { property: 'y' }, body);
  f.add('Keyframe', { time: 0, value: 20 }, track); f.add('Keyframe', { time: 1, value: 80 }, track);
  f.sample(.5); close(body.entity.get(api.Computed)!.positionY, 50);
});

test('timed bodies collide only during their authored span and preview/export frame rates agree', t => {
  const low = fixture(30), high = fixture(60);
  t.after(() => { low.world.destroy(); high.world.destroy(); });
  const make = (f: ReturnType<typeof fixture>) => {
    const body = f.add('Rect', { width: 20, height: 20, y: 0, start: .5, end: 5, rigidBody: { restitution: 0 } }, f.scene);
    f.add('Rect', { x: -100, y: 100, width: 400, height: 10, end: 1.5, rigidBody: { type: 'fixed', restitution: 0 } }, f.scene);
    return body;
  };
  const a = make(low), b = make(high);
  for (const time of [.2, 1, 2, .5, 1]) {
    low.sample(time); high.sample(time);
    close(a.entity.get(api.Computed)!.positionY, b.entity.get(api.Computed)!.positionY, 1e-6);
    if (time === .5) close(a.entity.get(api.Computed)!.positionY, 0);
    if (time === 1) close(a.entity.get(api.Computed)!.positionY, 80, .5);
    if (time === 2) assert.ok(a.entity.get(api.Computed)!.positionY > 180);
  }
});

test('unsupported parent transforms and competing transform animation fail explicitly', t => {
  const f = fixture();
  t.after(() => f.world.destroy());
  const group = f.add('Group', { x: 100, y: 100, width: 200, height: 200, scale: 2, end: 6 }, f.scene);
  const body = f.add('Rect', { width: 20, height: 20, end: 6, rigidBody: true }, group);
  assert.throws(() => f.sample(0), /scale 1/);
  f.document.setProperty(group, 'scale', 1);
  const track = f.add('KeyframeTrack', { property: 'rotation' }, body);
  f.add('Keyframe', { time: 0, value: 0 }, track); f.add('Keyframe', { time: 1, value: 90 }, track);
  assert.throws(() => f.sample(0), /transform keyframes/);
});

test('group physics uses its own clock and coordinates, and disabled scopes do not inherit outer worlds', t => {
  const f = fixture();
  t.after(() => f.world.destroy());
  const group = f.add('Group', { x: 200, y: 100, width: 300, height: 200, rotation: 90, start: .5, end: 6, physics: { gravity: [0, 200, 0] } }, f.scene);
  const body = f.add('Rect', { x: 0, y: 0, width: 20, height: 20, end: 5, rigidBody: true }, group);
  f.sample(.5); close(body.entity.get(api.Computed)!.positionY, 0);
  f.sample(1); close(body.entity.get(api.Computed)!.positionY, 25, .3);
  f.document.setProperty(group, 'physics', false); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, 0);
  f.document.setProperty(group, 'physics', { gravity: [0, 200, 0] }); f.sample(1);
  close(body.entity.get(api.Computed)!.positionY, 25, .3);
  const isolated = f.add('Scene3d', { width: 300, height: 200, end: 6 }, f.scene);
  f.add('Mesh', { rigidBody: true, end: 6 }, isolated);
  assert.throws(() => f.sample(0), /requires physics/);
});

test('native sphere meshes infer the same collider as an explicit sphere setting', t => {
  const inferred = fixture(), explicit = fixture();
  t.after(() => { inferred.world.destroy(); explicit.world.destroy(); });
  const make = (f: ReturnType<typeof fixture>, shape?: { type: 'sphere'; radius: number }) => {
    const scene = f.add('Scene3d', { width: 800, height: 600, end: 6, physics: true }, f.scene);
    const ball = f.add('Mesh', { shape: 'sphere', x: 100, y: 0, width: 40, height: 40, depth: 40, scale: 1.5, end: 6, rigidBody: { velocity: [80, 0, 0], restitution: .3, ...(shape ? { shape } : {}) } }, scene);
    f.add('Mesh', { x: -100, y: 150, width: 600, height: 20, depth: 300, end: 6, rigidBody: { type: 'fixed' } }, scene);
    return ball;
  };
  const a = make(inferred), b = make(explicit, { type: 'sphere', radius: 20 });
  inferred.sample(1); explicit.sample(1);
  const pa = a.entity.get(api.Computed)!, pb = b.entity.get(api.Computed)!;
  close(pa.positionX, pb.positionX, .001); close(pa.positionY, pb.positionY, .001); close(pa.rotation, pb.rotation, .001);
});
