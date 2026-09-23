import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import * as config from '../../web/src/engine/timeline/config.ts';
import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from '../../web/src/engine/timeline/surface.ts';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/timeline/render/clip.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'clip-boundaries', setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

function fixture() {
  const visited: number[] = [];
  let interactions = 0;
  const noop = () => {};
  const computed = { start: Array.from({ length: 1000 }, (_, i) => i * 100), end: Array.from({ length: 1000 }, (_, i) => (i + 1) * 100) };
  const dependencies: Record<string, unknown> = {
    '@diffusionstudio/runtime': { store: () => computed, CaptionType: {}, getSourceFailure: noop, fitsChildren: () => true, isGenerating: () => false, isGroup: () => false, isCaption: () => false, isText: () => false },
    '../../editor': { getDocumentEditor: () => ({ linkedSelection: false }) },
    '../../timeline-editing': { timelineEditing: () => ({ mode: () => 'trim' }) },
    '../config': config,
    '../style': { getClipAsset: (_world: World, entity: Entity) => { visited.push(entity.id()); return null; }, getClipStyle: () => ({ background: '#000', foreground: '#fff' }) },
    '../text': { truncateText: () => null },
    '../view': { framesToPixels: (frames: number) => frames, getResolution: () => 1, getViewport: () => [0, 360] },
  };
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/render/clip.ts') };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)((name: string) => dependencies[name] ?? {}, module, module.exports);
  const surface = {
    ctx: new Proxy({}, { get: () => noop }), colors: { border: {} }, layout: { width: 360 },
    pointer: { position: { state: 'idle' }, scope: noop, region: () => { interactions++; return {}; } }, marquee: null,
  } as unknown as TimelineSurfaceState;
  return {
    surface, visited, interactions: () => interactions,
    draw: () => {
      for (let id = 0; id < 1000; id++) {
        const entity = { id: () => id, has: () => false, get: () => ({ value: 'Clip' }) } as unknown as Entity;
        module.exports.renderClip({} as World, entity, surface, entity, { top: 0, height: 40 });
      }
    },
  };
}

test('a long sequence only resolves and paints clips near the horizontal viewport', () => {
  const f = fixture();
  f.draw();
  assert.deepEqual(f.visited, [0, 1, 2, 3]);
  assert.equal(f.interactions(), 4);
});

for (const state of ['pressed', 'pressing', 'lifted', 'marquee'] as const) {
  test(`${state} keeps offscreen clip interactions alive`, () => {
    const f = fixture();
    if (state === 'marquee') f.surface.marquee = {} as NonNullable<TimelineSurfaceState['marquee']>;
    else Object.assign(f.surface.pointer!.position!, { state });
    f.draw();
    assert.equal(f.interactions(), 1000);
  });
}
