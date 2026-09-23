import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ProjectFS } from '../../../packages/assets/src/fs.ts';
import type { Manifest } from '../../../packages/assets/src/manifest.ts';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../../packages/assets/src/library.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { AssetLibrary } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`) as typeof import('../../../packages/assets/src/library.ts');

function fixture(t: TestContext, initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, new File([text], path.split('/').at(-1)!)]));
  let saved: Manifest | undefined;
  let failWrite = false;
  const fs: ProjectFS = {
    readManifest: async () => saved,
    writeManifest: async (value) => { saved = value; },
    async list(path) {
      const entries = new Map<string, 'file' | 'directory'>();
      for (const source of files.keys()) {
        if (!source.startsWith(`${path}/`)) continue;
        const [name, next] = source.slice(path.length + 1).split('/');
        entries.set(name, next === undefined ? 'file' : 'directory');
      }
      return [...entries].map(([name, kind]) => ({ name, kind, size: 1, mtime: 1 }));
    },
    stat: async (path) => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async (path) => { const file = files.get(path); if (!file) throw new Error(`Missing file: ${path}`); return file; },
    write: async (path, blob, options) => {
      if (failWrite) throw new Error('Disk is full');
      if (options?.exclusive && files.has(path)) throw new Error(`File exists: ${path}`);
      files.set(path, new File([blob], path.split('/').at(-1)!));
    },
    remove: async (path) => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  t.after(() => library.dispose());
  return { library, fs, files, saved: () => saved, failWrites: (fail: boolean) => { failWrite = fail; } };
}

test('concurrent imports give different source files with the same name distinct library paths', async (t) => {
  const f = fixture(t, { '/first/captions.json': '["first"]', '/second/captions.json': '["second"]' });
  const imported = await f.library.import(['/first/captions.json', '/second/captions.json']);
  assert.deepEqual(imported.failed, []);
  assert.equal(imported.assets.length, 2);
  assert.equal(new Set(imported.assets.map(asset => asset.path)).size, 2);
  for (const asset of imported.assets) assert.equal(f.library.get(asset.path), asset);
  await f.library.settle();
  assert.equal(new Set(f.saved()!.assets.map(asset => asset.path)).size, 2);
});

test('concurrent generated assets retain both files and failed stores release their reserved names', async (t) => {
  const f = fixture(t);
  const stored = await Promise.all(['["one"]', '["two"]'].map(text => f.library.store(new Blob([text]), { name: 'captions.json' })));
  assert.equal(f.library.list().length, 2);
  assert.equal(new Set(stored.map(asset => asset.source)).size, 2);
  assert.deepEqual(await Promise.all(stored.map(async asset => (await f.library.file(asset)).text())), ['["one"]', '["two"]']);
  f.library.rename(stored[0], 'renamed.json');
  const another = await f.library.store(new Blob(['["three"]']), { name: 'captions.json' });
  assert.notEqual(another.source, stored[0].source);
  assert.equal(await (await f.library.file(stored[0])).text(), '["one"]', 'a library rename must not free the original file for overwrite');
  f.failWrites(true);
  await assert.rejects(f.library.store(new Blob(['[]']), { name: 'retry.json' }), /Disk is full/);
  f.failWrites(false);
  const retried = await f.library.store(new Blob(['[]']), { name: 'retry.json' });
  assert.equal(retried.path, 'retry.json');
});

test('folder imports return nested failures alongside successfully imported files', async (t) => {
  const f = fixture(t, { '/drop/good.json': '["keep"]', '/drop/nested/bad.bin': 'unsupported bytes' });
  const imported = await f.library.import(['/drop']);
  assert.equal(imported.assets.length, 1);
  assert.equal(imported.assets[0].path, 'drop/good.json');
  assert.equal(imported.failed.length, 1);
  assert.equal(imported.failed[0].source, '/drop/nested/bad.bin');
  assert.match(imported.failed[0].error.message, /Unsupported file/);
});

test('generated assets preserve unregistered files and leave no rejected or duplicate output behind', async (t) => {
  const f = fixture(t, { 'assets/captions.json': '["original"]' });
  const stored = await f.library.store(new Blob(['["generated"]']), { name: 'captions.json' });
  assert.equal(await f.files.get('assets/captions.json')!.text(), '["original"]');
  assert.equal(stored.path, 'captions 2.json');
  const duplicate = await f.library.store(new Blob(['["generated"]']), { name: 'duplicate.json' });
  assert.equal(duplicate, stored);
  assert.equal(f.files.has('assets/duplicate.json'), false);
  await assert.rejects(f.library.store(new Blob(['unsupported']), { name: 'broken.bin' }), /Unsupported file/);
  assert.equal(f.files.has('assets/broken.bin'), false);
});

test('manifest refresh preserves imports and renames completed while the manifest is being read', async (t) => {
  const f = fixture(t, { '/first.json': '["first"]', '/second.json': '["second"]' });
  const { assets: [first] } = await f.library.import(['/first.json']);
  await f.library.settle();
  const read = f.fs.readManifest;
  const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  f.fs.readManifest = async () => {
    const manifest = await read();
    started.resolve();
    await resume.promise;
    return manifest;
  };
  const refreshing = f.library.load();
  try {
    await started.promise;
    f.library.rename(first, 'renamed.json');
    f.library.createFolder('Keep this folder');
    const { assets: [second] } = await f.library.import(['/second.json']);
    resume.resolve();
    await refreshing;
    assert.equal(f.library.get('second.json')?.id, second.id);
    assert.equal(f.library.get('renamed.json')?.id, first.id);
    assert.ok(f.library.folders().has('Keep this folder'));
    await f.library.settle();
    assert.equal(f.saved()!.assets.length, 2);
  } finally { resume.resolve(); await refreshing; }
});

test('relinking to another registered asset refuses the collision without losing either library path', async (t) => {
  const f = fixture(t, { '/first.json': '["first"]', '/second.json': '["second"]' });
  const { assets } = await f.library.import(['/first.json', '/second.json']);
  const first = f.library.get('first.json')!, second = f.library.get('second.json')!;
  await assert.rejects(f.library.relink(first, second.source), /already.*second\.json/);
  assert.equal(f.library.get(first.path), first);
  assert.equal(f.library.get(second.path), second);
  assert.equal(f.library.list().length, assets.length);
});

test('a pending relink respects a later rename and cannot resurrect a removed asset', async (t) => {
  const f = fixture(t, { '/first.json': '["first"]', '/replacement.json': '["replacement"]' });
  const { assets: [first] } = await f.library.import(['/first.json']);
  const read = f.fs.file;
  let started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  f.fs.file = async source => {
    if (source === '/replacement.json') { started.resolve(); await resume.promise; }
    return read(source);
  };
  const pending = f.library.relink(first, '/replacement.json');
  await started.promise;
  f.library.rename(first, 'renamed.json');
  await f.library.load();
  resume.resolve();
  const relinked = await pending;
  assert.equal(relinked.path, 'renamed.json');
  started = Promise.withResolvers<void>(); resume = Promise.withResolvers<void>();
  const removed = f.library.relink(relinked, '/replacement.json');
  await started.promise;
  await f.library.remove([relinked]);
  const refused = assert.rejects(removed, /removed|changed/);
  resume.resolve();
  await refused;
  assert.deepEqual(f.library.list(), []);
});

test('recursive folder import reports a symlink cycle without walking it repeatedly', async (t) => {
  const f = fixture(t, { '/drop/good.json': '["keep"]' });
  const read = f.fs.file;
  let listings = 0;
  f.fs.realPath = async source => source.replaceAll('/loop', '');
  f.fs.file = source => read(source.replaceAll('/loop', ''));
  f.fs.list = async source => {
    if (source.endsWith('.json')) return [];
    if (++listings > 8) throw new Error('Repeated directory traversal');
    return [
      { name: 'good.json', kind: 'file', size: 8, mtime: 1 },
      { name: 'loop', kind: 'directory', size: 0, mtime: 1, link: true },
    ];
  };
  const result = await f.library.import(['/drop']);
  assert.equal(result.assets.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].source, '/drop/loop');
  assert.match(result.failed[0].error.message, /cycle/);
  assert.ok(listings <= 2);
});

test('an import finishing after a folder rename still gets a distinct library path', async (t) => {
  const f = fixture(t, { '/first/captions.json': '["first"]', '/second/captions.json': '["second"]' });
  const { assets: [first] } = await f.library.import(['/first/captions.json'], { folder: 'Original' });
  const read = f.fs.file;
  const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  f.fs.file = async source => { started.resolve(); await resume.promise; return read(source); };
  const pending = f.library.import(['/second/captions.json'], { folder: 'Renamed' });
  await started.promise;
  f.library.renameFolder('Original', 'Renamed');
  resume.resolve();
  const { assets: [second] } = await pending;
  assert.equal(first.path, 'Renamed/captions.json');
  assert.equal(second.path, 'Renamed/captions 2.json');
  assert.equal(f.library.get(first.path), first);
  assert.equal(f.library.get(second.path), second);
});

test('closing a library during a generated write removes the unfinished import', async (t) => {
  const f = fixture(t);
  const write = f.fs.write;
  const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  f.fs.write = async (...args) => { await write(...args); started.resolve(); await resume.promise; };
  const pending = f.library.store(new Blob(['[]']), { name: 'captions.json' });
  await started.promise;
  await f.library.dispose();
  const rejected = assert.rejects(pending, /closed/);
  resume.resolve();
  await rejected;
  assert.deepEqual([...f.files.keys()], []);
  assert.deepEqual(f.library.manifest().assets, []);
});

test('exclusive generated writes preserve a file created after the free-name check', async (t) => {
  const f = fixture(t);
  const write = f.fs.write;
  f.fs.write = async (...args) => {
    f.files.set(args[0], new File(['["external"]'], 'captions.json'));
    return write(...args);
  };
  await assert.rejects(f.library.store(new Blob(['["generated"]']), { name: 'captions.json' }), /File exists/);
  assert.equal(await f.files.get('assets/captions.json')!.text(), '["external"]');
  assert.deepEqual(f.library.list(), []);
});
