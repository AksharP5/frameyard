import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `export { createWorld } from 'koota'; export { Active, AudioEngine, Computed, FrameRate, Playback, Workarea } from '@diffusionstudio/runtime'; export { shuttle } from './engine/timeline-navigation';`, resolveDir: fileURLToPath(new URL('../../web/src/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', logOverride: { 'empty-import-meta': 'silent' },
  plugins: [{ name: 'unused-editor-actions', setup(build) {
    build.onResolve({ filter: /^\.\/(editor|timing)$/ }, args => args.importer.endsWith('timeline-navigation.ts') ? { path: args.path, namespace: 'stub' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function getDocumentEditor(){}; export function editWorkarea(){}' }));
  } }],
});
class Context { resumes = 0; resume() { this.resumes++; return Promise.resolve(); } }
const module = { exports: {} as Pick<typeof import('koota'), 'createWorld'> & Pick<typeof import('../../../packages/runtime/src/index.ts'), 'Active' | 'AudioEngine' | 'Computed' | 'FrameRate' | 'Playback' | 'Workarea'> & typeof import('../../web/src/engine/timeline-navigation.ts') };
runInThisContext(`(function(module,exports,AudioContext){${built.outputFiles[0].text}\n})`)(module, module.exports, Context);
const { createWorld, Active, AudioEngine, Computed, FrameRate, Playback, Workarea, shuttle } = module.exports;

test('JKL starts inside the marked range in either direction and unlocks audio', () => {
  const context = new Context();
  const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context: context as unknown as AudioContext }));
  const scene = world.spawn(Active, Playback, Computed({ end: 360, duration: 360 }), Workarea({ start: 60, end: 180 }));
  try {
    for (const [direction, frame, expected] of [[1, 0, 60], [1, 180, 60], [1, 240, 60], [-1, 0, 179], [-1, 240, 179], [1, 100, 100]] as const) {
      scene.set(Playback, { playing: false, speed: 1 });
      scene.set(Computed, { localTime: frame });
      shuttle(world, direction);
      assert.equal(scene.get(Computed)?.localTime, expected);
      assert.equal(scene.get(Playback)?.speed, direction);
    }
    assert.equal(context.resumes, 6);
    shuttle(world, 1);
    assert.equal(scene.get(Playback)?.speed, 2);
    shuttle(world, 0);
    assert.equal(scene.get(Playback)?.playing, false);
  } finally { world.destroy(); }
});
