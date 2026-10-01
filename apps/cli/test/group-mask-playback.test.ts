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

test('group effect masks advance with playback and preserve the uncovered underlay', { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
  const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve('puppeteer-core'));
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('/@vite/client', vite).href);
  const base = new URL(`/@fs${fileURLToPath(new URL('../../../packages/', import.meta.url))}`, vite).href;
  const result = await page.evaluate(async (base: string) => {
    const r = await import(`${base}runtime/src/index.ts`) as typeof import('../../../packages/runtime/src/index.ts');
    const d = await import(`${base}reconciler/src/index.ts`) as typeof import('../../../packages/reconciler/src/index.ts');
    const a = await import(`${base}assets/src/index.ts`) as typeof import('../../../packages/assets/src/index.ts');
    const left = Int8Array.from({ length: 16 * 9 }, (_, i) => i % 16 < 8 ? 127 : -127);
    const right = Int8Array.from(left, value => -value);
    const bytes = a.encodeMaskFile({ gridWidth: 16, gridHeight: 9, width: 320, height: 180, frameRate: 30 },
      Array.from({ length: 60 }, (_, frame) => ({ field: frame < 30 ? left : right, score: 1, iou: 1 })));
    const asset: import('../../../packages/assets/src/types.ts').MaskAsset = {
      id: 'group-mask', path: 'group.mask', source: 'group.mask', type: 'MASK', width: 320, height: 180,
      frameRate: 30, duration: 2, mimeType: 'application/x-diffusionstudio-mask', createdAt: '',
      handle: { async getFile() { return new File([bytes], 'group.mask'); } },
    };
    const world = r.createRuntimeWorld('group-mask-playback'), document = d.createRuntimeDocument(world);
    const canvas = new OffscreenCanvas(320, 180), ctx = canvas.getContext('2d')!;
    world.set(r.Library, { get: id => id === asset.id || id === asset.path ? asset : undefined } as import('../../../packages/assets/src/library.ts').AssetLibrary);
    world.set(r.Mode, { value: 'offline-video' });
    world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
    world.set(r.FramePromises, { list: [] });
    r.resetCamera(world);
    try {
      d.withDocument(document, () => d.insert(document.stage, d.renderAuthored({ tag: 'scene', props: { width: 320, height: 180, active: true, end: 2 }, children: [
        { tag: 'rect', props: { width: 320, height: 180, end: 2, fill: '#143a58' }, children: [] },
        { tag: 'group', props: { width: 320, height: 180, end: 2 }, children: [
          { tag: 'rect', props: { width: 320, height: 180, end: 2, fill: '#f5ba42' }, children: [] },
          { tag: 'effect', props: { type: 'opacity', value: 1 }, children: [{ tag: 'mask', props: { src: asset.path, smoothing: 0 }, children: [] }] },
        ] },
      ] })));
      const scene = r.getActiveEntity(world)!;
      const frame = async (at: number) => {
        r.setPlayhead(world, scene, at); r.playbackSystem(world);
        await Promise.all(world.get(r.FramePromises)!.list.splice(0));
        r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
        return { left: [...ctx.getImageData(40, 90, 1, 1).data], right: [...ctx.getImageData(280, 90, 1, 1).data] };
      };
      return { first: await frame(15), next: await frame(45) };
    } finally {
      r.disposeDecoders(world, world.get(r.Root)!);
      document.dispose(); world.destroy();
    }
  }, base);
  assert.deepEqual(result.first, { left: [245, 186, 66, 255], right: [20, 58, 88, 255] });
  assert.deepEqual(result.next, { left: [20, 58, 88, 255], right: [245, 186, 66, 255] });
});
