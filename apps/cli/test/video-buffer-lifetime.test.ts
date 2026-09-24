import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { VideoAsset, SequenceAsset } from '../../../packages/assets/src/types.ts';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../../packages/runtime/src/media/video.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['mediabunny', '../traits', '../actions/assets', './keyframe-index'],
});
const sequenceBuilt = await build({
  entryPoints: [fileURLToPath(new URL('../../../packages/runtime/src/media/sequence.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
});

class Canvas {
  width: number; height: number;
  readonly pixels = new Map<string, number | undefined>();
  draws = 0;
  constructor(width: number, height: number) { this.width = width; this.height = height; }
  getContext() { return {
    clearRect() {}, resetTransform() {}, translate() {}, rotate() {},
    drawImage: (source: { timestamp?: number; pixels?: Map<string, number | undefined> }, ...coordinates: number[]) => {
      this.draws++;
      const crop = coordinates.length === 8;
      this.pixels.set(`${coordinates[crop ? 4 : 0]},${coordinates[crop ? 5 : 1]}`,
        source.timestamp ?? source.pixels?.get(crop ? `${coordinates[0]},${coordinates[1]}` : '0,0'));
    },
  }; }
}

function fixture(stage: 'key' | 'packet' | 'timestamp' | 'output' | 'forward-key' | 'forward-packet' | 'variable-rate' | 'dense-scrub' | 'scrub' | 'scrub-stale' | 'end-output' | 'read-error' | 'codec-error', variableFrames = [0, 4, 8]) {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let created = 0, closed = 0, keyReads = 0;
  const decoded: number[] = [];
  class Frame {
    timestamp: number; displayWidth = 2; displayHeight = 2;
    duration: number;
    constructor(timestamp = 0, duration = 1e6 / 30) { this.timestamp = timestamp; this.duration = duration; }
    close() { closed++; }
  }
  const packet = { type: 'key', timestamp: 0, duration: 1 / 30, microsecondTimestamp: 0, toEncodedVideoChunk() { return { timestamp: 0 }; } };
  const track = {
    rotation: 0,
    getDecoderConfig: async () => ({ codec: 'avc1.64001f', codedWidth: 2, codedHeight: 2 }),
    getFirstTimestamp: async () => {
      if (stage === 'timestamp') { started.resolve(); await release.promise; }
      return 0;
    },
  };
  const dependencies = {
    mediabunny: {
      BlobSource: class {},
      Input: class { getPrimaryVideoTrack = async () => track; },
      EncodedPacketSink: class {
        async getKeyPacket(timestamp = 0) {
          keyReads++;
          if (stage === 'read-error') throw new Error('packet read failed');
          if (stage === 'key' || stage === 'forward-key' || stage === 'scrub') { started.resolve(); await release.promise; }
          if (stage === 'scrub-stale') return { ...packet, timestamp, microsecondTimestamp: Math.trunc(timestamp * 1e6),
            toEncodedVideoChunk: () => ({ timestamp: Math.trunc(timestamp * 1e6) }) };
          return packet;
        }
        async *packets(keyPacket = packet) {
          if (stage === 'packet') { started.resolve(); await release.promise; }
          if (stage === 'forward-key' || stage === 'forward-packet' || stage === 'variable-rate' || stage === 'dense-scrub') {
            const frames = stage === 'variable-rate' || stage === 'dense-scrub' ? variableFrames : Array.from({ length: 120 }, (_, index) => index);
            for (const [index, frame] of frames.entries()) {
              if (stage === 'forward-packet' && frame === 1) { started.resolve(); await release.promise; }
              const timestamp = frame / 30;
              const duration = ((frames[index + 1] ?? frame + 1) - frame) / 30;
              yield { ...packet, timestamp, duration, microsecondTimestamp: Math.trunc(timestamp * 1e6),
                toEncodedVideoChunk: () => ({ timestamp: Math.trunc(timestamp * 1e6), duration: Math.trunc(duration * 1e6) }) };
            }
          } else yield keyPacket;
        }
      },
    },
    '../traits': {},
    '../actions/assets': { getAssetFile: async () => new File([], 'video.mp4') },
    './keyframe-index': { getKeyframeIndex: () => ({ floor: (seconds: number) => stage === 'scrub-stale' ? Math.floor(seconds / 3) * 3 : stage === 'scrub' ? 0 : stage === 'dense-scrub' ? variableFrames[0] / 30 : null }) },
  };
  class Decoder extends EventTarget {
    state = 'configured'; decodeQueueSize = 0;
    output: (frame: Frame) => void;
    error: (error: DOMException) => void;
    constructor(options: { output: (frame: Frame) => void; error: (error: DOMException) => void }) { super(); this.output = options.output; this.error = options.error; created++; }
    static isConfigSupported = async () => ({ supported: true });
    configure() {} reset() {}
    close() { this.state = 'closed'; }
    decode(chunk: { timestamp: number; duration?: number }) {
      if (stage === 'codec-error') { this.error(new DOMException('codec failed')); return; }
      decoded.push(Math.round(chunk.timestamp / 1e6 * 30));
      if (stage === 'scrub-stale' && chunk.timestamp > 0) {
        started.resolve();
        void release.promise.then(() => this.output(new Frame(chunk.timestamp)));
        return;
      }
      if (stage !== 'end-output') this.output(new Frame(chunk.timestamp, chunk.duration));
    }
    async flush() { if (stage === 'end-output') this.output(new Frame(0)); }
  }
  const module = { exports: {} as typeof import('../../../packages/runtime/src/media/video.ts') };
  runInNewContext(built.outputFiles[0].text, {
    module, require: (name: keyof typeof dependencies) => dependencies[name],
    OffscreenCanvas: Canvas, VideoFrame: Frame, VideoDecoder: Decoder, performance, setTimeout, clearTimeout, console,
  });
  const asset: VideoAsset = { id: 'video', path: 'video.mp4', source: 'assets/video.mp4', mimeType: 'video/mp4', createdAt: '', type: 'VIDEO',
    width: 2, height: 2, duration: 60, frameRate: 30, bitRate: 0, handle: { getFile: async () => new File([], 'video.mp4') } };
  const buffer = new module.exports.VideoBuffer(asset);
  return { buffer, started, release, created: () => created, closed: () => closed, keyReads: () => keyReads, decoded, packet };
}

test('idle and dispose cancel video packet reads without recreating the decoder or frame cache', async () => {
  for (const stage of ['key', 'packet'] as const) {
    for (const stop of ['idle', 'dispose'] as const) {
      const f = fixture(stage);
      try {
        await f.buffer.initialized;
        f.buffer.seekTo(0, 30);
        await f.started.promise;
        f.buffer[stop]();
        f.release.resolve();
        await setImmediate();
        assert.equal(f.created(), 0, `${stop} while reading ${stage} must not create a decoder`);
        assert.equal(f.buffer.cache.atlas.width, 0);
        if (stop === 'idle') {
          f.buffer.seekTo(0, 30);
          await setImmediate();
          assert.equal(f.created(), 1, 'a canceled frame can be requested again after idling');
        } else {
          f.buffer.seekTo(1, 30);
          await setImmediate();
          assert.equal(f.created(), 0, 'a discarded buffer cannot wake');
        }
      } finally { f.release.resolve(); f.buffer.dispose(); }
    }
  }
});

test('forward playback preserves the pending keyframe walk and every consumed packet', async () => {
  for (const stage of ['forward-packet', 'forward-key'] as const) {
    const f = fixture(stage);
    try {
      await f.buffer.initialized;
      f.buffer.seekTo(0, 30);
      await f.started.promise;
      for (const frame of [1, 2, 3]) f.buffer.seekTo(frame, 30);
      f.release.resolve();
      await setImmediate();
      assert.deepEqual(f.decoded.slice(0, 5), [0, 1, 2, 3, 4], `${stage}: advancing playback cannot skip encoded dependencies`);
      assert.equal(f.keyReads(), 1, 'forward frames inside the pending fill keep its keyframe walk');
      assert.ok(f.buffer.toBitmap());
      assert.equal(f.buffer.renderedFrame, 3);
    } finally { f.release.resolve(); f.buffer.dispose(); }
  }
});

test('playback preparation rehydrates an idle video while paused same-frame seeks stay idle', async () => {
  const f = fixture('forward-key');
  try {
    await f.buffer.initialized;
    f.release.resolve();
    f.buffer.seekTo(0, 30);
    await setImmediate();
    assert.ok(f.buffer.toBitmap());
    f.buffer.idle();
    f.buffer.seekTo(0, 30);
    assert.equal(f.buffer.mode, 'idle');
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.cache.atlas.width, 0);
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), false);
    await setImmediate();
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), true);
    assert.equal(f.buffer.mode, 'alive');
    for (const frame of [0, 1, 2]) assert.equal(f.buffer.cache.has(frame), true);
    assert.equal(f.keyReads(), 2, 'resuming only starts one fresh keyframe walk');
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('playback preparation waits for forward video frames after the first picture arrives', async () => {
  const f = fixture('forward-packet');
  try {
    await f.buffer.initialized;
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), false);
    await f.started.promise;
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), false);
    f.release.resolve();
    await setImmediate();
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), true);
    assert.equal(f.keyReads(), 1);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('startup fills a short cache gap near the source tail instead of deferring it indefinitely', async () => {
  const f = fixture('forward-key');
  f.buffer.asset.duration = 4;
  try {
    await f.buffer.initialized;
    f.release.resolve();
    const bitmap = { width: 2, height: 2 } as ImageBitmap;
    f.buffer.cache.insert(bitmap, 116);
    f.buffer.cache.insert(bitmap, 117);
    assert.equal(f.buffer.prepareForPlayback(116, 30, 120), false);
    await setImmediate();
    assert.equal(f.buffer.prepareForPlayback(116, 30, 120), true);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('forward playback prefetches a short source tail before its first missing frame is requested', async () => {
  const f = fixture('forward-key');
  f.buffer.asset.duration = 4;
  try {
    await f.buffer.initialized;
    f.release.resolve();
    const bitmap = { width: 2, height: 2 } as ImageBitmap;
    f.buffer.cache.insert(bitmap, 116);
    f.buffer.cache.insert(bitmap, 117);
    f.buffer.seekTo(116, 30);
    await setImmediate();
    assert.equal(f.buffer.cache.has(118), true, 'the small refill must not wait until frame 118 is displayed');
    assert.equal(f.buffer.cache.has(119), true);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('cached VFR picture spans do not restart decoding for nominal frames inside them', async () => {
  const f = fixture('variable-rate', [0, 12, 24]);
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(0, 30);
    await setImmediate();
    const canvas = f.buffer.toBitmap() as unknown as Canvas;
    assert.equal(canvas.draws, 1);
    const decoded = f.decoded.length;
    const keyReads = f.keyReads();
    for (const target of [1, 2, 3, 2]) {
      f.buffer.seekTo(target, 30);
      await setImmediate();
      assert.ok(f.buffer.toBitmap());
      assert.equal(f.buffer.renderedFrame, 0);
    }
    assert.equal(canvas.draws, 1, 'a held source picture is copied to the display only once');
    assert.equal(f.decoded.length, decoded, 'forward playback and a cached backward seek must reuse the covering picture');
    assert.equal(f.keyReads(), keyReads);

    canvas.width = 0;
    f.buffer.seekTo(3, 30);
    assert.equal(f.buffer.toBitmap(), canvas);
    assert.equal(canvas.draws, 2, 'a reset display canvas still needs its picture');

    f.buffer.cache.dispose();
    f.buffer.cache.insert({ width: 2, height: 2, timestamp: 123 } as unknown as ImageBitmap, 0, 12);
    f.buffer.seekTo(1, 30);
    assert.equal(f.buffer.toBitmap(), canvas);
    assert.equal(canvas.draws, 3, 'replacing a tile at the same frame index redraws it');
    assert.equal(canvas.pixels.get('0,0'), 123);
  } finally { f.buffer.dispose(); }
});

test('variable-rate preview preserves distinct pictures within one average-rate frame', async () => {
  const f = fixture('variable-rate', [0, 1, 2, 12]);
  f.buffer.asset.frameRate = 7.5;
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(0, 30);
    await setImmediate();
    for (const [frame, timestamp] of [[0, 0], [1, 33333], [2, 66666], [8, 66666]]) {
      f.buffer.seekTo(frame, 30);
      await setImmediate();
      const canvas = f.buffer.toBitmap() as unknown as Canvas;
      assert.equal(canvas.pixels.get('0,0'), timestamp, `timeline frame ${frame} must show its source picture`);
    }
  } finally { f.buffer.dispose(); }
});

test('dense source samples stay within the tile budget and reindex when the project rate changes', async () => {
  const f = fixture('variable-rate', Array.from({ length: 481 }, (_, index) => index / 8));
  f.buffer.asset.frameRate = 7.5;
  f.buffer.cache.config.count = 30;
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(0, 30);
    await setImmediate();
    const atlas = f.buffer.cache.atlas as unknown as Canvas;
    assert.ok(atlas.pixels.size <= 30, '240 fps source packets must not overflow a 30-tile preview cache');
    for (const frame of [0, 1, 2, 20]) {
      f.buffer.seekTo(frame, 30);
      await setImmediate();
      const canvas = f.buffer.toBitmap() as unknown as Canvas;
      assert.equal(canvas.pixels.get('0,0'), Math.trunc(frame / 30 * 1e6));
    }
    f.buffer.seekTo(2, 60);
    await setImmediate();
    const canvas = f.buffer.toBitmap() as unknown as Canvas;
    assert.equal(canvas.pixels.get('0,0'), 33333, 'changing project FPS must discard tiles with the previous time mapping');
  } finally { f.buffer.dispose(); }
});

test('scrubbing through sub-tick keyframes preserves packet timing after WebCodecs truncation', async () => {
  for (const { frames, timestamp } of [
    { frames: [0.25, 0.5, 0.75, 1, 2, 3], timestamp: 33333 },
    { frames: [0.25, 0.999994, 1, 2], timestamp: 33333 },
    { frames: [30.000024, 31.02, 32, 33], timestamp: 1000000 },
  ]) {
    const f = fixture('dense-scrub', frames);
    try {
      await f.buffer.initialized;
      f.buffer.seekTo(100, 30);
      await setImmediate();
      f.buffer.seekTo(200, 30);
      await setImmediate();
      const canvas = f.buffer.toBitmap() as unknown as Canvas;
      assert.ok(canvas, 'a skipped keyframe must not leave the scrub preview blank');
      assert.equal(canvas.pixels.get('0,0'), timestamp);
    } finally { f.buffer.dispose(); }
  }
});

test('one- to four-frame source videos decode and display their requested frame', async () => {
  for (const frames of [1, 2, 4]) {
    const f = fixture('forward-key');
    f.buffer.asset.duration = frames / 30;
    try {
      await f.buffer.initialized;
      f.release.resolve();
      f.buffer.seekTo(0, 30);
      await setImmediate();
      assert.ok(f.buffer.toBitmap(), `${frames}-frame source must display its first frame`);
      assert.equal(f.buffer.renderedFrame, 0);
      f.buffer.seekTo(frames - 1, 30);
      await setImmediate();
      f.buffer.toBitmap();
      assert.equal(f.buffer.renderedFrame, frames - 1);
      assert.equal(f.buffer.prepareForPlayback(frames - 1, 30, frames), true, 'tiny sources and their last frame need no unavailable forward frames');
    } finally { f.release.resolve(); f.buffer.dispose(); }
  }
});

test('playback preparation respects fractional source rates, project rates, and a one-frame trim tail', async () => {
  const f = fixture('forward-key');
  f.buffer.asset.frameRate = 30000 / 1001;
  try {
    await f.buffer.initialized;
    f.release.resolve();
    assert.equal(f.buffer.prepareForPlayback(200, 60000 / 1001, 202), false);
    await setImmediate();
    assert.equal(f.buffer.pendingFrame, 200);
    assert.equal(f.buffer.prepareForPlayback(200, 60000 / 1001, 202), true);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('variable-rate and end-of-stream pictures do not wait for nonexistent nominal frames', async () => {
  const f = fixture('variable-rate');
  try {
    await f.buffer.initialized;
    assert.equal(f.buffer.prepareForPlayback(1, 30, 120), false);
    await setImmediate();
    assert.equal(f.buffer.cache.has(1), false);
    assert.equal(f.buffer.cache.has(3), false);
    assert.equal(f.buffer.prepareForPlayback(1, 30, 120), true, 'real packet timestamps cover missing nominal slots');
    assert.equal(f.buffer.prepareForPlayback(8, 30, 120), true, 'actual EOF settles a rounded metadata duration');
  } finally { f.buffer.dispose(); }
});

test('wide VFR gaps and metadata tails prepare the picture that actually covers the requested time', async () => {
  for (const [target, expected] of [[6, 0], [18, 12], [30, 24], [100, 24]]) {
    const f = fixture('variable-rate', [0, 12, 24]);
    try {
      await f.buffer.initialized;
      assert.equal(f.buffer.prepareForPlayback(target, 30, 120), false);
      await setImmediate();
      f.buffer.prepareForPlayback(target, 30, 120);
      await setImmediate();
      assert.equal(f.buffer.prepareForPlayback(target, 30, 120), true, `frame ${target} must settle after EOF`);
      assert.ok(f.buffer.toBitmap(), 'ready means a drawable picture');
      assert.equal(f.buffer.renderedFrame, expected);
    } finally { f.buffer.dispose(); }
  }
});

test('a long VFR picture can cover startup beyond the nominal cache window', async () => {
  const f = fixture('variable-rate', [0, 240, 480]);
  try {
    await f.buffer.initialized;
    assert.equal(f.buffer.prepareForPlayback(180, 30, 600), false);
    await setImmediate();
    assert.equal(f.buffer.prepareForPlayback(180, 30, 600), true);
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.renderedFrame, 0);
    assert.ok(f.buffer.cache.leftFrameIndex > 0, 'a covering frame may begin before the nominal cache window');
  } finally { f.buffer.dispose(); }
});

test('a previous EOF cannot start a backward seek on a later cached picture', async () => {
  const f = fixture('forward-key');
  f.buffer.asset.duration = 4;
  try {
    await f.buffer.initialized;
    f.release.resolve();
    f.buffer.seekTo(100, 30);
    await setImmediate();
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.cache.has(0), false);
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), false, 'cached tail pictures cannot satisfy a new opening seek');
    await setImmediate();
    assert.equal(f.buffer.prepareForPlayback(0, 30, 120), true);
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.renderedFrame, 0);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('end of stream releases frames retained by the codec', async () => {
  const f = fixture('end-output');
  f.buffer.asset.duration = 1 / 30;
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(0, 30);
    await setImmediate();
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.renderedFrame, 0);
    assert.equal(f.closed(), 1);
    assert.equal(f.buffer.queue.isAlive, false, 'finished decoders release resources and restart from a keyframe');
  } finally { f.buffer.dispose(); }
});

test('packet and codec failures settle video readiness with an error', async () => {
  for (const stage of ['read-error', 'codec-error'] as const) {
    const f = fixture(stage);
    try {
      await f.buffer.initialized;
      f.buffer.seekTo(0, 30);
      await setImmediate();
      assert.equal(f.buffer.errored, true, 'startup must be able to stop waiting for the failed picture');
      assert.equal(f.buffer.toBitmap(), null);
    } finally { f.buffer.dispose(); }
  }
});

test('trimmed playback decodes preroll dependencies without drawing them into the preview cache', async () => {
  const f = fixture('forward-key');
  const inserted: number[] = [];
  const insert = f.buffer.cache.insert.bind(f.buffer.cache);
  f.buffer.cache.insert = (frame, index) => { inserted.push(index); insert(frame, index); };
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(100, 30);
    await f.started.promise;
    f.release.resolve();
    await setImmediate();
    assert.equal(f.decoded[0], 0, 'the codec still receives the preceding keyframe');
    assert.equal(f.decoded.length, 120, 'all dependent packets are decoded');
    assert.equal(inserted[0], f.buffer.cache.leftFrameIndex, 'preroll never reaches the canvas cache');
    assert.ok(inserted.every(frame => frame <= f.buffer.cache.rightFrameIndex));
    assert.equal(f.closed(), f.decoded.length, 'both cached and discarded frames close');
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.renderedFrame, 100);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('scrubbing still displays its requested keyframe outside the playback cache window', async () => {
  const f = fixture('scrub');
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(100, 30);
    await f.started.promise;
    f.buffer.seekTo(140, 30);
    f.release.resolve();
    await setImmediate();
    assert.ok(f.buffer.cache.leftFrameIndex > 0);
    assert.ok(f.buffer.toBitmap());
    assert.equal(f.buffer.renderedFrame, 0, 'the covering scrub keyframe remains drawable');
    assert.equal(f.closed(), 1);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('a delayed scrub keyframe cannot replace a newer cached seek target', async () => {
  const f = fixture('scrub-stale');
  try {
    await f.buffer.initialized;
    f.buffer.seekTo(0, 30);
    await setImmediate();
    f.buffer.toBitmap();
    assert.equal(f.buffer.renderedFrame, 0);
    f.buffer.seekTo(100, 30);
    await f.started.promise;
    f.buffer.seekTo(0, 30);
    f.buffer.toBitmap();
    assert.equal(f.buffer.renderedFrame, 0);
    f.release.resolve();
    await setImmediate();
    f.buffer.toBitmap();
    assert.equal(f.buffer.renderedFrame, 0, 'the completed older scrub must not jump the picture back to frame 90');
    assert.equal(f.buffer.pendingFrame, 0);
  } finally { f.release.resolve(); f.buffer.dispose(); }
});

test('disposing during video initialization leaves no usable packet sink', async () => {
  const f = fixture('timestamp');
  await f.started.promise;
  f.buffer.dispose();
  f.release.resolve();
  await f.buffer.initialized;
  f.buffer.seekTo(0, 30);
  await setImmediate();
  assert.equal(f.created(), 0);
  assert.equal(f.buffer.packetSink, null);
});

test('video decoder output closes its owned frame even when caching throws', async () => {
  const f = fixture('output');
  try {
    await f.buffer.initialized;
    f.buffer.cache.insert = () => { throw new Error('cache draw failed'); };
    await assert.rejects(f.buffer.queue.decode(f.packet as import('mediabunny').EncodedPacket), /cache draw failed/);
    assert.equal(f.closed(), 1);
  } finally { f.buffer.dispose(); }
});

test('idling a sequence during bitmap decoding releases the result and leaves the cache empty', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = 0;
  const module = { exports: {} as typeof import('../../../packages/runtime/src/media/sequence.ts') };
  runInNewContext(sequenceBuilt.outputFiles[0].text, {
    module, OffscreenCanvas: Canvas, VideoFrame: class {}, Error, setTimeout, clearTimeout,
    createImageBitmap: async () => {
      started.resolve(); await release.promise;
      return { width: 2, height: 2, close() { closed++; } };
    },
  });
  const file = new File([], 'frame.png');
  const asset: SequenceAsset = { id: 'sequence', path: 'sequence.frames', source: 'assets/sequence.frames', createdAt: '', mimeType: 'image/png',
    type: 'SEQUENCE', width: 2, height: 2, duration: 1 / 30, frameRate: 30, handle: { getFile: async () => file },
    directoryHandle: { async *entries() { yield ['frame.png', { kind: 'file', getFile: async () => file }]; } },
  };
  const sequence = new module.exports.SequenceDecoder(asset, true);
  try {
    await sequence.initialized;
    await sequence.seekTo(0, 30);
    await started.promise;
    sequence.idle();
    release.resolve();
    await setImmediate();
    assert.equal(sequence.cache.atlas.width, 0);
    assert.equal(sequence.toBitmap(), null);
    assert.equal(closed, 1);
    await sequence.seekTo(0, 30);
    await setImmediate();
    assert.ok(sequence.toBitmap(), 'the canceled frame can be requested again after idling');
    assert.equal(closed, 2);
  } finally { release.resolve(); sequence.dispose(); }
});

test('export disposal cancels initialization and pending frames without restoring owned canvases', async () => {
  for (const stage of ['file', 'metadata', 'timestamp', 'frame'] as const) {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let inputs = 0, disposed = 0, sinks = 0;
    const wait = async (at: typeof stage) => { if (stage === at) { started.resolve(); await release.promise; } };
    const track = { canDecode: async () => true, getFirstTimestamp: async () => { await wait('timestamp'); return 0; } };
    const dependencies = {
      mediabunny: {
        BlobSource: class {},
        Input: class {
          constructor() { inputs++; }
          getPrimaryVideoTrack = async () => { await wait('metadata'); return track; };
          dispose() { disposed++; }
        },
        CanvasSink: class {
          constructor() { sinks++; }
          async *canvases() {
            yield { timestamp: 0, duration: 1, canvas: new Canvas(2, 2) };
            await wait('frame');
            yield { timestamp: 1, duration: 1, canvas: new Canvas(2, 2) };
          }
        },
      },
      '../traits': {}, '../actions/assets': {}, './keyframe-index': {},
    };
    const module = { exports: {} as typeof import('../../../packages/runtime/src/media/video.ts') };
    runInNewContext(built.outputFiles[0].text, { module, require: (name: keyof typeof dependencies) => dependencies[name], console });
    const asset: VideoAsset = { id: 'export', path: 'video.mp4', source: 'assets/video.mp4', mimeType: 'video/mp4', createdAt: '', type: 'VIDEO',
      width: 2, height: 2, duration: 2, frameRate: 1, bitRate: 0, handle: { getFile: async () => { await wait('file'); return new File([], 'video.mp4'); } } };
    const exporter = new module.exports.VideoExporter(asset);
    let pending = exporter.initialized;
    let displayed: HTMLCanvasElement | OffscreenCanvas | null = null;
    if (stage === 'frame') {
      await exporter.initialized;
      await exporter.seekTo(0, 1);
      displayed = exporter.toBitmap();
      assert.ok(displayed);
      pending = exporter.seekTo(1, 1);
    }
    await started.promise;
    exporter.dispose();
    release.resolve();
    await pending;
    assert.equal(exporter.toBitmap(), null, `${stage}: disposed export cannot restore a frame`);
    if (displayed) assert.equal(displayed.width, 0, 'disposal releases the displayed canvas backing store');
    assert.equal(inputs, stage === 'file' ? 0 : 1);
    assert.equal(disposed, inputs, 'each opened input is disposed once');
    assert.equal(sinks, stage === 'frame' ? 1 : 0, 'canceled initialization never creates a canvas sink');
  }
});
