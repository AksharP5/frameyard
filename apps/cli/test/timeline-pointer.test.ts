import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/timeline/pointer.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['@/utils'],
});

function fixture(transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, pixelRatio = 1) {
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/pointer') };
  runInThisContext(`(function(require,module,exports,window){${built.outputFiles[0].text}\n})`)(
    () => ({ assert }), module, module.exports, { devicePixelRatio: pixelRatio },
  );
  const pointer = module.exports.createPointer({
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLCanvasElement,
    ctx: { getTransform: () => transform } as unknown as CanvasRenderingContext2D,
  });
  const event = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, shiftKey: false, altKey: false }) as PointerEvent;
  return { pointer, event, transform };
}

test('pointer hits follow stacking, passthrough, mouse events and changed frame geometry', () => {
  const { pointer, event, transform } = fixture();
  const draw = () => {
    pointer.scope('clips');
    return [
      pointer.region(0, 0, 100, 100, 'back'),
      pointer.region(50, 0, 50, 100, 'front'),
      pointer.region(0, 0, 100, 100, 'overlay', true),
    ];
  };
  pointer.move(event(75, 25));
  draw(); pointer.reset();
  assert.deepEqual(draw().map(r => r.hovering), [false, true, true]);
  pointer.move(event(25, 25));
  assert.deepEqual(draw().map(r => r.hovering), [true, false, true]);
  pointer.down(event(75, 25));
  assert.deepEqual(draw().map(r => r.pressed), [false, true, true]);
  pointer.reset();
  pointer.move(event(120, 25));
  assert.deepEqual(draw().map(r => r.dragging), [false, true, false]);
  pointer.up(event(75, 25));
  assert.deepEqual(draw().map(r => r.clicked), [false, true, true]);
  pointer.reset();
  transform.e = 200;
  draw(); pointer.reset();
  assert.deepEqual(draw().map(r => r.hovering), [false, false, false]);
  pointer.reset(); pointer.reset();
  assert.deepEqual(draw().map(r => r.hovering), [false, false, false]);
});

test('pointer bounds preserve scaling, rotation, shear and negative extents', () => {
  for (const transform of [
    { a: 2, b: 0, c: 0, d: 2, e: 30, f: -10 },
    { a: 0, b: 1, c: -1, d: 0, e: 100, f: 20 },
    { a: -2, b: 0.5, c: 1, d: 3, e: 300, f: -40 },
  ]) {
    const { pointer, event } = fixture(transform, 2);
    const x = 10, y = 20, width = -30, height = 40;
    const points = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(([px, py]) => ({
      x: transform.a * px + transform.c * py + transform.e,
      y: transform.b * px + transform.d * py + transform.f,
    }));
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const draw = () => pointer.scope('clip').region(x, y, width, height);
    pointer.move(event((minX + maxX) / 4, (minY + maxY) / 4));
    draw(); pointer.reset();
    assert.equal(draw().hovering, true);
    pointer.move(event((maxX + 1) / 2, (minY + maxY) / 4));
    assert.equal(draw().hovering, false);
    pointer.move(event((minX + 1) / 2, (minY + 1) / 2));
    assert.equal(draw().hovering, true);
  }
});
