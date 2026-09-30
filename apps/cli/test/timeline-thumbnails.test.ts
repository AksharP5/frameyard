import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { FrameRequest } from '../../web/src/engine/timeline/media.ts';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/timeline/media.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['mediabunny', '@diffusionstudio/runtime'],
});

function fixture() {
  let active = 0, peak = 0;
  const calls: number[] = [];
  const sourceCalls: string[] = [];
  const releases: (() => void)[] = [];
  const imageReleases: ((tag: string) => void)[] = [];
  const dependencies = {
    mediabunny: { CanvasSink: class {
      readonly assetId: string;
      constructor(track: { assetId: string }) { this.assetId = track.assetId; }
      async getCanvas(timestamp: number) {
        calls.push(timestamp);
        sourceCalls.push(this.assetId);
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return { timestamp, canvas: { timestamp, width: 512, height: 512, assetId: this.assetId } };
      }
    } },
    '@diffusionstudio/runtime': {
      getVideoTrack: async (asset: { id: string }) => ({ assetId: asset.id, getFirstTimestamp: async () => 0, computeDuration: async () => 600 }),
      getAssetFile: async () => new File([], 'image.png'),
      secondsToFrames: (seconds: number, fps: number) => seconds * fps,
    },
  };
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/media.ts') };
  class Canvas {
    tag = '';
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() { return { drawImage: (bitmap: { tag: string }) => { this.tag = bitmap.tag; } }; }
  }
  runInThisContext(`(function(require,module,exports,window,OffscreenCanvas,createImageBitmap){${built.outputFiles[0].text}\n})`)(
    (name: keyof typeof dependencies) => dependencies[name], module, module.exports, { devicePixelRatio: 1 }, Canvas,
    () => new Promise((resolve) => imageReleases.push((tag) => resolve({ width: 128, height: 128, tag, close() {} }))),
  );
  const request: FrameRequest = {
    clip: 1,
    asset: { id: 'recording', type: 'VIDEO', path: 'recording.mp4', source: 'assets/recording.mp4', createdAt: '', mimeType: 'video/mp4',
      duration: 600, width: 1920, height: 1080, frameRate: 30, bitRate: 0, handle: { getFile: async () => new File([], 'recording.mp4') } },
    fps: 30, width: 56, height: 46, interval: 300, firstFrame: 0, lastFrame: 900,
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function drain() {
    for (let i = 0; i < 1000; i++) {
      await tick();
      if (!releases.length) return;
      releases.splice(0).forEach((resolve) => resolve());
    }
    assert.fail('thumbnail requests did not settle');
  }
  return { ...module.exports, request, calls, sourceCalls, tick, drain, imageReleases, peak: () => peak };
}

test('zooming out over many cuts keeps thumbnail decoding bounded and fills every clip', async () => {
  const f = fixture();
  f.requestFrames(f.request);
  await f.drain();
  const clips = Array.from({ length: 40 }, (_, clip) => ({ ...f.request, clip, firstFrame: clip * 300, lastFrame: (clip + 1) * 300 }));
  for (const request of clips) f.requestFrames(request);
  await f.drain();
  assert.equal(f.peak(), 1, 'all clips share one thumbnail decoder slot');
  for (const request of clips) assert.ok(f.pickFrame(request.clip, request.asset.id, request.firstFrame, request.interval));
});

test('a newer zoom supersedes queued tiles, and clearing media cancels pending thumbnail work', async () => {
  const f = fixture();
  f.requestFrames(f.request);
  await f.drain();
  f.calls.length = 0;
  f.requestFrames(f.request);
  await f.tick();
  f.requestFrames({ ...f.request, firstFrame: 9000, lastFrame: 9600 });
  await f.drain();
  assert.deepEqual(f.calls, [0, 290, 300, 310, 320]);
  f.requestFrames({ ...f.request, clip: 2 });
  f.requestFrames({ ...f.request, clip: 3 });
  await f.tick();
  const started = f.calls.length;
  f.clearMedia();
  await f.drain();
  assert.equal(f.calls.length, started, 'cleared jobs must not start another decode');
  assert.equal(f.pickFrame(2, f.request.asset.id, 0, 300), null);
});


test('playback suspends queued thumbnail work and pausing lets it finish', async () => {
  const f = fixture();
  let playing = false;
  const request = { ...f.request, canDecode: () => !playing };
  f.requestFrames(request);
  await f.tick();
  assert.equal(f.calls.length, 1);
  playing = true;
  await f.drain();
  f.requestFrames(request);
  await f.tick();
  assert.equal(f.calls.length, 1, 'only the already running thumbnail may finish during playback');
  playing = false;
  f.requestFrames(request);
  await f.drain();
  assert.ok(f.pickFrame(request.clip, request.asset.id, 0, request.interval), 'the interrupted spread resumes');
  f.calls.length = 0;
  f.requestFrames(request);
  await f.tick();
  playing = true;
  await f.drain();
  assert.equal(f.calls.length, 1, 'clip-specific tiles also yield to playback');
  playing = false;
  f.requestFrames(request);
  await f.drain();
  assert.ok(f.calls.length > 1, 'the interrupted clip strip retries after pause');
});

test('thumbnail cache releases scrolled-away clips but keeps the visible strip', async () => {
  const f = fixture();
  f.requestFrames(f.request);
  await f.drain();
  f.pruneMedia();

  const clips = Array.from({ length: 30 }, (_, index) => ({
    ...f.request, clip: index + 1, firstFrame: (index + 1) * 300, lastFrame: (index + 2) * 300,
  }));
  for (const clip of clips) f.requestFrames(clip);
  await f.drain();
  f.pruneMedia();

  const visible = clips.slice(-3);
  for (const clip of visible) f.requestFrames(clip);
  f.pruneMedia();

  f.calls.length = 0;
  for (const clip of visible) f.requestFrames(clip);
  await f.drain();
  assert.equal(f.calls.length, 0, 'the visible strip remains decoded');

  f.requestFrames(clips[0]!);
  await f.drain();
  assert.ok(f.calls.length > 0, 'returning to an evicted clip decodes its tiles again');
});

test('an obsolete still decode cannot replace a newer asset thumbnail', async () => {
  const f = fixture();
  const asset = { ...f.request.asset, type: 'IMAGE' as const, mimeType: 'image/png' };
  f.resolveStill(asset, 100);
  await f.tick();
  assert.equal(f.imageReleases.length, 1);

  f.forgetAssetMedia(asset.id);
  f.resolveStill(asset, 100);
  await f.tick();
  assert.equal(f.imageReleases.length, 2);

  f.imageReleases.shift()!('old');
  await f.tick();
  f.imageReleases.shift()!('new');
  await f.tick();
  assert.equal((f.resolveStill(asset, 100)?.canvas as unknown as { tag: string })?.tag, 'new');
});

test('replacing a clip source discards its old thumbnails and pending strip without redoing unchanged sources', async () => {
  const f = fixture();
  f.requestFrames(f.request);
  await f.drain();
  f.requestFrames(f.request);
  await f.drain();
  const original = f.pickFrame(f.request.clip, f.request.asset.id, 300, f.request.interval);
  assert.equal((original?.canvas as unknown as { assetId: string } | undefined)?.assetId, 'recording');

  f.calls.length = 0;
  f.requestFrames(f.request);
  await f.drain();
  assert.equal(f.calls.length, 0, 'unchanged source and viewport reuse their strip');

  f.sourceCalls.length = 0;
  f.requestFrames({ ...f.request, firstFrame: 9000, lastFrame: 9600 });
  await f.tick();
  assert.equal(f.calls.length, 1, 'the old source has an in-flight strip decode');
  const replacement = { ...f.request, asset: { ...f.request.asset, id: 'replacement' } };
  f.requestFrames(replacement);
  assert.equal(f.pickFrame(f.request.clip, replacement.asset.id, 300, f.request.interval), null, 'the old source cannot appear while its replacement loads');
  await f.drain();
  assert.equal(f.sourceCalls.filter(id => id === f.request.asset.id).length, 1, 'the superseded source starts no further tile decodes');
  f.requestFrames(replacement);
  await f.drain();
  const updated = f.pickFrame(f.request.clip, replacement.asset.id, 300, f.request.interval);
  assert.equal((updated?.canvas as unknown as { assetId: string } | undefined)?.assetId, 'replacement');

  f.calls.length = 0;
  f.requestFrames(replacement);
  await f.drain();
  assert.equal(f.calls.length, 0, 'the replacement strip is reused on later frames');
});
