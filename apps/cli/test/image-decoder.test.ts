import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { ImageAsset } from '@diffusionstudio/assets';

const built = await build({
  entryPoints: [new URL('../../../packages/runtime/src/media/image.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['../traits', '../actions/assets'],
});

function fixture(kind: 'BitmapImageDecoder' | 'ElementImageDecoder') {
  const file = Promise.withResolvers<File>();
  const started = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<void>();
  let decodes = 0, released = 0, urls = 0;
  const module = { exports: {} as typeof import('../../../packages/runtime/src/media/image.ts') };
  const dependencies = { '../traits': {}, '../actions/assets': { getAssetFile: () => file.promise } };
  runInNewContext(built.outputFiles[0].text, {
    module, require: (name: keyof typeof dependencies) => dependencies[name], console,
    createImageBitmap: async () => {
      decodes++; started.resolve(); await decoded.promise;
      return { width: 1920, height: 1080, close() { released++; } };
    },
    URL: { createObjectURL() { urls++; return 'blob:image'; }, revokeObjectURL() { released++; } },
    Image: class {
      onload?: () => void;
      set src(_value: string) {
        decodes++; started.resolve();
        void decoded.promise.then(() => this.onload?.());
      }
    },
  });
  const asset: ImageAsset = {
    id: 'picture', path: 'picture.png', source: 'assets/picture.png', createdAt: '',
    type: 'IMAGE', mimeType: 'image/png', width: 1920, height: 1080,
    handle: { getFile: () => file.promise },
  };
  return {
    create: () => new module.exports[kind](asset), file, started, decoded,
    counts: () => ({ decodes, released, urls }),
  };
}

test('abandoned image reads never start bitmap or SVG decoding, and reopening still loads the picture', async () => {
  for (const kind of ['BitmapImageDecoder', 'ElementImageDecoder'] as const) {
    const f = fixture(kind);
    const decoder = f.create();
    const loading = decoder.init();
    decoder.dispose();
    f.file.resolve(new File([], 'picture.png'));
    f.decoded.resolve();
    await loading;
    assert.deepEqual(f.counts(), { decodes: 0, released: 0, urls: 0 }, kind);
    assert.equal(decoder.getBitmap(1920, 1080), null);

    const reopened = f.create();
    await reopened.init();
    assert.equal(reopened.ready, true);
    assert.ok(reopened.getBitmap(1920, 1080));
    reopened.dispose();
    assert.deepEqual(f.counts(), { decodes: 1, released: 1, urls: kind === 'ElementImageDecoder' ? 1 : 0 });
  }
});

test('disposing during or after image decoding still releases the opened bitmap or SVG URL once', async () => {
  for (const kind of ['BitmapImageDecoder', 'ElementImageDecoder'] as const) {
    for (const stage of ['decoding', 'ready']) {
      const f = fixture(kind);
      const decoder = f.create();
      const loading = decoder.init();
      f.file.resolve(new File([], 'picture.png'));
      await f.started.promise;
      if (stage === 'decoding') decoder.dispose();
      f.decoded.resolve();
      await loading;
      if (stage === 'ready') assert.equal(decoder.ready, true);
      decoder.dispose();
      assert.equal(decoder.getBitmap(1920, 1080), null);
      assert.deepEqual(f.counts(), { decodes: 1, released: 1, urls: kind === 'ElementImageDecoder' ? 1 : 0 }, `${kind}: ${stage}`);
    }
  }
});
