import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import { DEFAULT_CLIP_HEIGHT, getClipRowHeight, KEYFRAME_TRACK_HEIGHT, RULER_HEIGHT, VIEWPORT_PADDING } from '../../web/src/engine/timeline/config.ts';
import type { Entity, World } from 'koota';
import type { TimelineNode } from '@diffusionstudio/runtime';
import type { TimelineSurfaceState } from '../../web/src/engine/timeline/surface';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/timeline/render/layers.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'row-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === 'entry-point' ? undefined : { path, external: true });
  } }],
});

function node(id: number, kind: TimelineNode['kind'] = 'geometry', children: TimelineNode[] = []): TimelineNode {
  return { entity: { id: () => id, has: () => false } as unknown as Entity, kind, children, expanded: children.length > 0, expandable: children.length > 0 };
}

function fixture(layers: TimelineNode[], onVisit?: (node: TimelineNode) => void) {
  const painted: { id: number; top: number; kind: string }[] = [];
  const height = (node: TimelineNode) => {
    onVisit?.(node);
    return node.kind === 'geometry' ? DEFAULT_CLIP_HEIGHT : KEYFRAME_TRACK_HEIGHT;
  };
  const subtreeHeight = (node: TimelineNode): number => height(node) + node.children.reduce((total, child) => total + subtreeHeight(child), 0);
  let scrollY = 0;
  const dependencies: Record<string, unknown> = {
    '@diffusionstudio/runtime': {
      buildTimelineLayers: () => layers,
      store: () => ({ start: Array(1000).fill(0), end: Array(1000).fill(360) }),
    },
    '../view': { getResolution: () => 1, getViewport: () => [0, 360], pixelsToFrames: (value: number) => value, getScrollY: () => scrollY },
    '../config': { RULER_HEIGHT, VIEWPORT_PADDING },
    '../layout': { getNodeHeight: height, getSubtreeHeight: subtreeHeight, getRowTransform: () => ({}) },
    '../drag': { isDragging: () => false },
    './clip': { getClipAlpha: () => 1, renderClip: (_world: World, _scene: Entity, _surface: TimelineSurfaceState, entity: Entity, row: { top: number }) => painted.push({ id: entity.id(), top: row.top, kind: 'clip' }) },
    './keyframes': { renderKeyframeTrack: (_world: World, _scene: Entity, _surface: TimelineSurfaceState, entity: Entity, row: { top: number }) => painted.push({ id: entity.id(), top: row.top, kind: 'keyframe' }) },
    koota: {},
  };
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/render/layers') };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    (name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports,
  );
  return (scroll: number, state: 'idle' | 'pressed' | 'pressing' | 'lifted' = 'idle', marquee = false, viewportHeight = 234) => {
    scrollY = scroll;
    painted.length = 0;
    module.exports.renderLayers({} as World, node(1001).entity, {
      ctx: { save() {}, restore() {}, setTransform() {} }, layout: { width: 360, height: viewportHeight },
      pointer: { position: { state } }, marquee: marquee ? {} : null,
    } as unknown as TimelineSurfaceState);
    return [...painted];
  };
}

test('a thousand rows paint only the vertical viewport, including partially visible boundary rows', () => {
  const draw = fixture(Array.from({ length: 1000 }, (_, id) => node(id)));
  assert.deepEqual(draw(0).map(row => row.id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(draw(1000).map(row => row.id), [24, 25, 26, 27, 28, 29, 30]);
  assert.deepEqual(draw(39_800).map(row => row.id), [994, 995, 996, 997, 998, 999]);
  for (const state of ['pressed', 'pressing', 'lifted'] as const) {
    assert.equal(draw(1000, state).length, 1000, `${state} keeps offscreen drag/trim interaction alive`);
  }
  assert.equal(draw(1000, 'idle', true).length, 1000, 'marquee still visits offscreen rows for deselection');
});

test('an offscreen parent does not hide visible nested keyframes or shift following rows', () => {
  const draw = fixture([
    node(0, 'geometry', [node(1, 'sub-item', [node(2, 'keyframe-track')])]),
    node(3), node(4),
  ]);
  assert.deepEqual(draw(60, 'idle', false, 80), [
    { id: 2, top: 72, kind: 'keyframe' },
    { id: 3, top: 104, kind: 'clip' },
  ]);
});

test('idle drawing stops at the last visible row while gestures keep all rows active', () => {
  let visits = 0;
  const draw = fixture(Array.from({ length: 1000 }, (_, id) => node(id)), () => { visits++; });

  draw(0);
  assert.ok(visits < 20, `idle drawing inspected ${visits} rows`);

  visits = 0;
  draw(0, 'pressed');
  assert.ok(visits >= 1000, 'active gestures inspect offscreen rows');
});

test('invalid authored row heights cannot reverse the visible row order', () => {
  assert.equal(getClipRowHeight(-40), DEFAULT_CLIP_HEIGHT);
  assert.equal(getClipRowHeight(Number.NaN), DEFAULT_CLIP_HEIGHT);
  assert.equal(getClipRowHeight(0), 0);
});
