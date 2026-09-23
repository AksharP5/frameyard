import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformAsync } from '@babel/core';
import { transform } from 'esbuild';
import type { SequenceAsset } from '../../../packages/assets/src/types.ts';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const path = new URL('../../web/src/components/agent/sequence-preview.tsx', import.meta.url);
const jsx = await transformAsync(await readFile(path, 'utf8'), {
  filename: path.pathname, babelrc: false, configFile: false,
  presets: [
    ['@babel/preset-typescript', { isTSX: true, allExtensions: true }],
    ['babel-preset-solid', { generate: 'universal', moduleName: 'test-renderer' }],
  ],
});
assert.ok(jsx?.code);
const compiled = await transform(jsx.code, { format: 'cjs' });

function fixture() {
  const displayed: number[] = [];
  const requested: number[] = [];
  const decodes: { frame: number; resolve(): void }[] = [];
  const frames = new Map<number, (time: number) => void>();
  const buttons: Record<string, unknown>[] = [];
  const elements: { tag: string; props: Record<string, unknown> }[] = [];
  const errors: unknown[] = [];
  let now = 0;
  let frameId = 0;
  let decoderDisposed = false;
  class Decoder {
    initialized = Promise.resolve();
    errored = false;
    current = 0;
    async seekTo(frame: number) {
      requested.push(frame);
      const done = Promise.withResolvers<void>();
      decodes.push({ frame, resolve: done.resolve });
      await done.promise;
      this.current = frame;
    }
    toBitmap() { return { frame: this.current }; }
    dispose() { decoderDisposed = true; }
  }
  const renderer = {
    createElement(tag: string) {
      const element = { tag, props: {}, width: 2, height: 2, getContext: () => ({
        clearRect() {}, drawImage(bitmap: { frame: number }) { displayed.push(bitmap.frame); },
      }) };
      elements.push(element);
      return element;
    },
    setProp(element: { props: Record<string, unknown> }, name: string, value: unknown) { element.props[name] = value; return value; },
    createTextNode: (value: string) => value,
    insertNode() {}, insert() {},
    createComponent: solid.createComponent,
    effect: solid.createRenderEffect,
  };
  const dependencies: Record<string, unknown> = {
    'solid-js': solid, 'test-renderer': renderer,
    '@diffusionstudio/runtime': { SequenceDecoder: Decoder },
    '@/components/ui/button': { Button: (props: Record<string, unknown>) => { buttons.push(props); return undefined; } },
  };
  const module = { exports: {} as typeof import('../../web/src/components/agent/sequence-preview.tsx') };
  runInNewContext(compiled.code, {
    module, exports: module.exports, require: (name: string) => dependencies[name],
    performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const asset: SequenceAsset = {
    id: 'overlay', path: 'overlay.frames', source: 'assets/overlay.frames', createdAt: '', mimeType: 'image/png',
    type: 'SEQUENCE', width: 2, height: 2, duration: 2, frameRate: 60,
    handle: { getFile: async () => new File(['frame'], 'frame000001.png') },
    directoryHandle: { async *entries() {} },
  };
  const [active, setActive] = solid.createSignal(true);
  const dispose = solid.createRoot((dispose) => {
    module.exports.SequencePreview({ asset, get active() { return active(); }, onError: (error) => errors.push(error) });
    return dispose;
  });
  return {
    displayed, requested, errors, setActive, dispose,
    disposed: () => decoderDisposed,
    pending: () => frames.size,
    toggle() { const click = buttons[0].onClick; assert.ok(typeof click === 'function'); click(); },
    scrub(frame: number) {
      const input = elements.find((element) => element.tag === 'input')?.props.onInput;
      assert.ok(typeof input === 'function'); input({ currentTarget: { value: String(frame) } });
    },
    async tick(time: number) {
      now = time;
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback(time);
      await setImmediate();
    },
    async finish() {
      const decode = decodes.shift(); assert.ok(decode, 'a frame decode should be pending');
      decode.resolve(); await setImmediate();
      return decode.frame;
    },
  };
}

test('slow sequence decoding keeps presenting frames and discards stale scrub or hidden work', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  await setImmediate();
  await f.finish();
  f.toggle();
  await f.tick(17);
  await f.tick(34);
  await f.tick(51);
  await f.finish();
  assert.deepEqual(f.displayed, [0, 1], 'a completed frame must display even when playback has advanced');
  assert.deepEqual(f.requested, [0, 1, 3], 'decode only the latest queued target after the current frame finishes');

  await f.tick(68);
  await f.tick(85);
  await f.finish();
  assert.deepEqual(f.displayed, [0, 1, 3], 'playback must continue presenting slow frames before reaching the end');
  f.scrub(80);
  await f.finish();
  assert.deepEqual(f.displayed, [0, 1, 3], 'scrubbing must discard the previous in-flight frame');
  await f.finish();
  assert.equal(f.displayed.at(-1), 80);
  assert.equal(f.pending(), 0, 'scrubbing pauses playback');

  f.toggle();
  await f.tick(102);
  f.toggle();
  const beforePause = f.displayed.length;
  await f.finish();
  assert.equal(f.displayed.length, beforePause, 'pausing must keep the last presented frame');
  assert.equal(f.pending(), 0);

  f.toggle();
  await f.tick(119);
  f.setActive(false);
  const beforeHide = f.displayed.length;
  await f.finish();
  assert.equal(f.displayed.length, beforeHide, 'a hidden preview must not display an in-flight frame');
  assert.equal(f.pending(), 0);
  const beforeHiddenTick = f.requested.length;
  await f.tick(500);
  assert.equal(f.requested.length, beforeHiddenTick, 'hidden previews stop scheduling decode work');
  f.setActive(true);
  await setImmediate();
  f.dispose();
  await f.finish();
  assert.equal(f.displayed.length, beforeHide, 'disposing must suppress a pending decode result');
  assert.equal(f.disposed(), true);
  assert.deepEqual(f.errors, []);
});
