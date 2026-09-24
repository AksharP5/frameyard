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

test('plain rectangle pixels match the full drawing path under transform and blur', { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
	const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve('puppeteer-core'));
	const browser = await puppeteer.launch({ headless: true, executablePath: chromium, args: ['--no-sandbox'] });
	t.after(() => browser.close());
	const page = await browser.newPage();
	await page.goto(new URL('/@vite/client', vite).href);
	await page.setContent('<!doctype html><body></body>');
	const runtimeUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/runtime/src/index.ts', import.meta.url))}`, vite).href;
	const reconcilerUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/reconciler/src/index.ts', import.meta.url))}`, vite).href;
	const result = await page.evaluate(async ({ runtimeUrl, reconcilerUrl }: { runtimeUrl: string; reconcilerUrl: string }) => {
		const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
		const d = await import(reconcilerUrl) as typeof import('../../../packages/reconciler/src/index.ts');
		const world = r.createRuntimeWorld('plain-rect-pixels'), document = d.createRuntimeDocument(world);
		const canvas = new OffscreenCanvas(240, 160), ctx = canvas.getContext('2d')!;
		try {
			r.resetCamera(world);
			world.set(r.RenderSurface, { canvas, ctx, resolution: 1 });
			d.withDocument(document, () => d.insert(document.stage, d.renderAuthored({ tag: 'scene', props: { width: 240, height: 160, active: true, end: 2 }, children: [
				{ tag: 'rect', props: { name: 'target', x: 35, y: 25, width: 140, height: 90, rotation: 17, blur: 3, opacity: .7, fill: '#e3572d', end: 2 }, children: [] },
			] })));
			const scene = r.getActiveEntity(world)!;
			const target = world.query(r.Geometry).find(entity => entity.get(r.Name)?.value === 'target')!;
			const render = () => {
				r.setPlayhead(world, scene, 0); r.playbackSystem(world); r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
				return ctx.getImageData(0, 0, 240, 160).data;
			};
			const fast = render().slice();
			target.add(r.SourceError({ value: '' }));
			const full = render();
			const center = (70 * 240 + 105) * 4;
			return { same: fast.every((value, index) => value === full[index]), visible: fast[center]! > fast[center + 2]! + 80 };
		} finally { document.dispose(); world.destroy(); }
	}, { runtimeUrl, reconcilerUrl });
	assert.equal(result.visible, true);
	assert.equal(result.same, true);
});
