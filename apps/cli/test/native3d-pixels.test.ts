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
const node = (tag: AuthoredTree['tag'], props: AuthoredTree['props'], children: AuthoredTree[] = []): AuthoredTree => ({ tag, props, children });

test('native 3D pixels preserve depth, editable paints, focus and volume occlusion', { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
  const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve('puppeteer-core'));
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium, protocolTimeout: 30_000, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(new URL('/@vite/client', vite).href);
  await page.setContent('<!doctype html><body></body>');
  const runtimeUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/runtime/src/index.ts', import.meta.url))}`, vite).href;
  const reconcilerUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/reconciler/src/index.ts', import.meta.url))}`, vite).href;
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('console', (message: { type(): string; text(): string }) => { if (message.type() === 'error') errors.push(message.text()); });
  const render = (children: AuthoredTree[], props: AuthoredTree['props'] = {}, mode: 'offline-video' | 'realtime' = 'offline-video') => page.evaluate(async ({ tree, runtimeUrl, reconcilerUrl, mode }: { tree: AuthoredTree; runtimeUrl: string; reconcilerUrl: string; mode: 'offline-video' | 'realtime' }) => {
    const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
    const d = await import(reconcilerUrl) as typeof import('../../../packages/reconciler/src/index.ts');
    const world = r.createRuntimeWorld('native-3d-pixels'), document = d.createRuntimeDocument(world);
    const canvas = new OffscreenCanvas(320, 200), ctx = canvas.getContext('2d')!;
    try {
      r.resetCamera(world);
      world.set(r.Mode, { value: mode });
      world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
      d.withDocument(document, () => d.insert(document.stage, d.renderAuthored(tree)));
      r.setPlayhead(world, r.getActiveEntity(world)!, 30);
      r.playbackSystem(world);
      const frames = world.get(r.FramePromises)?.list;
      while (frames?.length) await Promise.all(frames.splice(0));
      r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
      return Array.from(ctx.getImageData(0, 0, 320, 200).data);
    } finally { document.dispose(); world.destroy(); }
  }, { tree: node('scene', { width: 320, height: 200, active: true, end: 2 }, [node('rect', { width: 320, height: 200, fill: '#101820' }), node('scene3d', { width: 320, height: 200, end: 2, ...props }, children)]), runtimeUrl, reconcilerUrl, mode });
  const at = (pixels: number[], x: number, y: number) => pixels.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 4);

  await t.test('nearest solid occludes a later solid', async () => {
    const pixels = await render([
      node('mesh', { x: 110, y: 50, z: 100, width: 100, height: 100, depth: 100, fill: '#ff2200', lit: false }),
      node('mesh', { x: 100, y: 40, z: -100, width: 120, height: 120, depth: 100, fill: '#0033ff', lit: false }),
    ]);
    assert.deepEqual(at(pixels, 160, 100), [255, 34, 0, 255]);
  });
  await t.test('static point arrays reuse geometry while authored and keyframed replacements redraw', async () => {
    const result = await page.evaluate(async ({ runtimeUrl, reconcilerUrl }: { runtimeUrl: string; reconcilerUrl: string }) => {
      const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
      const d = await import(reconcilerUrl) as typeof import('../../../packages/reconciler/src/index.ts');
      const original = WebGL2RenderingContext.prototype.createBuffer;
      let buffers = 0;
      WebGL2RenderingContext.prototype.createBuffer = new Proxy(original, { apply(target, receiver, args) {
        buffers++; return Reflect.apply(target, receiver, args);
      } });
      const world = r.createRuntimeWorld('native-3d-geometry-cache'), document = d.createRuntimeDocument(world);
      const canvas = new OffscreenCanvas(320, 200), ctx = canvas.getContext('2d')!;
      try {
        r.resetCamera(world);
        world.set(r.Mode, { value: 'offline-video' });
        world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
        d.withDocument(document, () => d.insert(document.stage, d.renderAuthored({ tag: 'scene', props: { width: 320, height: 200, active: true, end: 2 }, children: [
          { tag: 'scene3d', props: { width: 320, height: 200, end: 2 }, children: [
            { tag: 'pointCloud', props: { points: [40, 100, 0], pointColors: [1, 0, 0, 1], pointSize: 20, end: 2 }, children: [] },
          ] },
        ] })));
        const scene = r.getActiveEntity(world)!;
        const cloud = world.query(r.SpatialGeometry).find(entity => entity.get(r.Geometry)?.value === r.GeometryType.POINT_CLOUD)!;
        const cloudNode = cloud.get(r.Host)!;
        const pixel = (x: number) => Array.from(ctx.getImageData(x, 100, 1, 1).data);
        const draw = (frame: number) => {
          r.setPlayhead(world, scene, frame); r.playbackSystem(world); r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
        };
        draw(0);
        const first = { old: pixel(40), buffers };
        draw(0);
        const staticBuffers = buffers;
        document.setProperty(cloudNode, 'points', [100, 100, 0]);
        draw(0);
        const authored = { old: pixel(40), next: pixel(100), buffers };
        const add = (tag: string, props: Record<string, unknown>, parent: ReturnType<typeof document.createElement>) => {
          const child = document.createElement(tag);
          for (const [name, value] of Object.entries(props)) document.setProperty(child, name, value);
          document.insertNode(parent, child);
          return child;
        };
        const track = add('KeyframeTrack', { property: 'points' }, cloudNode);
        add('Keyframe', { time: 0, value: [100, 100, 0] }, track);
        add('Keyframe', { time: 1, value: [160, 100, 0] }, track);
        draw(30);
        return { first, staticBuffers, authored, animated: { old: pixel(100), next: pixel(160), buffers } };
      } finally {
        document.dispose(); world.destroy();
        WebGL2RenderingContext.prototype.createBuffer = original;
      }
    }, { runtimeUrl, reconcilerUrl });
    assert.equal(result.staticBuffers, result.first.buffers, 'unchanged arrays do not upload new geometry');
    assert.ok(result.authored.buffers > result.staticBuffers, 'authored replacement uploads new geometry');
    assert.ok(result.animated.buffers > result.authored.buffers, 'keyframed replacement uploads new geometry');
    assert.ok(result.first.old[0]! > 150);
    assert.ok(result.authored.old[0]! < 100 && result.authored.next[0]! > 150);
    assert.ok(result.animated.old[0]! < 100 && result.animated.next[0]! > 150);
  });
  await t.test('unchanged 3D solid paint avoids texture uploads while edits and live fills redraw', async () => {
    const result = await page.evaluate(async ({ runtimeUrl, reconcilerUrl }: { runtimeUrl: string; reconcilerUrl: string }) => {
      const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
      const d = await import(reconcilerUrl) as typeof import('../../../packages/reconciler/src/index.ts');
      const originalImage = WebGL2RenderingContext.prototype.texImage2D;
      const originalSubImage = WebGL2RenderingContext.prototype.texSubImage2D;
      let uploads = 0;
      WebGL2RenderingContext.prototype.texImage2D = function (...args) { uploads++; return originalImage.apply(this, args); };
      WebGL2RenderingContext.prototype.texSubImage2D = function (...args) { uploads++; return originalSubImage.apply(this, args); };
      const world = r.createRuntimeWorld('native-3d-paint-cache'), document = d.createRuntimeDocument(world);
      const canvas = new OffscreenCanvas(320, 200), ctx = canvas.getContext('2d')!;
      try {
        r.resetCamera(world);
        world.set(r.Mode, { value: 'offline-video' });
        world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
        d.withDocument(document, () => d.insert(document.stage, d.renderAuthored({ tag: 'scene', props: { width: 320, height: 200, active: true, end: 2 }, children: [
          { tag: 'scene3d', props: { width: 320, height: 200, end: 2 }, children: [
            { tag: 'rect', props: { name: 'paint', x: 90, y: 60, width: 140, height: 80, fill: '#ff2200', end: 2 }, children: [] },
          ] },
        ] })));
        const scene = r.getActiveEntity(world)!;
        const paint = world.query(r.Geometry).find(entity => entity.get(r.Name)?.value === 'paint')!;
        const sample = () => {
          r.setPlayhead(world, scene, 0); r.playbackSystem(world); r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
          return { uploads, pixel: Array.from(ctx.getImageData(160, 100, 1, 1).data) };
        };
        const first = sample(), stable = sample();
        document.setProperty(paint.get(r.Host)!, 'fill', '#0066ff');
        const edited = sample();
        document.setProperty(paint.get(r.Host)!, 'cornerRadius', 12);
        const rounded = sample();
        document.setProperty(paint.get(r.Host)!, 'cornerRadius', 0);
        const square = sample(), squareStable = sample();
        const squarePixels = ctx.getImageData(90, 60, 140, 80).data.slice();
        paint.add(r.SourceError({ value: '' }));
        const fallback = sample();
        const fallbackPixels = ctx.getImageData(90, 60, 140, 80).data;
        const samePixels = squarePixels.every((value, index) => value === fallbackPixels[index]);
        paint.remove(r.SourceError);
        sample();
        paint.add(r.Generating);
        const generating = sample(), generatingAgain = sample();
        return { first, stable, edited, rounded, square, squareStable, fallback, samePixels, generating, generatingAgain };
      } finally {
        document.dispose(); world.destroy();
        WebGL2RenderingContext.prototype.texImage2D = originalImage;
        WebGL2RenderingContext.prototype.texSubImage2D = originalSubImage;
      }
    }, { runtimeUrl, reconcilerUrl });
    assert.equal(result.stable.uploads, result.first.uploads, 'stable solid paint stays on the GPU');
    assert.ok(result.first.pixel[0]! > 200 && result.edited.pixel[2]! > 200, 'the paint edit changes visible pixels');
    assert.ok(result.edited.uploads > result.stable.uploads);
    assert.ok(result.rounded.uploads > result.edited.uploads);
    assert.ok(result.square.uploads > result.rounded.uploads);
    assert.equal(result.squareStable.uploads, result.square.uploads);
    assert.ok(result.fallback.uploads > result.squareStable.uploads);
    assert.equal(result.samePixels, true, 'the fast paint matches the full drawing path');
    assert.ok(result.generating.uploads > result.fallback.uploads);
    assert.ok(result.generatingAgain.uploads > result.generating.uploads, 'live fills keep repainting');
  });
  await t.test('mesh retains editable gradient paint', async () => {
    const pixels = await render([node('mesh', { shape: 'plane', x: 60, y: 50, width: 200, height: 100, lit: false }, [
      node('linearGradientPaint', { x1: 0, y1: .5, x2: 1, y2: .5 }, [node('colorStop', { offset: 0, color: '#ff0000' }), node('colorStop', { offset: 1, color: '#0000ff' })]),
    ])]);
    const left = at(pixels, 80, 100), right = at(pixels, 240, 100);
    assert.ok(left[0]! > 210 && left[2]! < 45, `red end: ${left}`);
    assert.ok(right[2]! > 210 && right[0]! < 45, `blue end: ${right}`);
  });
  await t.test('aperture preserves focus and blurs distant geometry', async () => {
    const children = [node('rect', { x: 50, y: 50, width: 80, height: 100, fill: '#80c040' }), node('mesh', { shape: 'plane', x: 205, y: 65, z: 300, width: 40, height: 70, fill: '#80c040', lit: false })];
    const sharp = await render(children), focused = await render(children, { focusDistance: 1000, aperture: 30 });
    assert.ok(at(sharp, 90, 100).every((value, i) => Math.abs(value - at(focused, 90, 100)[i]!) <= 1), 'in-focus color is preserved');
    let nearDifferences = 0, farDifferences = 0;
    for (let y = 60; y < 140; y++) for (let x = 55; x < 285; x++) {
      const different = at(sharp, x, y).some((value, i) => Math.abs(value - at(focused, x, y)[i]!) > 12);
      if (different && x < 125) nearDifferences++;
      if (different && x > 220) farDifferences++;
    }
    assert.equal(nearDifferences, 0, 'in-focus interior stays sharp');
    assert.ok(farDifferences > 400, `out-of-focus geometry blurs: ${farDifferences}`);
  });
  await t.test('scene finish applies inside the 3D viewport', async () => {
    const children = [node('mesh', { shape: 'plane', width: 320, height: 200, fill: '#cccccc', lit: false })];
    const neutral = await render(children), vignette = await render(children, { vignette: 1 });
    assert.ok(at(vignette, 20, 20)[0]! < at(neutral, 20, 20)[0]! - 80);
    assert.ok(Math.abs(at(vignette, 160, 100)[0]! - at(neutral, 160, 100)[0]!) <= 1);
  });
  await t.test('smoke is deterministic and respects foreground depth', async () => {
    const children = [node('volume', { x: 30, y: 10, width: 260, height: 180, depth: 220, fill: '#79beff', density: 2.5, noiseScale: 3, flowSpeed: .3 }), node('mesh', { x: 150, y: 65, z: 200, width: 60, height: 70, depth: 50, fill: '#ff2200', lit: false })];
    const first = await render(children), second = await render(children);
    assert.deepEqual(first, second, 'same time renders identical volume noise');
    assert.deepEqual(at(first, 180, 100), [255, 34, 0, 255], 'foreground solid blocks smoke');
    assert.ok(at(first, 110, 100)[2]! > 80, 'smoke contributes visible color');
  });
  await t.test('paused preparation keeps future and nested 3D clips ready without exposing them', async () => {
    const tree = node('scene', { width: 320, height: 200, active: true, end: 5 }, [
      node('rect', { width: 320, height: 200, fill: '#101820' }),
      node('scene3d', { name: 'left', width: 160, height: 200, end: 5 }, [
        node('mesh', { start: 1, end: 5, x: 40, y: 60, width: 80, height: 80, fill: '#ff2200', lit: false }),
      ]),
      node('scene3d', { name: 'right', start: 1, end: 5, x: 160, width: 160, height: 200 }, [
        node('scene3d', { x: 20, y: 25, width: 120, height: 150, end: 5 }, [
          node('mesh', { start: 1, end: 5, x: 20, y: 30, width: 80, height: 90, fill: '#2288ff' }),
        ]),
      ]),
    ]);
    const result = await page.evaluate(async ({ tree, runtimeUrl, reconcilerUrl }: { tree: AuthoredTree; runtimeUrl: string; reconcilerUrl: string }) => {
      const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
      const d = await import(reconcilerUrl) as typeof import('../../../packages/reconciler/src/index.ts');
      const getContext = OffscreenCanvas.prototype.getContext, createProgram = WebGL2RenderingContext.prototype.createProgram;
      const contexts = new Set<WebGL2RenderingContext>();
      let programs = 0;
      OffscreenCanvas.prototype.getContext = new Proxy(getContext, { apply(target, receiver, args) {
        const context = Reflect.apply(target, receiver, args);
        if (context instanceof WebGL2RenderingContext) contexts.add(context);
        return context;
      } });
      WebGL2RenderingContext.prototype.createProgram = new Proxy(createProgram, { apply(target, receiver, args) {
        programs++; return Reflect.apply(target, receiver, args);
      } });
      const world = r.createRuntimeWorld('native-3d-preparation'), document = d.createRuntimeDocument(world);
      const canvas = new OffscreenCanvas(320, 200), ctx = canvas.getContext('2d')!;
      let disposed = false;
      try {
        r.resetCamera(world);
        world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
        d.withDocument(document, () => d.insert(document.stage, d.renderAuthored(tree)));
        const active = r.getActiveEntity(world)!;
        const renderAt = (frame: number) => {
          r.setPlayhead(world, active, frame); r.playbackSystem(world); r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
          return Array.from(ctx.getImageData(0, 0, 320, 200).data);
        };
        const paused = renderAt(0), preparedPrograms = programs;
        const futureHits = world.get(r.HitRegions)!.list.filter(region => region.target.kind === 'entity'
          && world.query(r.SpatialGeometry).some(entity => entity === region.target.id)).length;
        const timeAfterPreparation = active.get(r.Computed)!.localTime;
        active.set(r.Playback, { playing: true });
        const playing = renderAt(90), playbackPrograms = programs;
        active.set(r.Playback, { playing: false });
        world.set(r.Mode, { value: 'offline-video' });
        const offline = renderAt(90);
        const left = world.query(r.Scene3D, r.Name).find(entity => entity.get(r.Name)?.value === 'left')!;
        left.destroy();
        const afterRemoval = renderAt(90);
        const aliveAfterRemoval = [...contexts].every(context => !context.isContextLost());
        document.dispose(); world.destroy(); disposed = true;
        return { paused, playing, offline, afterRemoval, timeAfterPreparation, futureHits, preparedPrograms, playbackPrograms,
          contexts: contexts.size, aliveAfterRemoval, lostAfterDisposal: [...contexts].every(context => context.isContextLost()) };
      } finally {
        if (!disposed) { document.dispose(); world.destroy(); }
        OffscreenCanvas.prototype.getContext = getContext; WebGL2RenderingContext.prototype.createProgram = createProgram;
      }
    }, { tree, runtimeUrl, reconcilerUrl });
    assert.equal(result.contexts, 1, 'all nested and sibling viewports share one GPU context');
    assert.ok(result.preparedPrograms > 0, 'shaders compile while paused');
    assert.equal(result.playbackPrograms, result.preparedPrograms, 'future clips reuse shaders when playback reaches them');
    assert.equal(result.timeAfterPreparation, 0);
    assert.equal(result.futureHits, 0, 'future geometry cannot be selected');
    assert.deepEqual(at(result.paused, 80, 100), [16, 24, 32, 255]);
    assert.deepEqual(at(result.paused, 240, 100), [16, 24, 32, 255]);
    assert.deepEqual(at(result.playing, 80, 100), [255, 34, 0, 255]);
    assert.ok(at(result.playing, 240, 100)[2]! > 100, 'nested viewport draws at the correct size');
    assert.deepEqual(result.playing, result.offline, 'preview and export pixels agree');
    assert.deepEqual(at(result.afterRemoval, 240, 100), at(result.playing, 240, 100));
    assert.ok(result.aliveAfterRemoval, 'removing one scene leaves the others usable');
    assert.ok(result.lostAfterDisposal, 'document disposal releases the shared context');
  });
  await t.test('prepared future lights do not illuminate visible smoke', async () => {
    const volume = node('volume', { x: 30, y: 10, width: 260, height: 180, depth: 220, fill: '#79beff', density: 2.5 });
    const expected = await render([volume]);
    const prepared = await render([volume, node('light', { type: 'directional', start: 2, end: 3, color: '#ff0000', intensity: 10 })], {}, 'realtime');
    assert.deepEqual(prepared, expected);
  });
  assert.deepEqual(errors, [], 'no GPU or browser errors');
});
