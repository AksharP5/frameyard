import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/hooks/use-timeline-index.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['solid-js', '@diffusionstudio/runtime', '@diffusionstudio/koota-solid', '../context'],
});

function world() {
  const [frame, setFrame] = solid.createSignal(0);
  return {
    frame, tick: () => setFrame((value) => value + 1), builds: 0, root: 1,
    layers: [{ entity: 2, kind: 'geometry', expanded: false, expandable: true, children: [] }],
  };
}

function fixture() {
  const Context = solid.createContext<ReturnType<typeof world>>();
  const useScene = () => {
    const scene = solid.useContext(Context);
    assert.ok(scene, 'the shared index must retain its provider context');
    return scene;
  };
  const module = { exports: {} as typeof import('../../web/src/engine/hooks/use-timeline-index.ts') };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid,
    '@diffusionstudio/koota-solid': { useWorld: useScene },
    '../context': { useEngineContext: useScene },
    '@diffusionstudio/runtime': {
      getActiveEntity: (world: ReturnType<typeof world>) => world.root,
      buildTimelineLayers: (world: ReturnType<typeof world>) => { world.builds++; return structuredClone(world.layers); },
    },
  };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)((name: string) => dependencies[name], module, module.exports);
  function mount(scene: ReturnType<typeof world>) {
    let mounted: { value: ReturnType<typeof module.exports.useTimelineIndex>; updates(): number; dispose(): void } | undefined;
    solid.createRoot((dispose) => {
      solid.createComponent(Context.Provider, { value: scene, get children() {
        const value = module.exports.useTimelineIndex();
        let updates = 0;
        solid.createComputed(() => { value(); updates++; });
        mounted = { value, updates: () => updates, dispose };
        return null;
      } });
    });
    assert.ok(mounted);
    return mounted;
  }
  return { mount };
}

test('four timeline consumers share one tree build per tick and suppress unchanged row updates', () => {
  const f = fixture();
  const scene = world();
  const consumers = Array.from({ length: 4 }, () => f.mount(scene));
  for (let frame = 0; frame < 120; frame++) scene.tick();
  assert.equal(scene.builds, 121, 'build the tree once initially and once per tick');
  for (const consumer of consumers) assert.equal(consumer.updates(), 1);
  scene.layers[0].expanded = true;
  scene.tick();
  for (const consumer of consumers) {
    assert.equal(consumer.updates(), 2);
    assert.equal(consumer.value().layers[0].expanded, true);
    consumer.dispose();
  }
});

test('shared timeline state outlives its first consumer, releases its last consumer, and isolates worlds', () => {
  const f = fixture();
  const a = world(), b = world();
  const first = f.mount(a), remaining = f.mount(a), other = f.mount(b);
  first.dispose();
  a.layers[0].expanded = true;
  a.tick();
  assert.equal(remaining.value().layers[0].expanded, true);
  assert.equal(other.value().layers[0].expanded, false);
  assert.equal(b.builds, 1);
  remaining.dispose();
  const builds = a.builds;
  a.tick();
  assert.equal(a.builds, builds, 'the last unmount stops frame sampling');
  a.layers[0].expanded = false;
  const reopened = f.mount(a);
  assert.equal(reopened.value().layers[0].expanded, false);
  assert.equal(a.builds, builds + 1);
  reopened.dispose();
  other.dispose();
});
