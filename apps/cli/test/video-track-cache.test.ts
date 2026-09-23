import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { VideoAsset } from '../../../packages/assets/src/types.ts';

const compiled = await build({
  stdin: { contents: `export { getVideoTrack, clearVideoTrackCache } from './video'; export { getKeyframeIndex } from './keyframe-index';`, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/media/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['mediabunny', '../traits', '../actions/assets'],
});

function fixture() {
  type Track = { keys: number[] };
  const tracks = new Map<File, Track>();
  let opens = 0;
  class BlobSource {
    readonly file: File;
    constructor(file: File) { this.file = file; }
  }
  const dependencies = {
    mediabunny: {
      BlobSource,
      Input: class {
        readonly options: { source: BlobSource };
        constructor(options: { source: BlobSource }) { this.options = options; opens++; }
        getPrimaryVideoTrack = async () => tracks.get(this.options.source.file) ?? null;
      },
      EncodedPacketSink: class {
        readonly track: Track;
        constructor(track: Track) { this.track = track; }
        getFirstKeyPacket = async () => this.track.keys.length ? { timestamp: this.track.keys[0] } : null;
        getNextKeyPacket = async (packet: { timestamp: number }) => {
          const timestamp = this.track.keys[this.track.keys.indexOf(packet.timestamp) + 1];
          return timestamp === undefined ? null : { timestamp };
        };
      },
    },
    '../traits': {},
    '../actions/assets': { getAssetFile: (source: VideoAsset) => source.handle.getFile() },
  };
  const module = { exports: {} as Pick<typeof import('../../../packages/runtime/src/media/video.ts'), 'getVideoTrack' | 'clearVideoTrackCache'> & Pick<typeof import('../../../packages/runtime/src/media/keyframe-index.ts'), 'getKeyframeIndex'> };
  runInNewContext(compiled.outputFiles[0].text, { module, require: (name: keyof typeof dependencies) => dependencies[name], setTimeout, console });
  function asset(keys: number[]): VideoAsset {
    const file = new File([], 'recording.mp4');
    tracks.set(file, { keys });
    return { id: 'same-original-bytes', path: 'recording.mp4', source: 'assets/recording.mp4', mimeType: 'video/mp4', createdAt: '', type: 'VIDEO',
      width: 1920, height: 1080, duration: 10, frameRate: 30, bitRate: 0, handle: { getFile: async () => file } };
  }
  return { ...module.exports, asset, opens: () => opens };
}

test('video tracks are shared within one source handle, not across project media readers', async () => {
  const f = fixture();
  const original = f.asset([0, 4, 8]);
  const preview = f.asset([0, 2, 4, 6, 8]);
  const [one, same] = await Promise.all([f.getVideoTrack(original), f.getVideoTrack(original)]);
  assert.equal(one, same);
  assert.equal(f.opens(), 1);
  assert.notEqual(await f.getVideoTrack(preview), one, 'another project can supply a different playback copy of the same original');
  assert.equal(f.opens(), 2);
});

test('a replacement playback track gets its own keyframe positions after cache invalidation', async () => {
  const f = fixture();
  const original = f.asset([0, 4, 8]);
  const preview = f.asset([0, 2, 4, 6, 8]);
  const originalTrack = await f.getVideoTrack(original);
  assert.ok(originalTrack);
  const originalIndex = f.getKeyframeIndex(originalTrack);
  await setImmediate();
  assert.equal(originalIndex.floor(3), 0);
  f.clearVideoTrackCache();
  const previewTrack = await f.getVideoTrack(preview);
  assert.ok(previewTrack);
  const previewIndex = f.getKeyframeIndex(previewTrack);
  await setImmediate();
  assert.equal(previewIndex.floor(3), 2, 'scrubbing must use the current playback copy keyframes');
});
