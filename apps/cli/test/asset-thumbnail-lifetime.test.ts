import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { transformAsync } from '@babel/core';
import { transform } from 'esbuild';
import type { AssetCache } from '@diffusionstudio/assets';
import type { ThumbnailAsset } from '../../web/src/components/ui/asset-thumbnail.tsx';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const path = new URL('../../web/src/components/ui/asset-thumbnail.tsx', import.meta.url);
const jsx = await transformAsync(await readFile(path, 'utf8'), {
  filename: path.pathname, babelrc: false, configFile: false,
  presets: [
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
    ['babel-preset-solid', { generate: 'universal', moduleName: 'test-renderer' }],
  ],
});
assert.ok(jsx?.code);
const compiled = await transform(jsx.code, { format: 'cjs' });

function asset(id: string): ThumbnailAsset {
  return { id, type: 'IMAGE', mimeType: 'image/png', handle: { getFile: async () => new File([], id) } };
}

function fixture() {
  const loads: { id: string; resolve(value: Blob): void }[] = [];
  const files: { resolve(value: File): void }[] = [];
  const urls = new Map<string, Blob>();
  const revoked: string[] = [];
  const images: Record<string, unknown>[] = [];
  let derived = 0;
  let created = 0;
  const cache = { thumbnail(asset: ThumbnailAsset) {
    const result = Promise.withResolvers<Blob>();
    loads.push({ id: asset.id, resolve: result.resolve });
    return result.promise;
  } };
  const renderer = {
    createElement(tag: string) { const props = {}; if (tag === 'img') images.push(props); return props; },
    createTextNode: (value: string) => value,
    setProp(props: Record<string, unknown>, name: string, value: unknown) { props[name] = value; return value; },
    insert() {}, insertNode() {},
    createComponent: solid.createComponent, effect: solid.createRenderEffect,
    memo: solid.createMemo, mergeProps: solid.mergeProps,
  };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid, 'test-renderer': renderer,
    '@/lib/cva': { cx: (...values: string[]) => values.join(' ') },
    '@diffusionstudio/assets': { DEFAULT_THUMBNAIL_WIDTH: 160, deriveThumbnail: async () => { derived++; return new Blob(['derived']); } },
    '@diffusionstudio/runtime': { getAssetFile: () => {
      const result = Promise.withResolvers<File>();
      files.push({ resolve: result.resolve });
      return result.promise;
    } },
  };
  const module = { exports: {} as typeof import('../../web/src/components/ui/asset-thumbnail.tsx') };
  runInNewContext(compiled.code, {
    module, exports: module.exports, require: (name: string) => dependencies[name],
    URL: {
      createObjectURL(blob: Blob) { const url = `blob:${++created}`; urls.set(url, blob); return url; },
      revokeObjectURL(url: string) { urls.delete(url); revoked.push(url); },
    },
  });
  function mount(cached = true) {
    return solid.createRoot(dispose => {
      const [current, setAsset] = solid.createSignal(asset('first.png'));
      module.exports.AssetThumbnail({ get asset() { return current(); }, cache: cached ? cache as unknown as AssetCache : undefined });
      return { dispose, setAsset };
    });
  }
  return { loads, files, urls, revoked, images, mount, created: () => created, derived: () => derived };
}

test('scrolling tiles out of view before thumbnails load does not retain blob URLs', async () => {
  const f = fixture();
  for (let index = 0; index < 25; index++) f.mount().dispose();
  assert.equal(f.loads.length, 25);
  f.loads.forEach(load => load.resolve(new Blob(['thumbnail'])));
  await setImmediate();
  assert.equal(f.created(), 0, 'an unmounted tile must not allocate an image URL');
  assert.equal(f.urls.size, 0);
});

test('an obsolete thumbnail load cannot replace or leak the current image URL', async () => {
  const f = fixture();
  const tile = f.mount();
  tile.setAsset(asset('second.png'));
  const thumbnail = new Blob(['second']);
  f.loads[1].resolve(thumbnail);
  await setImmediate();
  const current = f.images.at(-1)!.src as string;
  assert.equal(f.urls.get(current), thumbnail);
  f.loads[0].resolve(new Blob(['first']));
  await setImmediate();
  assert.equal(f.created(), 1);
  assert.equal(f.images.at(-1)!.src, current);
  assert.equal(f.urls.get(current), thumbnail);
  tile.setAsset(asset('third.png'));
  assert.deepEqual(f.revoked, [current]);
  tile.dispose();
  f.loads[2].resolve(new Blob(['third']));
  await setImmediate();
  assert.equal(f.urls.size, 0);
  assert.equal(f.created(), 1);
});

test('closing an uncached tile while its source loads skips thumbnail decoding', async () => {
  const f = fixture();
  f.mount(false).dispose();
  f.files[0].resolve(new File([], 'source.png'));
  await setImmediate();
  assert.equal(f.derived(), 0);
  assert.equal(f.created(), 0);
});
