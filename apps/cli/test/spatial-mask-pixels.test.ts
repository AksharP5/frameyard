import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { AuthoredTree } from '@diffusionstudio/jsx';

const data = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const hyperframes = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data, 'diffusion-studio/tools/node_modules/.bin/hyperframes');
const chromium = process.env.DIFFUSION_CHROMIUM_BIN ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
const vite = process.env.DIFFUSION_TEST_VITE_URL;

test('scene and object effect masks preserve projected planes and native 3D pixels', { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
  const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve('puppeteer-core'));
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('/@vite/client', vite).href);
  const base = new URL(`/@fs${fileURLToPath(new URL('../../../packages/', import.meta.url))}`, vite).href;
  const result = await page.evaluate(async (base: string) => {
    const r = await import(`${base}runtime/src/index.ts`) as typeof import('../../../packages/runtime/src/index.ts');
    const d = await import(`${base}reconciler/src/index.ts`) as typeof import('../../../packages/reconciler/src/index.ts');
    const a = await import(`${base}assets/src/index.ts`) as typeof import('../../../packages/assets/src/index.ts');
    const bytes = a.encodeMaskFile({ gridWidth: 16, gridHeight: 10, width: 320, height: 200, frameRate: 30 }, [
      { field: new Int8Array(160).fill(127), score: 1, iou: 1 },
    ]);
    const asset: import('../../../packages/assets/src/types.ts').MaskAsset = {
      id: 'opaque-mask', path: 'opaque.mask', source: 'opaque.mask', type: 'MASK', width: 320, height: 200,
      frameRate: 30, duration: 1 / 30, mimeType: 'application/x-diffusionstudio-mask', createdAt: '',
      handle: { async getFile() { return new File([bytes], 'opaque.mask'); } },
    };
    const half = a.encodeMaskFile({ gridWidth: 10, gridHeight: 10, width: 100, height: 100, frameRate: 30 }, [
      { field: Int8Array.from({ length: 100 }, (_, i) => i % 10 < 5 ? 127 : -127), score: 1, iou: 1 },
    ]);
    const objectMask = { ...asset, id: 'object-mask', path: 'object.mask', source: 'object.mask', width: 100, height: 100,
      handle: { async getFile() { return new File([half], 'object.mask'); } },
    };
    const top = a.encodeMaskFile({ gridWidth: 16, gridHeight: 10, width: 320, height: 200, frameRate: 30 }, [
      { field: Int8Array.from({ length: 160 }, (_, i) => i < 80 ? 127 : -127), score: 1, iou: 1 },
    ]);
    const groupMask = { ...asset, id: 'group-mask', path: 'group.mask', source: 'group.mask',
      handle: { async getFile() { return new File([top], 'group.mask'); } },
    };
    const effect = (src: string): AuthoredTree => ({ tag: 'effect', props: { type: 'opacity', value: 1 }, children: [
      { tag: 'mask', props: { src, smoothing: 0 }, children: [] },
    ] });
    const render = async (target: 'none' | 'scene' | 'plane' | 'native' | 'group' | 'group-none') => {
      const world = r.createRuntimeWorld('spatial-mask-pixels'), document = d.createRuntimeDocument(world);
      const canvas = new OffscreenCanvas(320, 200), ctx = canvas.getContext('2d')!;
      try {
        r.resetCamera(world);
        world.set(r.Mode, { value: 'offline-video' });
        world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
        world.set(r.FramePromises, { list: [] });
        world.set(r.Library, { get: id => [asset, objectMask, groupMask].find(entry => entry.id === id || entry.path === id) } as import('../../../packages/assets/src/library.ts').AssetLibrary);
        let children: AuthoredTree[] = [
          { tag: 'rect', props: { x: 100, y: 50, width: 100, height: 100, rotationY: target === 'native' ? 0 : 45, fill: '#ff2200', end: 2 },
            children: target === 'plane' || target === 'native' || target === 'group' ? [effect(objectMask.path)] : [] },
          { tag: 'rect', props: { x: 220, y: 40, width: 50, height: 40, fill: '#0033ff', end: 2 }, children: [] },
        ];
        if (target === 'scene') children.push(effect(asset.path));
        if (target === 'native') children = [{ tag: 'scene3d', props: { width: 320, height: 200, end: 2 }, children }];
        if (target === 'group' || target === 'group-none') {
          if (target === 'group') children.push(effect(groupMask.path));
          children = [{ tag: 'group', props: { width: 320, height: 200, rotationY: 10, end: 2 }, children }];
        }
        d.withDocument(document, () => d.insert(document.stage, d.renderAuthored({ tag: 'scene', props: { width: 320, height: 200, active: true, end: 2 }, children })));
        r.setPlayhead(world, r.getActiveEntity(world)!, 0);
        r.playbackSystem(world);
        await Promise.all(world.get(r.FramePromises)!.list.splice(0));
        r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
        const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        const removed = ctx.getImageData(165, 40, 30, 120).data;
        let removedRightAlpha = 0;
        for (let i = 3; i < removed.length; i += 4) removedRightAlpha = Math.max(removedRightAlpha, removed[i]!);
        return { tilted: pixel(150, 100), affine: pixel(245, 60), origin: pixel(10, 10), left: pixel(125, 100), right: pixel(175, 100), topLeft: pixel(140, 90), topRight: pixel(170, 90), bottomLeft: pixel(140, 130), removedRightAlpha };
      } finally {
        r.disposeDecoders(world, world.get(r.Root)!);
        document.dispose(); world.destroy();
      }
    };
    return { normal: await render('none'), masked: await render('scene'), plane: await render('plane'), native: await render('native'), group: await render('group'), groupNormal: await render('group-none') };
  }, base);
  await t.test('an opaque scene mask preserves projected and affine child positions', () => {
    assert.deepEqual(result.normal.tilted, [255, 34, 0, 255]);
    assert.deepEqual(result.normal.affine, [0, 51, 255, 255]);
    assert.deepEqual(result.normal.origin, [0, 0, 0, 0]);
    assert.deepEqual(result.masked, result.normal);
  });
  for (const target of ['plane', 'native'] as const) {
    await t.test(`${target} object masks remove only the right half`, () => {
      assert.deepEqual(result[target].left, [255, 34, 0, 255]);
      assert.deepEqual(result[target].right, [0, 0, 0, 0]);
      assert.deepEqual(result[target].affine, [0, 51, 255, 255]);
      assert.equal(result[target].removedRightAlpha, 0);
    });
  }
  await t.test('a tilted group mask intersects its projected child mask', () => {
    for (const point of ['topLeft', 'topRight', 'bottomLeft'] as const) assert.deepEqual(result.groupNormal[point], [255, 34, 0, 255]);
    assert.deepEqual(result.group.topLeft, [255, 34, 0, 255]);
    assert.deepEqual(result.group.topRight, [0, 0, 0, 0]);
    assert.deepEqual(result.group.bottomLeft, [0, 0, 0, 0]);
    assert.deepEqual(result.group.affine, result.groupNormal.affine);
    assert.equal(result.group.removedRightAlpha, 0);
  });
});
