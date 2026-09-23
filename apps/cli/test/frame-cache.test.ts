import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../../../packages/runtime/src/media/frame-cache.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node',
});

function fixture() {
  const canvases: Canvas[] = [];
  class Canvas {
    width: number; height: number;
    readonly draws: unknown[][] = [];
    readonly clears: number[][] = [];
    readonly rotations: number[] = [];
    constructor(width: number, height: number) { this.width = width; this.height = height; canvases.push(this); }
    getContext() {
      return {
        clearRect: (...args: number[]) => this.clears.push(args), drawImage: (...args: unknown[]) => this.draws.push(args),
        resetTransform() {}, translate() {}, rotate: (angle: number) => this.rotations.push(angle),
      };
    }
  }
  class Frame { displayWidth = 3840; displayHeight = 2160; }
  const module = { exports: {} as typeof import('../../../packages/runtime/src/media/frame-cache.ts') };
  runInNewContext(compiled.outputFiles[0].text, { module, OffscreenCanvas: Canvas, VideoFrame: Frame });
  const cache = new module.exports.FrameCache({ pixels: 1280 * 720, count: 30 });
  const frame = new Frame() as VideoFrame;
  return { cache, canvases, frame };
}

test('unrotated 4K frames stay within the preview tile budget without a full-resolution canvas copy', () => {
  const { cache, canvases, frame } = fixture();
  try {
    for (let index = 0; index < 30; index++) cache.insert(frame, index);
    assert.ok(canvases.reduce((pixels, canvas) => pixels + canvas.width * canvas.height, 0) <= 1280 * 720 * 30, 'cached 4K preview frames must not retain an extra 3840×2160 backing store');
    assert.equal(canvases.reduce((draws, canvas) => draws + canvas.draws.length, 0), 30, 'each unrotated frame needs one downscale into its cache tile');
    assert.deepEqual(JSON.parse(JSON.stringify(cache.findTile(29))), { x: 6400, y: 2880, width: 1280, height: 720 });
  } finally { cache.dispose(); }
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('rotated preview tiles keep their orientation, dimensions, and transparent clear', () => {
  for (const rotation of [90, 180, 270]) {
    const { cache, canvases, frame } = fixture();
    try {
      cache.rotation = rotation;
      cache.insert(frame, 0);
      const width = rotation === 180 ? 1280 : 720;
      const height = rotation === 180 ? 720 : 1280;
      assert.deepEqual(JSON.parse(JSON.stringify(cache.findTile(0))), { x: 0, y: 0, width, height });
      assert.deepEqual(canvases[1].rotations, [rotation * Math.PI / 180]);
      assert.equal(canvases[0].draws[0][0], canvases[1], 'rotation still uses the correctly oriented intermediate');
      assert.deepEqual(canvases[0].clears, [[0, 0, width, height]], 'transparent frames replace the tile instead of accumulating pixels');
    } finally { cache.dispose(); }
  }
});

test('a later picture takes precedence over an overlapping duration estimate', () => {
  const { cache, frame } = fixture();
  try {
    cache.insert(frame, 0, 4);
    cache.insert(frame, 2, 3);
    assert.equal(cache.findCovering(2), 2);
    assert.equal(cache.findCovering(3), undefined, 'an older duration estimate cannot resume after a newer picture');
  } finally { cache.dispose(); }
});
