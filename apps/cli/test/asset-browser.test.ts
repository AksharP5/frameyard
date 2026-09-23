import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { transformAsync } from '@babel/core';
import { transform } from 'esbuild';
import type { Asset } from '@diffusionstudio/assets';
import type { LazyAssetItemProps } from '../../web/src/components/sidebar-left/asset-item.tsx';
import type { FolderItemProps } from '../../web/src/components/sidebar-left/folder-item.tsx';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const path = new URL('../../web/src/components/sidebar-left/assets.tsx', import.meta.url);
const jsx = await transformAsync(await readFile(path, 'utf8'), {
  filename: path.pathname, babelrc: false, configFile: false,
  presets: [
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
    ['babel-preset-solid', { generate: 'universal', moduleName: 'test-renderer' }],
  ],
});
assert.ok(jsx?.code);
const compiled = await transform(jsx.code, { format: 'cjs' });

function fixture() {
  type Props = Record<string, unknown>;
  const elements: Element[] = [];
  const tiles = new Map<string, LazyAssetItemProps>();
  const folders = new Map<string, FolderItemProps>();
  const removed: string[] = [];
  const errors: string[] = [];
  const basename = (path: string) => path.split('/').at(-1)!;
  const dirname = (path: string) => path.split('/').slice(0, -1).join('/');
  const [selected, setSelected] = solid.createSignal<string | null>(null);
  const assets = ['alpha.wav', 'beta.wav', 'gamma.wav', 'folder/inside.wav'].map((path): Asset => ({
    id: path, path, source: path, type: 'AUDIO', mimeType: 'audio/wav', createdAt: '', duration: 1,
    handle: { getFile: async () => new File([], basename(path)) },
  }));
  const library = {
    list: () => assets,
    partials: () => [],
    get: (id: string) => assets.find(asset => asset.id === id),
    getPartial: () => undefined,
    folders: () => new Set(['folder']),
    childrenOf: (folder: string) => ({ folders: folder ? [] : ['folder'], assets: assets.filter(asset => dirname(asset.path) === folder), partials: [] }),
    remove: async (assets: Asset[]) => { removed.push(...assets.map(asset => asset.id)); },
  };
  class Element {
    props: Props = {};
    isContentEditable = false;
    focus() {}
    querySelectorAll() { return [...tiles.keys()].map(id => ({ dataset: { assetId: id }, scrollIntoView() {} })); }
  }
  class Input extends Element {}
  const component = (props: { children?: unknown }) => props.children;
  const renderer = {
    createElement(tag: string) { const element = tag === 'input' ? new Input() : new Element(); elements.push(element); return element; },
    createTextNode: (value: string) => value,
    setProp(element: Element, name: string, value: unknown) { element.props[name] = value; return value; },
    insert() {}, insertNode() {},
    createComponent: solid.createComponent, effect: solid.createRenderEffect,
    memo: solid.createMemo, mergeProps: solid.mergeProps,
  };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid, 'test-renderer': renderer,
    '@diffusionstudio/assets': { basename, dirname },
    '@/context/prompt-input': { usePromptInput: () => ({ openPromptInput() {} }) },
    '@/context/layout': { useLayout: () => ({ setLibraryOpen() {} }) },
    '@/agent-chat': { SidebarTabs() {} },
    '@/components/genai/prompt-input': { createDefaultConfig() {} },
    '../ui/button': { Button: component }, '../ui/icon': { Icon() {} },
    '../ui/dropdown-menu': new Proxy({}, { get: () => component }),
    '@/components/ui/tooltip': new Proxy({}, { get: () => component }),
    '../ui/breadcrumbs': new Proxy({}, { get: () => component }),
    './asset-item': { LazyAssetItem(props: LazyAssetItemProps) { tiles.set(props.asset.id, props); solid.onCleanup(() => tiles.delete(props.asset.id)); } },
    './asset-preview': { AssetImagePreview() {} },
    './folder-item': { FolderItem(props: FolderItemProps) { folders.set(props.path, props); solid.onCleanup(() => folders.delete(props.path)); } },
    '@/engine/library': { useLibrary: () => () => library },
    '@/engine/hooks': { useAssetSelection: () => ({ id: selected, select: setSelected }) },
    '@/engine/asset-actions': {},
    '@/utils': { isInputTarget: () => false },
    '@/lib/local-mode': { localMode: true },
    'somoto': { toast: Object.assign(() => {}, { error: (_message: string, detail: { description: string }) => errors.push(detail.description) }) },
  };
  const module = { exports: {} as typeof import('../../web/src/components/sidebar-left/assets.tsx') };
  runInNewContext(compiled.code, {
    module, exports: module.exports, require: (name: string) => dependencies[name],
    Element, HTMLInputElement: Input, HTMLTextAreaElement: class extends Element {}, Error,
    window: { addEventListener() {}, removeEventListener() {} },
  });
  const dispose = solid.createRoot(dispose => { module.exports.Assets(); return dispose; });
  const root = elements.find(element => element.props.tabIndex === 0)!;
  function key(key: string, target: object = root) {
    const event = {
      key, target, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    (root.props.onKeyDown as (event: object) => void)(event);
    return event;
  }
  function search(value: string) {
    const input = elements.find(element => element.props['aria-label'] === 'Search media')!;
    (input.props.onInput as (event: object) => void)({ currentTarget: { value } });
  }
  const input = elements.find(element => element.props['aria-label'] === 'Search media')!;
  return { selected, tiles, folders, removed, errors, library, input, dispose, key, search };
}

test('asset keyboard navigation starts with the first visible tile and clears hidden selection', () => {
  const f = fixture();
  try {
    f.key('ArrowDown');
    assert.equal(f.selected(), 'alpha.wav');
    f.key('ArrowRight');
    assert.equal(f.selected(), 'beta.wav');
    f.search('alpha');
    assert.equal(f.selected(), null, 'search must not leave a hidden asset selected');
    const deletion = f.key('Delete');
    assert.deepEqual(f.removed, [], 'Delete must never remove a hidden selection');
    assert.ok(deletion.defaultPrevented && deletion.propagationStopped, 'an empty asset selection must not pass Delete to timeline shortcuts');
    f.key('ArrowDown');
    assert.equal(f.selected(), 'alpha.wav');
    f.search('');
    f.folders.get('folder')!.onOpen();
    assert.equal(f.selected(), null, 'opening another folder clears the previous folder selection');
    f.key('Delete');
    assert.deepEqual(f.removed, []);
    f.key('ArrowRight');
    assert.equal(f.selected(), 'folder/inside.wav');
  } finally { f.dispose(); }
});

test('asset commands require grid focus and a failed deletion is reported', async () => {
  const f = fixture();
  try {
    f.tiles.get('alpha.wav')!.onSelect();
    const typing = f.key('Delete', f.input);
    assert.equal(typing.defaultPrevented, false, 'Delete still edits the search field');
    assert.equal(typing.propagationStopped, true);
    assert.equal(f.key('Delete', { tagName: 'BUTTON' }).propagationStopped, true);
    assert.deepEqual(f.removed, [], 'typing or using toolbar controls must not delete assets');
    f.library.remove = async () => { throw new Error('The asset is unavailable'); };
    f.key('Delete');
    await setImmediate();
    assert.deepEqual(f.errors, ['The asset is unavailable']);
  } finally { f.dispose(); }
});
