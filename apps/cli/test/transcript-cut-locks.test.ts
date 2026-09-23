import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld } from '@diffusionstudio/runtime';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from '../../engine/history';
      export { planTranscriptCut, applyTranscriptCut } from './transcript-cut';
    `,
    resolveDir: fileURLToPath(new URL("../../web/src/components/agent/", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node", conditions: ["browser"],
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  logOverride: { "empty-import-meta": "silent" },
});
const module = { exports: {} as Pick<typeof import("@diffusionstudio/runtime"), "createRuntimeWorld">
  & Pick<typeof import("@diffusionstudio/reconciler"), "createRuntimeDocument">
  & Pick<typeof import("@diffusionstudio/jsx"), "SOURCE_ATTR">
  & Pick<typeof import("../../web/src/engine/history"), "getEditHistory">
  & typeof import("../../web/src/components/agent/transcript-cut")
};
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element){${built.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element);
const { createRuntimeWorld, createRuntimeDocument, SOURCE_ATTR, getEditHistory, planTranscriptCut, applyTranscriptCut } = module.exports;

function fixture() {
  const world = createRuntimeWorld("transcript-cut-locks");
  const document = createRuntimeDocument(world);
  let index = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `test.tsx:${++index}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    return node;
  };
  const scene = add("Scene", { active: true, end: 20 });
  const ordinary = add("Audio", { start: 0, end: 6 }, scene);
  return { world, document, add, scene, ordinary, history: getEditHistory(world) };
}

test("locked cut targets fail preflight before any track is changed", () => {
  for (const target of ["move", "split", "remove", "sequence", "descendant", "scene"] as const) {
    const f = fixture();
    try {
      if (target === "scene") f.document.setProperty(f.scene, "locked", true);
      else if (target === "sequence") {
        const sequence = f.add("Sequence", { locked: true }, f.scene);
        f.add("Audio", { start: 12, end: 18 }, sequence);
      } else if (target === "descendant") {
        const group = f.add("Group", { start: 12, end: 18 }, f.scene);
        f.add("Rect", { end: 6, locked: true }, group);
      } else {
        f.add("Audio", { start: target === "split" ? 0 : target === "remove" ? 5 : 12, end: target === "remove" ? 6 : 18, locked: true }, f.scene);
      }
      assert.throws(() => planTranscriptCut(f.world, f.scene.entity, 150, 210), /[Uu]nlock/, target);
      assert.equal(f.ordinary.props.end, 6, target);
      assert.equal(f.scene.props.end, 20, target);
      assert.equal(f.history.canUndo(), false, target);
    } finally { f.world.destroy(); }
  }
});

test("a locked earlier clip does not block cuts to later clips in its sequence", () => {
  const f = fixture();
  try {
    const sequence = f.add("Sequence", {}, f.scene);
    const locked = f.add("Audio", { end: 3, locked: true }, sequence);
    const later = f.add("Audio", { start: 12, end: 18 }, sequence);
    applyTranscriptCut(f.world, planTranscriptCut(f.world, f.scene.entity, 150, 210));
    assert.equal(locked.props.end, 3);
    assert.equal(later.props.start, 10);
    assert.equal(later.props.end, 16);
    assert.equal(f.scene.props.end, 18);
  } finally { f.world.destroy(); }
});
