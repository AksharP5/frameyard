import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import type { EditorSession } from "../../web/src/dapi/session";
import type { CodexToolResult } from "../../desktop/src/codex-contracts";

// Exercise the real editor, reconciler and undo history; only project IO and IPC are replaced.
const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld, Computed, Host, Source, FrameRate, Selected } from '@diffusionstudio/runtime';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { addHighlight, updateHighlight } from './highlight';
      export { addPreset, updatePreset } from './presets';
      export { PRESET_CATALOG, parsePresetOptions } from '@diffusionstudio/jsx';
      export { getEditHistory } from './history';
      export { getDocumentEditor } from './editor';
      export { editorToolSchema } from '@desktop/editor-agent-contracts';
      export { setEditorSession } from '@/dapi/session';
      export { setFlushHandler } from '@/projects/edits';
      export { registerAgentTools } from '@/dapi/agent';
      export { handlers, replies } from '@/lib/ipc';
    `,
    resolveDir: fileURLToPath(new URL("../../web/src/engine/", import.meta.url)),
  },
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  bundle: true, write: false, format: "cjs", platform: "node", conditions: ["browser"],
  jsx: "transform", jsxFactory: "clipJsx", logOverride: { "empty-import-meta": "silent" },
  plugins: [{ name: "highlight-boundaries", setup(builder) {
    builder.onResolve({ filter: /^(?:@\/dapi\/session|\.\/session)$/ }, () => ({ path: "session", namespace: "highlight-boundary" }));
    builder.onResolve({ filter: /^@\/projects\/edits$/ }, () => ({ path: "writer", namespace: "highlight-boundary" }));
    builder.onResolve({ filter: /^@\/lib\/ipc$/ }, () => ({ path: "ipc", namespace: "highlight-boundary" }));
    builder.onResolve({ filter: /^\.\/handlers\/(context|capture)$/ }, ({ path, importer }) => {
      if (importer.endsWith("/dapi/agent.ts")) return { path: path.split("/").at(-1)!, namespace: "highlight-boundary" };
    });
    builder.onLoad({ filter: /.*/, namespace: "highlight-boundary" }, ({ path }) => ({ contents: ({
      session: `let current; export function setEditorSession(value){current=value} export function editorSession(){return current} export function requireEditorSession(){if(!current)throw Error('No project open');return current}`,
      writer: `let flush=async()=>{}; export function setFlushHandler(value){flush=value} export function flushProjectEdits(world){return flush(world)}`,
      ipc: `export const handlers=new Map(),replies=[]; export const mainBridge={handle(name,fn){handlers.set(name,fn)},async call(name,value){replies.push(value)}};`,
      context: `export async function getEditorContext(){return {}}`,
      capture: `export function captureSceneFrames(){throw Error('Unexpected capture')}`,
    })[path], loader: "js" }));
  } }],
});

type Runtime = Pick<typeof import("@diffusionstudio/runtime"), "createRuntimeWorld" | "Computed" | "Host" | "Source" | "FrameRate" | "Selected">;
const module = { exports: {} as Runtime
  & Pick<typeof import("@diffusionstudio/reconciler"), "createRuntimeDocument">
  & Pick<typeof import("@diffusionstudio/jsx"), "SOURCE_ATTR">
  & Pick<typeof import("../../web/src/engine/highlight"), "addHighlight" | "updateHighlight">
  & Pick<typeof import("../../web/src/engine/presets"), "addPreset" | "updatePreset">
  & Pick<typeof import("@diffusionstudio/jsx"), "PRESET_CATALOG" | "parsePresetOptions">
  & Pick<typeof import("../../web/src/engine/history"), "getEditHistory">
  & Pick<typeof import("../../web/src/engine/editor"), "getDocumentEditor">
  & Pick<typeof import("../../desktop/src/editor-agent-contracts"), "editorToolSchema">
  & Pick<typeof import("../../web/src/dapi/agent"), "registerAgentTools">
  & {
    setEditorSession(session: EditorSession | null): void;
    setFlushHandler(handler: (world: ReturnType<Runtime["createRuntimeWorld"]>) => Promise<void>): void;
    handlers: Map<string, (request: unknown) => Promise<void>>;
    replies: { id: string; result: CodexToolResult }[];
  }
};
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,clipJsx){"use strict";${built.outputFiles[0].text}\n})`)(
  module, module.exports, Element, Element, Element,
  (component: (props: object) => unknown, props: object) => component(props),
);
const app = module.exports;
const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };

function fixture(fps = 24) {
  const world = app.createRuntimeWorld("highlight-tools");
  world.set(app.FrameRate, { value: fps });
  const document = app.createRuntimeDocument(world);
  let counter = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, app.SOURCE_ATTR, `test.tsx:${++counter}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    node.entity.set(app.Computed, { width: 1920, height: 1080, visibility: 1 });
    return node;
  };
  const scene = add("Scene", { active: true, width: 1920, height: 1080, end: 4 });
  const footage = add("Rect", { start: 0, end: 4 }, scene);
  const history = app.getEditHistory(world);
  const editor = app.getDocumentEditor(world);
  const edits: Parameters<Parameters<typeof editor.onEdit>[0]>[0][] = [];
  editor.onEdit((edit) => edits.push(edit));
  app.setEditorSession({ world, project: { dir: () => "/test-project" } } as EditorSession);
  app.setFlushHandler(async () => {
    const ids = Object.fromEntries(world.query(app.Source)
      .map((node) => node.get(app.Source)!.value)
      .filter((source) => source.startsWith("pending#"))
      .map((source) => [source, `test.tsx:${++counter}`]));
    editor.restamp(ids);
  });
  return { world, add, scene, footage, history, editor, edits, sceneId: scene.entity.get(app.Source)!.value };
}

test("Highlight tool rejects invalid intervals, coordinates and unsupported controls", () => {
  const args = { start: 1, end: 3, region };
  assert.equal(app.editorToolSchema.safeParse({ name: "editor_add_highlight", args }).success, true);
  for (const invalid of [
    { start: -1 }, { start: 3 }, { end: Infinity }, { region: { ...region, width: 0 } },
    { region: { ...region, x: 0.9 } }, { region: [0.1, 0.2, 0.3, 0.25] },
    { destination: [1.1, 0.5] }, { magnification: 0.5 }, { blur: 101 }, { mode: "zoom" },
    { frameRate: 24 }, { sceneSize: { width: 1920, height: 1080 } },
  ]) assert.equal(app.editorToolSchema.safeParse({ name: "editor_add_highlight", args: { ...args, ...invalid } }).success, false);
  assert.equal(app.editorToolSchema.safeParse({ name: "editor_update", args: { id: "highlight", props: { region, mode: "in-place", magnification: 2 } } }).success, true);
});

test("Highlight appends to the referenced scene, saves its source and undoes scene extension in one step", async () => {
  const f = fixture();
  const other = f.add("Scene", { active: true, end: 10 });
  const placed = await app.addHighlight({ sceneId: f.sceneId, sceneSize: { width: 1920, height: 1080 }, frameRate: 24, start: 3.01, end: 6.01, region });
  assert.deepEqual(placed, { source: "test.tsx:4", sceneId: f.sceneId, start: 3, end: 6 });
  assert.equal(f.scene.children.length, 2);
  assert.equal(other.children.length, 0);
  const effect = f.scene.children.at(-1)!;
  assert.equal(effect.tag.toLowerCase(), "highlight");
  assert.deepEqual(effect.props.region, [0.1, 0.2, 0.3, 0.25]);
  assert.equal(effect.props.width, 1920);
  assert.equal(effect.children.length, 0, "the effect does not duplicate source media or its audio");
  assert.equal(f.scene.props.end, 6);
  assert.equal(f.footage.props.end, 4);
  assert.deepEqual([...f.world.query(app.Selected)], [effect.entity]);
  assert.equal(f.edits.filter((edit) => edit.kind === "insert").length, 1);
  f.history.undo();
  assert.equal(f.scene.props.end, 4);
  assert.deepEqual(f.scene.children, [f.footage]);
  assert.equal(f.history.canUndo(), false);
  f.history.redo();
  assert.equal(f.scene.children.length, 2);
  assert.equal(f.scene.props.end, 6);
  f.world.destroy();
});

test("Highlight checks frozen geometry, scene identity and writer readiness before mutation", async () => {
  const f = fixture();
  const args = { sceneId: f.sceneId, start: 1, end: 2, region };
  await assert.rejects(app.addHighlight({ ...args, sceneSize: { width: 1280, height: 720 } }), /scene size changed/);
  await assert.rejects(app.addHighlight({ ...args, frameRate: 30 }), /frame rate changed/);
  await assert.rejects(app.addHighlight({ ...args, sceneId: f.footage.entity.get(app.Source)!.value }), /Select a scene/);
  await assert.rejects(app.addHighlight({ ...args, region: { ...region, x: 1, width: 1e-7 } }), /fit inside the frame/);
  assert.equal(f.edits.length, 0);
  app.setFlushHandler(async () => { throw new Error("disk write failed"); });
  await assert.rejects(app.addHighlight(args), /disk write failed/);
  assert.equal(f.edits.length, 0);
  app.setFlushHandler(async () => { app.setEditorSession(null); });
  await assert.rejects(app.addHighlight(args), /project is no longer open/);
  assert.equal(f.edits.length, 0);
  f.world.destroy();
});

test("Highlight updates remain one editable effect and invalid timing writes nothing", async () => {
  const f = fixture();
  const placed = await app.addHighlight({ start: 1, end: 3, region });
  const effect = f.scene.children.at(-1)!;
  const before = f.edits.length;
  await assert.rejects(app.updateHighlight({ id: placed.source, props: { start: 4, dim: 0.8 } }), /end must be after start/);
  assert.equal(f.edits.length, before);
  const updated = await app.updateHighlight({ id: placed.source, props: { region: { ...region, x: 0.2 }, end: 6, magnification: 2.5, mode: "in-place" } });
  assert.equal(updated.source, placed.source);
  assert.equal(f.scene.children.length, 2);
  assert.equal(effect.props.magnification, 2.5);
  assert.equal(f.scene.props.end, 6);
  f.history.undo();
  assert.equal(effect.props.end, 3);
  assert.equal(effect.props.magnification, undefined);
  assert.deepEqual(effect.props.region, [0.1, 0.2, 0.3, 0.25]);
  assert.equal(f.scene.props.end, 4);
  const narrow = await app.addHighlight({ start: 0.01, end: 0.011, region });
  assert.equal(narrow.start, 0);
  assert.equal(narrow.end, 0.041667, "a short positive interval occupies at least one scene frame");
  f.world.destroy();
});

test("A failed save is reported and the pending Highlight edit can be undone", async () => {
  const f = fixture();
  let flushes = 0;
  app.setFlushHandler(async () => { if (++flushes === 2) throw new Error("source is read-only"); });
  await assert.rejects(app.addHighlight({ start: 2, end: 6, region }), /source is read-only/);
  assert.equal(f.scene.children.length, 2);
  f.history.undo();
  assert.deepEqual(f.scene.children, [f.footage]);
  assert.equal(f.scene.props.end, 4);
  f.world.destroy();
});

test("Editor tool calls route Highlight add and revision through the shared helpers", async () => {
  const f = fixture();
  app.registerAgentTools();
  const call = app.handlers.get("editor:tool")!;
  await call({ id: "add", dir: "/test-project", name: "editor_add_highlight", args: { start: 1, end: 3, region } });
  const result = app.replies.at(-1)!.result;
  assert.equal(result.success, true);
  const item = result.contentItems[0];
  assert.equal(item.type, "inputText");
  if (item.type !== "inputText") throw new Error("Expected Highlight source result");
  const placed = JSON.parse(item.text) as { source: string };
  await call({ id: "update", dir: "/test-project", name: "editor_update", args: { id: placed.source, props: { magnification: 3 } } });
  assert.equal(app.replies.at(-1)!.result.success, true);
  assert.equal(f.scene.children.at(-1)!.props.magnification, 3);
  await call({ id: "wrong", dir: "/other-project", name: "editor_add_highlight", args: { start: 1, end: 3, region } });
  assert.equal(app.replies.at(-1)!.result.success, false);
  assert.equal(f.scene.children.length, 2);
  f.world.destroy();
});


test("Every public preset inserts an editable node and one undo removes it", async () => {
  const f = fixture();
  assert.deepEqual(app.PRESET_CATALOG.map((entry) => entry.id), ["frameyard-pixelate"]);
  for (const definition of app.PRESET_CATALOG) {
    const placed = await app.addPreset({ preset: definition.id, sceneId: f.sceneId, start: 1, end: 3 });
    assert.ok(placed.source.startsWith("test.tsx:"), definition.id);
    const effect = f.scene.children.at(-1)!;
    assert.equal(effect.tag.toLowerCase(), "preset", definition.id);
    assert.equal(effect.props.preset, definition.id);
    assert.deepEqual(effect.props.settings, app.parsePresetOptions({ preset: definition.id }).settings);
    assert.equal(effect.children.length, 0, "preset nodes do not duplicate audio or source clips");
    f.history.undo();
    assert.deepEqual(f.scene.children, [f.footage], definition.id);
    assert.equal(f.history.canUndo(), false);
  }
  f.world.destroy();
});

test("Preset revisions merge settings, snap timing and undo together", async () => {
  const f = fixture();
  const region = [75 / 1920, 90 / 1080, 450 / 1920, 250 / 1080] as [number, number, number, number];
  const placed = await app.addPreset({ preset: "frameyard-pixelate", start: 1.01, end: 3.01, settings: { region, amount: 12 } });
  assert.equal(placed.start, 1);
  const node = f.scene.children.at(-1)!;
  const before = structuredClone(node.props.settings);
  await app.updatePreset({ id: placed.source, settings: { amount: 24 }, end: 6 });
  const updated = app.parsePresetOptions(node.props).settings;
  assert.equal(updated.amount, 24);
  assert.deepEqual(updated.region, region);
  assert.equal(f.scene.props.end, 6);
  assert.equal(f.footage.props.end, 4);
  f.history.undo();
  assert.deepEqual(node.props.settings, before);
  assert.equal(node.props.end, 3);
  assert.equal(f.scene.props.end, 4);
  f.history.redo();
  assert.equal(app.parsePresetOptions(node.props).settings.amount, 24);
  assert.equal(f.scene.props.end, 6);
  f.world.destroy();
});

test("Invalid presets, stale geometry and invalid setting revisions write nothing", async () => {
  const f = fixture();
  const input = { preset: "frameyard-pixelate", sceneId: f.sceneId, start: 1, end: 3 };
  assert.throws(() => app.parsePresetOptions({ preset: null }), /Preset must identify/);
  assert.throws(() => app.parsePresetOptions({ preset: input.preset, settings: null }), /Preset settings/);
  assert.throws(() => app.parsePresetOptions({ preset: input.preset, settings: { region: null } }), /Preset region/);
  assert.throws(() => app.parsePresetOptions({ preset: input.preset, settings: { amount: null } }), /preset amount/);
  assert.throws(() => app.parsePresetOptions({ preset: input.preset, settings: { extra: true } }), /Unknown preset setting/);
  for (const invalid of [
    { preset: "missing" }, { sceneSize: { width: 640, height: 360 } }, { frameRate: 30 },
    { settings: { region: [0.9, 0, 0.4, 0.4] as [number, number, number, number] } },
    { settings: { amount: Infinity } }, { settings: { amount: 1.5 } },
  ]) await assert.rejects(app.addPreset({ ...input, ...invalid }));
  assert.equal(f.edits.length, 0);
  const placed = await app.addPreset(input);
  const count = f.edits.length;
  await assert.rejects(app.updatePreset({ id: placed.source, start: 5, settings: { amount: 50 } }), /end must be after start/);
  await assert.rejects(app.updatePreset({ id: placed.source, settings: { region: [0.9, 0, 0.2, 0.5] } }), /fit inside the frame/);
  assert.equal(f.edits.length, count);
  app.setFlushHandler(async () => { app.setEditorSession(null); });
  await assert.rejects(app.addPreset(input), /project is no longer open/);
  assert.equal(f.edits.length, count);
  f.world.destroy();
});

test("Agent catalog, native preset insertion and revisions use the same controls", async () => {
  const f = fixture();
  app.registerAgentTools();
  const call = app.handlers.get("editor:tool")!;
  await call({ id: "catalog", dir: "/test-project", name: "editor_effects", args: { id: "frameyard-pixelate" } });
  let result = app.replies.at(-1)!.result;
  assert.equal(result.success, true);
  let item = result.contentItems[0];
  assert.equal(item.type, "inputText");
  if (item.type !== "inputText") throw new Error("Expected catalog result");
  assert.equal(JSON.parse(item.text).id, "frameyard-pixelate");
  await call({ id: "add", dir: "/test-project", name: "editor_add_preset", args: { preset: "frameyard-pixelate", start: 1, end: 3 } });
  result = app.replies.at(-1)!.result;
  assert.equal(result.success, true);
  item = result.contentItems[0];
  if (item.type !== "inputText") throw new Error("Expected preset source result");
  const { source } = JSON.parse(item.text) as { source: string };
  const defaults = app.parsePresetOptions(f.scene.children.at(-1)!.props).settings;
  assert.deepEqual(defaults.region, [0.25, 0.25, 0.5, 0.5]);
  await call({ id: "edit", dir: "/test-project", name: "editor_update_preset", args: { id: source, settings: { region: [.6, .6, .2, .2], amount: 32 } } });
  assert.equal(app.replies.at(-1)!.result.success, true);
  assert.deepEqual(app.parsePresetOptions(f.scene.children.at(-1)!.props).settings.region, [.6, .6, .2, .2]);
  assert.equal(f.scene.children.length, 2);
  f.world.destroy();
});
