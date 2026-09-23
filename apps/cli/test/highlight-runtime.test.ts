import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import { HIGHLIGHT_DEFAULTS, highlightProgress, parseHighlightOptions } from "../../../packages/jsx/src/highlight.ts";

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld } from './packages/runtime/src/world/create-world';
      export { cloneFromRecords, serializeEntity } from './packages/runtime/src/world/serialize';
      export { getLocalWindow } from './packages/runtime/src/utils/time';
      export { computeGroupBounds } from './packages/runtime/src/systems/transform';
      export { Computed, Group, Highlight, Preset } from './packages/runtime/src/traits';
      export { RuntimeDocument } from './packages/reconciler/src/document';
    `,
    resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node",
  logOverride: { "empty-import-meta": "silent" },
});
const module = { exports: {} as
  Pick<typeof import("../../../packages/runtime/src/index"), "createRuntimeWorld" | "cloneFromRecords" | "serializeEntity" | "getLocalWindow" | "computeGroupBounds" | "Computed" | "Group" | "Highlight" | "Preset">
  & Pick<typeof import("../../../packages/reconciler/src/document"), "RuntimeDocument">
};
runInThisContext(`(function(module,exports,Element,HTMLCanvasElement,HTMLElement,OffscreenCanvas){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, class Element {}, class HTMLCanvasElement {}, class HTMLElement {}, class OffscreenCanvas {
  width: number; height: number;
  constructor(width: number, height: number) { this.width = width; this.height = height; }
  getContext() {
    return {
      resetTransform() {}, clearRect() {}, drawImage() {}, fillRect() {},
      createLinearGradient() { return { addColorStop() {} }; },
    };
  }
});
const r = module.exports;

test("highlight validates normalized input once and gives each instance independent defaults", () => {
  const first = parseHighlightOptions({});
  const second = parseHighlightOptions({});
  first.region[0] = 0;
  first.destination[0] = 0;
  assert.deepEqual(second, HIGHLIGHT_DEFAULTS);
  assert.notEqual(first.region, second.region);
  assert.deepEqual(parseHighlightOptions({ region: [.7, .2, .30000001, .4] }).region, [.7, .2, 1 - .7, .4]);
  for (const input of [
    { region: [0, 0, 0, .4] }, { region: [.9, .2, .2, .4] },
    { region: [NaN, 0, .2, .2] }, { destination: [2, .5] },
    { magnification: 0 }, { dim: 2 }, { blur: Infinity }, { enter: -1 }, { mode: "other" },
  ]) assert.throws(() => parseHighlightOptions(input), /Highlight/);
});

test("highlight ramps seek independently and fit short clips without overlapping motion", () => {
  assert.equal(highlightProgress(0, 3, .4, .4), 0);
  assert.equal(highlightProgress(.2, 3, .4, .4), .5);
  assert.equal(highlightProgress(1, 3, .4, .4), 1);
  assert.ok(Math.abs(highlightProgress(2.8, 3, .4, .4) - .5) < 1e-12);
  assert.equal(highlightProgress(3, 3, .4, .4), 0);
  assert.equal(highlightProgress(.1, .2, .4, .4), 1);
  assert.equal(highlightProgress(.05, .2, .4, .4), .5);
  assert.equal(highlightProgress(0, 2, 0, 0), 1);
  assert.equal(highlightProgress(1, 3, .4, .4), 1);
});

test("authored highlight retains options and trimmed timing through a capture-world clone", () => {
  const world = r.createRuntimeWorld("highlight-source");
  const capture = r.createRuntimeWorld("highlight-capture");
  try {
    const document = new r.RuntimeDocument(world);
    const scene = document.createElement("Scene");
    document.setProperty(scene, "width", 1280);
    document.setProperty(scene, "height", 720);
    document.insertNode(document.stage, scene);
    const node = document.createElement("Highlight");
    for (const [key, value] of Object.entries({
      region: [.6, .1, .2, .3], destination: [.4, .5], magnification: 2.5,
      blur: 16, mode: "in-place", start: 4, end: 7, sourceIn: 1,
    })) document.setProperty(node, key, value);
    document.insertNode(scene, node);
    r.computeGroupBounds(world, node.entity);
    assert.equal(node.entity.has(r.Group), true);
    assert.equal(node.entity.get(r.Computed)?.width, 1280);
    assert.equal(node.entity.get(r.Computed)?.height, 720);
    assert.equal(node.entity.get(r.Computed)?.start, 120);
    assert.equal(node.entity.get(r.Computed)?.end, 210);
    assert.deepEqual(r.getLocalWindow(node.entity), { in: 30, out: 120 });
    assert.equal(node.entity.get(r.Computed)?.blur, 0, "blur belongs to the background, not the enlarged region");

    const sourceOptions = node.entity.get(r.Highlight)!;
    const records = [r.serializeEntity(scene.entity), r.serializeEntity(node.entity)];
    const copied = r.cloneFromRecords(capture, records).get(node.entity)!;
    assert.ok(copied);
    assert.deepEqual(copied.get(r.Highlight), sourceOptions);
    assert.deepEqual(r.getLocalWindow(copied), { in: 30, out: 120 });
    assert.notEqual(copied.get(r.Highlight)?.region, sourceOptions.region);
    assert.notEqual(copied.get(r.Highlight)?.destination, sourceOptions.destination);
    document.setProperty(node, "magnification", 3);
    assert.equal(copied.get(r.Highlight)?.magnification, 2.5);
    assert.equal(node.entity.get(r.Highlight)?.magnification, 3);
  } finally {
    capture.destroy();
    world.destroy();
  }
});


test("Native preset settings survive cloning and unset undo without sharing arrays", () => {
  const world = r.createRuntimeWorld("preset-source");
  const capture = r.createRuntimeWorld("preset-capture");
  try {
    const document = new r.RuntimeDocument(world);
    const scene = document.createElement("Scene");
    document.setProperty(scene, "width", 1280);
    document.setProperty(scene, "height", 720);
    document.insertNode(document.stage, scene);
    const node = document.createElement("Preset");
    document.setProperty(node, "preset", "frameyard-pixelate");
    document.setProperty(node, "settings", { region: [.1, .2, .3, .4], amount: 24 });
    document.setProperty(node, "start", 4);
    document.setProperty(node, "end", 7);
    document.setProperty(node, "sourceIn", 1);
    document.insertNode(scene, node);
    r.computeGroupBounds(world, node.entity);
    assert.equal(node.entity.get(r.Computed)?.width, 1280);
    const copied = r.cloneFromRecords(capture, [r.serializeEntity(scene.entity), r.serializeEntity(node.entity)]).get(node.entity)!;
    assert.deepEqual(copied.get(r.Preset), node.entity.get(r.Preset));
    assert.notEqual(copied.get(r.Preset)?.settings.region, node.entity.get(r.Preset)?.settings.region);
    assert.deepEqual(r.getLocalWindow(copied), { in: 30, out: 120 });
    document.setProperty(node, "settings", false);
    assert.equal(copied.get(r.Preset)?.settings.amount, 24);
    assert.deepEqual(node.entity.get(r.Preset)?.settings.region, [.25, .25, .5, .5]);
  } finally { capture.destroy(); world.destroy(); }
});
