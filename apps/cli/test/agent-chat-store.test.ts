import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { ChatSummary } from '@diffusionstudio/agent-chat';
import type { CodexRequest } from '../../desktop/src/codex-contracts.ts';
import type { ChatDraft } from '../../web/src/components/agent/chat-draft.ts';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const store = require(require.resolve('solid-js/store').replace('server.cjs', 'store.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/agent-chat/store.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{ name: 'store-boundaries', setup(build) {
    build.onResolve({ filter: /^@\/components\/agent\/chat-draft$/ }, () => ({ path: fileURLToPath(new URL('../../web/src/components/agent/chat-draft.ts', import.meta.url)) }));
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' || path === '@diffusionstudio/agent-chat' || path === './chat-list' ? undefined : { path, external: true });
  } }],
});

const summary = (id: string): ChatSummary => ({ id, projectId: 'project', harness: 'claude', model: 'model', title: id, status: 'idle', createdAt: 1, updatedAt: 1 });

function fixture(config: { localMode?: boolean; desktop?: boolean; nativeSendError?: Error; savedDraft?: Partial<ChatDraft> } = {}) {
  type Message = Parameters<Parameters<typeof import('@diffusionstudio/agent-chat').AgentChatClient.prototype.open>[1]>[0];
  const listeners = new Map<string, (message: Message) => void>();
  const send = Promise.withResolvers<{ chatId: string }>();
  const nativeRequests: CodexRequest[] = [];
  const savedDraft = structuredClone(config.savedDraft ?? {});
  let deletionError: Error | undefined;
  const noop = () => {};
  const dependencies: Record<string, unknown> = {
    'solid-js': solid, 'solid-js/store': store,
    somoto: { toast: { error: noop } },
    '@/lib/local-mode': { localMode: config.localMode ?? false },
    '@desktop/main-channels': { MAIN_CHANNELS: { CODEX_REQUEST: 'codex:request' } },
    '@/lib/ipc': { mainBridge: { call: async (_channel: string, request: CodexRequest) => {
      nativeRequests.push(request);
      if (request.method === 'send' && config.nativeSendError) throw config.nativeSendError;
      return {};
    } } },
    '@/lib/db': {
      loadChatDraft: async () => structuredClone(savedDraft),
      saveChatDraftField: async <Key extends keyof ChatDraft>(_key: string, field: Key, value: ChatDraft[Key]) => { savedDraft[field] = structuredClone(value); },
    },
    '@/init': { store: { define: (_key: string, value: unknown) => ({ value }) } },
    '@/lib/store': { createStoredSignal: (stored: { value: unknown }) => solid.createSignal(stored.value) },
    './connection': { hasHost: () => true, client: {
      state: 'open', onState: () => noop, onHarnesses: noop, connect: noop,
      open: (id: string, listener: (message: Message) => void) => { listeners.set(id, listener); return () => { listeners.delete(id); }; },
      request: async (method: string) => {
        if (method === 'turn.send') return send.promise;
        if (method === 'chats.delete' && deletionError) throw deletionError;
        if (method === 'chats.list') return [summary('existing')];
      },
    } },
    './attachments': {
      attachmentFromPath: (path: string) => ({ key: path, path, name: path, kind: 'file' }),
      mergeAttachments: (current: { key: string }[], next: { key: string }[]) => [...current, ...next.filter((entry) => !current.some((item) => item.key === entry.key))],
    },
  };
  const module = { exports: {} as typeof import('../../web/src/agent-chat/store.ts') };
  runInThisContext(`(function(require,module,exports,window){${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? {}, module, module.exports, { desktop: config.desktop === false ? undefined : {} },
  );
  return { ...module.exports, listeners, nativeRequests, savedDraft, accept: send.resolve, reject: send.reject, failDeletion: (error?: Error) => { deletionError = error; } };
}

const options = { projectId: 'project', cwd: '/project', chatId: null, text: 'New prompt', attachments: [], model: { harness: 'claude' as const, model: 'model' } };

test('an accepted new chat is selected and remains busy until its first snapshot', async () => {
  const f = fixture();
  await f.refreshChats('project');
  f.setActiveChat('project', null);
  const pending = f.send(options);
  f.accept({ chatId: 'created' });
  await pending;
  assert.equal(f.activeChatId('project'), 'created');
  assert.equal(f.summaryOf('project', 'created')?.harness, 'claude');
  assert.equal(f.chatState.sending.created?.kind, 'user');
  assert.equal(f.chatState.sending['new:project'], null);
  f.listeners.get('created')?.({ type: 'snapshot', snapshot: { chat: summary('created'), items: [{ id: 'user', kind: 'user', text: 'New prompt' }], pending: null } });
  assert.equal(f.chatState.sending.created, null);
  assert.equal(f.transcriptOf('created').items.length, 1);
});

test('send acceptance preserves a conversation selected while the request was pending', async () => {
  const f = fixture();
  await f.refreshChats('project');
  f.setActiveChat('project', null);
  const pending = f.send(options);
  f.setActiveChat('project', 'existing');
  f.accept({ chatId: 'created' });
  await pending;
  f.listeners.get('created')?.({ type: 'snapshot', snapshot: { chat: summary('created'), items: [], pending: null } });
  assert.equal(f.activeChatId('project'), 'existing');
});

test('a rejected deletion preserves the live subscription and draft', async () => {
  const f = fixture();
  await f.refreshChats('project');
  f.setActiveChat('project', 'existing');
  f.setDraftText('existing', 'Unsent');
  f.openChat('existing');
  f.failDeletion(new Error('Chat is busy'));
  await assert.rejects(f.deleteChat('project', 'existing'), /busy/);
  assert.ok(f.listeners.has('existing'));
  f.listeners.get('existing')?.({ type: 'snapshot', snapshot: { chat: { ...summary('existing'), title: 'Still connected' }, items: [], pending: null } });
  assert.equal(f.summaryOf('project', 'existing')?.title, 'Still connected');
  assert.equal(f.draft('existing').text, 'Unsent');
  f.failDeletion();
  await f.deleteChat('project', 'existing');
  assert.equal(f.listeners.has('existing'), false);
  assert.equal(f.activeChatId('project'), null);
  assert.equal(f.draft('existing').text, '');
});

test('a failed dashboard send preserves an existing draft and attachments', async () => {
  const f = fixture();
  f.setDraftText('new:project', 'Earlier draft');
  f.setDraftAttachments('new:project', [{ key: '/old.png', path: '/old.png', name: 'old.png', kind: 'file' }]);
  const pending = f.startChat({ project: { id: 'project', name: 'Project', dir: '/project' }, text: 'Dashboard prompt', attachments: ['/new.png'], model: options.model });
  f.reject(new Error('Host unavailable'));
  await pending;
  assert.equal(f.draft('new:project').text, 'Earlier draft\n\nDashboard prompt');
  assert.deepEqual(f.draft('new:project').attachments.map((item) => item.key), ['/old.png', '/new.png']);
});

const dashboard = {
  project: { id: 'project', name: 'Project', dir: '/project', displayName: 'Project', entry: 'index.tsx', modifiedAt: '', createdAt: '' },
  text: 'Use the selected skill', attachments: ['/new.png'], model: { harness: 'codex' as const, model: 'codex-model' },
  skills: [{ name: 'video-editing', path: '/skills/video-editing/SKILL.md', description: 'Edit a video' }],
};

test('native dashboard sends forward selected skill identities through the existing Codex request', async () => {
  const f = fixture({ localMode: true });
  await f.startChat(dashboard);
  assert.deepEqual(f.nativeRequests, [
    { method: 'new', input: { dir: '/project' } },
    { method: 'send', input: {
      dir: '/project', model: 'codex-model',
      text: 'Use the selected skill\n\nAttached files and folders:\n/new.png',
      skills: [{ name: 'video-editing', path: '/skills/video-editing/SKILL.md' }],
      context: { projectDir: '/project', source: 'dashboard', attachments: ['/new.png'] },
    } },
  ]);
  assert.equal(f.savedDraft.draft, undefined, 'an accepted prompt is not restored as unsent');
});

test('failed native dashboard sends retain selected skills alongside the existing text and image draft', async () => {
  const existing = { name: 'audio-editing', path: '/skills/audio-editing/SKILL.md', description: 'Edit audio' };
  const images = [{ name: 'old.png', url: 'data:image/png;base64,AAAA' }];
  const f = fixture({ localMode: true, nativeSendError: new Error('Unavailable'), savedDraft: {
    draft: 'Earlier text', images, skills: [existing],
  } });
  await f.startChat(dashboard);
  assert.deepEqual(f.savedDraft.skills, [existing, ...dashboard.skills]);
  assert.equal(f.savedDraft.draft, 'Earlier text\n\nUse the selected skill\n\nAttached files and folders:\n/new.png');
  assert.deepEqual(f.savedDraft.images, images);
  assert.equal(f.savedDraft.modelOverride, 'codex-model');
});

test('selected skills reject unsupported providers or transports before starting a chat', async () => {
  for (const config of [
    { localMode: true, harness: 'claude' as const },
    { localMode: false, harness: 'codex' as const },
    { localMode: true, desktop: false, harness: 'codex' as const },
  ]) {
    const f = fixture(config);
    f.accept({ chatId: 'unexpected' });
    await assert.rejects(f.startChat({ ...dashboard, model: { harness: config.harness, model: 'model' } }), /Skills require native Codex/);
    assert.deepEqual(f.nativeRequests, []);
    assert.deepEqual(f.savedDraft, {});
    assert.equal(f.activeChatId('project'), null);
  }
});
