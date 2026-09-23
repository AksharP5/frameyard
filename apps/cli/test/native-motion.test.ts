import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import { transformSync } from '@babel/core';

const bundle = await build({
  stdin: {
    contents: `
      export * as runtime from '@diffusionstudio/runtime';
      export { createRuntimeDocument, authoredTree, renderAuthored, trackPropertyPath, trackProperty } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR, ANIMATABLE_PROPERTIES } from '@diffusionstudio/jsx';
      export { getEditHistory } from './history';
      export { getDocumentEditor } from './editor';
      export { canonicalizeTagsPlugin } from '../../../desktop/src/source';
    `,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as {
  runtime: typeof import('@diffusionstudio/runtime');

} & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument' | 'authoredTree' | 'renderAuthored' | 'trackPropertyPath' | 'trackProperty'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR' | 'ANIMATABLE_PROPERTIES'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../desktop/src/source'), 'canonicalizeTagsPlugin'> };
class Element {}
class Text {
  data: string;
  constructor(data: string) { this.data = data; }
  remove() {}
}
class CanvasPath {
  commands: [string, ...number[]][] = [];
  moveTo(x: number, y: number) { this.commands.push(['M', x, y]); }
  lineTo(x: number, y: number) { this.commands.push(['L', x, y]); }
  closePath() { this.commands.push(['Z']); }
}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,Path2D,Text,document,HTMLImageElement,HTMLVideoElement){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element, CanvasPath, Text, { createTextNode: (data: string) => new Text(data) }, Element, Element);
const reconciler = module.exports;
const { runtime: api, SOURCE_ATTR, ANIMATABLE_PROPERTIES, getEditHistory, getDocumentEditor } = module.exports;

function fixture() {
  const world = api.createRuntimeWorld('native-motion');
  const document = reconciler.createRuntimeDocument(world);
  let id = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `motion.tsx:${++id}`);
    for (const [name, value] of Object.entries(props)) document.setProperty(node, name, value);
    document.insertNode(parent, node);
    node.entity.set(api.Computed, { visibility: 1 });
    return node;
  };
  const scene = add('Scene', { width: 640, height: 360, active: true });
  return { world, document, add, scene };
}

const shapeA = 'M 0 0 C 10 0 10 20 20 20 Z';
const shapeB = 'M 10 10 C 20 10 20 30 30 30 Z';

test('converted trees insert without source-only ids while keeping nested text and keyframes', () => {
  const f = fixture();
  const tree: import('@diffusionstudio/jsx').AuthoredTree = {
    tag: 'group', props: { id: 'converted-group', name: 'Converted', width: 300, height: 200 }, children: [
      { tag: 'text', props: { id: 'converted-text', x: 10 }, text: 'Editable text', children: [] },
      { tag: 'path', props: { id: 'converted-path', d: shapeA }, children: [
        { tag: 'keyframeTrack', props: { id: 'converted-track', property: 'd' }, children: [
          { tag: 'keyframe', props: { id: 'converted-start', time: 0, value: shapeA }, children: [] },
          { tag: 'keyframe', props: { id: 'converted-end', time: 1, value: shapeB }, children: [] },
        ] },
      ] },
    ],
  };
  const [inserted] = getDocumentEditor(f.world).insertElement(f.scene.entity, () => reconciler.renderAuthored(tree));
  assert.ok(inserted);
  const copy = reconciler.authoredTree(f.world, inserted)!;
  const descendants = (node: typeof copy): typeof copy[] => [node, ...node.children.flatMap(descendants)];
  assert.equal(descendants(copy).length, 6);
  assert.ok(descendants(copy).every(node => !Object.hasOwn(node.props, 'id')));
  assert.equal(copy.children[0].text, 'Editable text');
  assert.equal(copy.children[1].children[0].props.property, 'd');
  assert.equal(copy.children[1].children[0].children[1].props.value, shapeB);
  assert.equal(tree.props.id, 'converted-group');
});

test('native path geometry and numeric keyframes stay editable through source edits, undo and snapshots', () => {
  const f = fixture();
  const path = f.add('Path', { d: shapeA, viewBox: [0, 0, 30, 30], width: 120, height: 120, end: 3, fill: '#ffffff' }, f.scene);
  const morph = f.add('KeyframeTrack', { property: 'd' }, path);
  f.add('Keyframe', { time: 0, value: shapeA }, morph);
  const end = f.add('Keyframe', { time: 1, value: shapeB }, morph);
  const x = f.add('KeyframeTrack', { property: 'x' }, path);
  f.add('Keyframe', { time: 0, value: 10 }, x);
  f.add('Keyframe', { time: 1, value: 30 }, x);
  const sample = (frame: number) => {
    path.entity.set(api.Computed, { localTime: frame });
    api.motionSystem(f.world);
    return path.entity.get(api.Computed)!;
  };
  assert.equal(path.entity.get(api.Geometry)?.value, api.GeometryType.PATH);
  assert.equal(end.entity.get(api.Keyframe)?.stringValue, shapeB);
  assert.equal(sample(15).pathData, 'M 5 5 C 15 5 15 25 25 25 Z');
  assert.equal(sample(15).positionX, 20);
  assert.equal(sample(30).pathData, shapeB);
  const editor = getDocumentEditor(f.world);
  const history = getEditHistory(f.world);
  editor.editProperty(end.entity, 'value', shapeA);
  assert.equal(sample(15).pathData, shapeA);
  history.undo();
  assert.equal(sample(15).pathData, 'M 5 5 C 15 5 15 25 25 25 Z');
  history.redo();
  assert.equal(end.props.value, shapeA);
  const tree = reconciler.authoredTree(f.world, path.entity)!;
  assert.equal(tree.tag, 'path');
  assert.deepEqual(tree.props.viewBox, [0, 0, 30, 30]);
  assert.equal(tree.children[0].children[1].props.value, shapeA);
  const clone = api.createEntity(f.world);
  api.deserializeEntity(clone, api.serializeEntity(path.entity));
  assert.deepEqual(clone.get(api.PathData), path.entity.get(api.PathData));
  const clonedFrame = api.createEntity(f.world);
  api.deserializeEntity(clonedFrame, api.serializeEntity(end.entity));
  assert.equal(clonedFrame.get(api.Keyframe)?.stringValue, shapeA);
});

test('incompatible path topology holds and invalid edits leave the prior authored path intact', () => {
  const f = fixture();
  const path = f.add('Path', { d: shapeA }, f.scene);
  const morph = f.add('KeyframeTrack', { property: 'd' }, path);
  f.add('Keyframe', { time: 0, value: shapeA }, morph);
  f.add('Keyframe', { time: 1, value: 'M 0 0 L 30 30 Z' }, morph);
  path.entity.set(api.Computed, { localTime: 29 });
  api.motionSystem(f.world);
  assert.equal(path.entity.get(api.Computed)?.pathData, shapeA);
  path.entity.set(api.Computed, { localTime: 30 });
  api.motionSystem(f.world);
  assert.equal(path.entity.get(api.Computed)?.pathData, 'M 0 0 L 30 30 Z');
  assert.throws(() => f.document.setProperty(path, 'd', 'M 0 bad 2'), /SVG path/);
  assert.equal(path.props.d, shapeA);
  assert.equal(path.entity.get(api.PathData)?.value, shapeA);
  assert.throws(() => f.document.setProperty(path, 'viewBox', [0, 0, 0, 10]), /positive/);
  const editor = getDocumentEditor(f.world);
  const history = getEditHistory(f.world);
  editor.editProperty(path.entity, 'viewBox', [0, 0, 30, 30]);
  history.undo();
  assert.equal(path.entity.get(api.PathData)?.viewBox, undefined);
});

test('transform and camera props animate from one property vocabulary and retain authored values when cloned', () => {
  const f = fixture();
  const shape = f.add('Ellipse', { z: 30, rotationX: 20, rotationY: -15, anchorX: 0.5, anchorY: 0.5, skewX: 4, skewY: 8, flipX: true }, f.scene);
  assert.equal(shape.entity.get(api.Geometry)?.value, api.GeometryType.ELLIPSE);
  assert.equal(shape.entity.get(api.Computed)?.positionZ, 30);
  assert.equal(shape.entity.get(api.Computed)?.rotationX, 20);
  assert.equal(shape.entity.get(api.Computed)?.anchorX, 0.5);
  assert.equal(shape.entity.get(api.Flip)?.x, -1);
  assert.equal(f.scene.entity.get(api.Computed)?.cameraX, 320);
  f.document.setProperty(f.scene, 'width', 800);
  assert.equal(f.scene.entity.get(api.Computed)?.cameraX, 400);
  f.document.setProperty(f.scene, 'cameraX', 125);
  f.document.setProperty(f.scene, 'width', 1000);
  assert.equal(f.scene.entity.get(api.Computed)?.cameraX, 125);
  const cameraTrack = f.add('KeyframeTrack', { property: 'cameraZoom' }, f.scene);
  f.add('Keyframe', { time: 0, value: 1 }, cameraTrack);
  f.add('Keyframe', { time: 1, value: 2 }, cameraTrack);
  f.scene.entity.set(api.Computed, { localTime: 15 });
  api.motionSystem(f.world);
  assert.equal(f.scene.entity.get(api.Computed)?.cameraZoom, 1.5);
  for (const [property, path] of Object.entries(ANIMATABLE_PROPERTIES)) {
    assert.equal(reconciler.trackPropertyPath(shape.entity, property), path);
    assert.equal(reconciler.trackProperty(path), property);
    assert.ok(path in api.getPropertyPaths(f.world));
  }
  const clone = api.createEntity(f.world);
  api.deserializeEntity(clone, api.serializeEntity(shape.entity));
  assert.deepEqual(clone.get(api.Position), shape.entity.get(api.Position));
  assert.deepEqual(clone.get(api.Rotation), shape.entity.get(api.Rotation));
  assert.deepEqual(clone.get(api.Anchor), shape.entity.get(api.Anchor));
  assert.deepEqual(clone.get(api.Skew), shape.entity.get(api.Skew));
  assert.deepEqual(clone.get(api.Flip), shape.entity.get(api.Flip));
  const copiedScene = api.createEntity(f.world);
  api.deserializeEntity(copiedScene, api.serializeEntity(f.scene.entity));
  assert.deepEqual(copiedScene.get(api.SceneCamera), f.scene.entity.get(api.SceneCamera));
});


test('native path tags compile while paths and ellipses inside SVG remain DOM content', () => {
  const compiled = transformSync('const scene = <scene><path d="M0 0L10 10"/><ellipse/><html><svg><path d="M0 0L20 20"/><ellipse rx="10"/></svg></html></scene>;', {
    plugins: [module.exports.canonicalizeTagsPlugin], parserOpts: { plugins: ['jsx'] }, configFile: false, babelrc: false,
  })!.code!;
  assert.match(compiled, /Path as _Path/);
  assert.match(compiled, /Ellipse as _Ellipse/);
  assert.match(compiled, /<_Path d="M0 0L10 10"/);
  assert.match(compiled, /<svg><path d="M0 0L20 20"\s*\/><ellipse rx="10"/);
});

test('projected masks preserve holes, viewBox mapping, curved edges and ellipse shape', () => {
  const f = fixture();
  const path = f.add('Path', { d: 'M0 0 H100 V100 H0 Z M25 25 V75 H75 V25 Z', viewBox: [0, 0, 100, 100], width: 200, height: 100, mask: true }, f.scene);
  const project = (x: number, y: number) => ({ x: x / (1 + x / 200), y: y / (1 + x / 200) });
  const result = api.projectedGeometryPath(path.entity, project) as unknown as CanvasPath;
  assert.equal(result.commands.filter(([kind]) => kind === 'M').length, 2);
  assert.equal(result.commands.filter(([kind]) => kind === 'Z').length, 2);
  assert.deepEqual(result.commands[1], ['L', 100, 0]);
  assert.deepEqual(result.commands[5], ['M', 40, 20]);
  f.document.setProperty(path, 'viewBox', false);
  f.document.setProperty(path, 'd', 'M0 0 C0 100 100 -100 100 0 S200 100 200 0 Q250 -100 300 0 T400 0 A50 50 0 0 1 500 0');
  const curved = api.projectedGeometryPath(path.entity, (x, y) => ({ x, y })) as unknown as CanvasPath;
  assert.ok(curved.commands.length > 30, 'curves are subdivided, including an inflection at their midpoint');
  assert.deepEqual(curved.commands.at(-1), ['L', 500, 0]);
  assert.ok(curved.commands.some(([, , y]) => y < -45));
  const ellipse = f.add('Ellipse', { width: 80, height: 40 }, f.scene);
  const oval = api.projectedGeometryPath(ellipse.entity, (x, y) => ({ x, y })) as unknown as CanvasPath;
  assert.deepEqual(oval.commands[0], ['M', 80, 20]);
  assert.deepEqual(oval.commands.at(-1), ['Z']);
  assert.ok(oval.commands.length > 12);
});

test('glass and scene finishing properties animate, reject invalid values and survive copying', () => {
  const f = fixture();
  const glass = f.add('Rect', { backdropBlur: 12, refraction: 0.4 }, f.scene);
  f.document.setProperty(f.scene, 'focusDistance', 700);
  f.document.setProperty(f.scene, 'aperture', 8);
  f.document.setProperty(f.scene, 'bloom', 0.2);
  const track = f.add('KeyframeTrack', { property: 'refraction' }, glass);
  f.add('Keyframe', { time: 0, value: 0 }, track);
  f.add('Keyframe', { time: 1, value: 1 }, track);
  glass.entity.set(api.Computed, { localTime: 15 });
  api.motionSystem(f.world);
  assert.equal(glass.entity.get(api.Computed)?.refraction, 0.5);
  assert.equal(glass.entity.get(api.Computed)?.backdropBlur, 12);
  assert.equal(f.scene.entity.get(api.Computed)?.focusDistance, 700);
  assert.throws(() => f.document.setProperty(glass, 'refraction', 2), /finite number/);
  assert.equal(glass.props.refraction, 0.4);
  assert.throws(() => f.document.setProperty(f.scene, 'bloom', NaN), /finite number/);
  assert.equal(f.scene.props.bloom, 0.2);
  const copy = api.createEntity(f.world);
  api.deserializeEntity(copy, api.serializeEntity(glass.entity));
  assert.deepEqual(copy.get(api.LayerMaterial), { backdropBlur: 12, refraction: 0.4 });
  const sceneCopy = api.createEntity(f.world);
  api.deserializeEntity(sceneCopy, api.serializeEntity(f.scene.entity));
  assert.deepEqual(sceneCopy.get(api.SceneEffects), f.scene.entity.get(api.SceneEffects));
});

test('native 3D nodes retain editable geometry, material, light and physics through undo and duplication', () => {
  const f = fixture();
  const root = f.add('Scene3d', { width: 640, height: 360, physics: { gravity: [0, 980, 0] }, cameraOffsetX: 24, cameraX: 100, cameraY: 70, cameraZ: 400, perspective: 400 }, f.scene);
  const mesh = f.add('Mesh', { name: 'Body', shape: 'box', width: 90, height: 80, depth: 70, roughness: .2, metalness: .7, rigidBody: { restitution: .8 } }, root);
  const light = f.add('Light', { type: 'spot', intensity: 4, targetX: 320, targetY: 180, coneAngle: 45 }, root);
  const volume = f.add('Volume', { width: 200, height: 200, depth: 150, density: .4 }, root);
  assert.ok(root.entity.has(api.Scene3D));
  assert.equal(root.entity.get(api.Computed)?.cameraX, 100);
  assert.equal(root.entity.get(api.Computed)?.cameraY, 70);
  assert.equal(root.entity.get(api.Computed)?.cameraZ, 400);
  assert.equal(root.entity.get(api.Computed)?.perspective, 400);
  assert.equal(mesh.entity.get(api.Computed)?.depth, 70);
  assert.equal(light.entity.get(api.LightSource)?.type, 'spot');
  assert.equal(volume.entity.get(api.Geometry)?.value, api.GeometryType.VOLUME);
  const editor = getDocumentEditor(f.world), history = getEditHistory(f.world);
  editor.editProperty(mesh.entity, 'roughness', .8);
  assert.equal(mesh.entity.get(api.Computed)?.roughness, .8);
  history.undo(); assert.equal(mesh.entity.get(api.Computed)?.roughness, .2);
  history.redo(); assert.equal(mesh.entity.get(api.Computed)?.roughness, .8);
  const record = api.serializeEntity(mesh.entity), copy = api.createEntity(f.world);
  api.deserializeEntity(copy, record);
  assert.equal(copy.get(api.SpatialParameters)?.depth, 70);
  assert.equal(copy.get(api.SpatialParameters)?.roughness, .8);
  assert.equal(copy.get(api.RigidBody)?.settings?.restitution, .8);
  assert.deepEqual(reconciler.authoredTree(f.world, root.entity)?.props.physics, { gravity: [0, 980, 0] });
  f.document.dispose(); f.world.destroy();
});

test('3D curve and point-array keyframes interpolate native data and restore authored values', () => {
  const f = fixture();
  const root = f.add('Scene3d', { width: 640, height: 360 }, f.scene);
  const path = f.add('Path3d', { d: 'M 0 0 0 L 20 20 20', width: 100, height: 100, end: 3 }, root);
  const track = f.add('KeyframeTrack', { property: 'd' }, path);
  f.add('Keyframe', { time: 0, value: 'M 0 0 0 L 20 20 20' }, track);
  f.add('Keyframe', { time: 1, value: 'M 10 20 30 L 40 40 40' }, track);
  const cloud = f.add('PointCloud', { points: [0, 0, 0, 20, 20, 20], pointColors: [1, 0, 0, 1, 0, 1, 0, 1], end: 3 }, root);
  const positions = f.add('KeyframeTrack', { property: 'points' }, cloud);
  f.add('Keyframe', { time: 0, value: [0, 0, 0, 20, 20, 20] }, positions);
  const end = f.add('Keyframe', { time: 1, value: [10, 20, 30, 40, 40, 40] }, positions);
  path.entity.set(api.Computed, { localTime: 15 }); cloud.entity.set(api.Computed, { localTime: 15 });
  api.motionSystem(f.world);
  assert.equal(track.entity.get(api.KeyframeTrack)?.property, 'spatial.path3d');
  assert.equal(path.entity.get(api.Computed)?.path3d, 'M 5 10 15 L 30 30 30');
  assert.deepEqual(cloud.entity.get(api.Computed)?.points, [5, 10, 15, 30, 30, 30]);
  assert.deepEqual(cloud.entity.get(api.SpatialGeometry)?.points, [0, 0, 0, 20, 20, 20]);
  const history = getEditHistory(f.world);
  getDocumentEditor(f.world).editProperty(end.entity, 'value', [20, 40, 60, 60, 60, 60]);
  api.motionSystem(f.world);
  assert.deepEqual(cloud.entity.get(api.Computed)?.points, [10, 20, 30, 40, 40, 40]);
  history.undo(); api.motionSystem(f.world);
  assert.deepEqual(cloud.entity.get(api.Computed)?.points, [5, 10, 15, 30, 30, 30]);
  const record = api.serializeEntity(end.entity), copy = api.createEntity(f.world);
  api.deserializeEntity(copy, record);
  assert.deepEqual(copy.get(api.Keyframe)?.arrayValue, [10, 20, 30, 40, 40, 40]);
  f.document.dispose(); f.world.destroy();
});

test('invalid spatial data fails at the authored boundary before changing the source', () => {
  const f = fixture();
  const mesh = f.add('Mesh', { roughness: .5 }, f.scene);
  for (const [property, value] of [['roughness', 2], ['points', [1, 2]], ['indices', [-1]], ['wireframe', 'false'], ['shape', 'unknown']] as const) {
    assert.throws(() => f.document.setProperty(mesh, property, value));
    assert.equal(mesh.props[property], property === 'roughness' ? .5 : undefined);
  }
  const path = f.add('Path3d', { d: 'M 0 0 0' }, f.scene);
  assert.throws(() => f.document.setProperty(path, 'd', 'M 0 0'), /coordinates/);
  const track = f.add('KeyframeTrack', { property: 'roughness' }, mesh);
  const key = f.add('Keyframe', { time: 0, value: .5 }, track);
  assert.throws(() => f.document.setProperty(key, 'value', -1), /roughness/);
  assert.equal(key.props.value, .5);
  f.document.dispose(); f.world.destroy();
});

test('adding a layer preserves sibling order without notifying unchanged indices', (t) => {
  const f = fixture();
  t.after(() => { f.document.dispose(); f.world.destroy(); });
  const layers = Array.from({ length: 64 }, () => f.add('Rect', { width: 10, height: 10, end: 1 }, f.scene));
  const changed: import('koota').Entity[] = [];
  const unsubscribe = f.world.onChange(api.ItemIndex, entity => changed.push(entity));
  t.after(unsubscribe);
  const appended = f.add('Rect', { width: 10, height: 10, end: 1 }, f.scene);
  assert.ok(changed.every(entity => entity === appended.entity), 'Appending must not invalidate existing sibling caches');
  assert.deepEqual(f.scene.entity.get(api.Cache)?.children, [...layers, appended].map(node => node.entity));

  f.document.insertNode(f.scene, appended, layers[1]);
  const reordered = [layers[0], appended, ...layers.slice(1)];
  assert.deepEqual(f.scene.entity.get(api.Cache)?.children, reordered.map(node => node.entity));
  assert.deepEqual(reordered.map(node => node.entity.get(api.ItemIndex)?.value), reordered.map((_, index) => index));
});

test('cycle rejection preserves runtime and authored trees, including adopted entities', (t) => {
  const f = fixture();
  t.after(() => { f.document.dispose(); f.world.destroy(); });
  const ancestor = f.add('Group', {}, f.document.stage);
  const child = f.add('Group', {}, ancestor);
  const descendant = f.add('Rect', { width: 10, height: 10 }, child);
  const stageChildren = [...f.document.stage.children];
  assert.throws(() => api.appendChild(f.world, ancestor.entity, descendant.entity), /own subtree/);
  assert.throws(() => api.appendChild(f.world, f.document.stage.entity, descendant.entity), /own subtree/);
  assert.throws(() => f.document.insertNode(descendant, ancestor), /own subtree/);
  assert.deepEqual(f.document.stage.children, stageChildren);
  assert.equal(ancestor.parent, f.document.stage);
  assert.equal(child.parent, ancestor);
  assert.equal(descendant.parent, child);
  assert.equal(api.getParentEntity(ancestor.entity), f.document.stage.entity);
  assert.equal(api.getParentEntity(child.entity), ancestor.entity);
  assert.equal(api.getParentEntity(descendant.entity), child.entity);

  const adopted = api.createEntity(f.world);
  api.appendChild(f.world, adopted, descendant.entity);
  const adoptedNode = f.document.node(adopted);
  assert.equal(adoptedNode.parent, null);
  assert.throws(() => f.document.insertNode(adoptedNode, ancestor), /own subtree/);
  assert.equal(api.getParentEntity(adopted), descendant.entity);
  assert.equal(ancestor.parent, f.document.stage);

  f.document.insertNode(f.scene, ancestor);
  assert.equal(ancestor.parent, f.scene);
  assert.equal(api.getParentEntity(ancestor.entity), f.scene.entity);
  assert.equal(api.getParentEntity(adopted), descendant.entity);
});

test('resizing applies child constraints through sequences while retaining keyframes', (t) => {
  const f = fixture();
  t.after(() => { f.document.dispose(); f.world.destroy(); });
  const parent = f.add('Rect', { width: 400, height: 300 }, f.scene);
  const sequence = f.add('Sequence', {}, parent);
  const child = f.add('Rect', { width: 40, height: 20, x: 10, y: 20 }, sequence);
  const track = f.add('KeyframeTrack', { property: 'opacity' }, child);
  const first = f.add('Keyframe', { time: 0, value: 0 }, track);
  const last = f.add('Keyframe', { time: 1, value: 1 }, track);
  child.entity.set(api.Computed, { positionX: 10, positionY: 20, width: 40, height: 20 });
  child.entity.add(api.Constraint({ horizontal: api.ConstraintType.MAX, vertical: api.ConstraintType.MAX }));
  api.resolveConstraintOffsets(f.world, parent.entity);
  api.resizeEntity(f.world, parent.entity, { width: 600, height: 400 });
  assert.equal(child.entity.get(api.Position)?.x, 210);
  assert.equal(child.entity.get(api.Position)?.y, 120);
  assert.equal(child.entity.get(api.Computed)?.width, 40);
  assert.deepEqual(track.entity.get(api.Cache)?.keyframes, [first.entity, last.entity]);
});
