import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import { MOTION_BLOCKS, motionBlockTree } from '../../web/src/engine/motion-blocks.ts';
import type { AuthoredTree } from '@diffusionstudio/jsx';

const bundle = await build({
  stdin: {
    contents: `
      export * as runtime from '@diffusionstudio/runtime';
      export { createRuntimeDocument, authoredTree, renderAuthored } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from './history';
      export { getDocumentEditor } from './editor';
    `,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as { runtime: typeof import('@diffusionstudio/runtime') }
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument' | 'authoredTree' | 'renderAuthored'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'> };
class Element {}
class Text {
  data: string;
  constructor(data: string) { this.data = data; }
  remove() {}
}
const dom = { createTextNode: (data: string) => new Text(data) };
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLImageElement,HTMLElement,Element,Text,document){"use strict";${bundle.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element, Element, Text, dom);
const { runtime: api, createRuntimeDocument, authoredTree, renderAuthored, SOURCE_ATTR, getDocumentEditor, getEditHistory } = module.exports;

function descendants(tree: AuthoredTree): AuthoredTree[] {
  return [tree, ...tree.children.flatMap(descendants)];
}

test('motion blocks insert as independently editable native trees and preserve sampled motion through edits and undo', () => {
  for (const block of MOTION_BLOCKS) {
    const world = api.createRuntimeWorld(`motion-block:${block.id}`);
    const document = createRuntimeDocument(world);
    try {
      const scene = document.createElement('Scene');
      document.setProperty(scene, SOURCE_ATTR, 'fixture.tsx:scene');
      document.setProperty(scene, 'width', 1920);
      document.setProperty(scene, 'height', 1080);
      document.insertNode(document.stage, scene);
      const editor = getDocumentEditor(world);
      const history = getEditHistory(world);
      history.beginGesture();
      const [inserted] = editor.insertElement(scene.entity, () => renderAuthored(motionBlockTree(block)));
      history.endGesture();
      assert.ok(inserted, `${block.id} inserts`);
      const tree = authoredTree(world, inserted)!;
      const nodes = descendants(tree);
      const nativeTags = new Set(['group', 'rect', 'ellipse', 'text', 'path', 'solidPaint', 'stroke', 'shadow', 'keyframeTrack', 'keyframe']);
      assert.ok(nodes.every(node => nativeTags.has(node.tag)), `${block.id} contains only native editable objects`);
      assert.ok(nodes.some(node => node.tag === 'text' && node.text), `${block.id} keeps text editable`);
      assert.ok(nodes.some(node => node.tag === 'keyframeTrack'), `${block.id} exposes animation tracks`);
      assert.equal(tree.props.end, block.duration);

      const track = world.query(api.KeyframeTrack).find(node => node.get(api.KeyframeTrack)?.property === (block.id === 'growth-chart' ? 'path.d' : 'rotation.y'))
        ?? world.queryFirst(api.KeyframeTrack)!;
      const target = track.get(api.KeyframeTrack)!.target!;
      const keys = track.get(api.Cache)!.keyframes;
      const last = keys.at(-1)!;
      const path = track.get(api.KeyframeTrack)!.property as keyof ReturnType<typeof api.getPropertyPaths>;
      const sample = () => {
        target.set(api.Computed, { localTime: last.get(api.Keyframe)!.time });
        api.motionSystem(world);
        return api.getPropertyPaths(world)[path].computed[target.id()];
      };
      const original = last.get(api.Keyframe)!;
      const value = path === 'path.d' ? original.stringValue : original.value;
      assert.equal(sample(), value);
      const next = typeof value === 'string' ? 'M 0 0 L 200 200' : value + 5;
      history.beginGesture();
      editor.editProperty(last, 'value', next);
      history.endGesture();
      assert.equal(sample(), next, `${block.id} keyframe edit changes the sample`);
      assert.ok(descendants(authoredTree(world, inserted)!).some(node => node.tag === 'keyframe' && node.props.value === next));
      history.undo();
      assert.equal(sample(), value, `${block.id} undo restores motion`);

      const fresh = motionBlockTree(block);
      tree.props.name = 'Edited instance';
      assert.equal(fresh.props.name, block.title, `${block.id} creates independent instances`);
    } finally {
      document.dispose();
      world.destroy();
    }
  }
});
