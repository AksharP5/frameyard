import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const [desktop, editor] = await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('../../desktop/src/projects.ts', import.meta.url))],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    external: ['electron', 'esbuild', '@babel/core', '@babel/preset-typescript', 'babel-preset-solid', 'ts-morph'],
  }),
  build({
    stdin: { contents: `
      export { createRuntimeWorld, Computed, FrameRate, Host, Source } from '@diffusionstudio/runtime';
      export { mount, renderAuthored } from '@diffusionstudio/reconciler';
      export { getDocumentEditor } from './editor';
      export { getEditHistory } from './history';
      export { trimIn, trimOut, moveEntityTo } from './timing';
      export { splitAtPlayhead } from './split';
      export { createEditWriter, flushProjectEdits, getProjectSaveState, getProjectRecovery } from '../projects/edits';
    `, resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)) },
    bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
    jsx: 'transform', jsxFactory: 'clipJsx', logOverride: { 'empty-import-meta': 'silent' },
    plugins: [{ name: 'host-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/engine\/editor$/ }, () => ({ path: fileURLToPath(new URL('../../web/src/engine/editor.ts', import.meta.url)) }));
      builder.onResolve({ filter: /^\.\/host$/ }, ({ importer }) => importer.endsWith('/projects/edits.ts') ? { path: 'project-host', external: true } : undefined);
      builder.onResolve({ filter: /^somoto$/ }, () => ({ path: 'somoto', external: true }));
      builder.onResolve({ filter: /^\.\/timeline$/ }, ({ importer }) => importer.endsWith('/split.tsx') ? { path: 'timeline-previews', namespace: 'test' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export function cloneFramesForSplit() {} export function clonePeaksForSplit() {}' }));
    } }],
  }),
]);

const hostModule = { exports: {} as Pick<typeof import('../../desktop/src/projects'), 'compileProject' | 'writeProject'> };
runInThisContext(`(function(require,module,exports){${desktop.outputFiles[0].text}\n})`)(
  (name: string) => name === 'electron' ? { app: { isPackaged: false }, dialog: {}, shell: {}, ipcMain: {} } : require(name),
  hostModule, hostModule.exports,
);

type EditorApi = Pick<typeof import('@diffusionstudio/runtime'), 'createRuntimeWorld' | 'Computed' | 'FrameRate' | 'Host' | 'Source'>
  & Pick<typeof import('@diffusionstudio/reconciler'), 'mount' | 'renderAuthored'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../web/src/engine/timing'), 'trimIn' | 'trimOut' | 'moveEntityTo'>
  & Pick<typeof import('../../web/src/engine/split'), 'splitAtPlayhead'>
  & Pick<typeof import('../../web/src/projects/edits'), 'createEditWriter' | 'flushProjectEdits' | 'getProjectSaveState' | 'getProjectRecovery'>;

const editorModule = { exports: {} as EditorApi };
const errors: string[] = [];
const storage = new Map<string, string>();
class Element {}
class Text {
  data: string;
  constructor(data: string) { this.data = data; }
  remove() {}
}
runInThisContext(`(function(require,module,exports,HTMLElement,HTMLCanvasElement,HTMLImageElement,HTMLVideoElement,Element,clipJsx,localStorage,Text,document){"use strict";${editor.outputFiles[0].text}\n})`)(
  (name: string) => {
    if (name === 'project-host') return hostModule.exports;
    if (name === 'somoto') return { toast: { error: (message: string) => errors.push(message) } };
    return require(name);
  }, editorModule, editorModule.exports, Element, Element, Element, Element, Element,
  (component: (props: object) => unknown, props: object) => component(props),
  { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key) },
  Text, { createTextNode: (data: string) => new Text(data) },
);
const api = editorModule.exports;

async function open(dir: string) {
  const compiled = await hostModule.exports.compileProject(dir);
  assert.ok(compiled.ok, compiled.ok ? undefined : compiled.error);
  const world = api.createRuntimeWorld('save-reopen');
  world.set(api.FrameRate, { value: 30 });
  const mounted = api.mount(compiled.code, world);
  const editor = api.getDocumentEditor(world);
  const writer = api.createEditWriter(dir, world);
  const unsubscribe = editor.onEdit(edit => writer.push(edit));
  const byId = (id: string) => {
    const entity = world.query(api.Source).find(entity => entity.get(api.Source)?.value === `index.tsx:${id}`);
    assert.ok(entity, `missing reopened element ${id}`);
    return entity;
  };
  return { world, editor, byId, history: api.getEditHistory(world),
    children: (id: string) => byId(id).get(api.Host)!.children.flatMap(child => child.entity.get(api.Source)?.value ?? []),
    props: (id: string) => byId(id).get(api.Host)!.props,
    save: async () => {
      await api.flushProjectEdits(world);
      assert.equal(api.getProjectSaveState(world).status, 'saved');
      assert.equal(api.getProjectRecovery(world), null);
      assert.deepEqual(errors, []);
    },
    close: () => { unsubscribe(); writer.dispose(); mounted.dispose(); world.destroy(); },
  };
}

test('clip trims, moves, split copies and property edits survive real source saves and reopening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameyard-save-reopen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage"><scene id="scene" active end={30}>
    <sequence id="track"><rect id="clip" start={2} end={8} sourceIn={3} sourceOut={9} width={100} height={80} /></sequence>
    <sequence id="destination" />
  </scene></stage>;`);
  const first = await open(dir);
  let copyId: string;
  try {
    const clip = first.byId('clip');
    api.trimIn(first.world, clip, 90);
    api.trimOut(first.world, clip, 210);
    api.moveEntityTo(first.world, clip, 120);
    first.editor.editProperty(clip, 'x', 42);
    first.editor.select(clip);
    first.byId('scene').set(api.Computed, { localTime: 180 });
    const [copy] = api.splitAtPlayhead(first.world);
    assert.ok(copy);
    first.editor.editProperty(copy, 'opacity', 0.5);
    await first.save();
    copyId = copy.get(api.Source)!.value.split(':')[1];
    assert.ok(!copyId.startsWith('pending'));
  } finally { first.close(); }

  const reopened = await open(dir);
  try {
    const { start, end, sourceIn, sourceOut, x } = reopened.props('clip');
    assert.deepEqual({ start, end, sourceIn, sourceOut, x }, { start: 4, end: 6, sourceIn: 4, sourceOut: 6, x: 42 });
    const copy = reopened.props(copyId);
    assert.deepEqual([copy.start, copy.end, copy.sourceIn, copy.sourceOut, copy.x, copy.opacity], [6, 8, 6, 8, 42, 0.5]);
    assert.ok(reopened.editor.reparent(reopened.byId(copyId), reopened.byId('destination')));
    reopened.editor.editProperty(reopened.byId(copyId), 'x', 84);
    await reopened.save();
  } finally { reopened.close(); }

  const again = await open(dir);
  try {
    assert.equal(again.props(copyId).x, 84);
    assert.equal(again.byId(copyId).get(api.Host)!.parent, again.byId('destination').get(api.Host));
    assert.equal(again.byId('track').get(api.Host)!.children.length, 1);
    const saved = await readFile(join(dir, 'index.tsx'), 'utf8');
    await again.save();
    assert.equal(await readFile(join(dir, 'index.tsx'), 'utf8'), saved, 'reopening and saving clean state must not rewrite the source');
  } finally { again.close(); }
});

test('saved split undo and deleted placement anchors preserve the reopened tree', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameyard-split-reopen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage"><scene id="scene" active end={30}>
    <rect id="clip" start={2} end={8} sourceIn={3} width={100} height={80} />
    <rect id="anchor" start={10} end={12} />
    <sequence id="track"><rect id="moving" start={14} end={16} /></sequence>
  </scene></stage>;`);
  const first = await open(dir);
  try {
    first.editor.select(first.byId('clip'));
    first.byId('scene').set(api.Computed, { localTime: 150 });
    assert.equal(api.splitAtPlayhead(first.world).length, 1);
    await first.save();
    first.history.undo();
    await first.save();
  } finally { first.close(); }

  const reopened = await open(dir);
  let insertedId: string;
  try {
    const clip = reopened.byId('clip');
    assert.deepEqual([reopened.props('clip').start, reopened.props('clip').end, reopened.props('clip').sourceIn], [2, 8, 3]);
    assert.equal(clip.get(api.Host)!.parent, reopened.byId('scene').get(api.Host));
    assert.equal(reopened.byId('scene').get(api.Host)!.children.length, 3, 'undo must remove both the split copy and its wrapper');
    const [temporary] = reopened.editor.insertElement(reopened.byId('scene'), () => api.renderAuthored({ tag: 'rect', props: { start: 20, end: 22 }, children: [] }), reopened.byId('anchor'));
    const [inserted] = reopened.editor.insertElement(reopened.byId('scene'), () => api.renderAuthored({ tag: 'rect', props: { start: 17, end: 19 }, children: [] }), temporary);
    assert.ok(inserted);
    assert.ok(reopened.editor.reparent(reopened.byId('moving'), reopened.byId('scene'), temporary));
    reopened.editor.remove(temporary);
    reopened.editor.remove(reopened.byId('anchor'));
    await reopened.save();
    insertedId = inserted.get(api.Source)!.value.split(':')[1];
    assert.deepEqual(reopened.byId('scene').get(api.Host)!.children.map(child => child.entity.get(api.Source)!.value.split(':')[1]), ['clip', insertedId, 'moving', 'track']);
  } finally { reopened.close(); }

  const again = await open(dir);
  try {
    const children = again.byId('scene').get(api.Host)!.children.map(child => child.entity.get(api.Source)!.value.split(':')[1]);
    assert.deepEqual(children, ['clip', insertedId, 'moving', 'track']);
    assert.equal(again.byId('track').get(api.Host)!.children.length, 0);
    assert.deepEqual([again.props(insertedId).start, again.props(insertedId).end], [17, 19]);
    assert.doesNotMatch(await readFile(join(dir, 'index.tsx'), 'utf8'), /id="anchor"/);
  } finally { again.close(); }
});

test('moving a saved clip into a deleted container does not restore it on reopen', async t => {
  for (const pending of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'frameyard-removed-container-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage"><scene id="scene" active end={30}>
      <rect id="clip" start={2} end={8} /><sequence id="track" />
    </scene></stage>;`);
    const first = await open(dir);
    try {
      const container = pending
        ? first.editor.insertElement(first.byId('scene'), () => api.renderAuthored({ tag: 'sequence', props: {}, children: [] }))[0]
        : first.byId('track');
      assert.ok(container);
      assert.ok(first.editor.reparent(first.byId('clip'), container));
      first.editor.remove(container);
      await first.save();
    } finally { first.close(); }
    const reopened = await open(dir);
    try {
      assert.equal(reopened.world.query(api.Source).some(entity => entity.get(api.Source)?.value === 'index.tsx:clip'), false, `removed child must stay deleted when its container was ${pending ? 'new' : 'saved'}`);
    } finally { reopened.close(); }
  }
});

test('a saved clip moved out of a deleted ancestor survives saving and reopening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameyard-escaped-clip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage"><scene id="scene" active end={30}>
    <sequence id="ancestor"><rect id="clip" start={2} end={8} /><rect id="removed" /></sequence>
  </scene></stage>;`);
  const first = await open(dir);
  try {
    first.editor.reparent(first.byId('clip'), first.byId('scene'), first.byId('ancestor'));
    first.editor.remove(first.byId('ancestor'));
    await first.save();
  } finally { first.close(); }
  const reopened = await open(dir);
  try {
    assert.deepEqual(reopened.byId('scene').get(api.Host)!.children.map(child => child.entity.get(api.Source)!.value), ['index.tsx:clip']);
    assert.deepEqual([reopened.props('clip').start, reopened.props('clip').end], [2, 8]);
  } finally { reopened.close(); }
});

test('repeated reorders before autosave preserve the final sibling order', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameyard-reorder-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage"><scene id="scene" active end={30}>
    <rect id="a" /><rect id="b" /><rect id="c" /><rect id="d" />
  </scene></stage>;`);
  const first = await open(dir);
  try {
    const parent = first.byId('scene');
    first.editor.reparent(first.byId('a'), parent, first.byId('d'));
    first.editor.reparent(first.byId('b'), parent, first.byId('a'));
    first.editor.reparent(first.byId('a'), parent, first.byId('c'));
    assert.deepEqual(first.children('scene'), ['index.tsx:a', 'index.tsx:c', 'index.tsx:b', 'index.tsx:d']);
    await first.save();
  } finally { first.close(); }
  const reopened = await open(dir);
  try {
    assert.deepEqual(reopened.children('scene'), ['index.tsx:a', 'index.tsx:c', 'index.tsx:b', 'index.tsx:d']);
  } finally { reopened.close(); }
});

test('inserting beside a clip moved to another track before autosave remains saveable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameyard-moved-anchor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.tsx'), `export default () => <stage id="stage"><scene id="scene" active end={30}>
    <sequence id="from"><rect id="clip" start={2} end={8} /></sequence><sequence id="to" />
  </scene></stage>;`);
  const first = await open(dir);
  let source: string;
  try {
    first.editor.reparent(first.byId('clip'), first.byId('to'));
    const [inserted] = first.editor.insertElement(first.byId('to'), () => api.renderAuthored({ tag: 'rect', props: { start: 10, end: 12 }, children: [] }), first.byId('clip'));
    assert.ok(inserted);
    await first.save();
    source = inserted.get(api.Source)!.value;
  } finally { first.close(); }
  const reopened = await open(dir);
  try {
    assert.deepEqual(reopened.children('to'), [source, 'index.tsx:clip']);
    assert.deepEqual(reopened.children('from'), []);
  } finally { reopened.close(); }
});
