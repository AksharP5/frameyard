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
  const releases: (() => void)[] = [];
  const dependencies = {
    mediabunny: { CanvasSink: class {
      async getCanvas(timestamp: number) {
        calls.push(timestamp);
        peak = Math.max(peak, ++active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return { timestamp, canvas: { timestamp } };
      }
    } },
    '@diffusionstudio/runtime': {
      getVideoTrack: async () => ({ getFirstTimestamp: async () => 0, computeDuration: async () => 600 }),
      secondsToFrames: (seconds: number, fps: number) => seconds * fps,
    },
  };
  const module = { exports: {} as typeof import('../../web/src/engine/timeline/media.ts') };
  runInThisContext(`(function(require,module,exports,window){${built.outputFiles[0].text}\n})`)(
    (name: keyof typeof dependencies) => dependencies[name], module, module.exports, { devicePixelRatio: 1 },
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
  return { ...module.exports, request, calls, tick, drain, peak: () => peak };
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
