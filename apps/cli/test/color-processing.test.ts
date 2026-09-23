import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorBalance, colorCurveLut, parseColorGrade, sampleColorCurve, COLOR_LUT_SIZE } from '../../../packages/runtime/src/media/color-grade-settings.ts';
import { analyzeColorScopes, SCOPE_WIDTH, SCOPE_HEIGHT } from '../../../packages/runtime/src/media/color-scopes.ts';

test('color grades canonicalize finite balance and ordered, bounded curves while omitting identity transforms', () => {
  assert.deepEqual(parseColorGrade({ temperature: 0, tint: NaN, curves: { master: [[1, 1], [.5, .5], [0, 0]] } }), {});
  assert.deepEqual(parseColorGrade({ temperature: 3, tint: -3, curves: { red: [[.7, 2], [.2, .1], [.7, .8], [NaN, 1]] } }), {
    temperature: 1, tint: -1, curves: { red: [[0, 0], [.2, .1], [.7, .8], [1, 1]] },
  });
  const points = Array.from({ length: 100 }, (_, index) => [index / 99, .5]);
  const curve = parseColorGrade({ curves: { master: points } }).curves!.master!;
  assert.equal(curve.length, 16);
  assert.deepEqual(curve[0], [0, .5]);
  assert.deepEqual(curve.at(-1), [1, .5]);
});

test('master then RGB curves interpolate known tones and balance preserves neutral luminance', () => {
  assert.equal(sampleColorCurve([[0, 0], [.5, .75], [1, 1]], .25), .375);
  const lut = colorCurveLut({ curves: { master: [[0, 0], [1, .5]], red: [[0, 0], [1, .5]] } });
  assert.deepEqual([...lut.slice((COLOR_LUT_SIZE - 1) * 4)], [64, 128, 128, 255]);
  const balance = colorBalance({ temperature: 1, tint: .5 });
  assert.ok(balance[0] > balance[2]);
  assert.ok(Math.abs(.2126 * balance[0] + .7152 * balance[1] + .0722 * balance[2] - 1) < 1e-12);
});

test('scopes exclude transparent pixels and distinguish neutral, red, and spatial luma', () => {
  const result = analyzeColorScopes({ width: 3, height: 1, data: new Uint8ClampedArray([128, 128, 128, 128, 255, 0, 0, 255, 0, 255, 0, 0]) });
  assert.equal(result.samples, 2);
  assert.equal(result.histogram[0][255], 1);
  assert.equal(result.histogram[1][255], 0);
  assert.equal(result.histogram[0][128], 1);
  assert.equal(result.vectorscope[64 * SCOPE_HEIGHT + 64], 1);
  const grayY = Math.round((1 - 128 / 255) * (SCOPE_HEIGHT - 1));
  const redY = Math.round((1 - .2126) * (SCOPE_HEIGHT - 1));
  assert.equal(result.waveform[grayY * SCOPE_WIDTH], 1);
  assert.equal(result.waveform[redY * SCOPE_WIDTH + Math.floor(SCOPE_WIDTH / 3)], 1);
  assert.equal(result.vectorscope.reduce((sum, value) => sum + value, 0), 2);
});
