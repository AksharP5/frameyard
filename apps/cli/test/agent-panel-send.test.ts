import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
import type { CodexCommands, CodexConversation, CodexEvent, CodexEventData, CodexRequest } from '../../desktop/src/codex-contracts.ts';
import type { CodexPendingRequest } from '../../desktop/src/codex-requests.ts';
import type { ChatDraft } from '../../web/src/components/agent/chat-draft.ts';
import type { ProjectSaveState } from '../../web/src/projects/edits.ts';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/components/agent/agent-panel.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view', jsxFragment: 'view',
  plugins: [{ name: 'panel-boundaries', setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

const emptyConversation: CodexConversation = {
  session: { id: 'thread', name: 'Thread', preview: '', cwd: '/project', updatedAt: 0, source: 'app' },
  messages: [], settings: { model: null, reasoningEffort: null }, activeTurn: false,
};
const connectedStatus: CodexCommands['status']['result'] = {
  account: null, requiresLogin: false, defaults: { model: null, reasoningEffort: null }, models: [],
};

function fixture(saveState: ProjectSaveState, steering = false, restoredTab?: ChatDraft['tab'], responses: {
  load?: () => Promise<CodexCommands['load']['result']>;
  status?: () => Promise<CodexCommands['status']['result']>;
  approve?: () => Promise<void>;
} = {}) {
  const sent: CodexCommands['send']['input'][] = [];
  const approved: CodexCommands['approve']['input'][] = [];
  const calls: CodexRequest['method'][] = [];
  const reply = Promise.withResolvers<void>();
  const fields = new Map<string, ReturnType<typeof solid.createSignal<unknown>>>();
  const arrayStates: (() => unknown)[] = [];
  let submit: (() => void) | undefined;
  let retry: (() => void) | undefined;
  let checkLogin: (() => void) | undefined;
  let approve: (() => void) | undefined;
  let saveAttempts = 0;
  let mountedTabs: () => unknown = () => undefined;
  let messageState: (() => unknown) | undefined;
  let receiveEvent: ((event: CodexEvent) => void) | undefined;
  const noop = () => {};
  const project = { id: () => 'project-id', dir: () => '/project' };
  const session = { project, world: {} };
  const dependencies: Record<string, unknown> = {
    'solid-js': { ...solid, createSignal: (initial: unknown) => {
      const signal = solid.createSignal(initial);
      if (Array.isArray(initial) && initial.length === 1 && initial[0] === 'Chat') mountedTabs = signal[0];
      if (Array.isArray(initial) && initial.length === 0) { messageState ??= signal[0]; arrayStates.push(signal[0]); }
      return signal;
    } },
    '@/context/project': { useProject: () => project },
    '@/engine/hooks/use-selection': { useSelection: () => ({ nodes: () => [], entity: () => undefined }) },
    '@/engine/hooks/use-asset-selection': { useAssetSelection: () => ({ asset: () => undefined }) },
    '@/engine/library': { useLibrary: () => () => ({ settle: () => { saveAttempts++; throw new Error('Asset save failed'); } }) },
    '@/engine/project-config': { useProjectConfig: () => () => undefined },
    '@/context/prompt-input': { usePromptInput: () => ({ promptInputOpen: () => false, setPromptInputOpen: noop }) },
    '@/dapi/session': { editorSession: () => session },
    '@/dapi/handlers/context': { getEditorContext: async () => ({ projectDir: '/project', currentTime: 3, selected: [{ source: 'scene.tsx:clip' }] }) },
    '@/projects/edits': {
      flushProjectEdits: () => { saveAttempts++; throw new Error('Recovered unsaved edits. Retry saving to restore them.'); },
      getProjectSaveState: () => saveState,
    },
    './chat-draft': { agentTabs: ['Editor', 'Chat', 'Transcript', 'Effects'], catalogTabs: ['HyperFrames', 'Templates', 'Hyfrme'], toolTabs: ['Editor', 'Effects', 'Transcript', 'Audio', 'Checkpoints', 'Assets'], createChatDraft: () => ({
      field: (key: string, initial: unknown) => { const signal = solid.createSignal(key === 'tab' && !restoredTab ? 'Chat' : initial); fields.set(key, signal); return signal; },
      trackSubmission: (submission: Promise<void>) => void submission,
      ready: async () => { if (restoredTab) { await Promise.resolve(); fields.get('tab')![1](restoredTab); } },
    }) },
    '@desktop/main-channels': { MAIN_CHANNELS: { CODEX_REQUEST: 'codex', CODEX_EVENT: 'event' } },
    '@/lib/ipc': { mainBridge: { handle: (_channel: string, handler: (event: CodexEvent) => void) => { receiveEvent = handler; return noop; }, call: async (_channel: string, request: CodexRequest) => {
      calls.push(request.method);
      if (request.method === 'status') return { method: 'status', result: responses.status ? await responses.status() : connectedStatus };
      if (request.method === 'load') return { method: 'load', result: responses.load ? await responses.load() : { ...emptyConversation, activeTurn: steering, activeTurnId: steering ? 'active-turn' : undefined } };
      if (request.method === 'approve') { approved.push(request.input); await responses.approve?.(); return { method: 'approve', result: null }; }
      assert.ok(request.method === 'send');
      sent.push(request.input);
      await reply.promise;
      return { method: 'send', result: { turnId: steering ? 'active-turn' : 'new-turn' } };
    } } },
  };
  const module = { exports: {} as typeof import('../../web/src/components/agent/agent-panel.tsx') };
  const view = (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    if (children.includes('Retry connection')) retry = props?.onClick as () => void;
    if (children.includes('Check login')) checkLogin = props?.onClick as () => void;
    if (children.includes('Allow once')) approve = props?.onClick as () => void;
    if (props?.label === 'Message Codex') submit = props.onSend as () => void;
  };
  runInThisContext(`(function(require,module,exports,view){${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? new Proxy({}, { get: () => noop }), module, module.exports, view,
  );
  const dispose = solid.createRoot((dispose) => { module.exports.AgentPanel({ open: true }); return dispose; });
  return { sent, approved, reply, dispose, mountedTabs, calls,
    messages: () => messageState?.(),
    requests: (): CodexPendingRequest[] => {
      for (const read of arrayStates) {
        const value = read();
        if (Array.isArray(value) && value.some((item: unknown) => item !== null && typeof item === 'object' && 'kind' in item && 'threadId' in item)) return value as CodexPendingRequest[];
      }
      return [];
    },
    event: (event: CodexEventData, threadId = 'thread') => { assert.ok(receiveEvent); receiveEvent({ dir: '/project', threadId, ...event }); },
    setField: <Key extends keyof ChatDraft>(key: Key, value: ChatDraft[Key]) => fields.get(key)![1](() => value),
    saveAttempts: () => saveAttempts, draft: () => fields.get('draft')![0](),
    setDraft: (text: string) => fields.get('draft')![1](text),
    submit: () => { assert.ok(submit); submit(); },
    approve: () => { assert.ok(approve); approve(); },
    checkLogin: () => { assert.ok(checkLogin); checkLogin(); },
    retry: () => { assert.ok(retry); retry(); } };
}

test('approving a request once preserves a newer approval received before the response', async (t) => {
  const response = Promise.withResolvers<void>();
  const f = fixture({ status: 'saved' }, true, undefined, { approve: () => response.promise });
  t.after(f.dispose);
  await setImmediate();
  f.event({ type: 'approval', requestId: 'first', kind: 'command', text: 'First request' });
  f.approve();
  f.approve();
  assert.equal(f.approved.length, 1, 'duplicate clicks must send one decision');
  f.event({ type: 'approval', requestId: 'second', kind: 'file', text: 'Second request' });
  response.resolve();
  await setImmediate();
  f.approve();
  await setImmediate();
  assert.deepEqual(f.approved, [{ requestId: 'first', decision: 'accept' }, { requestId: 'second', decision: 'accept' }]);
  f.approve();
  assert.equal(f.approved.length, 2, 'a completed approval must be removed');
});

test('pending request updates preserve local form answers when other requests are added or removed', async (t) => {
  const f = fixture({ status: 'saved' }, true);
  t.after(f.dispose);
  await setImmediate();
  const first: CodexPendingRequest = {
    id: 'first', threadId: 'thread', turnId: 'turn', kind: 'input', isBlocking: false,
    questions: [{ id: 'style', header: 'Style', question: 'Which style?', isOther: true, isSecret: false, options: null }],
  };
  const second = { ...first, id: 'second' };
  const forms = solid.createRoot((dispose) => {
    t.after(dispose);
    return solid.mapArray(f.requests, (request) => {
      const [answer, setAnswer] = solid.createSignal('');
      return { id: request.id, answer, setAnswer };
    });
  });
  f.event({ type: 'requests', requests: [first] });
  forms()[0].setAnswer('Keep my first answer');
  f.event({ type: 'requests', requests: structuredClone([first, second]) });
  assert.equal(forms()[0].answer(), 'Keep my first answer');
  forms()[1].setAnswer('Keep my second answer');
  f.event({ type: 'requests', requests: structuredClone([second]) });
  assert.equal(forms()[0].id, 'second');
  assert.equal(forms()[0].answer(), 'Keep my second answer');
});

test('checking login refreshes a signed-out account without reloading the conversation', async (t) => {
  let statusReads = 0;
  const f = fixture({ status: 'saved' }, false, undefined, {
    status: async () => ({ ...connectedStatus, requiresLogin: ++statusReads === 1 }),
  });
  t.after(f.dispose);
  await setImmediate();
  f.checkLogin();
  f.checkLogin();
  await setImmediate();
  assert.equal(statusReads, 2);
  assert.equal(f.calls.filter((method) => method === 'load').length, 1);
  f.retry();
  await setImmediate();
  assert.equal(statusReads, 2, 'successful login must update the cached account state');
});

for (const includesDelta of [false, true]) {
  test(`a conversation load overlapping streamed text reconciles without ${includesDelta ? 'duplicating' : 'losing'} it`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const initialLoad = Promise.withResolvers<CodexCommands['load']['result']>();
    const latest: CodexConversation = { ...emptyConversation, messages: [{ id: 'reply', role: 'assistant', text: 'Earlier text. New text. More text.' }] };
    let reads = 0;
    const f = fixture({ status: 'saved' }, false, undefined, {
      load: () => ++reads === 1 ? initialLoad.promise : Promise.resolve(latest),
    });
    t.after(f.dispose);
    await setImmediate();
    f.event({ type: 'delta', itemId: 'reply', text: 'New text.' });
    initialLoad.resolve({ ...latest, activeTurn: true, messages: [{ id: 'reply', role: 'assistant', text: includesDelta ? 'Earlier text. New text.' : 'Earlier text. ' }] });
    await setImmediate();
    t.mock.timers.tick(50);
    assert.deepEqual(f.messages(), [{ id: 'reply', role: 'assistant', text: 'New text.' }], 'an overlapping snapshot must not replace live text');
    f.event({ type: 'delta', itemId: 'reply', text: ' More text.' });
    f.event({ type: 'turn', status: 'completed' });
    t.mock.timers.tick(50);
    await setImmediate();
    assert.equal(reads, 1, 'continued streaming must postpone the next snapshot read');
    t.mock.timers.tick(100);
    await setImmediate();
    assert.equal(reads, 2);
    assert.deepEqual(f.messages(), latest.messages);
    f.event({ type: 'delta', itemId: 'unrelated', text: 'Another thread' }, 'other-thread');
    t.mock.timers.tick(100);
    assert.deepEqual(f.messages(), latest.messages, 'another thread must not change the loaded conversation');
  });
}

test('retrying failed account/model status preserves a successfully loaded conversation and draft', async (t) => {
  let statusReads = 0;
  const f = fixture({ status: 'saved' }, false, undefined, {
    status: async () => { if (++statusReads === 1) throw new Error('Status unavailable'); return connectedStatus; },
  });
  t.after(f.dispose);
  await setImmediate();
  f.setDraft('Keep my draft');
  f.setField('modelOverride', 'chosen-model');
  f.event({ type: 'delta', itemId: 'reply', text: 'Keep my conversation' });
  f.event({ type: 'turn', status: 'completed' });
  f.retry();
  await setImmediate();
  assert.equal(statusReads, 2);
  assert.equal(f.calls.filter((method) => method === 'load').length, 1, 'retry status independently');
  assert.deepEqual(f.messages(), [{ id: 'reply', role: 'assistant', text: 'Keep my conversation' }]);
  assert.equal(f.draft(), 'Keep my draft');
  f.submit();
  await setImmediate();
  assert.equal(f.sent[0]?.model, 'chosen-model');
  f.reply.resolve();
  await setImmediate();
});

test('streamed replies batch bursts and flush their final text before turn completion', async (t) => {
  const f = fixture({ status: 'saved' });
  t.after(f.dispose);
  await setImmediate();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let index = 0; index < 100; index++) f.event({ type: 'delta', itemId: 'reply', text: `${index} ` });
  assert.deepEqual(f.messages(), []);
  t.mock.timers.tick(49);
  assert.deepEqual(f.messages(), [], 'a burst should not render each arriving token');
  t.mock.timers.tick(1);
  const text = Array.from({ length: 100 }, (_, index) => `${index} `).join('');
  assert.deepEqual(f.messages(), [{ id: 'reply', role: 'assistant', text }]);

  f.event({ type: 'delta', itemId: 'reply', text: 'Finished.' });
  f.event({ type: 'turn', status: 'completed' });
  const completed = [{ id: 'reply', role: 'assistant', text: text + 'Finished.' }];
  assert.deepEqual(f.messages(), completed, 'the last text must appear with the completed turn');
  t.mock.timers.tick(100);
  assert.deepEqual(f.messages(), completed, 'the cancelled timer must not append the final text twice');
});

for (const [label, state, steering] of [
  ['recovered edits', { status: 'failed', error: 'Recovered unsaved edits. Retry saving to restore them.', retryable: true }, false],
  ['unsaved edits while steering', { status: 'dirty' }, true],
] as const) {
  test(`chat sends with ${label} without saving the project`, async (t) => {
    const f = fixture(state, steering);
    t.after(f.dispose);
    await setImmediate();
    f.setDraft('Can you help with the audio?');
    f.submit();
    await setImmediate();
    assert.equal(f.sent.length, 1);
    assert.equal(f.saveAttempts(), 0);
    assert.equal(f.sent[0].text, 'Can you help with the audio?');
    const context = f.sent[0].context;
    assert.ok(context && typeof context === 'object' && 'projectSave' in context);
    assert.deepEqual(context.projectSave, state);
    assert.equal(f.sent[0].expectedTurnId, steering ? 'active-turn' : undefined);
    assert.equal(f.draft(), 'Can you help with the audio?', 'retain draft until the send is accepted');
    f.reply.resolve();
    await setImmediate();
    assert.equal(f.draft(), '');
  });
}

test('a failed chat request keeps the unsent draft', async (t) => {
  const f = fixture({ status: 'failed', error: 'Disk is full', retryable: true });
  t.after(f.dispose);
  await setImmediate();
  f.setDraft('Help me recover this project');
  f.submit();
  await setImmediate();
  assert.equal(f.sent.length, 1);
  f.reply.reject(new Error('Codex is disconnected'));
  await setImmediate();
  assert.equal(f.draft(), 'Help me recover this project');
});


test('restored workspace tabs mount their panel after draft loading', async (t) => {
  const f = fixture({ status: 'saved' }, false, 'Transcript');
  t.after(f.dispose);
  await setImmediate();
  assert.ok((f.mountedTabs() as readonly string[]).includes('Transcript'));
  f.setField('tab', 'Effects');
  assert.ok((f.mountedTabs() as readonly string[]).includes('Effects'), 'programmatic tab changes must mount their panel too');
});

for (const kind of ['area', 'timeRange', 'transcript'] as const) {
  test(`chat sends an attached ${kind} without requiring extra text`, async (t) => {
    const f = fixture({ status: 'failed', error: 'Disk is full', retryable: true });
    t.after(f.dispose);
    await setImmediate();
    const scene = { sceneId: 'scene.tsx:main', sceneName: 'Main' };
    if (kind === 'timeRange') f.setField(kind, { ...scene, start: 1, end: 2, frameRate: 30 });
    if (kind === 'transcript') f.setField(kind, { ...scene, projectDir: '/project', path: '/project/assets/transcript.json', assetPath: 'transcript.json', duration: 12, capturedAt: 'now', timing: 'scene-seconds' });
    if (kind === 'area') {
      const snapshot = { ...scene, sceneSize: { width: 1920, height: 1080 }, frame: 90, time: 3, imageUrl: 'data:image/png;base64,AAAA', context: { rootDir: '/projects', projectDir: '/project', activeScene: null, selected: [], selectedAsset: null, assets: [], assetCount: 0, currentTime: 3, sceneTiming: null, fontFamilies: [], generations: [] } };
      f.setField(kind, { snapshot, annotation: { ...snapshot, note: '', region: { x: 0, y: 0, width: 1, height: 1 } } });
    }
    f.submit();
    await setImmediate();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /Main/);
    assert.equal(f.saveAttempts(), 0);
    f.reply.resolve();
    await setImmediate();
  });
}


for (const isBlocking of [false, true]) {
  test(`native steering ${isBlocking ? 'waits for a blocking' : 'continues through an optional'} question`, async (t) => {
    const f = fixture({ status: 'saved' }, true);
    t.after(f.dispose);
    await setImmediate();
    f.event({ type: 'requests', requests: [{
      id: 'question', threadId: 'thread', turnId: 'active-turn', kind: 'input', isBlocking,
      questions: [{ id: 'style', header: 'Style', question: 'Which style?', isOther: true, isSecret: false, options: null }],
    }] });
    f.setDraft('Continue with my latest direction');
    f.submit();
    await setImmediate();
    assert.equal(f.sent.length, isBlocking ? 0 : 1);
    if (!isBlocking) assert.equal(f.sent[0].expectedTurnId, 'active-turn');
    f.reply.resolve();
    await setImmediate();
  });
}
