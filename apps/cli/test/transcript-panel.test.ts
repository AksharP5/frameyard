import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import * as solid from "solid-js/dist/solid.js";
import { correctTranscriptWord, parseTranscript, transcriptSentences } from "../../web/src/components/agent/transcript-data.ts";

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld, Computed, Host, FrameRate, Loop, Library, AssetId, Caption, getEntityChildren } from '@diffusionstudio/runtime';
      export * as runtime from '@diffusionstudio/runtime';
      export { createRuntimeDocument, authoredElement } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from '../../engine/history';
      export { getDocumentEditor } from '../../engine/editor';
      export { planTranscriptCut, applyTranscriptCut } from './transcript-cut';
      export { transcriptSceneSignature, transcriptCacheKey, cachedTranscript, saveTranscriptAsset, readTranscriptAsset, transcriptAttachment, sceneTranscriptCaptions, usesSceneTranscriptTiming } from './transcript-document';
    `,
    resolveDir: fileURLToPath(new URL("../../web/src/components/agent/", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node", conditions: ["browser"],
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  logOverride: { "empty-import-meta": "silent" },
});
type Runtime = Pick<typeof import("@diffusionstudio/runtime"), "createRuntimeWorld" | "Computed" | "Host" | "FrameRate" | "Loop" | "Library" | "AssetId" | "Caption" | "getEntityChildren">;
const module = { exports: {} as Runtime
  & { runtime: typeof import("@diffusionstudio/runtime") }
  & Pick<typeof import("@diffusionstudio/reconciler"), "createRuntimeDocument" | "authoredElement">
  & Pick<typeof import("@diffusionstudio/jsx"), "SOURCE_ATTR">
  & Pick<typeof import("../../web/src/engine/history"), "getEditHistory">
  & Pick<typeof import("../../web/src/engine/editor"), "getDocumentEditor">
  & typeof import("../../web/src/components/agent/transcript-cut")
  & typeof import("../../web/src/components/agent/transcript-document")
};
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element);
const { createRuntimeWorld, createRuntimeDocument, Computed, Host, FrameRate, Loop, SOURCE_ATTR, getEditHistory, getDocumentEditor, planTranscriptCut, applyTranscriptCut, transcriptSceneSignature, transcriptCacheKey } = module.exports;

function fixture(fps = 30) {
  const world = createRuntimeWorld("transcript-panel");
  world.set(FrameRate, { value: fps });
  const document = createRuntimeDocument(world);
  let index = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `test.tsx:${++index}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    node.entity.set(Computed, { visibility: 1 });
    return node;
  };
  const scene = add("Scene", { active: true, end: 20, workarea: [3, 15] });
  return { world, add, scene, document, history: getEditHistory(world), editor: getDocumentEditor(world) };
}

test("word corrections preserve recording times and sentence selection spans segment boundaries", () => {
  const transcript = parseTranscript([
    { text: "One wrd", words: [{ text: "One", start: 0, end: 0.4 }, { text: "wrd", start: 0.5, end: 0.8 }] },
    { text: "here. Next!", words: [{ text: "here.", start: 0.9, end: 1.2 }, { text: "Next!", start: 1.3, end: 1.8 }] },
  ]);
  const corrected = correctTranscriptWord(transcript, 1, "word");
  assert.equal(corrected[0].text, "One word");
  assert.deepEqual(corrected[0].words[1], { text: "word", start: 0.5, end: 0.8 });
  assert.equal(transcript[0].words[1].text, "wrd", "the original transcript remains available for undo/checkpoints");
  assert.deepEqual(transcriptSentences(corrected).sentences, [{ first: 0, last: 2 }, { first: 3, last: 3 }]);
  assert.throws(() => parseTranscript([{ text: "bad", words: [{ text: "bad", start: 3, end: 2 }] }]));
  assert.throws(() => correctTranscriptWord(transcript, 1, "  "), /corrected word/);
});

test("transcript cuts ripple every scene track, preserve source speed and keyframes, and undo in one step", () => {
  const f = fixture();
  const track = f.add("Sequence", {}, f.scene);
  const clip = f.add("Audio", { start: 2, end: 14, sourceIn: 4, sourceOut: 28, playbackRate: 2 }, track);
  const keyframes = f.add("KeyframeTrack", { property: "x" }, clip);
  f.add("Keyframe", { time: 4, value: 20 }, keyframes);
  f.add("Keyframe", { time: 20, value: 200 }, keyframes);
  const overlay = f.add("Rect", { start: 4, end: 6, fill: "#ff0000" }, f.scene);
  const after = f.add("Rect", { start: 12, end: 18, sourceIn: 5 }, f.scene);
  const head = f.add("Rect", { start: 6, end: 10, sourceIn: 2 }, f.scene);
  const removed = f.add("Rect", { start: 5.5, end: 6.5 }, f.scene);
  const otherScene = f.add("Scene", { end: 20 });
  const outside = f.add("Rect", { start: 8, end: 12 }, otherScene);
  applyTranscriptCut(f.world, planTranscriptCut(f.world, f.scene.entity, 5 * 30, 7 * 30));
  const copy = track.children[1];
  assert.equal(clip.props.end, 5);
  assert.equal(clip.props.sourceOut, 10);
  assert.equal(copy.props.start, 5);
  assert.equal(copy.props.end, 12);
  assert.equal(copy.props.sourceIn, 14);
  assert.equal(copy.props.sourceOut, 28);
  assert.equal(copy.props.playbackRate, 2);
  assert.deepEqual(copy.children[0].children.map((keyframe) => [keyframe.props.time, keyframe.props.value]), [[4, 20], [20, 200]]);
  assert.equal(overlay.props.end, 5);
  assert.equal(after.props.start, 10);
  assert.equal(after.props.end, 16);
  assert.equal(after.props.sourceIn, 5);
  assert.equal(head.props.start, 5);
  assert.equal(head.props.sourceIn, 3);
  assert.equal(head.props.end, 8);
  assert.equal(removed.entity.isAlive(), false);
  assert.equal(outside.props.start, 8);
  assert.equal(f.scene.props.end, 18);
  assert.deepEqual(f.scene.props.workarea, [3, 13]);
  assert.equal(f.scene.entity.get(Computed)?.localTime, 150);
  f.history.undo();
  assert.equal(f.history.canUndo(), false);
  assert.equal(track.children.length, 1);
  assert.equal(clip.props.end, 14);
  assert.equal(clip.props.sourceOut, 28);
  assert.equal(after.props.start, 12);
  assert.equal(head.props.sourceIn, 2);
  assert.equal(f.scene.props.end, 20);
  assert.deepEqual(f.scene.props.workarea, [3, 15]);
  f.world.destroy();
});

test("unsupported scene slicing fails before any document edit, including unsupported later tracks", () => {
  for (const unsupported of ["group", "nested-scene", "loop", "animation", "sequence-time", "dynamic"] as const) {
    const f = fixture();
    const ordinary = f.add("Rect", { start: 0, end: 10 }, f.scene);
    const node = f.add(unsupported === "group" ? "Group" : unsupported === "nested-scene" ? "Scene" : unsupported === "sequence-time" ? "Sequence" : "Rect", { start: 0, end: 12 }, f.scene);
    if (unsupported === "loop") node.entity.add(Loop({ value: "test.tsx:loop" }));
    if (unsupported === "animation") f.add("Animation", { type: "fade" }, node);
    if (unsupported === "dynamic") node.props.custom = () => 1;
    assert.throws(() => planTranscriptCut(f.world, f.scene.entity, 150, 210), /cut|Cut/);
    assert.equal(ordinary.props.end, 10);
    assert.equal(node.props.end, 12);
    assert.equal(f.history.canUndo(), false);
    f.world.destroy();
  }
});

test("removing a whole sequence does not leave its default duration behind in an implicit scene", () => {
  const f = fixture();
  f.document.setProperty(f.scene, "end", false);
  f.add("Audio", { start: 0, end: 3 }, f.scene);
  const sequence = f.add("Sequence", {}, f.scene);
  f.add("Audio", { start: 3, end: 10 }, sequence);
  applyTranscriptCut(f.world, planTranscriptCut(f.world, f.scene.entity, 3 * 30, 10 * 30));
  assert.equal(sequence.entity.isAlive(), false);
  assert.equal(f.scene.entity.get(Computed)?.duration, 3 * 30);
  f.history.undo();
  assert.equal(f.scene.entity.get(Computed)?.duration, 10 * 30);
  assert.equal(f.history.canUndo(), false);
  f.world.destroy();
});

test("transcript cache survives caption spelling/selection changes and invalidates timeline edits", async () => {
  const f = fixture();
  const clip = f.add("Rect", { start: 0, end: 15 }, f.scene);
  const original = transcriptSceneSignature(f.world, f.scene.entity);
  const key = await transcriptCacheKey(original);
  const captions = f.add("Captions", { fontSize: 44 }, f.scene);
  f.editor.editProperty(clip.entity, "selected", true);
  f.editor.editProperty(captions.entity, "fontSize", 55);
  assert.equal(transcriptSceneSignature(f.world, f.scene.entity), original);
  assert.equal(await transcriptCacheKey(original), key);
  f.editor.editProperty(clip.entity, "sourceIn", 2);
  assert.notEqual(transcriptSceneSignature(f.world, f.scene.entity), original);
  f.world.destroy();
});

test("Undo restores the transcript signature when a cut temporarily pins an implicit clip end", () => {
  const f = fixture();
  f.add("Audio", { start: 0, end: 20 }, f.scene);
  const overlay = f.add("Rect", { start: 4, fill: "#fff" }, f.scene);
  const original = transcriptSceneSignature(f.world, f.scene.entity);
  applyTranscriptCut(f.world, planTranscriptCut(f.world, f.scene.entity, 5 * 30, 7 * 30));
  assert.notEqual(transcriptSceneSignature(f.world, f.scene.entity), original);
  f.history.undo();
  assert.equal(overlay.entity.get(Computed)?.end, 20 * 30);
  assert.equal(transcriptSceneSignature(f.world, f.scene.entity), original);
  f.world.destroy();
});

test("caption transcript targeting respects scene boundaries and accepts timing restored by Undo", () => {
  const f = fixture();
  const { sceneTranscriptCaptions, usesSceneTranscriptTiming } = module.exports;
  const caption = f.add("Captions", {}, f.scene);
  const timed = f.add("Captions", { start: 2 }, f.scene);
  const group = f.add("Group", {}, f.scene);
  const grouped = f.add("Captions", {}, group);
  const nestedScene = f.add("Scene", {}, f.scene);
  f.add("Captions", {}, nestedScene);
  assert.deepEqual(sceneTranscriptCaptions(f.world, f.scene.entity), [caption.entity, timed.entity, grouped.entity]);
  assert.equal(usesSceneTranscriptTiming(f.world, f.scene.entity, caption.entity), true);
  assert.equal(usesSceneTranscriptTiming(f.world, f.scene.entity, timed.entity), false);
  assert.equal(usesSceneTranscriptTiming(f.world, f.scene.entity, grouped.entity), false);
  f.history.beginGesture();
  f.editor.editProperty(caption.entity, "start", 1);
  f.editor.editProperty(caption.entity, "end", 5);
  f.editor.editProperty(caption.entity, "sourceIn", 1);
  f.editor.editProperty(caption.entity, "sourceOut", 5);
  f.editor.editProperty(caption.entity, "playbackRate", 2);
  f.history.endGesture();
  assert.equal(usesSceneTranscriptTiming(f.world, f.scene.entity, caption.entity), false);
  f.history.undo();
  assert.equal(caption.props.start, false);
  assert.equal(usesSceneTranscriptTiming(f.world, f.scene.entity, caption.entity), true);
  f.world.destroy();
});

const panelCode = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/components/agent/transcript-panel.tsx", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "transform", jsxFactory: "jsx", jsxFragment: "Fragment",
  plugins: [{ name: "panel-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === "entry-point" ? undefined : { path, external: true });
  } }],
});

test("regenerated transcript survives selection changes while caption Undo restores the previous transcript", async () => {
  const f = fixture();
  const clip = f.add("Rect", { end: 20 }, f.scene);
  const caption = f.add("Captions", { src: "old.json" }, f.scene);
  const asset = (name: string) => ({
    id: name, path: name, source: `assets/${name}`, type: "TRANSCRIPT", createdAt: "now", generation: { key: "test-key" },
    handle: { getFile: async () => new File([JSON.stringify([{ text: name, words: [{ text: name, start: 0, end: 1 }] }])], name) },
  });
  const old = asset("old.json"), fresh = asset("new.json");
  const library = { get: (id: string) => [fresh, old].find((asset) => asset.id === id), list: () => [fresh, old],
    update: (target: ReturnType<typeof asset>, value: object) => Object.assign(target, value), async settle() {} };
  f.world.set(module.exports.Library, library as unknown as import("@diffusionstudio/assets").AssetLibrary);
  const buttons = new Map<string, () => void>();
  const attached: string[] = [];
  const idle = Promise.withResolvers<void>();
  const dependencies: Record<string, unknown> = {
    "solid-js": solid,
    "@diffusionstudio/koota-solid": { useQuery: () => () => [] },
    "@diffusionstudio/runtime": module.exports.runtime,
    "@diffusionstudio/reconciler": { authoredElement: module.exports.authoredElement },
    "@/dapi/session": { editorSession: () => ({ world: f.world, project: { dir: () => "/project" } }), editorLoadState: () => ({ world: f.world, status: "ready" }) },
    "@/engine/editor": { getDocumentEditor }, "@/engine/history": { getEditHistory },
    "@/engine/clip-links": {}, "@/projects/edits": {}, "@/components/ui/button": { Button: "button" },
    "./full-transcript": { captureFullTranscript: async () => ({ assetPath: fresh.path }) },
    "./transcript-data": { transcriptSentences }, "./transcript-cut": {},
    "./transcript-document": { ...module.exports, transcriptCacheKey: async () => "test-key" },
  };
  const panel = { exports: {} as typeof import("../../web/src/components/agent/transcript-panel") };
  // Capture public button actions while Solid runs the component's actual effects.
  const jsx = (_tag: unknown, props: { onClick?: () => void } | null, ...children: unknown[]) => {
    if (props?.onClick && typeof children[0] === "string") buttons.set(children[0], props.onClick);
  };
  runInThisContext(`(function(require,module,exports,jsx,Fragment){${panelCode.outputFiles[0].text}\n})`)(
    (name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, panel, panel.exports, jsx, undefined,
  );
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const dispose = solid.createRoot((dispose) => {
    panel.exports.TranscriptPanel({ beforeEdit: async () => {}, onBusyChange: (busy) => { if (!busy) idle.resolve(); }, onAttach: (value) => attached.push(value.assetPath) });
    return dispose;
  });
  try {
    await settle();
    buttons.get("Attach to chat")!();
    assert.equal(attached.at(-1), old.path);
    buttons.get("Generate transcript")!();
    await idle.promise;
    await settle();
    buttons.get("Attach to chat")!();
    assert.equal(attached.at(-1), fresh.path);
    f.editor.editProperty(clip.entity, "selected", true);
    await settle();
    buttons.get("Attach to chat")!();
    assert.equal(attached.at(-1), fresh.path);
    f.history.beginGesture();
    f.editor.editProperty(caption.entity, "src", fresh.path);
    f.history.endGesture();
    await settle();
    f.history.undo();
    await settle();
    buttons.get("Attach to chat")!();
    assert.equal(attached.at(-1), old.path);
  } finally { dispose(); f.world.destroy(); }
});
