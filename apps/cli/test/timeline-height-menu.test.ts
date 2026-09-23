import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/components/timeline/layers/layers.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform', jsxFactory: 'view',
  plugins: [{ name: 'layers-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

test('the closed layer-height menu does not scan the timeline during playback', () => {
  let heightReads = 0;
  const [frame, setFrame] = solid.createSignal(0);
  const layers = Array.from({ length: 1000 }, () => ({
    kind: 'geometry', children: [], entity: { get() { heightReads++; return { value: 40 }; } },
  }));
  const scene = { get: () => ({ localTime: 0 }) };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid,
    '@diffusionstudio/koota-solid': { useWorld: () => ({}), useTrait: () => () => undefined },
    '@diffusionstudio/runtime': { ClipHeight: 'ClipHeight', Computed: 'Computed' },
    '@/engine/hooks': {
      useEditor: () => ({}), useTimelineIndex: () => () => ({ root: scene, layers }),
      useDerived: (read: () => unknown) => solid.createMemo(() => { frame(); return solid.untrack(read); }),
    },
    '@/context/timeline': { useTimeline: () => ({ setMinimized() {}, mount() {}, unmount() {} }) },
    '@/context/layout': { useLayout: () => ({ timelineMinimized: () => false, timeFormat: () => 'standard' }) },
    '@/engine/timeline': { DEFAULT_CLIP_HEIGHT: 40, RULER_HEIGHT: 40 },
    '../time-format': { formatFrames: () => '00:00', TIME_FORMAT_OPTIONS: [] },
  };
  let setMenuOpen: ((open: boolean) => void) | undefined;
  let setRootOpen: ((open: boolean) => void) | undefined;
  const view = (tag: unknown, props: Record<string, unknown> | null) => {
    if (tag === 'DropdownMenuSub' && props?.onOpenChange) setMenuOpen = props.onOpenChange as typeof setMenuOpen;
    if (tag === 'DropdownMenu' && props?.onOpenChange) setRootOpen = props.onOpenChange as typeof setRootOpen;
  };
  const module = { exports: {} as typeof import('../../web/src/components/timeline/layers/layers.tsx') };
  runInThisContext(`(function(require,module,exports,view,document){"use strict";${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? new Proxy({}, { get: (_target, key) => key }),
    module, module.exports, view, new EventTarget(),
  );
  const dispose = solid.createRoot((dispose) => { module.exports.Layers(); return dispose; });
  const tick = () => setFrame(value => value + 1);
  try {
    for (let index = 0; index < 120; index++) tick();
    assert.equal(heightReads, 0, 'a closed menu must not read all 1,000 row heights each frame');
    assert.ok(setMenuOpen);
    setMenuOpen(true); tick();
    assert.equal(heightReads, 1000, 'opening the menu checks current row heights');
    setMenuOpen(false);
    for (let index = 0; index < 120; index++) tick();
    assert.equal(heightReads, 1000, 'closing the menu stops the scan again');
    setMenuOpen(true); tick();
    assert.ok(setRootOpen);
    setRootOpen(false);
    for (let index = 0; index < 120; index++) tick();
    assert.equal(heightReads, 2000, 'closing the parent menu also stops its open submenu scan');
  } finally { dispose(); }
});
