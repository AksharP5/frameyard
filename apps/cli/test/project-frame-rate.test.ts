import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: `
    export { parseTime } from '@diffusionstudio/jsx';
    export { createRuntimeWorld, FrameRate, ProjectFrameRate, Computed, Workarea, Markers, Locked, formatTimestamp } from '@diffusionstudio/runtime';
    export { createRuntimeDocument } from '@diffusionstudio/reconciler';
  `, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  logOverride: { 'empty-import-meta': 'silent' },
});
type API = Pick<typeof import('@diffusionstudio/jsx'), 'parseTime'>
  & Pick<typeof import('@diffusionstudio/runtime'), 'createRuntimeWorld' | 'FrameRate' | 'ProjectFrameRate' | 'Computed' | 'Workarea' | 'Markers' | 'Locked' | 'formatTimestamp'>
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument'>;
const module = { exports: {} as API };
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element);
const api = module.exports;

test('frame strings and non-drop timecode follow the project rate without losing individual frames', () => {
  assert.equal(api.parseTime('60f', 60), 1);
  assert.equal(api.parseTime('60f', 30), 2);
  for (const fps of [24, 25, 30, 60, 24000 / 1001, 60000 / 1001]) {
    for (const frame of [0, 1, 59, 60, 3599, 216_216, -17]) {
      const timecode = api.formatTimestamp(frame / fps, fps);
      assert.equal(Math.round(api.parseTime(timecode, fps)! * fps), frame);
    }
  }
  for (const invalid of ['00:00:00:60', '00:60:00:00', '00::12', '3garbage']) assert.equal(api.parseTime(invalid, 60), undefined);
  assert.equal(api.parseTime('1f', 0), undefined);
});

test('export rate changes sampling while authored frame units and markers retain project timing', () => {
  for (const fps of [30, 60]) {
    const world = api.createRuntimeWorld(`fps-${fps}`);
    try {
      world.set(api.FrameRate, { value: fps });
      world.set(api.ProjectFrameRate, { value: 60 });
      const document = api.createRuntimeDocument(world);
      const scene = document.createElement('Scene');
      document.setProperty(scene, 'end', '180f');
      document.setProperty(scene, 'workarea', ['30f', '150f']);
      document.setProperty(scene, 'markers', [{ id: 'beat', name: 'Beat', time: '60f' }]);
      document.insertNode(document.stage, scene);
      const clip = document.createElement('Rect');
      document.setProperty(clip, 'start', '60f');
      document.setProperty(clip, 'end', '120f');
      document.setProperty(clip, 'locked', true);
      document.insertNode(scene, clip);
      assert.equal(clip.entity.get(api.Computed)?.start, fps);
      assert.equal(clip.entity.get(api.Computed)?.end, 2 * fps);
      assert.deepEqual(scene.entity.get(api.Workarea), { start: fps / 2, end: 2.5 * fps });
      assert.deepEqual(scene.entity.get(api.Markers)?.value, [{ id: 'beat', name: 'Beat', time: fps }]);
      assert.ok(clip.entity.has(api.Locked));
      assert.throws(() => document.setProperty(scene, 'markers', [{ id: 'beat', name: 'Bad', time: -1 }]), /nonnegative/);
    } finally { world.destroy(); }
  }
});
