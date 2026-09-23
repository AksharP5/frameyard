import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../../packages/encoder/src/encoder.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node",
  external: ["mediabunny", "koota", "@diffusionstudio/runtime", "./buffer", "./format"],
});

type Phase = "worklet" | "video" | "audio" | "finalize" | "cancel";
function fixture(addAudioSample: () => Promise<void> = async () => {}) {
  const events: string[] = [];
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
    get: (trait: string) => trait === "RenderSurface" ? { canvas: new Canvas() }
      : trait === "FrameRate" ? { value: 30 } : trait === "Time" ? { now: 0 } : undefined,
    set() {}, query: (...traits: string[]) => traits[0] === "Paint" ? [] : [scene],
  };
  const scene = { id: () => 0, get() {}, has: () => false, add() {}, set() {} };
  const traits = ["Computed", "Playback", "AudioPlayback", "FrameRate", "Time", "RenderSurface", "Root", "FramePromises", "Paint",
    "AudioEngine", "AudioBusHandle", "Workarea", "Geometry", "Position", "Offset", "Rotation", "Scale", "Skew"];
  const deps: Record<string, unknown> = {
    "@diffusionstudio/runtime": {
      ...Object.fromEntries(traits.map(name => [name, name])),
      assert, isScene: () => true, setActive() {}, ChildOf: () => "ChildOf",
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
        setMetadataTags() {} addAudioTrack() {} addVideoTrack() {}
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
    audioWorklet = { addModule: () => hooks.worklet() };
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
  const module = { exports: {} as typeof import("../../../packages/encoder/src/encoder") };
  runInNewContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`, {
    HTMLCanvasElement: Canvas, OfflineAudioContext: AudioContext, AudioWorkletNode: Worklet,
    Blob, Error, AggregateError, performance, setTimeout, console: { info() {} },
    URL: { createObjectURL: () => "blob:worklet", revokeObjectURL: () => events.push("url-dispose") },
  })((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected import ${name}`);
    return deps[name];
  }, module, module.exports);
  return {
    events, hooks,
    emitAudio(data: Float32Array) { sink?.port.onmessage?.({ data }); },
    create: (audio = false) => module.exports.createEncoder(world as unknown as Parameters<typeof module.exports.createEncoder>[0], {
      format: "mp4", video: { enabled: !audio }, audio: { enabled: audio },
    }),
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
  assert.ok(f.events.includes("port-dispose"));
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
    assert.ok(f.events.includes("url-dispose"));
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
  await assert.rejects(f.create(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, setupError.message);
    assert.equal(error.cause, setupError);
    assert.deepEqual(error.errors, [setupError, cleanupError]);
    return true;
  });
  assert.ok(f.events.includes("abort"));
  assert.ok(f.events.includes("url-dispose"));
});
