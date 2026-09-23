import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { ChatDraft } from '../../web/src/components/agent/chat-draft.ts';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/components/agent/chat-draft.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['solid-js', '@/lib/db'],
});

function fixture(loadError?: Error) {
  const rows = new Map<string, unknown>();
  const writes: string[] = [];
  const errors: unknown[] = [];
  let wait = Promise.resolve();
  const module = { exports: {} as typeof import('../../web/src/components/agent/chat-draft.ts') };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)((name: string) => {
    if (name === 'solid-js') return solid;
    assert.equal(name, '@/lib/db');
    return {
      loadChatDraft: async (key: string) => { await wait; if (loadError) throw loadError; return Object.fromEntries([...rows].filter(([row]) => row.startsWith(`${key}:`)).map(([row, value]) => [row.slice(key.length + 1), structuredClone(value)])); },
      saveChatDraftField: async (dir: string, key: keyof ChatDraft, value: unknown) => { writes.push(`${dir}:${key}`); rows.set(`${dir}:${key}`, structuredClone(value)); },
    };
  }, module, module.exports);
  function open(dir = 'project-a') {
    return solid.createRoot((dispose) => {
      const state = module.exports.createChatDraft({ id: dir, dir }, (cause) => errors.push(cause));
      const [draft, setDraft] = state.field('draft', '');
      const [images, setImages] = state.field('images', []);
      const [skills, setSkills] = state.field('skills', []);
      const [tab, setTab] = state.field('tab', 'Editor');
      const [model, setModel] = state.field('modelOverride', undefined);
      return { draft, setDraft, images, setImages, skills, setSkills, tab, setTab, model, setModel, ready: state.ready(), trackSubmission: state.trackSubmission, dispose };
    });
  }
  return { rows, writes, errors, open, prepare: module.exports.prepareChatDraft, pause: (promise: Promise<void>) => { wait = promise; } };
}

test('chat draft, attachments, tab and model survive remount and stay scoped to their project', async () => {
  const f = fixture();
  const first = f.open();
  await first.ready;
  const images = [{ name: 'reference.png', url: 'data:image/png;base64,AAAA' }];
  first.setImages(images);
  first.setTab('Chat');
  first.setModel('chosen-model');
  first.setDraft('Unsent edit');
  first.setDraft('Unsent edit with detail');
  await Promise.resolve();
  assert.equal(f.writes.filter((key) => key.endsWith(':images')).length, 1, 'typing must not rewrite images');
  first.dispose();
  const restored = f.open();
  const other = f.open('project-b');
  await Promise.all([restored.ready, other.ready]);
  assert.equal(restored.draft(), 'Unsent edit with detail');
  assert.deepEqual(restored.images(), images);
  assert.equal(restored.tab(), 'Chat');
  assert.equal(restored.model(), 'chosen-model');
  assert.equal(other.draft(), '');
  assert.deepEqual(other.images(), []);
  assert.deepEqual(f.errors, []);
  restored.setDraft('');
  restored.setImages([]);
  restored.dispose();
  other.dispose();
  const cleared = f.open();
  await cleared.ready;
  assert.equal(cleared.draft(), '');
  assert.deepEqual(cleared.images(), []);
  cleared.dispose();
});

test('delayed restoration cannot replace typing or clearing done while the database opens', async () => {
  const f = fixture();
  f.rows.set('project:project-a:draft', 'Old saved text');
  const gate = Promise.withResolvers<void>();
  f.pause(gate.promise);
  const current = f.open();
  assert.deepEqual(f.writes, [], 'initial defaults must not erase saved state');
  current.setDraft('New typing');
  current.setDraft('');
  gate.resolve();
  await current.ready;
  assert.equal(current.draft(), '');
  assert.equal(f.rows.get('project:project-a:draft'), '');
  current.dispose();
});

test('closing before restoration leaves the saved draft untouched', async () => {
  const f = fixture();
  f.rows.set('project:project-a:draft', 'Keep this');
  const gate = Promise.withResolvers<void>();
  f.pause(gate.promise);
  const current = f.open();
  current.dispose();
  gate.resolve();
  await current.ready;
  assert.deepEqual(f.writes, []);
  assert.equal(f.rows.get('project:project-a:draft'), 'Keep this');
});


test('a failed migration reports the error but does not prevent saving new typing', async () => {
  const error = new Error('Migration could not finish');
  const f = fixture(error);
  const current = f.open();
  await current.ready;
  assert.deepEqual(f.errors, [error]);
  current.setDraft('New text must still be kept');
  await Promise.resolve();
  assert.equal(f.rows.get('project:project-a:draft'), 'New text must still be kept');
  current.dispose();
});

test('reopening while draft storage is loading waits for typing queued by the previous panel', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  f.pause(gate.promise);
  const first = f.open();
  first.setDraft('Keep typing across a quick reopen');
  first.dispose();
  const reopened = f.open();
  gate.resolve();
  await reopened.ready;
  assert.equal(reopened.draft(), 'Keep typing across a quick reopen');
  reopened.dispose();
});


test('dashboard handoff selects its provider and preserves existing draft attachments on failure', async () => {
  const f = fixture();
  const current = f.open();
  await current.ready;
  const images = [{ name: 'marked-frame.png', url: 'data:image/png;base64,AAAA' }];
  current.setImages(images);
  current.setDraft('Keep this unfinished edit');
  current.dispose();
  await f.prepare({ id: 'project-a', dir: 'project-a' }, 'codex', { text: 'Dashboard request\n\nAttached files and folders:\n/project/clip.mp4', model: 'selected-model' });
  const restored = f.open();
  await restored.ready;
  assert.equal(restored.draft(), 'Keep this unfinished edit\n\nDashboard request\n\nAttached files and folders:\n/project/clip.mp4');
  assert.deepEqual(restored.images(), images);
  assert.equal(restored.tab(), 'Chat');
  assert.equal(restored.model(), 'selected-model');
  assert.equal(f.rows.get('project:project-a:harness'), 'codex');
  restored.dispose();
  await f.prepare({ id: 'project-a', dir: 'project-a' }, 'claude');
  assert.equal(f.rows.get('project:project-a:harness'), 'claude');
  assert.match(String(f.rows.get('project:project-a:draft')), /Keep this unfinished edit/);
});

for (const editedAfterReopen of [false, true]) {
  test(`a send accepted after unmount ${editedAfterReopen ? 'preserves new typing' : 'clears its persisted draft'} on reopen`, async () => {
    const f = fixture();
    const first = f.open();
    await first.ready;
    first.setDraft('Accepted message');
    first.setImages([{ name: 'sent.png', url: 'data:image/png;base64,AAAA' }]);
    const accepted = Promise.withResolvers<void>();
    first.trackSubmission(accepted.promise.then(() => {
      first.setDraft((current) => current === 'Accepted message' ? '' : current);
      first.setImages([]);
    }));
    first.dispose();
    const reopened = f.open();
    if (editedAfterReopen) reopened.setDraft('New typing after reopening');
    accepted.resolve();
    await reopened.ready;
    assert.equal(reopened.draft(), editedAfterReopen ? 'New typing after reopening' : '');
    assert.deepEqual(reopened.images(), []);
    reopened.dispose();
    const again = f.open();
    await again.ready;
    assert.equal(again.draft(), editedAfterReopen ? 'New typing after reopening' : '');
    assert.deepEqual(again.images(), []);
    again.dispose();
  });
}

const panelBuild = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/agent-chat/chat-panel.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'transform', jsxFactory: 'view', jsxFragment: 'view',
  plugins: [{ name: 'chat-boundaries', setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

function hostedPanel(newChat = false) {
  type Draft = import('../../web/src/agent-chat/store.ts').Draft;
  type Model = import('@diffusionstudio/agent-chat').ModelRef;
  type Composer = Parameters<typeof import('../../web/src/agent-chat/composer.tsx').Composer>[0];
  const [active, setActive] = solid.createSignal<string | null>(newChat ? null : 'existing');
  const [model, setModel] = solid.createSignal<Model>({ harness: 'codex', model: 'codex-model' });
  const [drafts, setDrafts] = solid.createSignal<Record<string, Draft>>({
    [newChat ? 'new:project' : 'existing']: { text: 'Original prompt', attachments: [{ key: 'old', name: 'old.png', kind: 'file', path: '/old.png' }] },
  });
  const pending = Promise.withResolvers<string>();
  let composer: Composer | undefined;
  const noop = () => {};
  const empty = () => ({ text: '', attachments: [] });
  const read = (key: string) => drafts()[key] ?? empty();
  const writeText = (key: string, text: string) => setDrafts((drafts) => ({ ...drafts, [key]: { ...read(key), text } }));
  const writeAttachments = (key: string, attachments: Draft['attachments']) => setDrafts((drafts) => ({ ...drafts, [key]: { ...read(key), attachments } }));
  const store = {
    activeChatId: active, blockedReason: () => null, chatState: { sending: {}, connection: 'open' },
    clearDraft: (key: string) => setDrafts((drafts) => ({ ...drafts, [key]: empty() })),
    currentModel: model, draft: read, draftKey: (_project: string, chat: string | null) => chat ?? 'new:project',
    ensureConnected: noop, interrupt: noop, openChat: noop, refreshChats: async () => {}, respond: noop,
    send: () => pending.promise.then((id) => { if (newChat) setActive(id); return id; }),
    setActiveChat: (_project: string, chat: string | null) => setActive(chat),
    setDraftAttachments: writeAttachments, setDraftText: writeText, setStoredModel: setModel, storedModel: model,
    summaryOf: (_project: string, id: string | null) => id ? { id, harness: 'codex', model: 'codex-model', status: 'idle' } : null,
    transcriptOf: () => ({ items: [{ id: 'message', kind: 'assistant', text: 'Previous reply' }], pending: null }),
  };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid,
    '@/context/project': { useProject: () => ({ id: () => 'project', dir: () => '/project' }) },
    './store': store,
    './composer': { Composer: 'Composer' },
    './attachments': { attachmentPaths: (attachments: Draft['attachments']) => attachments.map((item) => item.path), mergeAttachments: (current: Draft['attachments'], next: Draft['attachments']) => [...current, ...next.filter((entry) => !current.some((item) => item.key === entry.key))] },
    somoto: { toast: { error: noop } },
  };
  const module = { exports: {} as typeof import('../../web/src/agent-chat/chat-panel.tsx') };
  runInThisContext(`(function(require,module,exports,view){${panelBuild.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? new Proxy({}, { get: () => noop }), module, module.exports,
    (tag: unknown, props: Composer) => { if (tag === 'Composer') composer = props; },
  );
  const dispose = solid.createRoot((dispose) => { module.exports.ChatPanel(); return dispose; });
  assert.ok(composer);
  return { dispose, read, writeText, writeAttachments, pending, send: composer.onSend, changeModel: composer.onModel };
}

test('changing chat providers carries the draft before clearing its old conversation', () => {
  const f = hostedPanel();
  try {
    f.changeModel({ harness: 'claude', model: 'claude-model' });
    assert.equal(f.read('new:project').text, 'Original prompt');
    assert.equal(f.read('new:project').attachments[0]?.key, 'old');
    assert.equal(f.read('existing').text, '');
  } finally { f.dispose(); }
});

for (const succeeds of [true, false]) {
  test(`an ${succeeds ? 'accepted' : 'unsuccessful'} chat send preserves input edited while it was pending`, async () => {
    const f = hostedPanel();
    try {
      f.send();
      f.writeText('existing', 'More direction while sending');
      f.writeAttachments('existing', [...f.read('existing').attachments, { key: 'new', name: 'new.png', kind: 'file', path: '/new.png' }]);
      if (succeeds) f.pending.resolve('existing');
      else f.pending.reject(new Error('Host disconnected'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(f.read('existing').text, 'More direction while sending');
      assert.deepEqual(f.read('existing').attachments.map((item) => item.key), succeeds ? ['new'] : ['old', 'new']);
    } finally { f.dispose(); }
  });
}


test('the first accepted chat send carries newer input into its new conversation', async () => {
  const f = hostedPanel(true);
  try {
    f.send();
    f.writeText('new:project', 'Continue with this next');
    f.writeAttachments('new:project', [{ key: 'new', name: 'new.png', kind: 'file', path: '/new.png' }]);
    f.writeText('created', 'Keep destination text');
    f.pending.resolve('created');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.read('created').text, 'Keep destination text\n\nContinue with this next');
    assert.deepEqual(f.read('created').attachments.map((item) => item.key), ['new']);
    assert.equal(f.read('new:project').text, '');
  } finally { f.dispose(); }
});

test('changing providers preserves an existing new-chat draft', () => {
  const f = hostedPanel();
  try {
    f.writeText('new:project', 'Earlier draft');
    f.writeAttachments('new:project', [{ key: 'new', name: 'new.png', kind: 'file', path: '/new.png' }]);
    f.changeModel({ harness: 'claude', model: 'claude-model' });
    assert.equal(f.read('new:project').text, 'Earlier draft\n\nOriginal prompt');
    assert.deepEqual(f.read('new:project').attachments.map((entry) => entry.key), ['new', 'old']);
    assert.equal(f.read('existing').text, '');
  } finally { f.dispose(); }
});

test('failed dashboard skills merge by exact path and restore with the rest of the draft', async () => {
  const f = fixture();
  const first = f.open();
  await first.ready;
  const existing = { name: 'cut', path: '/skills/cut/SKILL.md', description: 'Existing cut skill' };
  const selected = { ...existing, description: 'Updated cut skill' };
  const sameName = { name: 'cut', path: '/project/.agents/skills/cut/SKILL.md', description: 'Project cut skill' };
  first.setSkills([existing]);
  first.setDraft('Keep my edit');
  first.setImages([{ name: 'frame.png', url: 'data:image/png;base64,AAAA' }]);
  first.dispose();
  await f.prepare({ id: 'project-a', dir: 'project-a' }, 'codex', { text: 'Dashboard edit', model: 'chosen', skills: [selected, sameName, selected] });
  const reopened = f.open();
  await reopened.ready;
  assert.deepEqual(reopened.skills(), [selected, sameName]);
  assert.equal(reopened.draft(), 'Keep my edit\n\nDashboard edit');
  assert.equal(reopened.images()[0]?.name, 'frame.png');
  reopened.dispose();
});
