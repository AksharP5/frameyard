import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { Item } from '@diffusionstudio/agent-chat';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/agent-chat/transcript-rows.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['solid-js'],
});
const module = { exports: {} as typeof import('../../web/src/agent-chat/transcript-rows.ts') };
runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
  () => solid, module, module.exports,
);
const { createTranscriptRows } = module.exports;
const message = (id: string, text = id): Item => ({ id, kind: 'assistant', text });

test('streaming updates only the active row without remounting it', () => {
  solid.createRoot((dispose) => {
    try {
      const [items, setItems] = solid.createSignal(Array.from({ length: 60 }, (_,i) => message(String(i))));
      const rows = createTranscriptRows(items, () => 'chat');
      let mounts = 0;
      let cleanups = 0;
      const reads = new Map<string, number>();
      let streamedText = '';
      const mounted = solid.mapArray(rows, (item) => {
        mounts++;
        solid.onCleanup(() => cleanups++);
        solid.createComputed(() => {
          const current = item();
          reads.set(current.id, (reads.get(current.id) ?? 0) + 1);
          if (current.id === '59' && current.kind === 'assistant') streamedText = current.text;
        });
        return item;
      });
      solid.createComputed(mounted);
      for (let i = 0; i < 100; i++) {
        setItems((current) => current.map((item) => item.id === '59' ? message('59', `chunk ${i}`) : item));
      }
      assert.equal(mounts, 60);
      assert.equal(cleanups, 0);
      assert.equal(reads.get('0'), 1, 'completed rows receive no streaming work');
      assert.equal(reads.get('59'), 101);
      assert.equal(streamedText, 'chunk 99');
    } finally { dispose(); }
  });
});

test('loading history and completing a tool preserve row state', () => {
  solid.createRoot((dispose) => {
    try {
      const tool: Item = { id: 'tool', kind: 'tool', title: 'Export', status: 'running' };
      const [items, setItems] = solid.createSignal<Item[]>([tool]);
      const rows = createTranscriptRows(items, () => 'chat');
      const mounted = solid.mapArray(rows, (item) => ({ item, expanded: solid.createSignal(false) }));
      solid.createComputed(mounted);
      const original = mounted()[0]!;
      original.expanded[1](true);
      setItems([message('earlier'), { ...tool, status: 'done', output: 'Exported' }]);
      assert.equal(mounted()[1], original);
      assert.equal(original.expanded[0](), true);
      assert.deepEqual(original.item(), { ...tool, status: 'done', output: 'Exported' });
      setItems((current) => [...current, message('later')]);
      assert.equal(mounted()[1], original);
      assert.deepEqual(mounted().map(({ item }) => item().id), ['earlier', 'tool', 'later']);
    } finally { dispose(); }
  });
});

test('removed rows and a different chat do not retain old row state', () => {
  solid.createRoot((dispose) => {
    try {
      const [items, setItems] = solid.createSignal([message('same-id')]);
      const [chat, setChat] = solid.createSignal('first');
      const rows = createTranscriptRows(items, chat);
      let mounts = 0;
      let cleanups = 0;
      const mounted = solid.mapArray(rows, (item) => {
        mounts++;
        solid.onCleanup(() => cleanups++);
        return item;
      });
      solid.createComputed(mounted);
      const first = mounted()[0];
      setChat('second');
      assert.notEqual(mounted()[0], first);
      assert.equal(cleanups, 1);
      const second = mounted()[0];
      setItems([]);
      setItems([message('same-id')]);
      assert.notEqual(mounted()[0], second);
      assert.equal(mounts, 3);
      assert.equal(cleanups, 2);
    } finally { dispose(); }
  });
});
