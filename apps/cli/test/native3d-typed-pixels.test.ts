import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const data = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const hyperframes = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data, 'diffusion-studio/tools/node_modules/.bin/hyperframes');
const chromium = process.env.DIFFUSION_CHROMIUM_BIN ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
const vite = process.env.DIFFUSION_TEST_VITE_URL;
test('ordinary and typed native geometry render identically through edits and out-of-order seeks', { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
  const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve('puppeteer-core'));
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium, protocolTimeout: 30_000, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('/@vite/client', vite).href);
  await page.setContent('<!doctype html><body></body>');
  const runtimeUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/runtime/src/index.ts', import.meta.url))}`, vite).href;
  const reconcilerUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/reconciler/src/index.ts', import.meta.url))}`, vite).href;
  const at = (pixels: number[], x: number, y: number) => pixels.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 4);
  const results = [];
  for (const typed of [false, true]) {
  const result = await page.evaluate(async ({ runtimeUrl, reconcilerUrl, typed }: { runtimeUrl: string; reconcilerUrl: string; typed: boolean }) => {
    const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
    const d = await import(reconcilerUrl) as typeof import('../../../packages/reconciler/src/index.ts');
    const world = r.createRuntimeWorld('native-3d-typed-geometry'), document = d.createRuntimeDocument(world);
    world.get(r.Root)!.set(r.Camera, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const canvas = new OffscreenCanvas(320, 200), ctx = canvas.getContext('2d')!;
    const bufferData = WebGL2RenderingContext.prototype.bufferData;
    let uploads = 0;
    WebGL2RenderingContext.prototype.bufferData = new Proxy(bufferData, { apply(target, receiver, args) {
      uploads++; return Reflect.apply(target, receiver, args);
    } });
    try {
      world.set(r.Mode, { value: 'offline-video' });
      world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
      const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(props)) document.setProperty(element, name, value);
        document.insertNode(parent, element);
        return element;
      };
      const scene = add('Scene', { width: 320, height: 200, active: true, end: 2 });
      add('Rect', { width: 320, height: 200, fill: '#101820' }, scene);
      const viewport = add('Scene3d', { width: 320, height: 200, end: 2 }, scene);
      const vertices = [40, 40, 0, 140, 40, 0, 40, 140, 0];
      const coordinates = (values: number[]) => typed ? new Float32Array(values) : [...values];
      const mesh = add('Mesh', { shape: 'custom', vertices: coordinates(vertices), indices: typed ? new Uint32Array([0, 1, 2]) : [0, 1, 2], fill: '#ff2200', lit: false }, viewport);
      Object.defineProperty(mesh.entity.get(r.SpatialGeometry)!.vertices, 'toJSON', {
        value: () => { throw new Error('Renderer serialized custom vertices'); },
      });
      const sample = (frame = 0) => {
        const before = uploads;
        r.setPlayhead(world, scene.entity, frame); r.playbackSystem(world); r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
        return { uploads: uploads - before, pixels: Array.from(ctx.getImageData(0, 0, 320, 200).data) };
      };
      const initial = sample(), repeated = sample();
      document.setProperty(mesh, 'vertices', coordinates(vertices));
      const equalReplacement = sample();
      document.setProperty(mesh, 'vertices', coordinates(vertices.map((value, index) => index % 3 === 0 ? value + 100 : value)));
      const edited = sample();
      document.setProperty(mesh, 'vertices', coordinates(vertices));
      const restored = sample();
      const track = add('KeyframeTrack', { property: 'vertices' }, mesh);
      add('Keyframe', { time: 0, value: coordinates(vertices) }, track);
      add('Keyframe', { time: 1, value: coordinates(vertices.map((value, index) => index % 3 === 0 ? value + 100 : value)) }, track);
      const animated = sample(15), end = sample(30), back = sample(0), animatedAgain = sample(15);
      return { initial, repeated, equalReplacement, edited, restored, animated, end, back, animatedAgain };
    } finally {
      document.dispose(); world.destroy(); WebGL2RenderingContext.prototype.bufferData = bufferData;
    }
  }, { runtimeUrl, reconcilerUrl, typed });
  results.push(result);
  assert.ok(result.initial.uploads > 0, 'initial geometry uploads');
  assert.equal(result.repeated.uploads, 0, 'static geometry stays on the GPU');
  assert.ok(result.equalReplacement.uploads > 0, 'source property edits replace geometry buffers');
  assert.deepEqual(result.repeated.pixels, result.initial.pixels);
  assert.deepEqual(result.equalReplacement.pixels, result.initial.pixels);
  assert.ok(result.edited.uploads > 0, 'source edits refresh geometry');
  assert.deepEqual(at(result.initial.pixels, 60, 60), [255, 34, 0, 255]);
  assert.deepEqual(at(result.edited.pixels, 60, 60), [16, 24, 32, 255]);
  assert.deepEqual(at(result.edited.pixels, 160, 60), [255, 34, 0, 255]);
  assert.deepEqual(result.restored.pixels, result.initial.pixels);
  assert.deepEqual(at(result.animated.pixels, 110, 60), [255, 34, 0, 255]);
  assert.deepEqual(result.end.pixels, result.edited.pixels);
  assert.deepEqual(result.back.pixels, result.initial.pixels);
  assert.deepEqual(result.animatedAgain.pixels, result.animated.pixels, 'array animation remains seek-safe');
  }
  for (const state of Object.keys(results[0]) as (keyof typeof results[0])[]) {
    assert.deepEqual(results[0][state].pixels, results[1][state].pixels, `${state}: typed/native pixel parity`);
  }
});
