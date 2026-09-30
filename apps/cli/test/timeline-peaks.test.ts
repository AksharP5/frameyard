import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { AssetCache, VideoAsset } from '../../../packages/assets/src/index.ts';
import type { World } from 'koota';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/timeline/peaks.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['@diffusionstudio/runtime'],
});

test('replacing a clip source clears its waveform and prevents a pending old read from restoring it', async () => {
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/peaks.ts') };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    () => ({ Library: 'library' }), module, module.exports,
  );
  const { requestPeaks, getClipSamples } = module.exports;
  const reads: string[] = [];
  const pendingRead = Promise.withResolvers<void>();
  let delayOriginal = false;
  const cache: Pick<AssetCache, 'waveform'> = {
    waveform: async (asset) => {
      const file = new File([new Uint8Array(8000).fill(asset.id === 'quiet' ? 20 : 220)], `${asset.id}.peaks`);
      const slice = file.slice.bind(file);
      file.slice = (start, end, type) => {
        const blob = slice(start, end, type);
        const arrayBuffer = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => {
          reads.push(asset.id);
          if (asset.id === 'quiet' && delayOriginal) await pendingRead.promise;
          return arrayBuffer();
        };
        return blob;
      };
      return file;
    },
  };
  const world = { get: () => ({ cache }) } as unknown as World;
  const source: VideoAsset = {
    id: 'quiet', path: 'quiet.mp4', source: 'quiet.mp4', createdAt: '', mimeType: 'video/mp4', type: 'VIDEO',
    duration: 10, width: 1280, height: 720, frameRate: 30, bitRate: 0, handle: { getFile: async () => new File([], 'quiet.mp4') },
  };
  const request = { clip: 1, asset: source, peaksPerSecond: 30, start: 0, end: 3 };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  requestPeaks(world, request);
  await tick();
  requestPeaks(world, request);
  await tick();
  assert.equal(getClipSamples(request.clip)?.data[0], 20);
  const initialReads = reads.length;
  requestPeaks(world, request);
  await tick();
  assert.equal(reads.length, initialReads, 'unchanged source and viewport reuse their waveform');

  delayOriginal = true;
  const scrolled = { ...request, start: 6, end: 8 };
  requestPeaks(world, scrolled);
  await tick();
  requestPeaks(world, { ...scrolled, start: 7, end: 9 });
  const replacement = { ...request, asset: { ...source, id: 'loud' } };
  requestPeaks(world, replacement);
  assert.equal(getClipSamples(request.clip), null, 'the old waveform cannot appear while the replacement loads');
  await tick();
  requestPeaks(world, replacement);
  await tick();
  assert.equal(getClipSamples(request.clip)?.data[0], 220);

  pendingRead.resolve();
  await tick();
  assert.equal(getClipSamples(request.clip)?.data[0], 220, 'an old queued range cannot restore its source');
  assert.equal(reads.filter(id => id === 'quiet').length, initialReads + 1, 'the old pending read starts no additional range');
  const finishedReads = reads.length;
  requestPeaks(world, replacement);
  await tick();
  assert.equal(reads.length, finishedReads, 'later frames reuse the replacement waveform');
});
