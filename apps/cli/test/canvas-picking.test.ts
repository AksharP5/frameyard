import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { HitRegion } from '@diffusionstudio/runtime';

const code = buildSync({
  stdin: { contents: `export {createWorld} from 'koota';
    export {Geometry, Group, Sequential, ChildOf, Computed, WorldBounds, WorldTransform, Selected, Hidden, Locked, IsMask, Interactive, getMaskSelection, enterEntity} from '@diffusionstudio/runtime';
    export {pickCanvasRegion} from './picking';`,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/input/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', logOverride: {'empty-import-meta': 'silent'},
}).outputFiles[0].text;
type API = typeof import('../../web/src/engine/input/picking') & typeof import('@diffusionstudio/runtime') & Pick<typeof import('koota'), 'createWorld'>;
const module = {exports: {} as API};
runInThisContext(`(function(module,exports){"use strict";${code}\n})`)(module, module.exports);
const api = module.exports;

function fixture() {
  const world = api.createWorld();
  const item = (parent?: import('koota').Entity, group = false) => world.spawn(
    group ? api.Group : api.Geometry,
    api.Computed({width: 100, height: 100, visibility: 1}),
    api.WorldBounds({minX: 0, minY: 0, maxX: 100, maxY: 100}),
    api.WorldTransform({a: 1, d: 1}),
    ...(parent ? [api.ChildOf(parent)] : []),
  );
  const region = (id: import('koota').Entity): HitRegion => ({target: {kind: 'entity', id}});
  const pick = (regions: HitRegion[], cycle = false) => api.pickCanvasRegion(world, regions, {type: 'pointerdown', clientX: 50, clientY: 50, button: 0}, cycle)?.target;
  return {world, item, region, pick};
}

test('ordinary clicks retain paint order; Alt-click cycles every overlapping entity through selection HUD', () => {
  const f = fixture();
  const image = f.item();
  const text = f.item();
  const overlay = f.item();
  const regions = [image, text, overlay].map(f.region);
  assert.deepEqual(f.pick(regions), {kind: 'entity', id: overlay});
  overlay.add(api.Selected);
  regions.push({target: {kind: 'hud', id: 'selection', quad: [{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}]}});
  assert.deepEqual(f.pick(regions, true), {kind: 'entity', id: text});
  overlay.remove(api.Selected); text.add(api.Selected);
  assert.deepEqual(f.pick(regions, true), {kind: 'entity', id: image});
  text.remove(api.Selected); image.add(api.Selected);
  assert.deepEqual(f.pick(regions, true), {kind: 'entity', id: overlay});
  assert.equal(f.pick(regions)?.kind, 'hud');
  const handle: HitRegion = {target: {kind: 'hud', id: 'resize-right', quad: [{x: 45, y: 45}, {x: 55, y: 45}, {x: 55, y: 55}, {x: 45, y: 55}]}};
  assert.deepEqual(f.pick([...regions, handle], true), handle.target, 'Alt-resize still belongs to the handle');
  f.world.destroy();
});

test('hidden, locked, out-of-time and inherited hidden or locked items never intercept canvas selection', () => {
  const f = fixture();
  const visible = f.item();
  const hidden = f.item(); hidden.add(api.Hidden);
  const locked = f.item(); locked.add(api.Locked);
  const expired = f.item(); expired.set(api.Computed, {visibility: 0});
  const parent = f.item(undefined, true); parent.add(api.Locked);
  const child = f.item(parent);
  const regions = [visible, hidden, locked, expired, child].map(f.region);
  assert.deepEqual(f.pick(regions), {kind: 'entity', id: visible});
  assert.deepEqual(f.pick(regions, true), {kind: 'entity', id: visible});
  parent.remove(api.Locked); parent.add(api.Hidden);
  assert.deepEqual(f.pick(regions), {kind: 'entity', id: visible});
  hidden.add(api.Selected); locked.add(api.Selected);
  assert.deepEqual(api.getMaskSelection(f.world), []);
  f.world.destroy();
});

test('a selected mask gets canvas handles without intercepting clicks or exposing masked children', () => {
  const f = fixture();
  const owner = f.item(undefined, true);
  const mask = f.item(owner); mask.add(api.IsMask, api.Selected);
  const child = f.item(mask);
  assert.deepEqual(api.getMaskSelection(f.world), [mask]);
  assert.equal(f.pick([f.region(mask)]), undefined);
  assert.equal(f.pick([f.region(child)]), undefined);
  child.add(api.Selected);
  assert.deepEqual(api.getMaskSelection(f.world), [mask]);
  mask.add(api.Locked);
  assert.deepEqual(api.getMaskSelection(f.world), []);
  f.world.destroy();
});

test('Alt-click and double-click reach children through nested sequence containers', () => {
  const f = fixture();
  const group = f.item(undefined, true);
  const sequence = f.item(group, true); sequence.add(api.Sequential);
  const child = f.item(sequence);
  group.add(api.Selected);
  assert.deepEqual(f.pick([f.region(group)], true), {kind: 'entity', id: child});
  assert.equal(api.enterEntity(f.world, group, {x: 50, y: 50}), child);
  assert.equal(child.has(api.Interactive), true);
  assert.equal(sequence.has(api.Interactive), false);
  f.world.destroy();
});
