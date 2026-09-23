import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { CodexToolResult } from "../../desktop/src/codex-contracts";
import type { EditorSession } from "../../web/src/dapi/session";

const directory = fileURLToPath(new URL("../../web/src/dapi/", import.meta.url));
const encoder = fileURLToPath(new URL("../../../packages/encoder/src/image-encoder.ts", import.meta.url));
const externals = new Set(["@diffusionstudio/runtime", "@diffusionstudio/reconciler", "@/engine/capture", "@/lib/ipc", "@desktop/main-channels", "@/engine/editor", "@/engine/history", "@/engine/insert-asset", "@/engine/highlight", "@/engine/presets", "@/engine/keyframes", "@/engine/clip-links", "@/projects/edits"]);
const built = await build({
  stdin: { contents: "export {capture, captureSceneFrames} from './handlers/capture'; export {registerAgentTools} from './agent';", resolveDir: directory },
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "capture-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
      if (externals.has(path)) return { path, external: true };
      if (["../lib/nodes", "./lib/nodes", "./nodes"].includes(path)) return { path: "nodes", external: true };
      if (path === "./session" || path === "../session") return { path: "session", external: true };
      if (path === "./handlers/context") return { path: "context", external: true };
      if (path === "@desktop/editor-agent-contracts") return { path: fileURLToPath(new URL("../../desktop/src/editor-agent-contracts.ts", import.meta.url)) };
      if (path === "@desktop/highlight-contracts") return { path: fileURLToPath(new URL("../../desktop/src/highlight-contracts.ts", import.meta.url)) };
      if (path === "./encoder" && importer === encoder) return { path: "encoder-runtime", external: true };
      if (path === "@diffusionstudio/encoder") return { path, namespace: "capture-encoder" };
    });
    builder.onLoad({ filter: /.*/, namespace: "capture-encoder" }, () => ({
      contents: `export {createImageEncoder} from ${JSON.stringify(encoder)}; export const composeSheet=unused, decodePng=unused, planSheet=unused, planSheetSizes=unused, sheetTimecode=unused; function unused(){throw new Error('Unexpected contact sheet')}`,
      resolveDir: directory,
    }));
  } }],
});

function fixture(frameRate = 30, onRender?: () => void) {
  const renderedTimes: number[] = [];
  const replies: CodexToolResult[] = [];
  let disposed = 0;
  let handler: ((request: { id: string; dir: string; name: string; args: object }) => Promise<void>) | undefined;
  class Canvas {
    width = 0; height = 0;
    toBlob(callback: (blob: object) => void) { callback({ arrayBuffer: async () => new Uint8Array([112, 110, 103]).buffer }); }
  }
  class Reader {
    result = "data:image/png;base64,cG5n";
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  }
  class Scene {
    hidden = false;
    workarea: { start: number; end: number } | undefined = { start: 45, end: 180 };
    id() { return 0; }
    get(trait: string) {
      if (trait === "Workarea") return this.workarea;
      if (trait === "Source") return { value: "demo" };
      if (trait === "Computed") return { localTime: 120, end: 180 };
    }
    remove(trait: string) { if (trait === "Workarea") this.workarea = undefined; }
    add(trait: string) { if (trait === "Hidden") this.hidden = true; }
  }
  class World {
    scene = new Scene();
    computed = { width: [1280], height: [720], end: [180], localTime: [0], localTimeInSeconds: [0] };
    playback = { playing: [false], loop: [false], speed: [1] };
    values: Record<string, object> = { FrameRate: { value: frameRate }, Time: { now: 0 }, RenderSurface: { canvas: new Canvas() } };
    get(trait: string) { return this.values[trait]; }
    set(trait: string, value: object) { this.values[trait] = { ...this.values[trait], ...value }; }
    add(trait: string) { this.values[trait] = {}; }
  }
  const world = new World();
  const captures: World[] = [];
  const session = { world, project: { dir: () => "/project" } } as unknown as EditorSession;
  const traits = ["Source", "Workarea", "Hidden", "Muted", "Silent", "Playback", "Computed", "Time", "FrameRate", "RenderSurface", "AudioEngine", "Library"];
  const dependencies: Record<string, unknown> = {
    "@diffusionstudio/runtime": {
      ...Object.fromEntries(traits.map((name) => [name, name])),
      isScene: () => true, getActiveEntity: (current: World) => current.scene, getParentNode: () => null,
      setActive() {}, framesToSeconds: (frames: number, fps: number) => frames / fps,
      formatTimecode: (seconds: number) => String(seconds), assert, getEntityTree: () => [],
      store: (current: World, trait: string) => trait === "Computed" ? current.computed : current.playback,
      assetSystem() {}, playbackSystem() {}, motionSystem() {}, transformSystem() {},
      renderSystem: (current: World) => { renderedTimes.push(current.computed.localTimeInSeconds[0]); onRender?.(); },
    },
    "@/engine/capture": { createCapture: async () => {
      const captured = new World();
      captures.push(captured);
      return { world: captured, node: captured.scene, dispose() { disposed++; } };
    } },
    "encoder-runtime": { captureScene: (current: World) => current.scene, normalizeSceneTransform() {}, resolverSystem: async () => {}, warmupAssets: async () => {} },
    nodes: { resolveNode: (current: World) => current.scene, resolveElement: (current: World) => current.scene },
    "@/lib/ipc": { mainBridge: {
      handle(_channel: string, next: typeof handler) { handler = next; return () => {}; },
      async call(_channel: string, reply: { result: CodexToolResult }) { replies.push(reply.result); },
    } },
    "@desktop/main-channels": { MAIN_CHANNELS: { EDITOR_TOOL: "editor:tool", EDITOR_TOOL_RESULT: "editor:tool-result" } },
    session: { requireEditorSession: () => session, editorSession: () => session },
    context: { getEditorContext: async () => ({}) },
    "@/projects/edits": { flushProjectEdits: async () => {} },
    "@/engine/editor": {}, "@/engine/insert-asset": {}, "@/engine/highlight": {}, "@/engine/presets": {}, "@/engine/keyframes": {}, "@/engine/clip-links": {}, "@/engine/history": {}, "@diffusionstudio/reconciler": {},
  };
  const module = { exports: {} as typeof import("../../web/src/dapi/handlers/capture") & typeof import("../../web/src/dapi/agent") };
  runInNewContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`, {
    HTMLCanvasElement: Canvas, OffscreenCanvas: class {}, OfflineAudioContext: class {}, FileReader: Reader, btoa,
  })((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return { ...module.exports, session, world, captures, renderedTimes, replies, disposed: () => disposed, tool: async (args = {}) => {
    assert.ok(handler);
    await handler({ id: "capture", dir: "/project", name: "editor_capture", args });
  } };
}

test("capture keeps CLI times relative to the workarea and editor references at absolute scene frames", async () => {
  const f = fixture();
  const context = { requireSession: () => f.session, signal: new AbortController().signal } as Parameters<typeof f.capture>[1];
  // Exercise the real image encoder's playhead calculation with the same frame in both modes.
  await f.capture({ id: "demo", times: [2], separate: true }, context);
  await f.captureSceneFrames(f.session, "demo", [60], { sceneTime: true });
  await f.capture({ id: "demo", times: [1, 6], sceneTime: true, separate: true }, context);
  assert.deepEqual(f.renderedTimes, [3.5, 2, 1, 6]);
  assert.deepEqual(f.world.scene.workarea, { start: 45, end: 180 });
  assert.equal(f.disposed(), 3);
});

test("area picking can exclude an effect from its capture without hiding the live node", async () => {
  const f = fixture();
  await f.captureSceneFrames(f.session, "demo", [60], { sceneTime: true, exclude: ["highlight"] });
  assert.equal(f.captures[0].scene.hidden, true);
  assert.equal(f.world.scene.hidden, false);
  assert.equal(f.disposed(), 1);
});

test("capture samples the requested seconds at the project's frame rate", async () => {
  const f = fixture(60);
  const context = { requireSession: () => f.session, signal: new AbortController().signal } as Parameters<typeof f.capture>[1];
  await f.capture({ id: "demo", times: [2], separate: true }, context);
  await f.capture({ id: "demo", times: [2], sceneTime: true, separate: true }, context);
  assert.deepEqual(f.renderedTimes, [2.75, 2]);
  assert.equal(f.disposed(), 2);
});

test("capture cancels remaining frames and disposes its rendering world", async () => {
  const controller = new AbortController();
  const f = fixture(30, () => controller.abort());
  const context = { requireSession: () => f.session, signal: controller.signal } as Parameters<typeof f.capture>[1];
  await assert.rejects(f.capture({ id: "demo", times: [0, 1, 2], sceneTime: true, separate: true }, context), { name: "AbortError" });
  assert.deepEqual(f.renderedTimes, [0]);
  assert.equal(f.disposed(), 1);
  await assert.rejects(f.capture({ id: "demo", separate: true }, context), { name: "AbortError" });
  assert.equal(f.captures.length, 1, "an already canceled call must not create a capture world");
});

test("the agent captures its current nonzero playhead without converting frame indices to seconds", async () => {
  const f = fixture();
  f.registerAgentTools();
  await f.tool();
  assert.deepEqual(f.renderedTimes, [4]);
  assert.equal(f.replies[0].success, true);
  assert.equal(f.replies[0].contentItems[0].type, "inputImage");
  assert.deepEqual(f.world.scene.workarea, { start: 45, end: 180 });
});


test("the agent inspects a requested scene time without moving the playhead or workarea", async () => {
  const f = fixture();
  f.registerAgentTools();
  await f.tool({ sceneId: "demo", time: 2.5 });
  assert.deepEqual(f.renderedTimes, [2.5]);
  assert.equal(f.replies[0].success, true);
  assert.equal(f.world.scene.get("Computed")?.localTime, 120);
  assert.deepEqual(f.world.scene.workarea, { start: 45, end: 180 });
  await f.tool({ sceneId: "demo", time: 6 });
  assert.equal(f.replies[1].success, false);
  assert.deepEqual(f.renderedTimes, [2.5]);
});
