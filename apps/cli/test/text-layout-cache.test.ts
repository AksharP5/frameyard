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

test('text layout reuses stable measurements and refreshes after edits or font loading', { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
	const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve('puppeteer-core'));
	const browser = await puppeteer.launch({ headless: true, executablePath: chromium, args: ['--no-sandbox'] });
	t.after(() => browser.close());
	const page = await browser.newPage();
	await page.goto(new URL('/@vite/client', vite).href);
	await page.setContent('<!doctype html><body></body>');
	const runtimeUrl = new URL(`/@fs${fileURLToPath(new URL('../../../packages/runtime/src/index.ts', import.meta.url))}`, vite).href;
	const result = await page.evaluate(async (runtimeUrl: string) => {
		const r = await import(runtimeUrl) as typeof import('../../../packages/runtime/src/index.ts');
		const original = OffscreenCanvasRenderingContext2D.prototype.measureText;
		let measurements = 0;
		OffscreenCanvasRenderingContext2D.prototype.measureText = function (...args) {
			measurements++;
			return original.apply(this, args);
		};
		const world = r.createRuntimeWorld('text-layout-cache');
		try {
			const text = world.spawn(r.Geometry, r.Computed({ chars: 'Frameyard' }), r.TextStyle({ fontSize: 20 }), r.Cache);
			const sample = () => {
				r.layoutText(world, text);
				return { measurements, width: text.get(r.Computed)!.width };
			};
			const first = sample();
			const stable = sample();
			text.set(r.Computed, { chars: 'FrameyardFrameyard' });
			const characters = sample();
			text.set(r.TextStyle, { fontSize: 30 });
			const style = sample();
			text.add(r.Size({ width: 80, height: 60 }));
			const sized = sample();
			text.set(r.Size, { width: 160 });
			const resized = sample();
			document.fonts.dispatchEvent(new Event('loadingdone'));
			const fontLoaded = sample();
			const range = world.spawn(r.TextRange({ start: 0, end: 10 }), r.TextStyle({ fontWeight: '700' }));
			text.set(r.Cache, { textRanges: [range] });
			const rangeFirst = sample();
			const rangeAgain = sample();
			return { first, stable, characters, style, sized, resized, fontLoaded, rangeFirst, rangeAgain };
		} finally {
			world.destroy();
			OffscreenCanvasRenderingContext2D.prototype.measureText = original;
		}
	}, runtimeUrl);
	assert.equal(result.first.measurements, 1);
	assert.equal(result.stable.measurements, result.first.measurements, 'unchanged text does not remeasure');
	assert.ok(result.characters.width > result.first.width);
	assert.equal(result.characters.measurements, result.stable.measurements + 1);
	assert.equal(result.style.measurements, result.characters.measurements + 1);
	assert.equal(result.sized.measurements, result.style.measurements + 1);
	assert.equal(result.resized.measurements, result.sized.measurements + 1);
	assert.equal(result.fontLoaded.measurements, result.resized.measurements + 1);
	assert.ok(result.rangeFirst.measurements > result.fontLoaded.measurements);
	assert.ok(result.rangeAgain.measurements > result.rangeFirst.measurements, 'styled ranges still measure on each call');
});
