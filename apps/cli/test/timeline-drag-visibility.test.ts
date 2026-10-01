import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { TimelineSurfaceState } from '../../web/src/engine/timeline/surface';

const built = await build({
  stdin: { contents: `
    export { createRuntimeWorld, Timeline, Computed, Cache, Keyframe, KeyframeDragOrigin, Markers } from '@diffusionstudio/runtime';
    export { createRuntimeDocument } from '@diffusionstudio/reconciler';
    export { SOURCE_ATTR } from '@diffusionstudio/jsx';
    export { getEditHistory } from '../history';
    export { createPointer } from './pointer';
    export { updateDragGestures } from './drag';
    export { renderKeyframeTrack } from './render/keyframes';
    export { renderMarkers } from './render/markers';
  `, resolveDir: fileURLToPath(new URL('../../web/src/engine/timeline/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  logOverride: { 'empty-import-meta': 'silent' }, external: ['@/utils'],
});

type API = Pick<typeof import('@diffusionstudio/runtime'), 'createRuntimeWorld' | 'Timeline' | 'Computed' | 'Cache' | 'Keyframe' | 'KeyframeDragOrigin' | 'Markers'>
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & typeof import('../../web/src/engine/timeline/pointer')
  & Pick<typeof import('../../web/src/engine/timeline/drag'), 'updateDragGestures'>
  & typeof import('../../web/src/engine/timeline/render/keyframes')
  & typeof import('../../web/src/engine/timeline/render/markers');

class Matrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  scaleSelf() { return this; }
  translateSelf() { return this; }
  translate() { return this; }
}
class Element { width = 1280; height = 720; }
const module = { exports: {} as API };
runInThisContext(`(function(require,module,exports,HTMLCanvasElement,HTMLElement,Element,DOMRect,DOMMatrix,window){"use strict";${built.outputFiles[0].text}\n})`)(
  () => ({ assert, clamp: (value: number, min: number, max: number) => Math.max(min, Math.min(value, max)) }),
  module, module.exports, Element, Element, Element, Element, Matrix, { devicePixelRatio: 1 },
);
const runtime = module.exports;
const { createRuntimeDocument, SOURCE_ATTR, getEditHistory, createPointer, updateDragGestures, renderKeyframeTrack, renderMarkers } = module.exports;

function fixture(kind: 'keyframe' | 'marker') {
  const world = runtime.createRuntimeWorld('timeline-drag-visibility');
  const document = createRuntimeDocument(world);
  let counter = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `drag.tsx:${++counter}`);
    for (const [name, value] of Object.entries(props)) document.setProperty(node, name, value);
    document.insertNode(parent, node);
    return node;
  };
  const scene = add('Scene', { active: true, end: 30, markers: [{ id: 'marker', name: 'Marker', time: 6 }] });
  scene.entity.add(runtime.Timeline);
  scene.entity.set(runtime.Timeline, { resolution: 1, scrollX: 0, transform: new Matrix() as unknown as DOMMatrix });
  const clip = add('Rect', { end: 30 }, scene);
  clip.entity.set(runtime.Computed, { origin: 0, playbackRate: 1 });
  const track = add('KeyframeTrack', { property: 'opacity' }, clip);
  const keyframe = add('Keyframe', { time: 6, value: 1 }, track);
  track.entity.set(runtime.Cache, { keyframes: [keyframe.entity] });
  const history = getEditHistory(world);
  const transform = new Matrix();
  const context = new Proxy({ getTransform: () => transform }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
  const canvas = { width: 360, height: 100, getBoundingClientRect: () => ({ left: 0, top: 0 }) } as unknown as HTMLCanvasElement;
  const surface = {
    canvas, ctx: context, layout: { width: 360, height: 100 }, marquee: null,
    colors: { border: { ring: '#fff' }, background: {} },
  } as unknown as TimelineSurfaceState;
  const pointer = createPointer(surface);
  surface.pointer = pointer;
  const y = kind === 'keyframe' ? 16 : 29;
  const event = (x: number) => ({ clientX: x, clientY: y, button: 0, shiftKey: false, altKey: false }) as PointerEvent;
  const value = () => kind === 'keyframe' ? keyframe.entity.get(runtime.Keyframe)!.time : scene.entity.get(runtime.Markers)!.value[0]!.time;
  const draw = () => {
    updateDragGestures(world, surface);
    if (kind === 'keyframe') renderKeyframeTrack(world, scene.entity, surface, track.entity, { top: 0, height: 32 });
    else renderMarkers(world, scene.entity, surface);
    pointer.reset();
  };
  const down = (x: number) => {
    pointer.move(event(x)); draw(); draw();
    history.beginGesture(); pointer.down(event(x)); draw();
  };
  const move = (x: number) => { pointer.move(event(x)); draw(); };
  const up = (x: number) => {
    pointer.up(event(x)); draw(); updateDragGestures(world, surface); history.endGesture();
  };
  const cancel = () => { pointer.cancel(); history.cancelGesture(); updateDragGestures(world, surface); draw(); };
  return { world, history, down, move, up, cancel, value };
}

for (const kind of ['keyframe', 'marker'] as const) {
  test(`${kind} drag follows the pointer back from outside the viewport, releases, and undoes as one edit`, () => {
    const f = fixture(kind);
    try {
      f.down(180);
      f.move(600);
      assert.equal(f.value(), 600);
      f.move(120);
      assert.equal(f.value(), 120, 'a culled target remains attached to the drag');
      f.move(650);
      f.up(700);
      assert.equal(f.value(), 700, 'release consumes the final pointer position outside the viewport');
      f.move(100);
      assert.equal(f.value(), 700, 'the released target stops following the pointer');
      f.history.undo();
      assert.equal(f.value(), 180);
      assert.equal(f.history.canUndo(), false, 'all moves belong to one undo step');
      f.history.redo();
      assert.equal(f.value(), 700);
    } finally { f.world.destroy(); }
  });

  test(`${kind} drag cancellation restores its time and clears the offscreen gesture`, () => {
    const f = fixture(kind);
    try {
      f.down(180);
      f.move(600);
      f.cancel();
      assert.equal(f.value(), 180);
      assert.equal(f.history.canUndo(), false);
      f.move(120);
      assert.equal(f.value(), 180);
      f.down(180);
      f.move(120);
      f.up(120);
      assert.equal(f.value(), 120, 'a new drag does not inherit the canceled origin');
    } finally { f.world.destroy(); }
  });
}
