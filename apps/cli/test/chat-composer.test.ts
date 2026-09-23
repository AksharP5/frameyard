import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/agent-chat/prompt-input.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view', jsxFragment: 'view',
  plugins: [{ name: 'composer-boundaries', setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' || path === './skill-mentions' ? undefined : { path, external: true });
  } }],
});

test('restored multiline input resizes when its hidden panel opens without observing its own height changes', () => {
  let width = 0;
  let contentHeight = 0;
  let writes = 0;
  let height = '';
  let resize: (() => void) | undefined;
  let disconnected = false;
  const field = {
    get clientWidth() { return width; },
    get scrollHeight() { return contentHeight; },
    style: { get height() { return height; }, set height(value: string) { height = value; writes++; } },
  };
  class Observer {
    constructor(callback: () => void) { resize = callback; }
    observe(element: unknown) { assert.equal(element, field); }
    disconnect() { disconnected = true; }
  }
  const noop = () => {};
  const dependencies: Record<string, unknown> = {
    'solid-js': solid,
  };
  const module = { exports: {} as typeof import('../../web/src/agent-chat/prompt-input.tsx') };
  runInThisContext(`(function(require,module,exports,view,ResizeObserver){${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? new Proxy({}, { get: () => noop }), module, module.exports,
    (tag: unknown, props: { ref?: (field: unknown) => void }) => { if (tag === 'textarea') props.ref?.(field); }, Observer,
  );
  const dispose = solid.createRoot((dispose) => {
    module.exports.PromptInput({
      text: 'A saved draft\nwith several\nlines of context', onText: noop, label: 'Message the agent',
    });
    return dispose;
  });
  try {
    assert.equal(writes, 0, 'hidden input must not be measured as zero height');
    width = 300;
    contentHeight = 120;
    assert.ok(resize);
    resize();
    assert.equal(height, '120px');
    const resized = writes;
    resize();
    assert.equal(writes, resized, 'height-only observer notifications must not feed another resize');
    width = 180;
    contentHeight = 230;
    resize();
    assert.equal(height, '160px', 'narrower panels recalculate wrapping and retain the height cap');
  } finally { dispose(); }
  assert.equal(disconnected, true);
});

type Skill = import('../../desktop/src/codex-capabilities.ts').CodexSkill;
const available: Skill[] = [
  { name: 'captions', description: 'Add subtitles', path: '/skills/captions' },
  { name: 'capture', description: 'Capture a frame', path: '/skills/capture' },
];

type InputHandlers = {
  ref(element: unknown): void;
  onFocus(): void;
  onInput(event: { currentTarget: { value: string } }): void;
  onKeyDown(event: KeyboardEvent): void;
};

function promptFixture(initial: string, selected: Skill[] = []) {
  const [text, setText] = solid.createSignal(initial);
  const [skills, setSkills] = solid.createSignal(selected);
  const [catalog, setCatalog] = solid.createSignal(available);
  let handlers!: InputHandlers;
  let sends = 0;
  const field = {
    value: initial, selectionStart: initial.length, selectionEnd: initial.length,
    clientWidth: 300, scrollHeight: 48, style: { height: '' },
    focus() { handlers.onFocus(); },
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
  };
  const module = { exports: {} as typeof import('../../web/src/agent-chat/prompt-input.tsx') };
  runInThisContext(`(function(require,module,exports,view,ResizeObserver,document){${built.outputFiles[0].text}\n})`)(
    (name: string) => name === 'solid-js' ? solid : new Proxy({}, { get: () => () => {} }), module, module.exports,
    (tag: unknown, props: InputHandlers) => { if (tag === 'textarea') { handlers = props; props.ref(field); } },
    class { observe() {} disconnect() {} }, { getElementById: () => null },
  );
  const dispose = solid.createRoot(dispose => {
    module.exports.PromptInput({
      get text() { return text(); }, onText: setText, label: 'Message',
      get skills() { return skills(); }, onSkills: setSkills,
      catalog: {
        directory: () => '/project', enabled: () => true, result: () => ({ skills: catalog(), mcpServers: [], errors: [] }),
        loading: () => false, error: () => '', load: async () => {},
      },
      onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey) sends++; },
    });
    return dispose;
  });
  return {
    text, skills, setCatalog, sends: () => sends, dispose, field,
    focus: () => handlers.onFocus(),
    type(value: string, caret = value.length) {
      field.value = value; field.setSelectionRange(caret, caret);
      handlers.onInput({ currentTarget: field });
    },
    key(key: string, extra: Partial<KeyboardEvent> = {}) {
      let prevented = false;
      handlers.onKeyDown({ key, keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
        preventDefault: () => { prevented = true; }, stopPropagation() {}, ...extra } as KeyboardEvent);
      return prevented;
    },
  };
}

test('skill completion keeps keyboard focus and consumes Tab/Enter before sending', async () => {
  const f = promptFixture('Use $captions now', [available[0]]);
  try {
    f.focus();
    f.type('Use $captions now', 'Use $cap'.length);
    assert.equal(f.key('ArrowDown'), true);
    assert.equal(f.key('Tab'), true);
    await Promise.resolve();
    assert.equal(f.text(), 'Use $capture now');
    assert.deepEqual(f.skills(), [available[1]]);
    assert.equal(f.field.selectionStart, 'Use $capture '.length);
    assert.equal(f.sends(), 0);
    f.type('$cap');
    assert.equal(f.key('Enter'), true);
    await Promise.resolve();
    assert.equal(f.text(), '$captions ');
    assert.deepEqual(f.skills(), [available[0]]);
    assert.equal(f.sends(), 0);
  } finally { f.dispose(); }
});

test('Escape dismisses suggestions, IME Enter cannot send, and removing a token detaches its skill', () => {
  const f = promptFixture('$captions ', [available[0]]);
  try {
    f.focus();
    f.type('New message');
    assert.deepEqual(f.skills(), []);
    f.type('$cap');
    assert.equal(f.key('Enter', { isComposing: true }), false);
    assert.equal(f.sends(), 0);
    assert.equal(f.key('Escape'), true);
    f.key('Enter');
    assert.equal(f.sends(), 1);
  } finally { f.dispose(); }
});

test('a refreshed catalog resets keyboard selection instead of sending an unfinished mention', async () => {
  const f = promptFixture('$');
  try {
    f.focus();
    f.key('ArrowDown');
    f.setCatalog([available[0]]);
    assert.equal(f.key('Enter'), true);
    await Promise.resolve();
    assert.equal(f.text(), '$captions ');
    assert.deepEqual(f.skills(), [available[0]]);
    assert.equal(f.sends(), 0);
  } finally { f.dispose(); }
});

test('choosing a skill with the same name replaces its previous path', async () => {
  const replacement = { ...available[0], path: '/project/skills/captions' };
  const f = promptFixture('$captions', [available[0]]);
  try {
    f.setCatalog([available[0], replacement]);
    f.focus();
    f.key('ArrowDown');
    f.key('Tab');
    await Promise.resolve();
    assert.equal(f.text(), '$captions ');
    assert.deepEqual(f.skills(), [replacement]);
    assert.equal(f.sends(), 0);
  } finally { f.dispose(); }
});
