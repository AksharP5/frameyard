import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { VideoAsset } from '../../../packages/assets/src/types.ts';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../../../packages/runtime/src/media/video.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['mediabunny', '../traits', '../actions/assets', './keyframe-index'],
});

function fixture(timestamps: number[], durations: number[], frameRate = 30) {
  class Canvas { width = 2; height = 2; timestamp = -1; }
  const pool = [new Canvas(), new Canvas()];
  let reads = 0;
  const track = { canDecode: async () => true, getFirstTimestamp: async () => 0 };
  const dependencies = {
    mediabunny: {
      BlobSource: class {},
      Input: class { getPrimaryVideoTrack = async () => track; dispose() {} },
      CanvasSink: class {
        async *canvases(start: number) {
          let index = timestamps.findLastIndex(timestamp => timestamp <= start);
          for (; index < timestamps.length; index++) {
            const canvas = pool[reads++ % pool.length];
            canvas.timestamp = timestamps[index];
            yield { timestamp: timestamps[index], duration: durations[index], canvas };
          }
        }
      },
    },
    '../traits': {}, '../actions/assets': {}, './keyframe-index': {},
  };
  const module = { exports: {} as typeof import('../../../packages/runtime/src/media/video.ts') };
  runInNewContext(compiled.outputFiles[0].text, { module, require: (name: keyof typeof dependencies) => dependencies[name], console });
  const asset: VideoAsset = { id: 'variable-video', path: 'video.mp4', source: 'assets/video.mp4', mimeType: 'video/mp4', createdAt: '', type: 'VIDEO',
    width: 2, height: 2, duration: timestamps.at(-1)! + durations.at(-1)!, frameRate, bitRate: 0, handle: { getFile: async () => new File([], 'video.mp4') } };
  const exporter = new module.exports.VideoExporter(asset);
  return { exporter, timestamp: () => (exporter.toBitmap() as unknown as Canvas)?.timestamp, reads: () => reads };
}

test('video export holds variable-rate frames until the next source timestamp, including backward seeks', async () => {
  const f = fixture([0, 0.1, 0.3], [0.1, 0.2, 0.1]);
  try {
    for (const [frame, timestamp] of [[0, 0], [1, 0], [2, 0], [3, 0.1], [8, 0.1], [9, 0.3], [11, 0.3], [2, 0], [6, 0.1]]) {
      await f.exporter.seekTo(frame, 30);
      assert.equal(f.timestamp(), timestamp, `output frame ${frame} must retain the source frame covering its timestamp`);
    }
  } finally { f.exporter.dispose(); }
});

test('video export retains the preceding frame across source gaps and fractional frame-rate conversion', async () => {
  const f = fixture([0, 0.1, 0.4], [0.05, 0.05, 0.1], 10);
  try {
    for (const [frame, timestamp] of [[0, 0], [1, 0], [2, 0], [3, 0.1], [8, 0.1], [9, 0.1], [10, 0.4]]) {
      await f.exporter.seekTo(frame, 24);
      assert.equal(f.timestamp(), timestamp, `output frame ${frame} must not show a future source frame`);
    }
    assert.equal(f.reads(), 3, 'forward export decodes each source frame once and retains a bounded lookahead');
  } finally { f.exporter.dispose(); }
});
