import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
import type { World } from 'koota';
import type { EntityEdit } from '../../web/src/engine/editor.ts';
import type { EditorRecovery } from '../../desktop/src/checkpoint-contracts.ts';
import type { WriteResult } from '../../desktop/src/edit.ts';

const web = fileURLToPath(new URL('../../web/src/', import.meta.url));
const built = await build({
  stdin: { contents: `export { EditorPage } from './pages/editor'; export { createEditWriter, getProjectSaveState, flushProjectEdits, getProjectRecovery } from './projects/edits';`, resolveDir: web },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'transform', jsxFactory: 'view',
  plugins: [{ name: 'editor-boundaries', setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path }) => path === '@/projects/edits' || path === '@/projects/edit-recovery'
      ? { path: `${web}${path.slice(2)}.ts` } : { path, external: true });
    build.onResolve({ filter: /^\.\/host$/ }, () => ({ path: 'writer-host', external: true }));
  } }],
});

function fixture(t: TestContext, recovered?: string, selections: Record<string, string[]> = {}, outgoingSave?: Promise<WriteResult>) {
  const storage = new Map(recovered ? [['diffusion-studio:edit-recovery:project', recovered]] : []);
  const compiled = Promise.withResolvers<{ ok: true; code: string }>();
  let compilation = compiled.promise;
  let sourceChanged: ((paths: string[]) => void) | undefined;
  const states: { status: string; error?: string }[] = [];
  const loaded = Promise.withResolvers<{ status: string; error?: string }>();
  const mounts: string[] = [], cleanups: (() => void)[] = [];
  const Source = Symbol('Source'), Selected = Symbol('Selected'), Scene = Symbol('Scene');
  const sources = [...new Set(Object.values(selections).flat())];
  const makeEntity = (source: string, selected: boolean) => ({
    source, selected,
    get: (trait: symbol) => trait === Source ? { value: source } : undefined,
    has(trait: symbol) { return trait === Source || (trait === Selected && this.selected); },
    add(trait: symbol) { if (trait === Selected) this.selected = true; },
    remove(trait: symbol) { if (trait === Selected) this.selected = false; },
    isAlive() { return entities.includes(this); },
  });
  let entities: ReturnType<typeof makeEntity>[] = [];
  let primary: ReturnType<typeof makeEntity> | undefined;
  const world = { query: (...traits: symbol[]) => entities.filter(entity => traits.every(trait => entity.has(trait))), get: () => ({ value: 60 }), set() {} } as unknown as World;
  let edit: ((value: EntityEdit) => void) | undefined;
  let writes = 0;
  let compilations = 0;
  let writeFails = true;
  let recoveryTick: (() => void) | undefined;
  let checkpointFailure = false;
  const checkpoints: { dir: string; editorRecovery?: EditorRecovery }[] = [];
  const errors: string[] = [];
  const noop = () => {};
  const editor = {
    primarySelection: () => primary, linkedSelection: true,
    select(targets: typeof entities) {
      for (const entity of entities) {
        const selected = targets.includes(entity);
        if (entity.selected === selected) continue;
        entity.selected = selected;
        edit?.({ kind: 'prop', source: entity.source, name: 'selected', value: selected });
      }
      primary = targets[0];
    },
    onEdit: (listener: typeof edit) => { edit = listener; return () => { if (edit === listener) edit = undefined; }; },
    restamp: noop, unsettle: noop, discardPending: noop,
  };
  const library = { load: async () => {}, settle: async () => {}, list: () => [], dispose: noop };
  const config = { ready: Promise.resolve(), settle: async () => {}, frameRate: () => 60, previewScale: () => 1, dispose: noop };
  const dependencies: Record<string, unknown> = {
    'solid-js': { Show: noop, createMemo: (fn: () => unknown) => fn, createEffect: (fn: () => void) => fn(), onCleanup: (fn: () => void) => cleanups.push(fn), onMount: noop, untrack: (fn: () => unknown) => fn(),
      createSignal: (initial: unknown) => { let value = initial; return [() => value, (next: unknown) => { value = typeof next === 'function' ? next(value) : next; }]; } },
    '@solid-primitives/resize-observer': { createWindowSize: () => ({ width: 1600, height: 1000 }) },
    '@diffusionstudio/koota-solid': { useWorld: () => world },
    '@diffusionstudio/runtime': { Source, Selected, Scene },
    '@diffusionstudio/reconciler': { mount: (code: string) => {
      mounts.push(code);
      entities = sources.map(source => makeEntity(source, selections[code]?.includes(source) ?? false));
      return { dispose: () => { entities = []; }, inspect: [] };
    } },
    '@diffusionstudio/assets': { isCacheFile: () => false },
    '@/context/layout': { MIN_TIMELINE_HEIGHT: 80, useLayout: () => ({ uiVisible: () => false, timelineMinimized: () => false, timelineHeight: () => 200, leftPanelWidth: () => 264, inspectorWidth: () => 264, agentWidth: () => 384 }) },
    '@/agent-chat': { RightSidebar: noop, rightSidebarWidth: () => 384 },
    '@/dapi': { useEditorApi: () => ({ isDesktop: false, isFullscreen: () => false }) },
    '@/context/project': { useProject: () => ({ dir: () => 'project', id: () => 'project-id' }) },
    '@/dapi/session': { setEditorLoadState: (state: { status: string; error?: string }) => { if (state?.status === 'ready' || state?.status === 'error') { states.push(state); loaded.resolve(state); } } },
    '@/engine': { useEngineContext: () => ({ frame: () => 1, snapshot: noop }) },
    '@/engine/timeline': { RULER_HEIGHT: 20 },
    '@/engine/editor': { getDocumentEditor: () => editor },
    '@/engine/history': { getEditHistory: () => ({ reset: noop }) },
    '@/engine/timeline-editing': { timelineEditing: () => ({ target: noop, syncTracks: () => new Set(), setTarget: noop, setSyncTracks: noop }) },
    '@/engine/inspect': { setInspectEntries: noop },
    '@/engine/library': { attachLibrary: () => library, isLibraryFile: () => false },
    '@/engine/project-config': { attachProjectConfig: () => config, isProjectConfigFile: () => false },
    '@/utils/gen-ai': { attachAi: noop },
    '@/lib/db': { loadProjectBundle: async () => 'cached', rememberProjectBundle: async () => {} },
    '@/lib/local-mode': { localMode: true },
    '@/lib/ipc': { mainBridge: { call: async (_channel: string, input: { dir: string; editorRecovery?: EditorRecovery }) => {
      if (checkpointFailure) throw new Error('Checkpoint disk failure');
      checkpoints.push(input);
    } } },
    '@desktop/main-channels': { MAIN_CHANNELS: {} },
    '@/projects/host': { compileProject: () => { compilations++; return compilation; }, refreshProject: noop, watchProject: (_dir: string, listener: typeof sourceChanged) => { sourceChanged = listener; return noop; } },
    '@/projects/change-batch': { isProjectSourceFile: () => true },
    '@/projects/cover': { captureProjectCover: noop },
    'writer-host': { writeProject: async () => { writes++; if (writes === 1 && outgoingSave) return outgoingSave; if (writeFails) throw new Error('Disk is full'); return { skipped: [] }; } },
    somoto: { toast: { error: (title: string) => errors.push(title) } },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as Pick<typeof import('../../web/src/pages/editor.tsx'), 'EditorPage'> & Pick<typeof import('../../web/src/projects/edits.ts'), 'createEditWriter' | 'getProjectSaveState' | 'flushProjectEdits' | 'getProjectRecovery'> };
  runInThisContext(`(function(require,module,exports,localStorage,view,setInterval,clearInterval,console){${built.outputFiles[0].text}\n})`)(
    (name: string) => {
      if (name in dependencies) return dependencies[name];
      if (name.startsWith('@/components/')) return new Proxy({}, { get: () => noop });
      if (name === 'zod') return require(name);
      throw new Error(`Unexpected dependency ${name}`);
    }, module, module.exports,
    { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    noop, (tick: () => void, delay: number) => { if (delay === 5 * 60 * 1000) recoveryTick = tick; }, noop, { error: noop },
  );
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
  if (outgoingSave) {
    const writer = module.exports.createEditWriter('project', world);
    writer.push({ kind: 'text', source: 'index.tsx:title', value: 'Outgoing edit' });
    writer.dispose();
  }
  module.exports.EditorPage();
  return { ...module.exports, states, recompile: async (code: string) => { compilation = Promise.resolve({ ok: true, code }); assert.ok(sourceChanged); sourceChanged(['index.tsx']); await setImmediate(); }, checkpoint: () => { assert.ok(recoveryTick); recoveryTick(); }, checkpoints, errors, failCheckpoint: () => { checkpointFailure = true; }, world, mounts, storage, compiled, loaded, edit: (value: EntityEdit) => { assert.ok(edit); edit(value); }, writes: () => writes,
    allowWrites: () => { writeFails = false; },
    compilations: () => compilations,
    selected: () => entities.filter(entity => entity.selected).map(entity => entity.source),
    select: (sources: string[]) => editor.select(entities.filter(entity => sources.includes(entity.source))),
  };
}

test('reopening waits for the outgoing save before compiling or mounting a cached scene', async (t) => {
  const save = Promise.withResolvers<WriteResult>();
  const f = fixture(t, undefined, {}, save.promise);
  await setImmediate();
  assert.equal(f.compilations(), 0);
  assert.deepEqual(f.mounts, []);
  assert.match([...f.storage.values()][0], /Outgoing edit/);
  save.resolve({ skipped: [], remaining: [] });
  f.compiled.resolve({ ok: true, code: 'fresh with outgoing edit' });
  assert.equal((await f.loaded.promise).status, 'ready');
  assert.deepEqual(f.mounts, ['fresh with outgoing edit']);
  assert.equal(f.getProjectSaveState(f.world).status, 'saved');
  assert.equal(f.storage.size, 0);
});

test('fresh source selection replaces stale cached selection when opening a project', async (t) => {
  const f = fixture(t, undefined, { cached: ['shade'], fresh: ['text'] });
  await setImmediate();
  assert.deepEqual(f.selected(), ['shade']);
  f.compiled.resolve({ ok: true, code: 'fresh' });
  assert.equal((await f.loaded.promise).status, 'ready');
  assert.deepEqual(f.selected(), ['text']);
  assert.equal(f.writes(), 0, 'restoring selection must not rewrite the source');
});

test('live selections, including an empty selection, survive compilation without adding authored selections', async (t) => {
  for (const selection of [['text'], []]) {
    const f = fixture(t, undefined, { cached: ['shade'], fresh: ['shade'], external: ['text'], later: ['shade'] });
    f.allowWrites();
    await setImmediate();
    f.select(selection);
    await f.flushProjectEdits(f.world);
    f.compiled.resolve({ ok: true, code: 'fresh' });
    assert.equal((await f.loaded.promise).status, 'ready');
    assert.deepEqual(f.selected(), selection, 'user input while the cached preview is visible takes priority');
    f.select(['shade']);
    await f.flushProjectEdits(f.world);
    await f.recompile('external');
    assert.deepEqual(f.selected(), ['shade']);
    f.select([]);
    await f.flushProjectEdits(f.world);
    await f.recompile('later');
    assert.deepEqual(f.selected(), [], 'a live reload must not reselect a layer after the user cleared selection');
  }
});

test('opening with recovered edits mounts fresh saved code and keeps recovery available', async (t) => {
  const journal = JSON.stringify({ version: 1, updatedAt: '', safe: true, edits: [{ kind: 'set', source: 'index.tsx:scene', props: { timelineZoom: 0.5 } }] });
  const f = fixture(t, journal);
  await setImmediate();
  f.compiled.resolve({ ok: true, code: 'fresh' });
  assert.equal((await f.loaded.promise).status, 'ready');
  assert.deepEqual(f.mounts, ['fresh']);
  assert.equal(f.getProjectSaveState(f.world).status, 'failed');
  assert.equal(f.storage.get('diffusion-studio:edit-recovery:project'), journal);
  assert.equal(f.writes(), 0, 'opening must not replay or discard recovery');
});

test('fresh compilation cannot replace a cached scene whose live edits failed to save', async (t) => {
  const f = fixture(t);
  await setImmediate();
  assert.deepEqual(f.mounts, ['cached']);
  f.edit({ kind: 'text', source: 'index.tsx:title', value: 'Unsaved title' });
  await assert.rejects(f.flushProjectEdits(f.world), /Disk is full/);
  f.compiled.resolve({ ok: true, code: 'fresh' });
  assert.match((await f.loaded.promise).error ?? '', /Disk is full/);
  assert.deepEqual(f.mounts, ['cached']);
  assert.match(f.getProjectRecovery(f.world) ?? '', /Unsaved title/);
});


test('automatic checkpoints retain pending edits separately when saving the source is blocked', async (t) => {
  const journal = JSON.stringify({ version: 1, updatedAt: '', safe: true, edits: [{ kind: 'set', source: 'index.tsx:scene', props: { timelineZoom: 0.5 } }] });
  const f = fixture(t, journal);
  f.compiled.resolve({ ok: true, code: 'fresh' });
  await f.loaded.promise;
  f.edit({ kind: 'text', source: 'index.tsx:title', value: 'Still unsaved' });
  f.checkpoint();
  await setImmediate();
  assert.equal(f.checkpoints.length, 1);
  const recovery = f.checkpoints[0].editorRecovery;
  assert.ok(recovery?.journal);
  assert.match(recovery.journal, /Still unsaved/);
  assert.match(recovery.journal, /timelineZoom/);
  assert.match(recovery.saveErrors.join(' '), /Recovered unsaved edits/);
  assert.equal(f.getProjectSaveState(f.world).status, 'failed');
  assert.equal(f.writes(), 0, 'checkpointing must not replay unresolved recovery');
  assert.ok(!f.errors.includes('Could not save a recovery checkpoint'));

  f.edit({ kind: 'text', source: 'index.tsx:title', value: 'Another edit' });
  f.failCheckpoint();
  f.checkpoint();
  await setImmediate();
  assert.ok(f.errors.includes('Could not save a recovery checkpoint'), 'real checkpoint failures must remain visible');
  assert.match(f.getProjectRecovery(f.world) ?? '', /Another edit/);
});

for (const safe of [true, false]) {
  test(`external source updates refresh a recovered project without replaying its journal (safe=${safe})`, async (t) => {
    const journal = JSON.stringify({ version: 1, updatedAt: '', safe, edits: [{ kind: 'set', source: 'index.tsx:title', props: {}, text: 'Recovered title' }] });
    const f = fixture(t, journal);
    f.compiled.resolve({ ok: true, code: 'fresh' });
    await f.loaded.promise;
    await f.recompile('external update');
    assert.deepEqual(f.mounts, ['fresh', 'external update']);
    assert.equal(f.states.at(-1)?.status, 'ready');
    assert.match(f.getProjectRecovery(f.world) ?? '', /Recovered title/);
    assert.equal(f.getProjectSaveState(f.world).status, 'failed');
    assert.equal(f.writes(), 0);

    f.edit({ kind: 'text', source: 'index.tsx:title', value: 'Live unsaved title' });
    await f.recompile('another external update');
    assert.deepEqual(f.mounts, ['fresh', 'external update'], 'live edits must prevent remounting');
    assert.equal(f.states.at(-1)?.status, 'error');
    assert.match(f.getProjectRecovery(f.world) ?? '', /Live unsaved title/);
    assert.equal(f.writes(), 0);
  });
}
