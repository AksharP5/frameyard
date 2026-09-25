import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import { getClipRowHeight } from '../../web/src/engine/timeline/config.ts';
import type { Entity } from 'koota';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/components/timeline/layers/node.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view',
  plugins: [{ name: 'layer-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

function fixture() {
  const edits: { name: string; value: string | number }[] = [];
  const document = new EventTarget();
  const traits = new Map<string, { value: string | number }>([['Name', { value: 'Original' }]]);
  const [version, setVersion] = solid.createSignal(0);
  const resized = solid.createSignal<Entity | null>(null);
  const entity = { get: (trait: string) => traits.get(trait), has: () => false, isAlive: () => true };
  const runtime: Record<string, unknown> = {
    ...Object.fromEntries(['Audio', 'ClipHeight', 'ClipLink', 'Expanded', 'Hidden', 'Hovering', 'Locked', 'Muted', 'Name', 'Selected', 'Soloed'].map(name => [name, name])),
    ...Object.fromEntries(['isAdjustmentLayer', 'isCaption', 'isGroup', 'isMask', 'isScene', 'isSequence', 'isText'].map(name => [name, () => false])),
    findGeometryAsset: () => undefined,
  };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid,
    '@diffusionstudio/runtime': runtime,
    '@diffusionstudio/koota-solid': {
      useWorld: () => ({}), useTag: () => () => false,
      useTrait: (_target: unknown, trait: string) => () => { version(); return traits.get(trait); },
    },
    '@/engine/hooks': { useEditor: () => ({ editProperty(_entity: unknown, name: string, value: string | number) {
      edits.push({ name, value });
      traits.set(name === 'name' ? 'Name' : 'ClipHeight', { value });
      setVersion(value => value + 1);
    } }) },
    '@/engine/clip-links': { isClipLocked: () => false, linkableSelection: () => [] },
    '@/engine/insert-asset': { canSeparateAudio: () => false },
    '@/engine/timeline-editing': { timelineEditing: () => ({ target: () => null, syncTracks: () => new Set() }) },
    '@/engine/timeline': { DEFAULT_CLIP_HEIGHT: 40, MIN_CLIP_HEIGHT: 28, MAX_CLIP_HEIGHT: 120, getClipRowHeight, getClipFallbackName: () => 'Clip' },
    './context': { useLayerContext: () => ({ resized, drag: { dragging: () => null } }) },
    './config': { NESTED_INDENT_PX: 20 },
  };
  let startRename!: () => void;
  let startResize!: (event: PointerEvent) => void;
  let closeMenuFocus: ((event: Event) => void) | undefined;
  let inputHandlers!: { onInput?(event: InputEvent): void; onBlur(event: FocusEvent): void; onKeyDown(event: KeyboardEvent): void };
  const input = { value: '', blur() { inputHandlers.onBlur({ currentTarget: input } as unknown as FocusEvent); } };
  const view = (tag: unknown, props: Record<string, unknown> | null) => {
    if (tag === 'input') inputHandlers = props as unknown as typeof inputHandlers;
    if (tag === 'ContextMenuContent') closeMenuFocus = props?.onCloseAutoFocus as typeof closeMenuFocus;
    if (tag === 'span' && props?.onDblClick) startRename = props.onDblClick as typeof startRename;
    if (String(props?.class).includes('cursor-ns-resize')) startResize = props!.onPointerDown as typeof startResize;
  };
  const module = { exports: {} as typeof import('../../web/src/components/timeline/layers/node.tsx') };
  runInThisContext(`(function(require,module,exports,view,document){"use strict";${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? new Proxy({}, { get: (_target, key) => key }), module, module.exports, view, document,
  );
  const dispose = solid.createRoot((dispose) => {
    module.exports.NodeLayer({ layer: { kind: 'geometry', entity: entity as unknown as Entity, children: [], expanded: false, expandable: false }, now: () => 0, selected: () => false, depth: 0, expanded: false, ancestorSelected: false });
    return dispose;
  });
  function pointer(type: string, clientY: number, button = 0) {
    return Object.assign(new Event(type), { clientY, button }) as PointerEvent;
  }
  return { edits, dispose, resized: resized[0], startRename, input,
    closeMenu() {
      const event = new Event('closeAutoFocus', { cancelable: true });
      closeMenuFocus?.(event);
      if (!event.defaultPrevented) input.blur();
    },
    type(value: string) { input.value = value; inputHandlers.onInput?.({ currentTarget: input } as unknown as InputEvent); },
    key(key: string, isComposing = false) {
      inputHandlers.onKeyDown({ key, isComposing, currentTarget: input, stopPropagation() {}, preventDefault() {} } as unknown as KeyboardEvent);
    },
    resize(button = 0) { startResize(pointer('pointerdown', 100, button)); },
    move(clientY: number) { document.dispatchEvent(pointer('pointermove', clientY)); },
    cancel() { document.dispatchEvent(new Event('pointercancel')); },
    release() { document.dispatchEvent(new Event('pointerup')); },
  };
}

test('a layer rename writes once on completion and Escape or an empty draft leaves the source untouched', () => {
  const f = fixture();
  try {
    f.startRename();
    for (const draft of ['', 'N', 'Ne', 'New name']) f.type(draft);
    f.closeMenu();
    assert.deepEqual(f.edits, [], 'typing a local name draft does not save or create undo steps');
    f.key('Enter', true);
    assert.deepEqual(f.edits, [], 'IME confirmation does not finish the rename');
    f.key('Enter');
    f.input.blur();
    assert.deepEqual(f.edits, [{ name: 'name', value: 'New name' }]);
    f.startRename(); f.type('Cancelled'); f.key('Escape'); f.input.blur();
    f.startRename(); f.type('   '); f.input.blur();
    assert.equal(f.edits.length, 1, 'cancelled and empty drafts do not modify the source');
  } finally { f.dispose(); }
});

test('row resizing ignores other buttons, ends on cancellation or unmount, and skips unchanged heights', () => {
  const f = fixture();
  try {
    f.resize(2); f.move(120);
    assert.equal(f.resized(), null, 'right-clicking the resize edge must not capture the row');
    assert.deepEqual(f.edits, []);
    f.resize(); f.move(110); f.move(110);
    assert.deepEqual(f.edits, [{ name: 'clipHeight', value: 50 }]);
    f.cancel();
    assert.equal(f.resized(), null, 'pointer cancellation restores row controls');
    f.move(130);
    assert.equal(f.edits.length, 1);
    f.resize(); f.dispose(); f.move(140);
    assert.equal(f.resized(), null, 'unmount releases the shared resize state');
    assert.equal(f.edits.length, 1, 'a removed row no longer receives resize edits');
  } finally { f.dispose(); }
});
