import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const [waveform, worker] = await Promise.all(['waveform', 'waveform-worker'].map(async (name) => (await build({
  entryPoints: [new URL(`../../../packages/assets/src/derive/${name}.ts`, import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['mediabunny'],
  define: { 'import.meta.url': '"file:///waveform.ts"' },
})).outputFiles[0].text));

test('waveform requests bound live workers and continue after a decode failure', async () => {
  const pending: Worker[] = [];
  let active = 0, maximum = 0, terminated = 0;
  class Worker {
    onmessage?: (event: { data: { peaks: Uint8ClampedArray } }) => void;
    onerror?: (event: { message: string }) => void;
    constructor() { maximum = Math.max(maximum, ++active); pending.push(this); }
    postMessage() {}
    terminate() { active--; terminated++; }
  }
  const module = { exports: {} as typeof import('../../../packages/assets/src/derive/waveform.ts') };
  runInNewContext(waveform, { module, exports: module.exports, Worker, URL });
  const results = Array.from({ length: 32 }, () => module.exports.deriveWaveform(new Blob()).catch((error: Error) => error.message));
  assert.equal(active, 2, 'only two full-file audio decoders should run at once');
  pending.shift()!.onerror!({ message: 'Decode failed' });
  for (let completed = 1; completed < results.length; completed++) {
    await new Promise(setImmediate);
    pending.shift()!.onmessage!({ data: { peaks: new Uint8ClampedArray([123]) } });
  }
  const values = await Promise.all(results);
  assert.equal(values[0], 'Decode failed');
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(terminated, 32);
  for (const value of values.slice(1)) assert.deepEqual(value, new Uint8ClampedArray([123]));
});

test('waveform gamma correction runs once per output peak while preserving channel maxima', async () => {
  const channels = 2, rate = 48000, duration = 2, resolution = 800;
  const pcm = new Float32Array(channels * rate * duration);
  for (let i = 0; i < pcm.length; i += 2) { pcm[i] = -0.25; pcm[i + 1] = 0.75; }
  let powers = 0, closed = 0, disposed = 0;
  const math = Object.create(Math) as Math;
  math.pow = (base, exponent) => { powers++; return Math.pow(base, exponent); };
  const sample = {
    allocationSize: () => pcm.byteLength,
    copyTo: (target: Float32Array) => target.set(pcm),
    numberOfChannels: channels, timestamp: 0, duration,
    close: () => { closed++; },
  };
  const result = Promise.withResolvers<{ peaks: Uint8ClampedArray; error?: string }>();
  const scope = { onmessage: undefined as unknown as (event: { data: { file: Blob; peaksPerSecond: number } }) => Promise<void>, postMessage: result.resolve };
  runInNewContext(worker, {
    module: { exports: {} }, exports: {}, self: scope, Math: math,
    require: () => ({
      ALL_FORMATS: [], BlobSource: class {},
      Input: class { async getPrimaryAudioTrack() { return { computeDuration: async () => duration }; } dispose() { disposed++; } },
      AudioSampleSink: class { async *samples() { yield sample; } },
    }),
  });
  await scope.onmessage({ data: { file: new Blob(), peaksPerSecond: resolution } });
  const value = await result.promise;
  assert.equal(value.error, undefined);
  assert.equal(value.peaks.length, duration * resolution);
  assert.ok(value.peaks.every((peak) => peak === Math.floor(255 * Math.pow(0.75, 0.8))));
  assert.equal(powers, value.peaks.length, 'gamma correction must not repeat for each PCM channel/sample');
  assert.equal(closed, 1);
  assert.equal(disposed, 1);
});
