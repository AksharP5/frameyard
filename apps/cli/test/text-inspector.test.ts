import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { transformAsync } from '@babel/core';
import { build, transform } from 'esbuild';
import type { ComponentProps } from 'solid-js';
import type { SelectProps } from '../../web/src/components/ui/select.tsx';

const runtimeBuild = await build({
  stdin: {
    contents: `
      import { createRuntimeWorld, Chars, Cache, Color, Computed, FONT_WEIGHTS, Size, Source,
        TextAlign, TextBaseline, TextStyle, Tool, ToolType, WebFonts, getWebFonts,
        isCaption, isText, loadWebFont, colorToHex } from '@diffusionstudio/runtime';
      export const runtime = { createRuntimeWorld, Chars, Cache, Color, Computed, FONT_WEIGHTS, Size, Source,
        TextAlign, TextBaseline, TextStyle, Tool, ToolType, WebFonts, getWebFonts,
        isCaption, isText, loadWebFont, colorToHex };
      export * as solid from 'solid-js';
      export * as kootaSolid from '@diffusionstudio/koota-solid';
      export * as keyframes from './keyframes';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from './history';
      export { getDocumentEditor } from './editor';
    `,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  jsx: 'transform', jsxFactory: 'view', logOverride: { 'empty-import-meta': 'silent' },
});
const engine = { exports: {} as {
  runtime: typeof import('@diffusionstudio/runtime');
  solid: typeof import('solid-js');
  kootaSolid: typeof import('@diffusionstudio/koota-solid');
  keyframes: typeof import('../../web/src/engine/keyframes.tsx');
} & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'> };
class Element { width = 1280; height = 720; }
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,view){"use strict";${runtimeBuild.outputFiles[0].text}\n})`)(
  engine, engine.exports, Element, Element, Element,
  (component: (props: object) => unknown, props: object) => component(props),
);
const { runtime, solid, kootaSolid, createRuntimeDocument, SOURCE_ATTR, getDocumentEditor, getEditHistory, keyframes } = engine.exports;

const path = new URL('../../web/src/components/sidebar-right/inspector/text.tsx', import.meta.url);
const jsx = await transformAsync(await readFile(path, 'utf8'), {
  filename: path.pathname, babelrc: false, configFile: false,
  presets: [
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
    ['babel-preset-solid', { generate: 'universal', moduleName: 'test-renderer' }],
  ],
});
assert.ok(jsx?.code);
const panelCode = await transform(jsx.code, { format: 'cjs' });

type Controls = {
  GrowingTextArea: ComponentProps<typeof import('../../web/src/components/sidebar-right/inspector/text.tsx').GrowingTextArea>;
  FontDropdown: ComponentProps<typeof import('../../web/src/components/sidebar-right/inspector/text.tsx').FontDropdown>;
  ColorOpacityRow: ComponentProps<typeof import('../../web/src/components/ui/color-opacity-row.tsx').ColorOpacityRow>;
  'Font size': ComponentProps<typeof import('../../web/src/components/ui/text-field.tsx').ControlledTextField>;
  Select: SelectProps<string>;
};

function fixture(paint: 'color' | 'fill' = 'color') {
  const world = runtime.createRuntimeWorld('text-inspector');
  const document = createRuntimeDocument(world);
  const scene = document.createElement('Scene');
  document.setProperty(scene, SOURCE_ATTR, 'text.tsx:1');
  document.insertNode(document.stage, scene);
  const add = (source: string, text: string) => {
    const node = document.createElement('Text');
    document.setProperty(node, SOURCE_ATTR, source);
    for (const [name, value] of Object.entries({ fontFamily: 'Inter', fontSize: 48, fontWeight: 400, [paint]: '#123456' })) document.setProperty(node, name, value);
    document.insertNode(scene, node);
    document.setText(node.entity, text);
    return node;
  };
  const selected = add('text.tsx:2', 'Original title');
  const other = add('text.tsx:3', 'Other title');
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  const controls = new Map<string, unknown>();
  const capture = (name: string) => (props: Record<string, unknown>) => {
    controls.set(String(props['aria-label'] ?? name), props);
    return props.children;
  };
  const ui = new Proxy({}, { get: (_target, name) => capture(String(name)) });
  const module = { exports: {} as typeof import('../../web/src/components/sidebar-right/inspector/text.tsx') };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid,
    '@diffusionstudio/runtime': runtime,
    '@diffusionstudio/koota-solid': kootaSolid,
    '@/engine/hooks': { useEditor: () => editor, useTool: () => () => runtime.ToolType.MOVE, useDerived: <T>(read: () => T) => read },
    '@/engine/hooks/use-document': { useDocument: () => () => document },
    '@/engine/history': { getEditHistory },
    '@/engine/keyframes': keyframes,
    'test-renderer': {
      createComponent(component: (props: object) => unknown, props: object) {
        if (component === module.exports.FontDropdown || component === module.exports.GrowingTextArea) {
          controls.set(component.name, props);
          return;
        }
        return solid.createComponent(component, props);
      },
      createElement: () => ({}), createTextNode: (text: string) => text,
      setProp() {}, insert() {}, insertNode() {},
      effect: solid.createRenderEffect, memo: solid.createMemo, mergeProps: solid.mergeProps,
    },
  };
  runInThisContext(`(function(require,module,exports){${panelCode.code}\n})`)(
    (name: string) => dependencies[name] ?? ui, module, module.exports,
  );
  const dispose = solid.createRoot(dispose => {
    solid.createComponent(kootaSolid.WorldProvider, {
      world,
      get children() { return module.exports.TextPanel({ selection: [selected.entity] }); },
    });
    return dispose;
  });
  return { selected, other, editor, history,
    control<K extends keyof Controls>(name: K): Controls[K] {
      assert.ok(controls.has(name), `${name} must be available in the text inspector`);
      return controls.get(name) as Controls[K];
    },
    dispose() { dispose(); world.destroy(); },
  };
}

test('text color edits preserve the authored color or fill spelling and undo on the selected layer', () => {
  for (const paint of ['color', 'fill'] as const) {
    const f = fixture(paint);
    try {
      f.control('ColorOpacityRow').onChangeColor!(0xc0ffee);
      assert.equal(f.selected.props[paint], '#C0FFEE');
      assert.equal(f.selected.props[paint === 'color' ? 'fill' : 'color'], undefined);
      assert.equal(f.other.props[paint], '#123456');
      f.history.undo();
      assert.equal(f.selected.props[paint], '#123456');
    } finally { f.dispose(); }
  }
});

test('consecutive typing coalesces by text source and font size changes undo independently', async () => {
  const f = fixture();
  try {
    const text = f.control('GrowingTextArea');
    text.onFocus!();
    text.onInput('Revised');
    await Promise.resolve();
    text.onInput('Revised title');
    text.onBlur!();
    assert.equal(f.selected.entity.get(runtime.Chars)?.value, 'Revised title');
    assert.equal(f.other.entity.get(runtime.Chars)?.value, 'Other title');
    f.history.undo();
    assert.equal(f.selected.entity.get(runtime.Chars)?.value, 'Original title');
    assert.equal(f.history.canUndo(), false);
    f.history.redo();
    assert.equal(text.value, 'Revised title');
    f.editor.editText(f.other.entity, 'Another title');
    await Promise.resolve();
    f.history.undo();
    assert.equal(f.other.entity.get(runtime.Chars)?.value, 'Other title');
    assert.equal(text.value, 'Revised title', 'typing into another layer is a separate undo step');
    f.control('Font size').onNumber!(72);
    assert.equal(f.selected.props.fontSize, 72);
    assert.equal(f.other.props.fontSize, 48);
    f.history.undo();
    assert.equal(f.control('Font size').value, 48);
  } finally { f.dispose(); }
});

test('font hover is transient and family and weight controls follow undo and redo', () => {
  const f = fixture();
  try {
    const family = f.control('FontDropdown');
    const weight = f.control('Select');
    family.onPreview('Courier New');
    assert.equal(f.selected.entity.get(runtime.TextStyle)?.fontFamily, 'Courier New');
    assert.equal(f.selected.props.fontFamily, 'Inter');
    assert.equal(family.family, 'Inter');
    assert.equal(f.history.canUndo(), false, 'hovering must not write an edit');
    family.onPreview(family.family);
    assert.equal(f.selected.entity.get(runtime.TextStyle)?.fontFamily, 'Inter');
    family.onFamilyChange('Courier New');
    assert.equal(f.selected.props.fontFamily, 'Courier New');
    f.history.undo();
    assert.equal(family.family, 'Inter');
    f.history.redo();
    assert.equal(family.family, 'Courier New');
    weight.onChange!('700');
    assert.equal(f.selected.props.fontWeight, 700);
    f.history.undo();
    assert.equal(weight.value, '400');
    f.history.redo();
    assert.equal(weight.value, '700');
    assert.equal(f.other.props.fontFamily, 'Inter');
    assert.equal(f.other.props.fontWeight, 400);
  } finally { f.dispose(); }
});
