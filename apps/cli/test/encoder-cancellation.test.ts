import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents: "export {createEncoder} from './encoder'; export {createImageEncoder} from './image-encoder';",
    resolveDir: fileURLToPath(new URL("../../../packages/encoder/src", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node",
  external: ["mediabunny", "koota", "@diffusionstudio/runtime", "./buffer", "./format"],
});

type Phase = "worklet" | "video" | "audio" | "finalize" | "cancel";
function fixture(addAudioSample: () => Promise<void> = async () => {}) {
  const events: string[] = [];
  let framePromises: Array<Promise<unknown>> = [];
  let alive = true;
  let sink: Worklet | undefined;
  const hooks: Record<Phase, () => Promise<void>> = {
    worklet: async () => {}, video: async () => {}, audio: async () => {}, finalize: async () => {}, cancel: async () => {},
  };
  const stores: Record<string, Record<string, number[]>> = {
    Computed: { width: [640], height: [360], end: [1] }, Playback: {}, AudioPlayback: {},
  };
  const getStore = (trait: string) => stores[trait] ??= {};
  class Canvas { width = 0; height = 0; }
  const world = {
    get: (trait: string) => trait === "FramePromises" ? { list: framePromises } : trait === "RenderSurface" ? { canvas: new Canvas() }
      : trait === "FrameRate" ? { value: 30 } : trait === "Time" ? { now: 0 } : undefined,
    set(trait: string, value: { list?: Array<Promise<unknown>> }) {
      assert.equal(alive, true, "a disposed capture must not be changed by late readiness");
      if (trait === "FramePromises") { framePromises = value.list ?? []; events.push("assets-ready"); }
    },
    add(trait: string) { events.push(`add:${trait}`); },
    query: (...traits: string[]) => traits[0] === "Paint" ? [] : [scene],
  };
  const scene = { id: () => 0, get() {}, has: () => false, add() {}, set() {} };
  const traits = ["Computed", "Playback", "AudioPlayback", "FrameRate", "Time", "RenderSurface", "Root", "FramePromises", "Paint",
    "AudioEngine", "AudioBusHandle", "Workarea", "Geometry", "Position", "Offset", "Rotation", "Scale", "Skew", "Silent"];
  const deps: Record<string, unknown> = {
    "@diffusionstudio/runtime": {
      ...Object.fromEntries(traits.map(name => [name, name])),
      assert, isScene: () => true, setActive() {}, ChildOf: () => "ChildOf", framesToSeconds: (frames: number, fps: number) => frames / fps,
      store: (_world: unknown, trait: string) => new Proxy(getStore(trait), {
        get: (target, key: string) => target[key] ??= [0],
      }),
      assetSystem() {}, playbackSystem() {}, motionSystem() {}, transformSystem() {}, renderSystem() {},
      AudioBus: class { connect() {} disconnect() { events.push("bus-dispose"); } },
    },
    koota: { Not: () => "Not" },
    "./buffer": { TargetBuffer: { create: async () => ({
      target: {}, close: async () => { events.push("commit"); }, abort: async () => { events.push("abort"); },
    }) } },
    "./format": { createOutputFormat: async () => ({}) },
    mediabunny: {
      canEncodeVideo: async () => true, canEncodeAudio: async () => true,
      Output: class {
        state = "pending";
        setMetadataTags() {} addAudioTrack() { events.push("audio-track"); } addVideoTrack() {}
        async start() { events.push("start"); this.state = "started"; }
        async cancel() { events.push("cancel"); this.state = "canceled"; await hooks.cancel(); }
        async finalize() { events.push("finalize"); await hooks.finalize(); this.state = "finalized"; }
      },
      AudioSample: class { close() {} },
      AudioSampleSource: class { add = addAudioSample; },
      CanvasSource: class { async add() { events.push("video"); await hooks.video(); } },
    },
  };
  class AudioContext {
    constructor() { events.push("audio-context"); }
    audioWorklet = { addModule: () => { events.push("audio-worklet"); return hooks.worklet(); } };
    destination = {};
    createGain() { return { connect() {}, disconnect() { events.push("gain-dispose"); } }; }
    startRendering() { return hooks.audio(); }
  }
  class Worklet {
    constructor() { sink = this; }
    port = {
      onmessage: undefined as ((event: { data: Float32Array }) => void) | undefined,
      close() { events.push("port-dispose"); },
      postMessage: () => this.port.onmessage?.({ data: new Float32Array(0) }),
    };
    connect() {} disconnect() { events.push("worklet-dispose"); }
  }
  const module = { exports: {} as typeof import("../../../packages/encoder/src/encoder") & typeof import("../../../packages/encoder/src/image-encoder") };
  runInNewContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`, {
    HTMLCanvasElement: Canvas, OfflineAudioContext: AudioContext, AudioWorkletNode: Worklet,
    AbortController, AbortSignal, Blob, Error, AggregateError, performance, setTimeout, console: { info() {} },
    URL: { createObjectURL: () => "blob:worklet", revokeObjectURL: () => events.push("url-dispose") },
  })((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected import ${name}`);
    return deps[name];
  }, module, module.exports);
  return {
    events, hooks,
    awaitAsset(promise: Promise<unknown>) { framePromises.push(promise); },
    disposeWorld() { alive = false; },
    emitAudio(data: Float32Array) { sink?.port.onmessage?.({ data }); },
    create: (audio = false, signal?: AbortSignal, format: "mp4" | "ogg" = "mp4") => module.exports.createEncoder(world as unknown as Parameters<typeof module.exports.createEncoder>[0], {
      format, video: { enabled: !audio }, audio: { enabled: audio },
    }, signal),
    createImage: (signal?: AbortSignal) => module.exports.createImageEncoder(world as unknown as Parameters<typeof module.exports.createImageEncoder>[0], { frames: [0] }, signal),
    pause(phase: Phase) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      hooks[phase] = () => { entered.resolve(); return release.promise; };
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

test("an early audio chunk failure fails the export after later chunks arrive", async () => {
  const error = new Error("Audio encoder failed");
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw error;
  });
  const encoder = await f.create(true);
  f.emitAudio(new Float32Array(256));
  f.emitAudio(new Float32Array(256));
  const result = await encoder.render();
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error, error);
  assert.equal(f.events.includes("commit"), false);
  assert.ok(f.events.includes("abort"));
});

test("canceling before render never starts or commits the output", async () => {
  const f = fixture();
  const encoder = await f.create();
  encoder.cancel();
  assert.equal((await encoder.render()).type, "canceled");
  assert.equal(f.events.includes("start"), false);
  assert.equal(f.events.includes("commit"), false);
  assert.ok(f.events.includes("abort"));
  assert.equal(f.events.includes("audio-context"), false);
});

for (const phase of ["video", "audio", "finalize"] as const) {
  test(`cancellation during the final ${phase} await preserves the destination`, async () => {
    const f = fixture();
    const gate = f.pause(phase);
    const encoder = await f.create(phase === "audio");
    const pending = encoder.render();
    await gate.entered;
    encoder.cancel();
    if (phase !== "audio") gate.release();
    assert.equal((await pending).type, "canceled");
    gate.release();
    assert.equal(f.events.includes("commit"), false);
    assert.ok(f.events.includes("abort"));
    if (phase === "audio") assert.ok(f.events.includes("url-dispose"));
    else assert.equal(f.events.includes("audio-worklet"), false);
  });
}

test("successful finalization commits once, while finalization errors abort", async () => {
  const success = fixture();
  assert.equal((await (await success.create()).render()).type, "success");
  assert.equal(success.events.filter(event => event === "commit").length, 1);
  assert.equal(success.events.includes("abort"), false);
  const failure = fixture();
  const error = new Error("Muxer failed");
  failure.hooks.finalize = async () => { throw error; };
  const result = await (await failure.create()).render();
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error, error);
  assert.equal(failure.events.includes("commit"), false);
  assert.ok(failure.events.includes("abort"));
});

test("setup failure still aborts the file and releases resources if output cleanup also fails", async () => {
  const f = fixture();
  const setupError = new Error("Audio worklet failed");
  const cleanupError = new Error("Output close failed");
  f.hooks.worklet = async () => { throw setupError; };
  f.hooks.cancel = async () => { throw cleanupError; };
  await assert.rejects(f.create(true), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, setupError.message);
    assert.equal(error.cause, setupError);
    assert.deepEqual(error.errors, [setupError, cleanupError]);
    return true;
  });
  assert.ok(f.events.includes("abort"));
  assert.ok(f.events.includes("url-dispose"));
});

test("video-only export skips PCM allocation, audio worklets and audio tracks", async () => {
  const f = fixture();
  assert.equal((await (await f.create()).render()).type, "success");
  assert.ok(f.events.includes("video"));
  assert.ok(f.events.includes("add:Silent"));
  assert.equal(f.events.includes("audio-context"), false);
  assert.equal(f.events.includes("audio-worklet"), false);
  assert.equal(f.events.includes("audio-track"), false);
});

test("Ogg still encodes audio when the supplied video settings disable it", async () => {
  const f = fixture();
  assert.equal((await (await f.create(false, undefined, "ogg")).render()).type, "success");
  assert.ok(f.events.includes("audio-context"));
  assert.ok(f.events.includes("audio-worklet"));
  assert.ok(f.events.includes("audio-track"));
  assert.equal(f.events.includes("video"), false);
  assert.equal(f.events.includes("add:Silent"), false);
});

test("canceling asset warmup does not wait for readiness or mutate a disposed capture", { timeout: 5000 }, async () => {
  const f = fixture();
  const asset = Promise.withResolvers<void>();
  f.awaitAsset(asset.promise);
  const controller = new AbortController();
  const pending = f.create(false, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.events.includes("audio-context"), false);
  assert.equal(f.events.includes("start"), false);
  f.disposeWorld();
  asset.reject(new Error("Late source failure"));
  await new Promise(setImmediate);
  assert.equal(f.events.includes("assets-ready"), false);
});

test("canceling a frame blocked on asset readiness aborts its output immediately", { timeout: 5000 }, async () => {
  const f = fixture();
  const encoder = await f.create();
  const asset = Promise.withResolvers<void>();
  f.awaitAsset(asset.promise);
  const pending = encoder.render();
  await new Promise(setImmediate);
  encoder.cancel();
  assert.equal((await pending).type, "canceled");
  assert.ok(f.events.includes("abort"));
  assert.equal(f.events.includes("commit"), false);
  f.disposeWorld();
  asset.resolve();
  await new Promise(setImmediate);
  assert.equal(f.events.includes("assets-ready"), false);
});

test("canceling image warmup releases its caller before the asset finishes", { timeout: 5000 }, async () => {
  const f = fixture();
  const asset = Promise.withResolvers<void>();
  f.awaitAsset(asset.promise);
  const controller = new AbortController();
  const pending = f.createImage(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  f.disposeWorld();
  asset.resolve();
  await new Promise(setImmediate);
  assert.equal(f.events.includes("assets-ready"), false);
});
