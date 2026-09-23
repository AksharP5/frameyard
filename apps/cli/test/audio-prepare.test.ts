import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { AudioAsset } from '../../../packages/assets/src/types.ts';
import type { AudioBus } from '../../../packages/runtime/src/media/audio-bus.ts';

class BufferData {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(options: AudioBufferOptions) {
    this.sampleRate = options.sampleRate;
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this.duration = options.length / this.sampleRate;
    this.data = Array.from({ length: this.numberOfChannels }, () => new Float32Array(options.length));
  }
  copyToChannel(data: Float32Array, channel: number) { this.data[channel].set(data); }
  getChannelData(channel: number) { return this.data[channel]; }
}

const built = await build({
  stdin: { contents: `export { AudioDecoder } from './audio'; export { AudioBufferSink } from 'mediabunny';`, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/media/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('../../../packages/runtime/src/media/audio.ts'), 'AudioDecoder'>
  & Pick<typeof import('mediabunny'), 'AudioBufferSink'>
};
runInThisContext(`(function(module,exports,AudioBuffer){${built.outputFiles[0].text}\n})`)(module, module.exports, BufferData);
const { AudioDecoder, AudioBufferSink } = module.exports;

function source(): AudioAsset {
  const pcm = Buffer.alloc(44 + 96000);
  pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(48000, 24); pcm.writeUInt32LE(96000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
  const file = new File([pcm], 'tone.wav');
  return { id: 'tone', path: file.name, source: file.name, createdAt: '', mimeType: 'audio/wav', type: 'AUDIO', duration: 1, channels: 1, sampleRate: 48000, handle: { getFile: async () => file } };
}

function sample(timestamp: number) {
  const buffer = new BufferData({ length: 4800, sampleRate: 48000 });
  buffer.getChannelData(0).fill(0.5);
  return { buffer: buffer as unknown as AudioBuffer, timestamp, duration: buffer.duration };
}

function output() {
  const starts: { when: number; offset: number; duration: number }[] = [];
  const bus = {
    context: { currentTime: 0, sampleRate: 48000, createBufferSource: () => ({
      connect() {}, stop() {}, start(when: number, offset: number, duration: number) { starts.push({ when, offset, duration }); },
    }) },
    input: {}, ready: Promise.resolve(),
  } as unknown as AudioBus;
  return { bus, starts };
}

test('preparation waits for the whole requested interval and playback consumes every sample once', async () => {
  const original = AudioBufferSink.prototype.buffers;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  AudioBufferSink.prototype.buffers = async function* () {
    for (const timestamp of [0, 0.1, 0.2, 0.3, 0.4]) {
      if (timestamp === 0.2) { entered(); await pending; }
      reads++; yield sample(timestamp);
    }
  };
  const decoder = new AudioDecoder(source());
  const { bus, starts } = output();
  try {
    const prepare = decoder.prepare(0.04, 0.25, 0.3);
    assert.equal(decoder.prepare(0.04, 0.25, 0.3), prepare, 'concurrent startup requests share preparation');
    await started;
    assert.equal(reads, 2, 'the first buffer alone does not complete preparation');
    assert.equal(decoder.isPrepared(0.04), false);
    release(); await prepare;
    assert.equal(decoder.isPrepared(0.04), true);
    assert.equal(reads, 3, 'preparation stops after the one buffer covering the requested end');
    assert.equal(starts.length, 0);
    for (let tick = 0; tick < 3; tick++) {
      await decoder.playTo(bus, { relativeFrom: 0.04, relativeTo: 0.3, trimStart: 0.04, trimEnd: 0.3, playbackRate: 1, currentTime: 0, relativeDelay: -0.04 });
    }
    assert.equal(reads, 3, 'playback reuses all prepared buffers without another decoder read');
    assert.equal(starts.length, 3);
    assert.ok(Math.abs(starts[0].offset - 0.04) < 1 / 48000);
    assert.ok(Math.abs(starts.reduce((sum, start) => sum + start.duration, 0) - 0.26) < 1 / 48000);
  } finally { decoder.reset(); AudioBufferSink.prototype.buffers = original; }
});

test('a seek invalidates pending preparation and starts from the newly requested source window', async () => {
  const original = AudioBufferSink.prototype.buffers;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const windows: number[] = [];
  AudioBufferSink.prototype.buffers = async function* (from = 0) {
    windows.push(from);
    if (from === 0) { yield sample(0); entered(); await pending; }
    yield sample(from);
  };
  const decoder = new AudioDecoder(source());
  const { bus, starts } = output();
  try {
    const old = decoder.prepare(0, 0.5, 1);
    await started;
    decoder.reset();
    const current = decoder.prepare(0.5, 0.8, 1);
    release(); await Promise.all([old, current]);
    assert.equal(decoder.isPrepared(0), false);
    assert.equal(decoder.isPrepared(0.5), true);
    assert.deepEqual(windows, [0, 0.5]);
    await decoder.playTo(bus, { relativeFrom: 0.5, relativeTo: 0.6, trimStart: 0.5, trimEnd: 0.6, playbackRate: 1, currentTime: 0, relativeDelay: -0.5 });
    assert.equal(starts.length, 1);
    assert.ok(starts[0].when < 1 / 48000);
    decoder.reset();
    assert.equal(decoder.isPrepared(0.5), false);
  } finally { decoder.reset(); AudioBufferSink.prototype.buffers = original; }
});

test('preparation preserves leading silence and EOF and stops at the clip trim', async () => {
  const original = AudioBufferSink.prototype.buffers;
  try {
    for (const timestamps of [[0.2, 0.3, 0.4], []]) {
      let reads = 0, decoded = 0;
      AudioBufferSink.prototype.buffers = async function* () {
        reads++;
        for (const timestamp of timestamps) { decoded++; yield sample(timestamp); }
      };
      const decoder = new AudioDecoder(source());
      const { bus, starts } = output();
      try {
        await decoder.prepare(0, 0.5, 0.3);
        assert.equal(decoder.isPrepared(0), true);
        await decoder.prepare(0, 0.5, 0.3);
        await decoder.playTo(bus, { relativeFrom: 0, relativeTo: 0.3, trimStart: 0, trimEnd: 0.3, playbackRate: 1, currentTime: 0, relativeDelay: 0 });
        assert.equal(reads, 1);
        assert.equal(decoded, timestamps.length ? 1 : 0, 'the requested window is capped at the clip end');
        assert.equal(starts.length, timestamps.length ? 1 : 0);
        if (starts.length) assert.ok(Math.abs(starts[0].when - 0.2) < 1 / 48000);
      } finally { decoder.reset(); }
    }
  } finally { AudioBufferSink.prototype.buffers = original; }
});
