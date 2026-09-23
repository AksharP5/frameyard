import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build, transform } from "esbuild";
import type { AuthoredTree } from "@diffusionstudio/jsx";
import type { EntityEdit } from "../../web/src/engine/editor";

const built = await build({
  stdin: { contents: `
    export * as runtime from '@diffusionstudio/runtime';
    export { createRuntimeDocument, authoredTree } from '@diffusionstudio/reconciler';
    export { SOURCE_ATTR } from '@diffusionstudio/jsx';
    export { getDocumentEditor } from './apps/web/src/engine/editor';
    export { getEditHistory } from './apps/web/src/engine/history';
    export { insertNativeTree, updateNativeElement, nativeElementTree } from './apps/web/src/dapi/native-authoring';
    export { resolveElement } from './apps/web/src/dapi/lib/nodes';
    export { editorToolSchema } from './apps/desktop/src/editor-agent-contracts';
    export { applyEdits, stampProject } from './apps/desktop/src/edit';
  `, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)) },
  bundle: true, write: false, format: "cjs", platform: "node", conditions: ["browser"],
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  jsx: "transform", jsxFactory: "nativeJsx", external: ["ts-morph"],
  logOverride: { "empty-import-meta": "silent" },
});
type Api = { runtime: typeof import("@diffusionstudio/runtime") }
  & Pick<typeof import("@diffusionstudio/reconciler"), "createRuntimeDocument" | "authoredTree">
  & Pick<typeof import("@diffusionstudio/jsx"), "SOURCE_ATTR">
  & Pick<typeof import("../../web/src/engine/editor"), "getDocumentEditor">
  & Pick<typeof import("../../web/src/engine/history"), "getEditHistory">
  & typeof import("../../web/src/dapi/native-authoring")
  & Pick<typeof import("../../web/src/dapi/lib/nodes"), "resolveElement">
  & Pick<typeof import("../../desktop/src/editor-agent-contracts"), "editorToolSchema">
  & Pick<typeof import("../../desktop/src/edit"), "applyEdits" | "stampProject">;
const module = { exports: {} as Api };
class Element {}
class Text { data: string; constructor(data: string) { this.data = data; } remove() {} }
runInThisContext(`(function(require,module,exports,HTMLCanvasElement,HTMLImageElement,HTMLElement,Element,Text,document,nativeJsx){"use strict";${built.outputFiles[0].text}\n})`)(
  createRequire(import.meta.url), module, module.exports, Element, Element, Element, Element, Text,
  { createTextNode: (text: string) => new Text(text) }, (component: (props: object) => unknown, props: object) => component(props),
);
const { runtime, ...api } = module.exports;

function fixture() {
  const world = runtime.createRuntimeWorld("native-authoring-test");
  const document = api.createRuntimeDocument(world);
  const scene = document.createElement("Scene");
  document.setProperty(scene, api.SOURCE_ATTR, "index.tsx:scene");
  document.setProperty(scene, "width", 640); document.setProperty(scene, "height", 360);
  document.insertNode(document.stage, scene);
  const editor = api.getDocumentEditor(world), history = api.getEditHistory(world);
  return { world, document, scene: scene.entity, editor, history };
}

test("agent native creation and array/path edits survive source save, undo and a fresh mount", async t => {
  const directory = await mkdtemp(join(tmpdir(), "native-authoring-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.tsx"), 'export default () => <scene id="scene" width={640} height={360} />;\n');
  const f = fixture();
  t.after(() => { f.document.dispose(); f.world.destroy(); });
  const edits: EntityEdit[] = [];
  f.editor.onEdit(edit => edits.push(edit));
  const input = api.editorToolSchema.parse({ name: "editor_add", args: { tree: {
    tag: "scene3d", props: { name: "World", width: 640, height: 360, physics: { gravity: [0, 980, 0] }, ambientIntensity: 0.7 }, children: [
      { tag: "mesh", props: { name: "Body", shape: "sphere", width: 80, height: 80, depth: 80, metalness: 0.6, roughness: 0.3, rigidBody: { mass: 2 } } },
      { tag: "path3d", props: { name: "Curve", d: "M 0 0 0 C 10 20 30 40 50 60 70 80 90" }, children: [
        { tag: "keyframeTrack", props: { property: "d" }, children: [{ tag: "keyframe", props: { time: 0, value: "M 0 0 0 C 10 20 30 40 50 60 70 80 90" } }] },
        { tag: "stroke", props: { name: "Outline", color: "#112233", width: 4 } },
      ] },
      { tag: "pointCloud", props: { name: "Points", points: [0, 0, 0, 20, 30, 40], pointColors: [1, 0, 0, 1, 0, 0, 1, 0.5] }, children: [
        { tag: "keyframeTrack", props: { property: "points" }, children: [{ tag: "keyframe", props: { time: 0, value: [0, 0, 0, 20, 30, 40] } }] },
      ] },
      { tag: "light", props: { name: "Key", type: "spot", color: "#ffeedd", intensity: 2, targetX: 300, targetY: 200 } },
      { tag: "volume", props: { name: "Mist", density: 0.4, noiseScale: 2, flowSpeed: 0.1, scatter: 0.8 } },
      { tag: "text", props: { name: "Label" }, text: "Editable text" },
    ],
  } } });
  assert.equal(input.name, "editor_add");
  if (input.name !== "editor_add") return;
  f.history.beginGesture();
  const root = api.insertNativeTree(f.world, f.scene, input.args.tree);
  f.history.endGesture();
  const written = await api.applyEdits({ dir: directory }, edits.filter(edit => edit.kind === "insert"));
  assert.deepEqual(written.skipped, []);
  f.editor.restamp(written.ids ?? {});
  const elements = api.nativeElementTree(f.world, root);
  assert.ok(["scene3d", "mesh", "path3d", "pointCloud", "light", "volume", "text"].every(tag => elements.some(node => node.tag === tag)));
  const point = api.resolveElement(f.world, elements.find(node => node.name === "Points")!.source);
  f.scene.set(runtime.Computed, { localTime: 15 });
  point.set(runtime.Computed, { localTime: 15, visibility: 1 });
  const next = [10, 20, 30, 40, 50, 60];
  const update = api.editorToolSchema.parse({ name: "editor_update", args: { id: point.get(runtime.Source)!.value, props: { points: next, pointSize: 7 } } });
  assert.equal(update.name, "editor_update");
  if (update.name !== "editor_update") return;
  edits.length = 0;
  f.history.beginGesture(); api.updateNativeElement(f.world, point, update.args.props!); f.history.endGesture();
  const track = api.authoredTree(f.world, point)!.children[0];
  assert.equal(track.children.length, 2);
  assert.deepEqual(track.children[1].props.value, next);
  f.history.undo();
  assert.deepEqual(point.get(runtime.SpatialGeometry)?.points, [0, 0, 0, 20, 30, 40]);
  f.history.redo();
  assert.deepEqual(point.get(runtime.SpatialGeometry)?.points, next);

  const curve = api.resolveElement(f.world, elements.find(node => node.name === "Curve")!.source);
  const outline = api.resolveElement(f.world, elements.find(node => node.name === "Outline")!.source);
  const nextPath = "M 10 20 30 C 20 30 40 50 60 70 80 90 100";
  f.history.beginGesture();
  api.updateNativeElement(f.world, curve, { d: nextPath });
  api.updateNativeElement(f.world, outline, { color: "#aabbcc", cap: "round", dash: [4, 2] });
  f.history.endGesture();
  assert.equal(api.authoredTree(f.world, curve)!.children[0].children[1].props.value, nextPath);
  assert.equal(api.authoredTree(f.world, outline)!.props.color, "#aabbcc");
  f.history.undo();
  assert.equal(api.authoredTree(f.world, curve)!.children[0].children.length, 1);
  assert.equal(api.authoredTree(f.world, outline)!.props.color, "#112233");
  f.history.redo();

  const pointTrack = runtime.getEntityChildren(f.world, point).find(node => node.has(runtime.KeyframeTrack))!;
  const pointKey = runtime.getEntityChildren(f.world, pointTrack)[0]!;
  const keyUpdate = api.editorToolSchema.parse({ name: "editor_update", args: { id: pointKey.get(runtime.Source)!.value, props: { time: 0.1, value: [1, 2, 3, 4, 5, 6], easing: "easeInOut" } } });
  assert.equal(keyUpdate.name, "editor_update");
  if (keyUpdate.name !== "editor_update") return;
  f.history.beginGesture(); api.updateNativeElement(f.world, pointKey, keyUpdate.args.props!); f.history.endGesture();
  assert.equal(pointKey.get(runtime.Keyframe)?.time, 3);
  assert.deepEqual(pointKey.get(runtime.Keyframe)?.arrayValue, [1, 2, 3, 4, 5, 6]);

  const sourceEdits = edits.filter(edit => edit.kind === "insert" || edit.kind === "prop" || edit.kind === "remove").map(edit => edit.kind === "prop" ? { kind: "set" as const, source: edit.source, props: { [edit.name]: edit.value } } : edit);
  const saved = await api.applyEdits({ dir: directory }, sourceEdits);
  assert.deepEqual(saved.skipped, []);
  const source = await readFile(join(directory, "index.tsx"), "utf8");
  await api.stampProject({ dir: directory });
  assert.equal(await readFile(join(directory, "index.tsx"), "utf8"), source);
  const compiled = await transform(source, { loader: "tsx", format: "cjs", jsxFactory: "treeJsx" });
  const decoded = { exports: {} as { default: () => AuthoredTree } };
  const treeJsx = (tag: string, props: Record<string, unknown>, ...children: (AuthoredTree | string)[]): AuthoredTree => ({ tag, props, children: children.filter((child): child is AuthoredTree => typeof child !== "string"), ...(children.some(child => typeof child === "string") ? { text: children.filter(child => typeof child === "string").join("") } : {}) });
  runInThisContext(`(function(module,exports,treeJsx){${compiled.code}\n})`)(decoded, decoded.exports, treeJsx);
  const fresh = fixture();
  t.after(() => { fresh.document.dispose(); fresh.world.destroy(); });
  const restored = api.insertNativeTree(fresh.world, fresh.scene, decoded.exports.default().children[0]);
  assert.deepEqual(api.authoredTree(fresh.world, restored), api.authoredTree(f.world, root));
});

test("invalid native input cannot leave partial layers or properties in the live document", () => {
  const f = fixture();
  try {
    const initialCount = f.world.entities.length;
    assert.throws(() => api.insertNativeTree(f.world, f.scene, { tag: "group", props: {}, children: [{ tag: "mesh", props: { roughness: 0.3 }, children: [] }, { tag: "pointCloud", props: { points: [1, 2] }, children: [] }] }), /groups of 3/);
    assert.equal(f.world.entities.length, initialCount);
    const mesh = api.insertNativeTree(f.world, f.scene, { tag: "mesh", props: { x: 4, roughness: 0.3 }, children: [] });
    assert.throws(() => api.updateNativeElement(f.world, mesh, { x: 99, roughness: 2 }), /roughness/);
    assert.equal(api.authoredTree(f.world, mesh)!.props.x, 4);
    assert.throws(() => api.editorToolSchema.parse({ name: "editor_add", args: { tree: { tag: "mesh", props: { __source: "elsewhere.tsx:forged" } } } }), /Source stamps/);
    assert.throws(() => api.editorToolSchema.parse({ name: "editor_update", args: { id: "mesh", props: { metalness: 2 } } }));
  } finally { f.document.dispose(); f.world.destroy(); }
});

test("custom geometry rejects broken indices and color counts before an agent edit", () => {
  const f = fixture();
  try {
    const vertices = [0, 0, 0, 10, 0, 0, 0, 10, 0];
    const before = f.world.entities.length;
    assert.throws(() => api.insertNativeTree(f.world, f.scene, {
      tag: "mesh", props: { shape: "custom", vertices, indices: [0, 1, 999] }, children: [],
    }), /index 999 is outside/);
    assert.equal(f.world.entities.length, before);

    const mesh = api.insertNativeTree(f.world, f.scene, {
      tag: "mesh", props: { shape: "custom", vertices, indices: [0, 1, 2] }, children: [],
    });
    const original = api.authoredTree(f.world, mesh);
    assert.throws(() => api.updateNativeElement(f.world, mesh, { indices: [0, 1, 999] }), /index 999 is outside/);
    assert.deepEqual(api.authoredTree(f.world, mesh), original);

    const expanded = [...vertices, 10, 10, 0];
    api.updateNativeElement(f.world, mesh, { vertices: expanded, indices: [0, 1, 2, 1, 3, 2] });
    assert.deepEqual(api.authoredTree(f.world, mesh)!.props.vertices, expanded);
    assert.deepEqual(api.authoredTree(f.world, mesh)!.props.indices, [0, 1, 2, 1, 3, 2]);

    assert.throws(() => api.insertNativeTree(f.world, f.scene, {
      tag: "pointCloud", props: { points: [0, 0, 0, 10, 0, 0], pointColors: [1, 0, 0, 1] }, children: [],
    }), /one RGBA group per point/);
  } finally { f.document.dispose(); f.world.destroy(); }
});

test("agent edits reject protected content before changes while explicit lock controls remain usable", () => {
  const f = fixture();
  try {
    const text = api.insertNativeTree(f.world, f.scene, { tag: "text", props: { x: 4, locked: true }, text: "Original", children: [] });
    const before = api.authoredTree(f.world, text);
    assert.throws(() => api.updateNativeElement(f.world, text, { hidden: true, x: 99 }, "Changed"), /lock/);
    assert.deepEqual(api.authoredTree(f.world, text), before);
    api.updateNativeElement(f.world, text, { locked: false });
    api.updateNativeElement(f.world, text, { locked: true, x: 99, fontFamily: "serif" }, "Changed");
    const updated = api.authoredTree(f.world, text)!;
    assert.equal(updated.props.x, 99);
    assert.equal(updated.props.fontFamily, "serif");
    assert.equal(updated.props.locked, true);
    assert.equal(updated.text, "Changed");

    const group = api.insertNativeTree(f.world, f.scene, { tag: "group", props: {}, children: [{ tag: "rect", props: { locked: true }, children: [] }] });
    assert.throws(() => api.updateNativeElement(f.world, group, { x: 10 }), /lock/);
    api.updateNativeElement(f.world, text, { hidden: true });
    assert.equal(api.authoredTree(f.world, text)!.props.hidden, true);
  } finally { f.document.dispose(); f.world.destroy(); }
});
