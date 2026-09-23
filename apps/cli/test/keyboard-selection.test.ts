import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const engineBuild = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/create-engine.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'engine-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => args.kind === 'entry-point' ? undefined : { path: args.path, external: true });
  } }],
});
const editorBuild = await build({
  stdin: { contents: `
    export * from '@diffusionstudio/runtime';
    export { createRuntimeDocument } from '@diffusionstudio/reconciler';
    export { SOURCE_ATTR } from '@diffusionstudio/jsx';
    export { getDocumentEditor } from './editor';
    export { getEditHistory } from './history';
    export { shortcutSystem } from './input/shortcuts';
    export * from './traits';
    export { TimelineSurface } from './timeline/surface';
    export { createPointer } from './timeline/pointer';
  `, resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  alias: { '@/utils': fileURLToPath(new URL('../../web/src/utils/common.ts', import.meta.url)) },
  jsx: 'transform', jsxFactory: 'clipJsx', logOverride: { 'empty-import-meta': 'silent' },
  plugins: [{ name: 'unused-ui-actions', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/group|\.\/interactions|\.\/timeline)$/ }, ({ path, importer }) => {
      if (importer.endsWith('/input/shortcuts.ts') || importer.endsWith('/split.tsx')) return { path, namespace: 'unused-ui' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'unused-ui' }, () => ({ contents: `
      export const groupSelection=unused, ungroupSelection=unused, unwrapSequenceSelection=unused,
        wrapSelectionInScene=unused, wrapSelectionInSequence=unused, editTransform=unused;
      export function cloneFramesForSplit() {} export function clonePeaksForSplit() {}
      function unused() { throw new Error('Unexpected UI action'); }
    ` }));
  } }],
});
type API = typeof import('@diffusionstudio/runtime')
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../web/src/engine/input/shortcuts'), 'shortcutSystem'>
  & typeof import('../../web/src/engine/traits')
  & Pick<typeof import('../../web/src/engine/timeline/surface'), 'TimelineSurface'>
  & Pick<typeof import('../../web/src/engine/timeline/pointer'), 'createPointer'>;
class Rectangle { x = 0; y = 0; left = 0; top = 0; width = 800; height = 500; }
const editorModule = { exports: {} as API };
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,DOMRect,window,clipJsx){"use strict";${editorBuild.outputFiles[0].text}\n})`)(
  editorModule, editorModule.exports, Rectangle, Rectangle, Rectangle, Rectangle, { devicePixelRatio: 1 },
  (component: (props: object) => unknown, props: object) => component(props),
);
const api = editorModule.exports;

function fixture() {
  let active: Element | null = null;
  class Element extends EventTarget {
    tabIndex = -1;
    isContentEditable = false;
    style = {};
    focus() { active = this; }
    closest() { return null; }
    getBoundingClientRect() { return new Rectangle(); }
  }
  class Input extends Element {}
  class TextArea extends Element {}
  class Select extends Element {}
  class Canvas extends Element {
    parentElement = new Element();
    getContext() { return null; }
  }
  const window = new EventTarget();
  let frame: (() => void) | undefined;
  let timelineInput = () => {};
  const noop = () => {};
  const dependencies: Record<string, unknown> = {
    '@diffusionstudio/runtime': { ...api, assetSystem: noop, renderSystem: noop, transformSystem: noop,
      playbackSystem: noop, motionSystem: noop, syncInteractiveState: noop },
    'solid-js': { createSignal<T>(value: T) { return [() => value, (next: T | ((current: T) => T)) => {
      value = typeof next === 'function' ? (next as (current: T) => T)(value) : next;
    }]; } },
    './traits': api,
    './hud': { hudSystem: noop },
    './input/input-system': { inputSystem: noop },
    './input/shortcuts': api,
    './source-errors': { sourceErrorSystem: noop },
    './timeline': { TimelineSurface: api.TimelineSurface, timelineSystem: () => timelineInput(),
      clearClipFrames: noop, clearClipPeaks: noop, clearMedia: noop, clearPeaks: noop },
  };
  const engineModule = { exports: {} as typeof import('../../web/src/engine/create-engine') };
  runInThisContext(`(function(require,module,exports,window,ResizeObserver,HTMLElement,HTMLInputElement,HTMLTextAreaElement,HTMLSelectElement,requestAnimationFrame,cancelAnimationFrame,setTimeout,clearTimeout){${engineBuild.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name], engineModule, engineModule.exports, window,
    class { observe() {} disconnect() {} }, Element, Input, TextArea, Select,
    (next: () => void) => { frame = next; return 1; }, noop, () => 1, noop,
  );
  const audio = { createGain: () => ({ connect() {}, disconnect() {} }), destination: {} } as unknown as AudioContext;
  const engine = engineModule.exports.createEngine('keyboard-selection', { audioContext: audio });
  const world = engine.world;
  const document = api.createRuntimeDocument(world);
  document.setProperty(document.stage, api.SOURCE_ATTR, 'keyboard.tsx:0');
  const canvas = new Canvas();
  engine.mount(canvas as unknown as HTMLCanvasElement);
  engine.start();
  const editor = api.getDocumentEditor(world);
  const history = api.getEditHistory(world);
  let id = 0;
  const add = (tag: string, props: Record<string, unknown> = {}, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, api.SOURCE_ATTR, `keyboard.tsx:${++id}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    return node;
  };
  const scene = add('Scene', { active: true, end: 10 });
  const key = (value: string, target: Element | null = active, type = 'keydown') => {
    const event = Object.assign(new Event(type, { cancelable: true }), { key: value, repeat: false, isComposing: false });
    Object.defineProperty(event, 'target', { value: target });
    window.dispatchEvent(event);
    return event;
  };
  return { world, canvas, editor, history, scene, add, key,
    input: new Input(), textarea: new TextArea(), select: new Select(), editable: Object.assign(new Element(), { isContentEditable: true }),
    active: () => active,
    tick() { assert.ok(frame); frame(); },
    click() { canvas.dispatchEvent(Object.assign(new Event('pointerdown', { cancelable: true }), { button: 0, clientX: 0, clientY: 0 })); },
    timelineClick(node: ReturnType<typeof add>) {
      const pointer = api.createPointer({
        canvas: canvas as unknown as HTMLCanvasElement,
        ctx: { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) } as unknown as CanvasRenderingContext2D,
      });
      world.get(api.TimelineSurface)!.pointer = pointer;
      timelineInput = () => {
        const hit = pointer.scope('clip').region(0, 0, 100, 30);
        if (hit.pressed || hit.clicked) editor.select(node.entity);
        pointer.reset();
      };
      pointer.move({ clientX: 50, clientY: 15, shiftKey: false, altKey: false } as PointerEvent);
      timelineInput();
      pointer.down({ clientX: 50, clientY: 15, button: 0, shiftKey: false, altKey: false } as PointerEvent);
    },
    dispose() { engine.dispose(); },
  };
}

test('clicking the canvas returns Delete from text editing to selected rectangles and frames, with undo', () => {
  const f = fixture();
  try {
    const rect = f.add('Rect', {}, f.scene);
    f.editor.select(rect.entity);
    for (const field of [f.input, f.textarea, f.select, f.editable]) {
      field.focus();
      assert.equal(f.key('Delete').defaultPrevented, false);
      f.tick();
      assert.equal(rect.entity.isAlive(), true, 'Delete inside an input belongs to the input');
    }
    f.click();
    assert.equal(f.active(), f.canvas, 'canvas selection must leave the previous text field');
    assert.equal(f.key('Delete').defaultPrevented, true);
    f.key('Delete', f.canvas, 'keyup');
    f.tick();
    assert.equal(rect.entity.isAlive(), false);
    f.history.undo();
    assert.equal(f.scene.children.length, 1);
    f.editor.select(f.scene.entity);
    f.key('Backspace'); f.tick();
    assert.equal(f.scene.entity.isAlive(), false);
    f.history.undo();
    assert.equal(f.world.query(api.Scene).length, 1);
  } finally { f.dispose(); }
});

test('Delete follows a timeline click queued in the same frame and preserves locked selections', () => {
  const f = fixture();
  try {
    const previous = f.add('Rect', {}, f.scene);
    const clicked = f.add('Text', {}, f.scene);
    f.editor.select(previous.entity);
    f.timelineClick(clicked);
    f.key('Delete', f.canvas); f.tick();
    assert.equal(previous.entity.isAlive(), true, 'the previously selected layer must survive');
    assert.equal(clicked.entity.isAlive(), false, 'Delete targets the pending pointer selection');
    f.history.undo();
    const locked = f.add('Rect', { locked: true }, f.scene);
    f.editor.select(locked.entity);
    f.key('Delete', f.canvas); f.tick();
    assert.equal(locked.entity.isAlive(), true);
  } finally { f.dispose(); }
});
