import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { ChatDraft } from '../../web/src/components/agent/chat-draft.ts';
import type { GlobalDBSchema } from '../../web/src/lib/db.ts';

type StoredChatDraft = GlobalDBSchema['chatDrafts']['value'];

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/lib/db.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['idb', 'nanoid'],
});

function fixture() {
  const rows = new Map<string, StoredChatDraft>();
  let writes = 0;
  let failAfter = Infinity;
  const database = { transaction() {
    const pending = Promise.withResolvers<void>();
    const staged = new Map(rows);
    let failed = false;
    const store = {
      async get(key: [string, keyof StoredChatDraft]) { return structuredClone(staged.get(JSON.stringify(key))); },
      async getAllKeys(range: { prefix: string }) { return [...staged.keys()].map((key) => JSON.parse(key) as [string, keyof StoredChatDraft]).filter(([prefix]) => prefix === range.prefix); },
      async getAll(range: { prefix: string }) { return Promise.all((await store.getAllKeys(range)).map((key) => store.get(key))); },
      async put(value: StoredChatDraft, key: [string, keyof StoredChatDraft]) {
        if (writes++ >= failAfter) {
          failed = true;
          const cause = new Error('Disk is full');
          pending.reject(cause);
          throw cause;
        }
        staged.set(JSON.stringify(key), structuredClone(value));
      },
      async delete(key: [string, keyof StoredChatDraft]) { staged.delete(JSON.stringify(key)); },
    };
    setImmediate(() => {
      if (failed) return;
      rows.clear(); for (const [key, value] of staged) rows.set(key, value);
      pending.resolve();
    });
    return { store, done: pending.promise };
  } };
  const module = { exports: {} as Pick<typeof import('../../web/src/lib/db.ts'), 'loadChatDraft' | 'saveChatDraftField'> };
  runInThisContext(`(function(require,module,exports,IDBKeyRange){${built.outputFiles[0].text}\n})`)(
    (name: string) => name === 'idb' ? { openDB: async () => database } : { nanoid: () => 'unused' },
    module, module.exports, { bound: (lower: [string, string]) => ({ prefix: lower[0] }) },
  );
  return { ...module.exports, rows, writes: () => writes, failNextMigration: () => { failAfter = 1; },
    put: <Key extends keyof StoredChatDraft>(key: string, field: Key, value: StoredChatDraft[Key]) => rows.set(JSON.stringify([key, field]), { [field]: value }),
  };
}

test('legacy chat drafts migrate once without replacing newer fields or restoring cleared attachments', async () => {
  const f = fixture();
  f.put('/project', 'draft', 'Legacy draft');
  f.put('/project', 'images', [{ name: 'reference.png', url: 'data:image/png;base64,AAAA' }]);
  f.put('project:stable-id', 'draft', 'New typing');
  const restored = await f.loadChatDraft('project:stable-id', '/project');
  assert.equal(restored.draft, 'New typing');
  assert.equal(restored.images?.[0].name, 'reference.png');
  assert.equal([...f.rows.keys()].some((key) => key.startsWith('["/project",')), false);
  const writes = f.writes();
  await f.loadChatDraft('project:stable-id', '/project');
  assert.equal(f.writes(), writes, 'reopening must not rewrite image rows');
  await f.saveChatDraftField('project:stable-id', 'images', []);
  assert.deepEqual((await f.loadChatDraft('project:stable-id', '/project')).images, []);
});

test('renaming keeps drafts and updates only project-local attachment paths', async () => {
  const f = fixture();
  const key = 'project:stable-id';
  const transcript = { sceneId: 'scene:main', sceneName: 'Main', duration: 12, projectDir: '/old', path: '/old/assets/transcript.json', assetPath: 'transcript.json', timing: 'scene-seconds' as const, capturedAt: 'now' };
  f.put(key, 'projectDir', '/old');
  f.put(key, 'draft', 'Keep this unsent text');
  f.put(key, 'tab', 'Transcript');
  f.put(key, 'transcript', transcript);
  f.put(key, 'videoContext', { ...transcript, frameRate: 30, path: '/old/.diffusion/video-context/shot/context.json', transcriptStatus: 'available', fullTranscript: transcript, frames: [{ time: 3, timecode: '3s', path: '/old/.diffusion/video-context/shot/frame-01.png' }], sampling: 'overview' });
  f.put(key, 'skills', [{ name: 'local', path: '/old/.agents/skills/local/SKILL.md', description: '' }, { name: 'external', path: '/old-other/skill.md', description: '' }]);
  f.put(key, 'manimReferences', [{ id: 'animation', engine: 'manim', transparent: true, source: '/old/animation', output: '/old/assets/animation.frames', entry: '/old/animation/main.py', scene: 'Main', renderedAt: null, libraryPath: 'animation.frames' }]);
  const snapshot = { sceneId: 'scene:main', sceneName: 'Main', sceneSize: { width: 1920, height: 1080 }, frame: 90, time: 3, imageUrl: 'data:image/png;base64,AAAA', context: { rootDir: '/', projectDir: '/old', activeScene: null, selected: [], selectedAsset: null, assets: [], assetCount: 0, currentTime: 3, sceneTiming: null, fontFamilies: [], generations: [] } };
  f.put(key, 'area', { snapshot, annotation: { ...snapshot, note: '', region: { x: 0, y: 0, width: 1, height: 1 } } });
  const renamed = await f.loadChatDraft(key, '/renamed');
  assert.equal(renamed.draft, 'Keep this unsent text');
  assert.equal(renamed.tab, 'Transcript');
  assert.equal(renamed.transcript?.path, '/renamed/assets/transcript.json');
  assert.equal(renamed.videoContext?.fullTranscript?.projectDir, '/renamed');
  assert.equal(renamed.videoContext?.frames[0].path, '/renamed/.diffusion/video-context/shot/frame-01.png');
  assert.deepEqual(renamed.skills?.map((skill) => skill.path), ['/renamed/.agents/skills/local/SKILL.md', '/old-other/skill.md']);
  assert.equal(renamed.animationReferences?.[0].entry, '/renamed/animation/main.py');
  assert.equal(renamed.area?.snapshot.context.projectDir, '/renamed');
  assert.deepEqual(await f.loadChatDraft(key, '/renamed'), renamed);
  assert.equal((await f.loadChatDraft('project:other-id', '/another')).draft, undefined);
});

test('the Manim tab and references migrate to Animations without reviving cleared references', async () => {
  const f = fixture();
  const key = 'project:stable-id';
  const reference: ChatDraft['animationReferences'][number] = {
    id: 'diagram', engine: 'manim', transparent: true, source: '/project/animations/diagram',
    output: '/project/assets/diagram.frames', entry: '/project/animations/diagram/scene.py',
    scene: 'Diagram', renderedAt: null, libraryPath: 'diagram.frames',
  };
  f.put(key, 'tab', 'Manim');
  f.put(key, 'manimReferences', [reference]);
  const migrated = await f.loadChatDraft(key, '/project');
  assert.equal(migrated.tab, 'Animations');
  assert.deepEqual(migrated.animationReferences, [reference]);
  assert.equal(f.rows.has(JSON.stringify([key, 'manimReferences'])), false);
  const writes = f.writes();
  assert.deepEqual(await f.loadChatDraft(key, '/project'), migrated);
  assert.equal(f.writes(), writes, 'reopening must not repeat the migration');

  await f.saveChatDraftField(key, 'animationReferences', []);
  f.put('/project', 'manimReferences', [reference]);
  assert.deepEqual((await f.loadChatDraft(key, '/project')).animationReferences, []);
  assert.equal(f.rows.has(JSON.stringify(['/project', 'manimReferences'])), false);
});

test('failed migration leaves legacy draft rows recoverable', async () => {
  const f = fixture();
  f.put('/project', 'draft', 'Keep this draft');
  f.put('/project', 'tab', 'Transcript');
  const original = structuredClone(f.rows);
  f.failNextMigration();
  await assert.rejects(f.loadChatDraft('project:stable-id', '/project'), /Disk is full/);
  assert.deepEqual(f.rows, original);
});
