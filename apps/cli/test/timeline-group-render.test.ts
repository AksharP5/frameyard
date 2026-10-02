import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from '../../web/src/engine/timeline/surface.ts';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/timeline/render/group.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['@diffusionstudio/runtime'],
});

function fixture(clips: { start: number; end: number }[], viewportWidth = 1000) {
  const computed = {
    start: [0, ...clips.map(clip => clip.start)],
    end: [Math.max(...clips.map(clip => clip.end)), ...clips.map(clip => clip.end)],
  };
  const view = { resolution: [1], scrollX: [0] };
  const Computed = Symbol('Computed');
  const dependencies = {
    '@diffusionstudio/runtime': {
      Computed, Timeline: Symbol('Timeline'), Cache: Symbol('Cache'),
      store: (_world: World, trait: symbol) => trait === Computed ? computed : view,
    },
  };
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/render/group.ts') };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    (name: keyof typeof dependencies) => dependencies[name], module, module.exports,
  );
  const children = clips.map((_clip, index) => ({ id: () => index + 1 }));
  const group = { id: () => 0, get: () => ({ children }) } as unknown as Entity;
  const painted: { x: number; width: number }[] = [];
  let box = { x: 0, width: 0 };
  const surface = {
    ctx: {
      save() {}, restore() {}, beginPath() {}, clip() {},
      roundRect(x: number, _y: number, width: number) { box = { x, width }; },
      fill() { painted.push(box); },
    },
    layout: { width: viewportWidth }, colors: { clip: { group: { primary: '#fff' } } },
  } as unknown as TimelineSurfaceState;
  return (scrollX: number) => {
    view.scrollX[0] = scrollX;
    painted.length = 0;
    module.exports.renderGroup({} as World, group, surface, group, { top: 0, height: 40 });
    return [...painted];
  };
}

test('a collapsed group paints only the visible bars among a thousand children', () => {
  const draw = fixture(Array.from({ length: 1000 }, (_, index) => ({ start: index * 30, end: index * 30 + 24 })));
  assert.deepEqual(draw(4500), Array.from({ length: 34 }, (_, index) => ({ x: 4500 + index * 30, width: 24 })));
});

test('group bars preserve partial visibility and minimum width at whole and fractional scroll positions', () => {
  const draw = fixture([
    { start: 0, end: 9 }, { start: 0, end: 10 }, { start: 8, end: 12 },
    { start: 14, end: 15 }, { start: 16, end: 18 }, { start: 18, end: 25 }, { start: 20, end: 25 },
  ], 10);
  assert.deepEqual(draw(10), [{ x: 8, width: 4 }, { x: 16, width: 2 }, { x: 18, width: 7 }]);
  assert.deepEqual(draw(10.5), [{ x: 8, width: 4 }, { x: 16, width: 2 }, { x: 18, width: 7 }, { x: 20, width: 5 }]);
});
