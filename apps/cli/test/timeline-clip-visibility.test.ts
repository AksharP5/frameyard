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

function fixture({ draggingId, trimmingId }: { draggingId?: number; trimmingId?: number } = {}) {
  const visited: number[] = [];
  const selected: number[] = [];
  const moved = new Set<number>();
  const trimmed = new Set<number>();
  const ClipDragOrigin = Symbol('ClipDragOrigin');
  const TrimDragOrigin = Symbol('TrimDragOrigin');
  let interactions = 0;
  let fills = 0;
  let scopedId = 0;
  let scopedRegion = 0;
  const noop = () => {};
  const computed = { start: Array.from({ length: 1000 }, (_, i) => i * 100), end: Array.from({ length: 1000 }, (_, i) => (i + 1) * 100) };
  const dependencies: Record<string, unknown> = {
    '@diffusionstudio/runtime': { ClipDragOrigin, TrimDragOrigin, store: () => computed, CaptionType: {}, getSourceFailure: noop, fitsChildren: (entity: Entity) => entity.id() !== trimmingId, isGenerating: () => false, isGroup: () => false, isCaption: () => false, isText: () => false },
    '../../editor': { getDocumentEditor: () => ({ linkedSelection: false, select: (entity: Entity) => selected.push(entity.id()) }) },
    '../../clip-links': { isClipLocked: () => false },
    '../drag': {
      beginClipDrag: (_world: World, entity: Entity) => moved.add(entity.id()),
      applyClipDrag: () => {
        if (draggingId === undefined) return;
        computed.start[draggingId] = 100;
        computed.end[draggingId] = 200;
      },
      beginTrim: (_world: World, entity: Entity) => trimmed.add(entity.id()),
      applyTrim: (_world: World, _surface: TimelineSurfaceState, entity: Entity) => {
        computed.start[entity.id()] = 100;
        computed.end[entity.id()] = 200;
      },
    },
    '../../timeline-editing': { timelineEditing: () => ({ mode: () => 'trim' }) },
    '../config': config,
    '../style': { getClipAsset: (_world: World, entity: Entity) => { visited.push(entity.id()); return null; }, getClipStyle: () => ({ background: '#000', foreground: '#fff' }) },
    '../text': { truncateText: () => null },
    '../view': { framesToPixels: (frames: number) => frames, getResolution: () => 1, getViewport: () => [0, 360] },
  };
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/render/clip.ts') };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)((name: string) => dependencies[name] ?? {}, module, module.exports);
  const surface = {
    ctx: new Proxy({}, { get: (_target, method) => method === 'fill' ? () => { fills++; } : noop }), colors: { border: {} }, layout: { width: 360 },
    pointer: {
      position: { state: 'idle' },
      scope: (id: string) => { scopedId = Number(id); scopedRegion = 0; },
      region: () => {
        interactions++;
        scopedRegion++;
        return { dragging: scopedId === draggingId && scopedRegion === 1 || scopedId === trimmingId && scopedRegion === 2 };
      },
    }, marquee: null,
  } as unknown as TimelineSurfaceState;
  return {
    surface, visited, selected, moved, trimmed, computed, interactions: () => interactions, fills: () => fills,
    draw: () => {
      visited.length = interactions = fills = 0;
      for (let id = 0; id < 1000; id++) {
        const entity = {
          id: () => id,
          has: (trait: symbol) => trait === ClipDragOrigin && moved.has(id) || trait === TrimDragOrigin && trimmed.has(id),
          get: () => ({ value: 'Clip' }),
        } as unknown as Entity;
        module.exports.renderClip({} as World, entity, surface, entity, { top: 0, height: 40 });
      }
    },
  };
}

test('an offscreen body drag paints the clip immediately when it moves into view', () => {
  const f = fixture({ draggingId: 999 });
  Object.assign(f.surface.pointer!.position!, { state: 'pressing' });
  f.draw();
  assert.deepEqual([...f.moved], [999]);
  assert.deepEqual(f.visited, [0, 1, 2, 3, 999]);
  assert.equal(f.fills(), 5);
  assert.equal(f.interactions(), 1000);
});

test('an offscreen trim still selects and moves the clip before it returns to view', () => {
  const f = fixture({ trimmingId: 999 });
  Object.assign(f.surface.pointer!.position!, { state: 'pressing' });
  f.draw();
  assert.deepEqual([...f.trimmed], [999]);
  assert.deepEqual(f.selected, [999]);
  assert.equal(f.computed.start[999], 100);
  assert.equal(f.computed.end[999], 200);
  assert.deepEqual(f.visited, [0, 1, 2, 3]);
  assert.equal(f.interactions(), 1002);
  f.draw();
  assert.deepEqual(f.visited, [0, 1, 2, 3, 999]);
  assert.equal(f.fills(), 5);
});

test('a long sequence only resolves and paints clips near the horizontal viewport', () => {
  const f = fixture();
  f.draw();
  assert.deepEqual(f.visited, [0, 1, 2, 3]);
  assert.equal(f.interactions(), 4);
  assert.equal(f.fills(), 4);
});

for (const state of ['pressed', 'pressing', 'lifted', 'marquee'] as const) {
  test(`${state} keeps offscreen clip interactions alive`, () => {
    const f = fixture();
    if (state === 'marquee') f.surface.marquee = {} as NonNullable<TimelineSurfaceState['marquee']>;
    else Object.assign(f.surface.pointer!.position!, { state });
    f.draw();
    assert.equal(f.interactions(), 1000);
    assert.deepEqual(f.visited, [0, 1, 2, 3]);
    assert.equal(f.fills(), 4);
  });
}
