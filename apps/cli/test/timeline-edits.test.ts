import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld, Computed, Host, FrameRate, Selected, RenderSurface, getActiveEntity, getCameraMatrix, setCameraMatrix, transformSystem } from '@diffusionstudio/runtime';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from './history';
      export { getDocumentEditor } from './editor';
      export { Keys } from './traits';
      export { shortcutSystem } from './input/shortcuts';
      export { TimelineSurface } from './timeline/surface';
      export { timelineEditing } from './timeline-editing';
      export { Timeline } from '@diffusionstudio/runtime';
    `,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  jsx: 'transform', jsxFactory: 'clipJsx', logOverride: { 'empty-import-meta': 'silent' },
  plugins: [{ name: 'unused-ui-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/group|\.\/interactions|\.\/timeline)$/ }, ({ path, importer }) => {
      if (importer.endsWith('/input/shortcuts.ts') || importer.endsWith('/split.tsx')) return { path, namespace: 'ui-boundary' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'ui-boundary' }, () => ({ contents: `
      export const groupSelection=unused, ungroupSelection=unused, unwrapSequenceSelection=unused,
        wrapSelectionInScene=unused, wrapSelectionInSequence=unused, editTransform=unused;
      export function cloneFramesForSplit() {} export function clonePeaksForSplit() {}
      function unused() { throw new Error('Unexpected UI action'); }
    ` }));
  } }],
});

type Runtime = Pick<typeof import('@diffusionstudio/runtime'), 'createRuntimeWorld' | 'Computed' | 'Host' | 'FrameRate' | 'Selected' | 'RenderSurface' | 'getActiveEntity' | 'getCameraMatrix' | 'setCameraMatrix' | 'transformSystem'>;
const module = { exports: {} as Runtime
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../web/src/engine/traits'), 'Keys'>
  & Pick<typeof import('../../web/src/engine/input/shortcuts'), 'shortcutSystem'>
  & Pick<typeof import('../../web/src/engine/timeline/surface'), 'TimelineSurface'>
  & Pick<typeof import('../../web/src/engine/timeline-editing'), 'timelineEditing'>
  & Pick<typeof import('@diffusionstudio/runtime'), 'Timeline'>
};
class Element { width = 1280; height = 720; }
class Matrix { scaleSelf() { return this; } translateSelf() { return this; } }
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,clipJsx,DOMRect,DOMMatrix,window){"use strict";${built.outputFiles[0].text}\n})`)(
  module, module.exports, Element, Element, Element,
  (component: (props: object) => unknown, props: object) => component(props),
  Element, Matrix, { devicePixelRatio: 1 },
);
const { createRuntimeWorld, createRuntimeDocument, Computed, Host, FrameRate, Selected, RenderSurface, getActiveEntity, getCameraMatrix, setCameraMatrix, transformSystem, SOURCE_ATTR, getEditHistory, getDocumentEditor, Keys, shortcutSystem } = module.exports;

function fixture(fps = 30) {
  const world = createRuntimeWorld('timeline-shortcuts');
  world.set(FrameRate, { value: fps });
  world.add(Keys);
  const document = createRuntimeDocument(world);
  let counter = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `test.tsx:${++counter}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    node.entity.set(Computed, { visibility: 1 });
    return node;
  };
  const scene = add('Scene', { active: true, end: 30 });
  const history = getEditHistory(world);
  const editor = getDocumentEditor(world);
  const press = (key: string, ...modifiers: string[]) => {
    const keys = world.get(Keys)!;
    keys.held.clear(); keys.pressed.clear(); keys.lifted.clear();
    for (const modifier of modifiers) keys.held.add(modifier);
    keys.held.add(key); keys.pressed.add(key);
    shortcutSystem(world);
    keys.held.clear(); keys.pressed.clear(); keys.lifted.clear();
  };
  const seek = (seconds: number) => scene.entity.set(Computed, { localTime: Math.round(seconds * fps) });
  return { world, add, scene, editor, history, press, seek };
}

test('selecting a frame or its contents switches the timeline without moving either playhead', () => {
  const f = fixture();
  try {
    const other = f.add('Scene', { end: 12 });
    const group = f.add('Group', {}, other);
    const text = f.add('Text', {}, group);
    const shape = f.add('Rect', {}, f.scene);
    f.scene.entity.set(Computed, { localTime: 90 });
    other.entity.set(Computed, { localTime: 180 });

    f.editor.select(text.entity);
    assert.equal(getActiveEntity(f.world), other.entity);
    assert.equal(f.editor.primarySelection(), text.entity);
    f.editor.select(shape.entity);
    assert.equal(getActiveEntity(f.world), f.scene.entity);
    f.editor.select(other.entity);
    assert.equal(getActiveEntity(f.world), other.entity, 'clicking the frame itself also opens its timeline');
    f.editor.clearSelection();
    assert.equal(getActiveEntity(f.world), other.entity, 'clearing selection leaves the current timeline open');
    assert.equal(f.scene.entity.get(Computed)?.localTime, 90);
    assert.equal(other.entity.get(Computed)?.localTime, 180);
    assert.equal(f.history.canUndo(), false, 'selection and active-scene changes are navigation');
  } finally { f.world.destroy(); }
});

test('Q and W trim only selected clips at frame boundaries and preserve nested media offsets through undo', () => {
  const f = fixture(24);
  const group = f.add('Group', { start: 3 }, f.scene);
  const clip = f.add('Rect', { start: 2, end: 8, sourceIn: 4, sourceOut: 16, playbackRate: 2, selected: true }, group);
  const untouched = f.add('Rect', { start: 2, end: 8 }, group);
  const otherScene = f.add('Scene', { end: 30 });
  const outside = f.add('Rect', { start: 1, end: 10, selected: true }, otherScene);
  f.seek(6 + 1 / 24);
  f.press('q');
  assert.equal(clip.props.start, 3.041667);
  assert.equal(clip.props.end, 8);
  assert.equal(clip.props.sourceIn, 6.083333);
  assert.equal(clip.props.sourceOut, 16);
  assert.equal(untouched.props.start, 2);
  assert.equal(outside.props.start, 1);
  assert.equal(f.history.canUndo(), true);
  f.history.undo();
  assert.equal(clip.props.start, 2);
  assert.equal(clip.props.sourceIn, 4);
  f.press('w');
  assert.equal(clip.props.start, 2);
  assert.equal(clip.props.end, 3.041667);
  assert.equal(clip.props.sourceOut, 6.083333);
  f.history.undo();
  assert.equal(clip.props.end, 8);
  assert.equal(clip.props.sourceOut, 16);
  f.seek(5);
  f.press('q');
  assert.equal(f.history.canUndo(), false, 'a cut at the existing in point is a no-op');
  f.editor.clearSelection();
  f.seek(7);
  f.press('w');
  assert.equal(untouched.props.end, 8, 'trim requires a selection');
  f.world.destroy();
});

test('X leaves a gap; Shift+X closes merged deleted spans only in their containers and undoes as one edit', () => {
  const f = fixture();
  const group = f.add('Group', { start: 3 }, f.scene);
  const first = f.add('Rect', { start: 0, end: 2, selected: true }, group);
  const second = f.add('Rect', { start: 1, end: 4, selected: true }, group);
  const tail = f.add('Rect', { start: 6, end: 10, sourceIn: 5, sourceOut: 9 }, group);
  const otherTrack = f.add('Rect', { start: 9, end: 12 }, f.scene);
  f.press('x', 'alt');
  assert.equal(first.entity.isAlive(), true, 'Alt+X does not delete');
  f.press('x');
  assert.equal(first.entity.isAlive(), false);
  assert.equal(second.entity.isAlive(), false);
  assert.equal(tail.props.start, 6);
  f.history.undo();
  const restored = f.world.query(Selected).filter((entity) => entity !== f.scene.entity);
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map((entity) => {
    const props = entity.get(Host)!.props;
    return [props.start ?? 0, props.end];
  }).sort((a, b) => Number(a[0]) - Number(b[0])), [[0, 2], [1, 4]]);
  f.press('x', 'shift');
  assert.equal(tail.props.start, 2, 'overlapping spans close once, not once per selected clip');
  assert.equal(tail.props.end, 6);
  assert.equal(tail.props.sourceIn, 5);
  assert.equal(tail.props.sourceOut, 9);
  assert.equal(otherTrack.props.start, 9);
  f.history.undo();
  assert.equal(tail.props.start, 6);
  assert.equal(tail.props.end, 10);
  assert.equal(f.world.query(Selected).length, 2);
  f.world.destroy();
});

test('split keeps sequential clips on one track and undoes without losing their source range', () => {
  const f = fixture();
  const track = f.add('Sequence', {}, f.scene);
  const clip = f.add('Rect', { start: 2, end: 8, sourceIn: 3, selected: true }, track);
  f.add('Rect', { start: 9, end: 11 }, track);
  f.seek(5);
  f.press('e');
  assert.equal(clip.props.end, 5);
  const selected = f.world.query(Selected);
  assert.equal(selected.length, 1);
  const copy = selected[0].get(Host)!;
  assert.equal(copy.props.start, 5);
  assert.equal(copy.props.sourceIn, 6);
  assert.equal(copy.props.end, 8);
  assert.equal(copy.parent, track);
  f.history.undo();
  assert.equal(clip.props.end, 8);
  assert.equal(track.children.length, 2);
  f.world.destroy();
});


test('Z fits the viewer while Ctrl+Z still undoes the preceding edit', () => {
  const f = fixture();
  f.world.set(RenderSurface, { canvas: new Element() as unknown as HTMLCanvasElement });
  f.editor.editProperty(f.scene.entity, 'width', 1920);
  f.editor.editProperty(f.scene.entity, 'height', 1080);
  const clip = f.add('Rect', { start: 0, end: 6, selected: true }, f.scene);
  f.seek(2);
  f.press('w');
  setCameraMatrix(f.world, [2, 0, 0, 2, 200, 300]);
  transformSystem(f.world);
  f.press('z');
  const fitted = getCameraMatrix(f.world);
  assert.ok(fitted[0] > 0 && fitted[0] < 1);
  assert.equal(clip.props.end, 2, 'Z does not undo a clip edit');
  f.press('z', 'mod');
  assert.equal(clip.props.end, 6);
  assert.deepEqual(getCameraMatrix(f.world), fitted, 'view changes stay out of edit history');
  f.world.destroy();
});

test('Shift+Z fits only the focused timeline without moving the playhead or stage camera', () => {
  const f = fixture();
  const { TimelineSurface, Timeline, timelineEditing } = module.exports;
  f.world.add(TimelineSurface);
  const surface = f.world.get(TimelineSurface)!;
  surface.canvas = new Element() as HTMLCanvasElement;
  surface.layout.width = 800;
  f.scene.entity.add(Timeline({ resolution: 2, scrollX: 100 }));
  f.scene.entity.set(Computed, { end: 900, localTime: 150 });
  const camera = getCameraMatrix(f.world);
  f.press('z', 'shift');
  assert.equal(f.scene.entity.get(Timeline)?.resolution, 2, 'unfocused timeline is unchanged');
  timelineEditing(f.world).focused = true;
  f.press('z', 'shift');
  assert.equal(f.scene.entity.get(Timeline)?.resolution, 784 / 900);
  assert.equal(f.scene.entity.get(Computed)?.localTime, 150);
  assert.deepEqual(getCameraMatrix(f.world), camera);
  f.world.destroy();
});
