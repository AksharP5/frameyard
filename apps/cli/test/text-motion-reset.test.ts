import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { Asset } from '@diffusionstudio/assets';

const bundle = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld } from './world/create-world';
      export { Geometry, Caption, Computed, Cache, Chars, TextStyle, TextCache, Blur, Animation, ChildOf } from './traits';
      export { AnimationType } from './constants';
      export { motionSystem } from './systems/motion';
      export { layoutText } from './utils/text';
      export { WhisperCaptionDecoder } from './media/caption/whisper';
    `,
    resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  Pick<typeof import('../../../packages/runtime/src/world/create-world'), 'createRuntimeWorld'>
  & Pick<typeof import('../../../packages/runtime/src/traits'), 'Geometry' | 'Caption' | 'Computed' | 'Cache' | 'Chars' | 'TextStyle' | 'TextCache' | 'Blur' | 'Animation' | 'ChildOf'>
  & Pick<typeof import('../../../packages/runtime/src/constants'), 'AnimationType'>
  & Pick<typeof import('../../../packages/runtime/src/systems/motion'), 'motionSystem'>
  & Pick<typeof import('../../../packages/runtime/src/utils/text'), 'layoutText'>
  & Pick<typeof import('../../../packages/runtime/src/media/caption/whisper'), 'WhisperCaptionDecoder'>
};
class MeasureCanvas {
  getContext() {
    return { measureText: (text: string) => ({ width: text.length, fontBoundingBoxAscent: 1, fontBoundingBoxDescent: 0 }) };
  }
}
runInThisContext(`(function(module,exports,OffscreenCanvas){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports, MeasureCanvas);
const { createRuntimeWorld, Geometry, Caption, Computed, Cache, Chars, TextStyle, TextCache, Blur, Animation, ChildOf, AnimationType, motionSystem, layoutText, WhisperCaptionDecoder } = module.exports;

function fixture() {
  const world = createRuntimeWorld('text-motion-reset');
  const text = world.spawn(Geometry, Computed({ visibility: 1, start: 0, end: 90, duration: 90, origin: 0 }), Cache, Chars({ value: 'Frameyard' }), TextStyle, Blur);
  const displayed = () => {
    layoutText(world, text);
    return text.get(TextCache)!.tokens.flat().map(token => token.chars).join('');
  };
  return { world, text, displayed };
}

test('removing a style does not pin later static text edits', () => {
  const f = fixture();
  try {
    f.text.remove(Blur);
    assert.equal(f.displayed(), 'Frameyard');
    f.text.set(Chars, { value: 'Edited title' });
    motionSystem(f.world);
    assert.equal(f.displayed(), 'Edited title');
  } finally { f.world.destroy(); }
});

test('caption playback still updates text after an authored style reset', async () => {
  const f = fixture();
  const transcript: Asset = {
    type: 'TRANSCRIPT', id: 'text-reset', path: 'captions.json', source: 'captions.json',
    mimeType: 'application/json', createdAt: 'now',
    handle: { getFile: async () => new File([JSON.stringify([
      { text: 'First', words: [{ text: 'First', start: 0, end: 0.9 }] },
      { text: 'Second', words: [{ text: 'Second', start: 1, end: 1.9 }] },
    ])], 'captions.json') },
  };
  const decoder = new WhisperCaptionDecoder(transcript);
  try {
    f.text.add(Caption);
    f.text.remove(Blur);
    await decoder.initialized;
    decoder.seekTo(f.world, f.text, 0.3);
    motionSystem(f.world);
    assert.equal(f.displayed(), 'First');
    decoder.seekTo(f.world, f.text, 1.3);
    motionSystem(f.world);
    assert.equal(f.displayed(), 'Second');
  } finally {
    decoder.dispose();
    f.world.destroy();
  }
});

test('text presets release overrides after completion, retiming and removal', () => {
  const f = fixture();
  try {
    const animation = f.world.spawn(Animation({ type: AnimationType.APPEAR_CHAR, duration: 5 }), ChildOf(f.text));
    const sample = (frame: number) => {
      f.text.set(Computed, { localTime: frame });
      motionSystem(f.world);
      return f.displayed();
    };
    assert.equal(sample(0), '', 'an intentional empty override hides authored text');
    assert.equal(sample(2), 'Fram');
    assert.equal(sample(5), 'Frameyard');
    f.text.set(Chars, { value: 'Edited' });
    assert.equal(sample(5), 'Edited');
    assert.equal(sample(2), 'Edi', 'backward seeking resamples the edited text');
    animation.set(Animation, { duration: 0 });
    assert.equal(sample(2), 'Edited', 'a disabled preset does not leave a partial reveal');
    animation.set(Animation, { duration: 5 });
    assert.equal(sample(0), '');
    animation.destroy();
    f.text.set(Chars, { value: 'Final title' });
    assert.equal(sample(0), 'Final title');
  } finally { f.world.destroy(); }
});
