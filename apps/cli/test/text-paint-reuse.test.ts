import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { TokenOptions } from '../../../packages/runtime/src/utils/text';

const bundle = await build({
  stdin: {
    contents: `
      export { createWorld } from 'koota';
      export * from './traits';
      export { PaintType } from './constants';
      export { Token, renderText } from './utils/text';
    `,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('koota'), 'createWorld'>
  & typeof import('../../../packages/runtime/src/traits')
  & Pick<typeof import('../../../packages/runtime/src/constants'), 'PaintType'>
  & Pick<typeof import('../../../packages/runtime/src/utils/text'), 'Token' | 'renderText'>
};
runInThisContext(`(function(module,exports){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports);
const { createWorld, Computed, Cache, Color, ColorStop, ChildOf, Hidden, Paint, PaintType,
  RenderSurface, Shadow, Stroke, TextStyle, TextCache, Token, renderText } = module.exports;

type Gradient = {
  kind: 'linear' | 'radial';
  coordinates: number[];
  transform: number[];
  operations: number[][];
  stops: [number, string][];
  addColorStop(offset: number, color: string): void;
};

function recordingCanvas() {
  let state = {
    font: '', textAlign: 'start', textBaseline: 'top', letterSpacing: '0px',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000000' as string | Gradient, strokeStyle: '#000000' as string | Gradient,
    lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', miterLimit: 10, lineDashOffset: 0,
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    transform: [1, 0, 0, 1, 0, 0], operations: [] as number[][],
  };
  const saved: typeof state[] = [];
  const gradients: Gradient[] = [];
  let fontAssignments = 0;
  let strokeSetups = 0;
  const draw = (kind: 'fill' | 'stroke', chars: string, x: number, y: number) => {
    const paint = kind === 'fill' ? state.fillStyle : state.strokeStyle;
    const style = typeof paint === 'string' ? paint : {
      kind: paint.kind, coordinates: paint.coordinates, transform: paint.transform,
      operations: paint.operations, stops: paint.stops,
    };
    return { kind, chars, x, y, font: state.font, alpha: state.globalAlpha, style,
      lineWidth: kind === 'stroke' ? state.lineWidth : null,
      shadow: [state.shadowColor, state.shadowBlur, state.shadowOffsetX, state.shadowOffsetY],
    };
  };
  const draws: ReturnType<typeof draw>[] = [];
  const gradient = (kind: Gradient['kind'], coordinates: number[]): Gradient => {
    const value: Gradient = {
      kind, coordinates, transform: [...state.transform], operations: [...state.operations], stops: [],
      addColorStop(offset, color) { this.stops.push([offset, color]); },
    };
    gradients.push(value);
    return value;
  };
  const methods = {
    save() { saved.push({ ...state, operations: [...state.operations] }); },
    restore() { state = saved.pop()!; },
    getTransform() { const [a, b, c, d, e, f] = state.transform; return { a, b, c, d, e, f }; },
    setTransform(...values: number[]) { state.transform = values; state.operations = []; },
    translate(x: number, y: number) { state.operations.push([x, y]); },
    rotate(angle: number) { state.operations.push([angle]); },
    scale(x: number, y: number) { state.operations.push([x, y]); },
    setLineDash() { strokeSetups++; },
    createLinearGradient(...values: number[]) { return gradient('linear', values); },
    createRadialGradient(...values: number[]) { return gradient('radial', values); },
    fillText(chars: string, x: number, y: number) { draws.push(draw('fill', chars, x, y)); },
    strokeText(chars: string, x: number, y: number) { draws.push(draw('stroke', chars, x, y)); },
  };
  const context = new Proxy({ ...state, ...methods }, {
    get(_target, key) { return Reflect.get(methods, key) ?? Reflect.get(state, key); },
    set(_target, key, value) {
      if (key === 'font') fontAssignments++;
      Reflect.set(state, key, value);
      return true;
    },
  });
  return { context, draws, gradients,
    get fontAssignments() { return fontAssignments; },
    get strokeSetups() { return strokeSetups; },
  };
}

function fixture() {
  const canvas = recordingCanvas();
  const world = createWorld(RenderSurface({ ctx: canvas.context as unknown as CanvasRenderingContext2D }));
  const metrics = { width: 40, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 } as TokenOptions['metrics'];
  const tokens = ['one ', 'two ', 'three'].map((chars, index) => new Token({ chars, metrics, ranges: [], offset: index * 40 }));
  const text = world.spawn(Computed({ width: 200, height: 40 }), TextStyle({ fontSize: 20 }),
    Cache, TextCache({ tokens: [tokens] }));
  const gradient = (type: typeof PaintType.LINEAR_GRADIENT | typeof PaintType.RADIAL_GRADIENT, color: number) => {
    const paint = world.spawn(Paint({ value: type }), Computed);
    const first = world.spawn(ColorStop, Computed({ stopOffset: 0, color }), ChildOf(paint));
    const last = world.spawn(ColorStop, Computed({ stopOffset: 1, color: 0x0000ff }), ChildOf(paint));
    return { paint, first, last };
  };
  return { world, text, tokens, canvas, gradient, render: () => renderText(world, text, false) };
}

test('text reuses distinct gradient paints within a render and preserves styled glyph draws', () => {
  const f = fixture();
  try {
    const fill = f.gradient(PaintType.LINEAR_GRADIENT, 0xff0000);
    const rangeFill = f.gradient(PaintType.RADIAL_GRADIENT, 0x00ff00);
    const stroke = f.gradient(PaintType.LINEAR_GRADIENT, 0xffffff);
    stroke.paint.add(Stroke);
    stroke.paint.set(Computed, { strokeWidth: 3 });
    const range = f.world.spawn(TextStyle({ fontWeight: '700' }), Cache({ fills: [rangeFill.paint] }));
    f.tokens[0]!.ranges = f.tokens[1]!.ranges = [range];
    f.text.set(Cache, { fills: [fill.paint], strokes: [stroke.paint] });
    f.render();

    const first = [...f.canvas.draws];
    assert.deepEqual(first.map(({ kind, chars, x, y, font }) => ({ kind, chars, x, y, font })),
      ['stroke', 'fill'].flatMap(kind => ['one ', 'two ', 'three'].map((chars, index) => ({
        kind, chars, x: index * 40, y: 0, font: `normal ${index < 2 ? '700' : '400'} 20px "Inter", Inter`,
      }))));
    const rangePaint = first[3]!.style;
    const defaultPaint = first[5]!.style;
    assert.ok(typeof rangePaint !== 'string');
    assert.ok(typeof defaultPaint !== 'string');
    assert.equal(rangePaint.kind, 'radial');
    assert.deepEqual(rangePaint.stops, [[0, '#00FF00'], [1, '#0000FF']]);
    assert.deepEqual(defaultPaint.stops, [[0, '#FF0000'], [1, '#0000FF']]);
    assert.equal(f.canvas.gradients.length, 3, 'each visible paint is constructed once, independent of word count');
    f.render();
    assert.equal(f.canvas.gradients.length, 6, 'each render builds fresh gradients');
    assert.deepEqual(f.canvas.draws.slice(first.length), first);
  } finally { f.world.destroy(); }
});

test('later text renders sample edited stops, paint geometry, dimensions and canvas transforms', () => {
  const f = fixture();
  try {
    const fill = f.gradient(PaintType.LINEAR_GRADIENT, 0xff0000);
    f.text.set(Cache, { fills: [fill.paint] });
    f.render();
    assert.deepEqual(f.canvas.gradients[0]!.coordinates, [0, 20, 200, 20]);
    fill.first.set(Computed, { stopOffset: .25, color: 0x00ff00, opacity: .5 });
    fill.paint.set(Computed, { rotation: 90, scaleX: .5, opacity: .4 });
    f.text.set(Computed, { width: 400, height: 60 });
    f.canvas.context.setTransform(2, 0, 0, 3, 9, 11);
    f.render();

    const edited = f.canvas.gradients.at(-1)!;
    assert.deepEqual(edited.stops, [[.25, 'rgba(0,255,0,0.5)'], [1, '#0000FF']]);
    assert.ok(edited.coordinates.every((value, index) => Math.abs(value - [200, 15, 200, 45][index]!) < 1e-9));
    assert.deepEqual(edited.transform, [2, 0, 0, 3, 9, 11]);
    assert.equal(f.canvas.draws.at(-1)!.alpha, .4);

    fill.paint.set(Paint, { value: PaintType.RADIAL_GRADIENT });
    f.render();
    const radial = f.canvas.gradients.at(-1)!;
    assert.equal(radial.kind, 'radial');
    assert.deepEqual(radial.operations, [[200, 30], [Math.PI / 2], [100, 30]]);
    assert.deepEqual(f.canvas.context.getTransform(), { a: 2, b: 0, c: 0, d: 3, e: 9, f: 11 });
    assert.equal(f.canvas.gradients.length, 3);
  } finally { f.world.destroy(); }
});

test('shadow-free text skips font and stroke setup while visible shadows retain the widest stroke', () => {
  const f = fixture();
  try {
    const thin = f.world.spawn(Stroke, Paint, Computed({ strokeWidth: 2 }));
    const wide = f.world.spawn(Stroke, Paint, Computed({ strokeWidth: 5 }));
    f.text.add(Color);
    f.text.set(Cache, { strokes: [thin, wide] });
    f.render();
    assert.equal(f.canvas.draws.length, 9);
    assert.equal(f.canvas.fontAssignments, 6, 'only the stroke and fill passes set each word font');
    assert.equal(f.canvas.strokeSetups, 6, 'absent shadows do not prepare the stroke silhouette');

    const shadow = f.world.spawn(Shadow, Computed({ color: 0xff0000, opacity: .5, blur: 3, offsetX: 2, offsetY: 4 }));
    f.text.set(Cache, { shadows: [shadow] });
    f.canvas.context.setTransform(2, 0, 0, 2, 0, 0);
    f.canvas.draws.length = 0;
    f.render();
    assert.equal(f.canvas.draws.length, 12);
    assert.deepEqual(f.canvas.draws.slice(0, 3).map(({ kind, lineWidth, alpha, shadow }) => ({ kind, lineWidth, alpha, shadow })),
      Array.from({ length: 3 }, () => ({ kind: 'stroke', lineWidth: 5, alpha: .5, shadow: ['#FF0000', 6, 4, 8] })));
    shadow.add(Hidden);
    f.canvas.draws.length = 0;
    f.render();
    assert.equal(f.canvas.draws.length, 9, 'hidden shadows never add glyph draws');
  } finally { f.world.destroy(); }
});
