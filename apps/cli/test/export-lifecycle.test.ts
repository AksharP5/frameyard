import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createSignal } from "solid-js";
import { build } from "esbuild";
import type { EncoderConfig } from "@diffusionstudio/encoder";
import type { EditorSession } from "../../web/src/dapi/session";
import type { ToolContext } from "../../web/src/dapi/handler";

const external = new Set([
  "solid-js", "mediabunny", "@diffusionstudio/runtime", "@diffusionstudio/encoder",
  "@/engine/capture", "@/projects/edits", "@/lib/analytics", "@/engine/traits",
  "@/engine/project-config", "@/components/sidebar-right/inspector/export-templates", "@/lib/ipc",
]);
const built = await build({
  stdin: {
    contents: `export {exportScene} from './dapi/handlers/export'; export {renderScene,renderOverlay,cancelRender} from './context/render'; export {ElectronWritableFileHandle} from './lib/electron-file-writable';`,
    resolveDir: fileURLToPath(new URL("../../web/src/", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node",
  supported: { "dynamic-import": false },
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  plugins: [{ name: "export-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => {
      if (external.has(path)) return { path, external: true };
      if (path === "../lib/scene") return { path: "scene", external: true };
    });
  } }],
});

type Phase = "flush" | "capture" | "encoder" | "render";
function fixture(template: Partial<EncoderConfig> = { video: { enabled: false } }, formats = ["mp4"]) {
  const events: string[] = [];
  const writes = new Set<string>();
  let encodedConfig: EncoderConfig | undefined;
  const hooks: Record<Phase, () => Promise<void>> = {
    flush: async () => {}, capture: async () => {}, encoder: async () => {}, render: async () => {},
  };
  const scene = { get: (trait: string) => trait === "Computed" ? { width: 640, height: 360, duration: 30 } : undefined };
  const world = { isInitialized: true, get: (trait: string) => trait === "FrameRate" ? { value: 30 } : undefined };
  const engine = { world, stop: () => events.push("stop"), start: () => { assert.equal(world.isInitialized, true); events.push("start"); } };
  const session = { world, engine, project: { dir: () => "/project" } } as unknown as EditorSession;
  const deps: Record<string, unknown> = {
    "solid-js": { createSignal },
    "@diffusionstudio/runtime": { Computed: "Computed", FrameRate: "FrameRate", Workarea: "Workarea" },
    "@diffusionstudio/encoder": {
      computeOutputSize: () => ({ width: 640, height: 360 }),
      getExportFrameRange: (end: number) => ({ frames: end }),
      createEncoder: async (_world: unknown, config: EncoderConfig) => {
        encodedConfig = config;
        assert.ok(config.target);
        const stream = await config.target.createWritable();
        const writer = stream.getWriter();
        events.push("encoder");
        await hooks.encoder();
        let canceled = false;
        return {
          cancel() { canceled = true; events.push("cancel"); },
          async render() {
            events.push("render");
            await hooks.render();
            if (canceled) { await writer.abort(); return { type: "canceled" }; }
            await writer.close();
            return { type: "success" };
          },
        };
      },
    },
    "@/engine/capture": { createCapture: async () => {
      events.push("capture");
      await hooks.capture();
      return { world: {}, dispose: () => events.push("dispose") };
    } },
    "@/projects/edits": { flushProjectEdits: () => hooks.flush() },
    "@/lib/analytics": { track() {} },
    "@/engine/traits": { ProjectConfig: "ProjectConfig" },
    "@/engine/project-config": { sceneConfigKey: () => "scene" },
    "@/components/sidebar-right/inspector/export-templates": {
      getDefaultExportTemplate: () => template, VIDEO_FORMAT_OPTIONS: formats,
    },
    "@/lib/ipc": { mainBridge: { call: async (channel: string, input: { id?: string }) => {
      if (channel === "file:write-open") { writes.add("write"); events.push("open"); return { id: "write" }; }
      if (channel === "file:write-close" || channel === "file:write-abort") { writes.delete(input.id!); events.push(channel); return; }
      if (channel === "projects:fs-stat") return { size: 100 };
      throw new Error(`Unexpected IPC ${channel}`);
    } } },
    scene: { requireScene: () => scene },
    mediabunny: {
      canEncodeVideo: async () => true,
      Mp4OutputFormat: class {
        getSupportedVideoCodecs() { return ["avc"]; }
        getSupportedAudioCodecs() { return ["aac"]; }
      },
      WebMOutputFormat: class {
        getSupportedVideoCodecs() { return ["vp9"]; }
        getSupportedAudioCodecs() { return ["opus"]; }
      },
      OggOutputFormat: class {
        getSupportedVideoCodecs() { return []; }
        getSupportedAudioCodecs() { return ["opus"]; }
      },
    },
  };
  const module = { exports: {} as typeof import("../../web/src/context/render")
    & typeof import("../../web/src/dapi/handlers/export")
    & typeof import("../../web/src/lib/electron-file-writable") };
  runInNewContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`, {
    AbortController, WritableStream, performance,
    window: { desktop: { platform: "linux" } },
  })((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected import ${name}`);
    return deps[name];
  }, module, module.exports);
  const controller = new AbortController();
  const context = { requireSession: () => session, signal: controller.signal } as ToolContext;
  return {
    ...module.exports, events, writes, world, controller, hooks,
    encodedConfig: () => encodedConfig,
    export: (path = "/project/export.mp4") => module.exports.exportScene({ id: "scene", path }, context),
    render: () => module.exports.renderScene(session.engine, {
      scene: scene as unknown as Parameters<typeof module.exports.renderScene>[1]["scene"],
      target: new module.exports.ElectronWritableFileHandle("/project/export.mp4"), source: "ui",
    }),
    pause(phase: Phase) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      hooks[phase] = () => { entered.resolve(); return release.promise; };
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

test("an already canceled MCP export performs no rendering or file writes", async () => {
  const f = fixture();
  f.controller.abort();
  await assert.rejects(f.export(), { name: "AbortError" });
  assert.deepEqual(f.events, []);
  assert.equal(f.renderOverlay(), null);
});

test("DAPI resolves omitted codecs for WebM and OGG paths", async () => {
  const webm = fixture({ video: { resolution: 720 }, audio: {} }, ["mp4", "webm", "ogg"]);
  const webmResult = await webm.export("/project/export.webm");
  assert.equal(webm.encodedConfig()?.video?.codec, "vp9");
  assert.equal(webm.encodedConfig()?.audio?.codec, "opus");
  assert.equal(webmResult.config.video?.codec, "vp9");
  assert.equal(webmResult.config.audio?.codec, "opus");

  const ogg = fixture({ video: {}, audio: {} }, ["mp4", "webm", "ogg"]);
  const oggResult = await ogg.export("/project/export.ogg");
  assert.equal(ogg.encodedConfig()?.audio?.codec, "opus");
  assert.equal(oggResult.config.audio?.codec, "opus");
});

test("DAPI rejects a Windows path before exporting on Linux", async () => {
  const f = fixture();
  await assert.rejects(f.export("C:\\temp\\export.mp4"), { code: "invalid-input" });
  assert.deepEqual(f.events, []);
});

test("the UI cancel button remains effective while source edits are saving", async () => {
  const f = fixture();
  const gate = f.pause("flush");
  const pending = f.render();
  await gate.entered;
  assert.ok(f.renderOverlay());
  f.cancelRender();
  gate.release();
  assert.equal((await pending).type, "canceled");
  assert.deepEqual(f.events, ["stop", "start"]);
  assert.equal(f.renderOverlay(), null);
});

test("overlapping UI exports cannot replace the active export's cancel control", async () => {
  const f = fixture();
  const gate = f.pause("flush");
  const pending = f.render();
  await gate.entered;
  const overlay = f.renderOverlay();
  await assert.rejects(f.render(), { code: "busy" });
  assert.equal(f.renderOverlay(), overlay);
  assert.deepEqual(f.events, ["stop"]);
  f.cancelRender();
  gate.release();
  assert.equal((await pending).type, "canceled");
  assert.equal(f.renderOverlay(), null);
});

for (const phase of ["capture", "encoder", "render"] as const) {
  test(`MCP cancellation during ${phase} cleans resources and restores the editor`, async () => {
    const f = fixture();
    const gate = f.pause(phase);
    const pending = f.export();
    await gate.entered;
    f.controller.abort();
    gate.release();
    await assert.rejects(pending, { code: "canceled" });
    assert.equal(f.writes.size, 0);
    assert.equal(f.events.filter(event => event === "dispose").length, 1);
    assert.equal(f.events.at(-1), "start");
    assert.equal(f.renderOverlay(), null);
    if (phase === "capture") assert.equal(f.events.includes("encoder"), false);
    else assert.ok(f.events.includes("cancel"));
  });
}

test("encoder setup failures close the partial file and preserve the original error", async () => {
  const f = fixture();
  const error = new Error("Audio worklet failed");
  f.hooks.encoder = async () => { throw error; };
  await assert.rejects(f.export(), value => value === error);
  assert.equal(f.writes.size, 0);
  assert.ok(f.events.includes("file:write-abort"));
  assert.ok(f.events.includes("dispose"));
  assert.ok(f.events.includes("start"));
  assert.equal(f.renderOverlay(), null);
});

test("leaving a project during setup does not restart its disposed engine", async () => {
  const f = fixture();
  const gate = f.pause("flush");
  const pending = f.render();
  await gate.entered;
  f.world.isInitialized = false;
  gate.release();
  assert.equal((await pending).type, "canceled");
  assert.deepEqual(f.events, ["stop"]);
  assert.equal(f.renderOverlay(), null);
});
