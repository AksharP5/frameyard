import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: {
    contents: `
      export * as runtime from '@diffusionstudio/runtime';
      export * as spatial from './packages/runtime/src/math/spatial';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export * as gestures from './apps/web/src/engine/input/spatial-gestures';
      export { snapshotSelectionMask } from './apps/web/src/engine/input/snapping';
      export { Pointer, Keys } from './apps/web/src/engine/traits';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from './apps/web/src/engine/history';
    `,
    resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  jsx: 'transform', jsxFactory: 'gestureJsx',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as {
  runtime: typeof import('@diffusionstudio/runtime');
  spatial: typeof import('../../../packages/runtime/src/math/spatial');
  gestures: typeof import('../../web/src/engine/input/spatial-gestures');
} & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>
  & Pick<typeof import('../../web/src/engine/input/snapping'), 'snapshotSelectionMask'>
  & Pick<typeof import('../../web/src/engine/traits'), 'Pointer' | 'Keys'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'> };
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,gestureJsx){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element, (component: (props: object) => unknown, props: object) => component(props));
const { runtime: api, spatial, gestures, createRuntimeDocument, Pointer, Keys, SOURCE_ATTR, snapshotSelectionMask, getEditHistory } = module.exports;
const camera = { x: 500, y: 300, z: 1000, perspective: 1000, zoom: 1, rotationX: 0, rotationY: 0, rotation: 0, width: 1000, height: 600 };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
const closePoint = (actual: { x: number; y: number }, expected: { x: number; y: number }) => { close(actual.x, expected.x); close(actual.y, expected.y); };

function fixture() {
  const world = api.createRuntimeWorld('spatial-motion');
  world.get(api.Root)!.set(api.Camera, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  world.add(Pointer, Keys);
  const document = createRuntimeDocument(world);
  let id = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `spatial.tsx:${++id}`);
    for (const [name, value] of Object.entries(props)) document.setProperty(node, name, value);
    document.insertNode(parent, node);
    node.entity.set(api.Computed, { visibility: 1 });
    return node;
  };
  const scene = add('Scene', { width: 1000, height: 600 });
  return { world, document, scene, add };
}

test('camera perspective keeps the default 2D plane unchanged and responds to depth, pan, zoom and roll', () => {
  const plane = spatial.projectPlane(spatial.identity4(), camera);
  closePoint(api.transformPoint(plane, 120, 80), { x: 120, y: 80 });
  const deep = spatial.projectPlane(spatial.translation4(0, 0, 250), camera);
  closePoint(api.transformPoint(deep, 600, 300), { x: 500 + 1000 * 100 / 750, y: 300 });
  closePoint(api.transformPoint(spatial.projectPlane(spatial.identity4(), { ...camera, x: 600, zoom: 2 }), 650, 300), { x: 600, y: 300 });
  closePoint(api.transformPoint(spatial.projectPlane(spatial.identity4(), { ...camera, rotation: 90 }), 600, 300), { x: 500, y: 200 });
});

test('nested plane transforms and viewport transforms retain an invertible homography for pointer coordinates', () => {
  const parent = spatial.multiply4(spatial.translation4(500, 300, 0), spatial.rotation4(0, 60));
  const child = spatial.multiply4(parent, spatial.translation4(100, 0, 0));
  const plane = spatial.projectPlane(child, camera);
  closePoint(api.transformPoint(plane, 0, 0), { x: 500 + 50 * 1000 / (1000 + 100 * Math.sin(Math.PI / 3)), y: 300 });
  const screen = api.multiply2D(api.multiply2D(api.translate2D(23, 47), api.scale2D(0.7, 0.7)), plane);
  const inverse = api.invert2D(screen);
  for (const point of [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 60 }, { x: 19, y: 27 }]) {
    const projected = api.transformPoint(screen, point.x, point.y);
    closePoint(api.transformPoint(inverse, projected.x, projected.y), point);
  }
});

test('ordinary unanchored 2D rotation retains its center pivot and nested spatial rotations retain the child pivot', () => {
  const f = fixture();
  const rect = f.add('Rect', { x: 100, y: 80, width: 200, height: 100, rotation: 90 }, f.scene);
  api.transformSystem(f.world);
  assert.equal(api.hasSpatialCamera(f.world, f.scene.entity), false);
  closePoint(api.transformPoint(api.entityWorldMat(f.world, rect.entity), 0, 0), { x: 250, y: 30 });
  closePoint(api.transformPoint(api.entityWorldMat(f.world, rect.entity), 100, 50), { x: 200, y: 130 });
  const group = f.add('Group', { x: 400, y: 250, width: 200, height: 100, rotationY: 30 }, f.scene);
  const child = f.add('Rect', { x: 70, y: 30, width: 60, height: 40, rotationX: 45, rotation: 20 }, group);
  api.transformSystem(f.world);
  const node = api.spatialNode(f.world, child.entity)!;
  closePoint(api.transformPoint(node.plane, 30, 20), { x: 500, y: 300 });
  closePoint(api.transformPoint(api.projectParentPlane(f.world, child.entity, 0), 100, 50), { x: 500, y: 300 });
});

test('keyframed depth and camera tracks activate perspective without requiring static props', () => {
  const f = fixture();
  const rect = f.add('Rect', { x: 600, y: 300, width: 80, height: 80 }, f.scene);
  const depth = f.add('KeyframeTrack', { property: 'z' }, rect);
  f.add('Keyframe', { time: 0, value: 0 }, depth);
  f.add('Keyframe', { time: 1, value: 200 }, depth);
  rect.entity.set(api.Computed, { localTime: 15 });
  api.motionSystem(f.world);
  api.transformSystem(f.world);
  assert.equal(api.hasSpatialCamera(f.world, f.scene.entity), true);
  closePoint(api.transformPoint(api.entityWorldMat(f.world, rect.entity), 0, 0), { x: 500 + 100 / 0.9, y: 300 });
  const g = fixture();
  const other = g.add('Rect', { x: 600, y: 300, width: 80, height: 80 }, g.scene);
  const zoom = g.add('KeyframeTrack', { property: 'cameraZoom' }, g.scene);
  g.add('Keyframe', { time: 0, value: 1 }, zoom);
  g.add('Keyframe', { time: 1, value: 2 }, zoom);
  g.scene.entity.set(api.Computed, { localTime: 15 });
  api.motionSystem(g.world);
  api.transformSystem(g.world);
  assert.equal(api.hasSpatialCamera(g.world, g.scene.entity), true);
  closePoint(api.transformPoint(api.entityWorldMat(g.world, other.entity), 0, 0), { x: 650, y: 300 });
});

test('depth on a mask activates the scene camera and returns to affine rendering when removed', () => {
  const f = fixture();
  const rect = f.add('Rect', { x: 550, y: 250, width: 100, height: 100 }, f.scene);
  const mask = f.add('Ellipse', { x: 10, y: 10, z: 200, width: 80, height: 80, mask: true }, rect);
  api.transformSystem(f.world);
  assert.equal(api.hasSpatialCamera(f.world, f.scene.entity), true);
  const projected = api.spatialNode(f.world, mask.entity)!;
  closePoint(api.transformPoint(projected.plane, 0, 0), { x: 575, y: 250 });
  f.document.setProperty(mask, 'z', 0);
  api.transformSystem(f.world);
  assert.equal(api.hasSpatialCamera(f.world, f.scene.entity), false);
  assert.equal(api.spatialNode(f.world, mask.entity), undefined);
  closePoint(api.transformPoint(api.entityWorldMat(f.world, mask.entity), 0, 0), { x: 560, y: 260 });
});

test('children of a plane hidden behind the camera cannot remain selectable', () => {
  const f = fixture();
  const group = f.add('Group', { x: 400, y: 250, z: 1100, width: 200, height: 100 }, f.scene);
  const child = f.add('Rect', { x: 50, y: 20, z: -200, width: 100, height: 60 }, group);
  api.transformSystem(f.world);
  assert.equal(api.spatialNode(f.world, group.entity)?.visible, false);
  assert.equal(api.isEntitySelectable(f.world, child.entity), false);
  f.document.setProperty(group, 'z', 900);
  api.transformSystem(f.world);
  assert.equal(api.isEntitySelectable(f.world, child.entity), true);
});


function begin(f: ReturnType<typeof fixture>, nodes: import('koota').Entity[], start: { x: number; y: number }) {
  for (const node of f.world.query(api.Selected)) node.remove(api.Selected);
  for (const node of nodes) node.add(api.Selected);
  f.world.set(Pointer, { dragStartX: start.x, dragStartY: start.y, clientX: start.x, clientY: start.y });
  snapshotSelectionMask(f.world);
  gestures.snapshotSpatialGesture(f.world);
}


test('spatial drag keeps the grabbed point under the pointer and undo restores its source position', () => {
  const f = fixture();
  const parent = f.add('Group', { x: 400, y: 250, width: 200, height: 100, rotationY: 35 }, f.scene);
  const child = f.add('Rect', { x: 30, y: 20, z: 40, width: 100, height: 60, rotationX: 25, rotation: 15 }, parent);
  api.transformSystem(f.world);
  const grabbed = { x: 70, y: 15 };
  const start = api.transformPoint(api.entityWorldMat(f.world, child.entity), grabbed.x, grabbed.y);
  begin(f, [child.entity], start);
  const history = getEditHistory(f.world);
  f.world.set(Pointer, { clientX: start.x + 60, clientY: start.y - 25 });
  assert.equal(gestures.moveSpatialGesture(f.world), true);
  api.transformSystem(f.world);
  closePoint(api.transformPoint(api.entityWorldMat(f.world, child.entity), grabbed.x, grabbed.y), { x: start.x + 60, y: start.y - 25 });
  assert.equal(child.props.z, 40);
  history.undo();
  assert.equal(child.props.x, 30);
  assert.equal(child.props.y, 20);
});

test('single spatial resize holds the opposite corner in 3D and roll follows the layer plane', () => {
  const f = fixture();
  const child = f.add('Rect', { x: 400, y: 230, z: 100, width: 160, height: 80, rotationX: 25, rotationY: 30, rotation: 10 }, f.scene);
  api.transformSystem(f.world);
  const initial = api.entityWorldMat(f.world, child.entity);
  const fixed = api.transformPoint(initial, 0, 0);
  const start = api.transformPoint(initial, 160, 80);
  const destination = api.transformPoint(initial, 200, 110);
  begin(f, [child.entity], start);
  f.world.set(Pointer, { clientX: destination.x, clientY: destination.y });
  assert.equal(gestures.resizeSpatialGesture(f.world, { x: 1, y: 1 }), true);
  api.transformSystem(f.world);
  close(Number(child.props.width), 200);
  close(Number(child.props.height), 110);
  closePoint(api.transformPoint(api.entityWorldMat(f.world, child.entity), 0, 0), fixed);
  closePoint(api.transformPoint(api.entityWorldMat(f.world, child.entity), 200, 110), destination);
  const c = child.entity.get(api.Computed)!;
  const world = api.entityWorldMat(f.world, child.entity);
  const rotationPlane = api.multiply2D(world, api.invert2D(api.entityLocalMat(f.world, child.entity)));
  const px = c.positionX + c.width * c.anchorX, py = c.positionY + c.height * c.anchorY;
  const turnStart = api.transformPoint(rotationPlane, px + 80, py);
  const turnEnd = api.transformPoint(rotationPlane, px, py + 80);
  begin(f, [child.entity], turnStart);
  f.world.set(Pointer, { clientX: turnEnd.x, clientY: turnEnd.y });
  assert.equal(gestures.rotateSpatialGesture(f.world), true);
  close(Number(child.props.rotation), 100);
});

test('spatial group resizing scales its editable children and multi-selection preserves tilt while placing anchors', () => {
  const f = fixture();
  const group = f.add('Group', { x: 300, y: 200, z: 100, width: 200, height: 100, rotationY: 25, scale: 1 }, f.scene);
  const child = f.add('Rect', { x: 20, y: 15, width: 100, height: 50 }, group);
  api.transformSystem(f.world);
  const plane = api.entityWorldMat(f.world, group.entity);
  begin(f, [group.entity], api.transformPoint(plane, 200, 100));
  const larger = api.transformPoint(plane, 300, 150);
  f.world.set(Pointer, { clientX: larger.x, clientY: larger.y });
  gestures.resizeSpatialGesture(f.world, { x: 1, y: 1 });
  close(Number(group.props.scale), 1.5);
  assert.equal(child.props.width, 100);
  assert.equal(child.props.x, 20);
  const other = f.add('Rect', { x: 650, y: 200, z: -100, width: 100, height: 60, rotationX: 30 }, f.scene);
  api.transformSystem(f.world);
  group.entity.add(api.Selected);
  other.entity.add(api.Selected);
  const mask = api.getSelectionMask(f.world)!;
  const center = api.transformPoint(mask.mat, mask.width / 2, mask.height / 2);
  const anchors = [group, other].map(node => {
    const c = node.entity.get(api.Computed)!;
    return api.transformPoint(api.entityWorldMat(f.world, node.entity), c.anchorX * c.width, c.anchorY * c.height);
  });
  begin(f, [group.entity, other.entity], { x: center.x + 100, y: center.y });
  f.world.set(Pointer, { clientX: center.x, clientY: center.y + 100 });
  gestures.rotateSpatialGesture(f.world);
  api.transformSystem(f.world);
  for (const [index, node] of [group, other].entries()) {
    const c = node.entity.get(api.Computed)!;
    closePoint(api.transformPoint(api.entityWorldMat(f.world, node.entity), c.anchorX * c.width, c.anchorY * c.height), { x: center.x - (anchors[index]!.y - center.y), y: center.y + (anchors[index]!.x - center.x) });
  }
  assert.equal(group.props.rotationY, 25);
  assert.equal(other.props.rotationX, 30);
});
