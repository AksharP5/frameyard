import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAudioProcessing, loudnessGain } from '../../../packages/runtime/src/media/audio-processing.ts';
import { createDynamicsProcessor } from '../../../packages/runtime/src/media/audio-dynamics.ts';

test('audio settings preserve enabled dynamics, omit neutral processing and bound finite parameters', () => {
  assert.deepEqual(parseAudioProcessing({ pan: 0, eq: [0, 0, 0] }), {});
  assert.deepEqual(parseAudioProcessing({ pan: 5, eq: [50, NaN, -50], compressor: { threshold: -200, ratio: 0, attack: -2, release: Infinity }, limiter: 2 }), {
    pan: 1, eq: [24, 0, -24], compressor: { threshold: -100, ratio: 1, attack: 0 }, limiter: 0,
  });
  assert.deepEqual(parseAudioProcessing({ compressor: {}, limiter: -1 }), { compressor: {}, limiter: -1 });
});

test('gain normalization reaches the target when possible, reserves true-peak headroom, and rejects silence', () => {
  assert.deepEqual(loudnessGain(-24, -12, 0, -16), { volume: 8, gain: 8, peakLimited: false, estimatedLufs: -16 });
  assert.deepEqual(loudnessGain(-24, -4, -6, -16), { volume: -3, gain: 3, peakLimited: true, estimatedLufs: -21 });
  assert.equal(loudnessGain(-9, -0.2, 0, -16).volume, -7);
  assert.equal(loudnessGain(-40, -30, 6, -16).volume, 12);
  assert.throws(() => loudnessGain(null, null, 0, -16), /no measurable audio/);
  assert.throws(() => loudnessGain(-30, 90, 0, -16), /attenuation/);
});

test('linked sample limiter bounds either channel at the first sample without delay and preserves channel balance', () => {
  const process = createDynamicsProcessor(48000, true);
  const left = new Float32Array([4, 0, -3, .2]);
  const right = new Float32Array([2, 0, -1.5, .1]);
  const output = [new Float32Array(4), new Float32Array(4)];
  const parameters = { threshold: new Float32Array([-1]), ratio: new Float32Array([4]), attack: new Float32Array([1]), release: new Float32Array([.1]) };
  process([left, right], output, parameters);
  const ceiling = 10 ** (-1 / 20);
  assert.ok(Math.abs(output[0][0] - ceiling) < 1e-6);
  for (let index = 0; index < left.length; index++) {
    assert.ok(Math.abs(output[0][index]) <= ceiling + 1e-6);
    assert.equal(output[0][index], output[1][index] * 2);
  }
  process([], output, parameters);
  assert.ok(output.every((channel) => channel.every((sample) => sample === 0)));
});
