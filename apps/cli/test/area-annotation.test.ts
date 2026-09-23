import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const math = await build({
  stdin: { contents: `export {invert2D, multiply2D} from './index';`, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/math/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node',
});
const mathModule = { exports: {} as Pick<typeof import('../../../packages/runtime/src/math/index.ts'), 'invert2D' | 'multiply2D'> };
runInThisContext(`(function(module,exports){${math.outputFiles[0].text}\n})`)(mathModule, mathModule.exports);
const { invert2D, multiply2D } = mathModule.exports;

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/components/agent/area-annotation.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'transform',
  plugins: [{ name: 'annotation-boundaries', setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

function fixture() {
  class Node {
    parent?: Node;
    children: Node[] = [];
    traits = new Map<string, object>();
    readonly index: number;
    constructor(index: number, source: string) { this.index = index; this.traits.set('Source', { value: source }); }
    id() { return this.index; }
    isAlive() { return true; }
    get(trait: string) { return this.traits.get(trait); }
    set(trait: string, value: object) { this.traits.set(trait, { ...this.traits.get(trait), ...value }); }
    has(trait: string) { return this.traits.has(trait); }
    add(trait: string) { this.traits.set(trait, {}); }
    remove(trait: string) { this.traits.delete(trait); }
  }
  const root = new Node(0, 'root');
  const scene = new Node(1, 'scene');
  const other = new Node(2, 'other');
  const effect = new Node(3, 'effect');
  scene.parent = other.parent = root;
  effect.parent = scene;
  root.children = [scene, other]; scene.children = [effect];
  scene.set('Size', { width: 1920, height: 1080 });
  scene.set('Computed', { width: 1920, height: 1080, localTime: 90 });
  scene.set('Name', { value: 'Unsaved cut' });
  let liveContent = 'unsaved-red-frame';
  let camera = { a: 2, b: 0, c: 0, d: 2, e: 50, f: 100 };
  const originalCamera = { ...camera };
  const surface = { canvas: {}, ctx: null, resolution: 2 };
  const values = new Map<string, object>([['RenderSurface', surface], ['Mode', { value: 'realtime' }], ['FrameRate', { value: 30 }]]);
  const world = { get: (trait: string) => values.get(trait), set: (trait: string, value: object) => { values.set(trait, { ...values.get(trait), ...value }); } };
  let session = { world, project: { dir: () => '/project' } };
  let loadState = {};
  let active = scene;
  let edit: (() => void) | undefined;
  let saveAttempts = 0;
  let stopped = 0;
  let renderError = false;
  let context: () => Promise<object> = async () => ({ projectDir: '/project' });
  const rendered: object[] = [];
  const transforms = { a: [1, 4], b: [0, 0], c: [0, 0], d: [1, 4], e: [0, 500], f: [0, 1000] };
  const runtime = {
    ...Object.fromEntries(['Computed', 'FrameRate', 'Hidden', 'Mode', 'Name', 'Playback', 'RenderSurface', 'Size', 'Source', 'WorldTransform'].map((name) => [name, name])),
    getActiveEntity: () => active, getCamera: () => camera, isScene: () => true,
    getParentEntity: (node: Node) => node.parent ?? null, getEntityChildren: (_world: unknown, node: Node) => node.children,
    getViewMatrix: () => ({ a: 4, b: 0, c: 0, d: 4, e: 100, f: 200 }),
    invert2D, multiply2D, store: () => transforms,
    setCamera: (_world: unknown, value: typeof camera) => { camera = value; }, transformSystem() {},
    renderSystem() {
      if (renderError) throw new Error('Render failed');
      rendered.push({ content: liveContent, camera, otherHidden: other.has('Hidden'), effectHidden: effect.has('Hidden'), surface: world.get('RenderSurface') });
    },
  };
  const dependencies: Record<string, unknown> = {
    'solid-js': { batch: (fn: () => string) => fn() }, '@diffusionstudio/runtime': runtime,
    '@/dapi/session': { requireEditorSession: () => session, editorSession: () => session, editorLoadState: () => loadState },
    '@/dapi/handlers/context': { getEditorContext: () => context() },
    '@/engine/editor': { getDocumentEditor: () => ({ onEdit: (listener: () => void) => { edit = listener; return () => { stopped++; }; } }) },
    '@/dapi/lib/nodes': { resolveNode: (_world: unknown, source: string) => { const node = [scene, other, effect].find((node) => (node.get('Source') as { value: string }).value === source); assert.ok(node); return node; } },
    '@/projects/edits': { flushProjectEdits: () => { saveAttempts++; throw new Error('Recovered unsaved edits'); } },
  };
  const module = { exports: {} as typeof import('../../web/src/components/agent/area-annotation.tsx') };
  runInThisContext(`(function(require,module,exports,document){${built.outputFiles[0].text}\n})`)(
    (name: string) => dependencies[name] ?? {}, module, module.exports,
    { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), toDataURL: () => `data:image/png;base64,${liveContent}` }) },
  );
  return { capture: module.exports.captureAnnotationFrame, scene, effect, other, rendered,
    changeContent: () => { liveContent = 'new-unsaved-frame'; },
    setContext: (next: typeof context) => { context = next; }, edit: () => edit?.(),
    changeProject: () => { session = { ...session, world: { ...world } }; },
    reload: () => { loadState = {}; }, changeActive: () => { active = other; },
    failRender: () => { renderError = true; },
    assertRestored: () => { assert.deepEqual(camera, originalCamera); assert.deepEqual(world.get('RenderSurface'), surface); assert.deepEqual(world.get('Mode'), { value: 'realtime' }); assert.equal(other.has('Hidden'), false); assert.equal(stopped, 1); assert.equal(saveAttempts, 0); },
  };
}

test('marking captures live unsaved edits without saving, with full scene framing and excluded effects', async () => {
  const f = fixture();
  f.changeContent();
  const snapshot = await f.capture({ exclude: ['effect'] });
  assert.equal(snapshot.imageUrl, 'data:image/png;base64,new-unsaved-frame');
  assert.equal(snapshot.frame, 90); assert.equal(snapshot.time, 3);
  assert.deepEqual(snapshot.sceneSize, { width: 1920, height: 1080 });
  assert.equal(f.rendered.length, 1);
  const rendered = f.rendered[0] as { camera: object; otherHidden: boolean; effectHidden: boolean; surface: { canvas: { width: number; height: number } } };
  assert.deepEqual(rendered.camera, { a: 1, b: 0, c: 0, d: 1, e: -100, f: -200 });
  assert.equal(rendered.otherHidden, true); assert.equal(rendered.effectHidden, true);
  assert.equal(rendered.surface.canvas.width, 1280); assert.equal(rendered.surface.canvas.height, 720);
  assert.equal(f.effect.has('Hidden'), false);
  f.assertRestored();
});

test('capture failure restores viewport state and preserves already-hidden effects', async () => {
  const f = fixture();
  f.effect.add('Hidden'); f.failRender();
  await assert.rejects(f.capture({ exclude: ['effect'] }), /Render failed/);
  assert.equal(f.effect.has('Hidden'), true);
  f.assertRestored();
});

for (const change of ['edit', 'changeProject', 'reload', 'changeActive', 'playhead'] as const) {
  test(`marking rejects a changed ${change} while collecting context`, async () => {
    const f = fixture();
    f.setContext(async () => { if (change === 'playhead') f.scene.set('Computed', { localTime: 120 }); else f[change](); return {}; });
    await assert.rejects(f.capture(), /scene changed/);
    assert.equal(f.rendered.length, 0);
    f.assertRestored();
  });
}
