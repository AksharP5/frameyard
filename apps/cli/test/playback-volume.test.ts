import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents: `
      export { createWorld } from 'koota';
      export { AudioEngine, Computed, Volume, Playback, Workarea, FrameRate, AudioPlayback, AudioBusHandle, AudioDecoderHandle, AssetId, Audio, Group, Geometry, ChildOf, Root, Mode, Time, Soloed, Muted, Hidden } from './traits';
      export { resolveAudioBus, playbackSystem } from './systems/playback';
      export { setPlayhead, togglePlayback } from './actions/playback';
    `,
    resolveDir: fileURLToPath(new URL("../../../packages/runtime/src/", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node",
  logOverride: { "empty-import-meta": "silent" },
});
const module = { exports: {} as
  Pick<typeof import("koota"), "createWorld">
  & Pick<typeof import("../../../packages/runtime/src/traits"), "AudioEngine" | "Computed" | "Volume" | "Playback" | "Workarea" | "FrameRate" | "AudioPlayback" | "AudioBusHandle" | "AudioDecoderHandle" | "AssetId" | "Audio" | "Group" | "Geometry" | "ChildOf" | "Root" | "Mode" | "Time" | "Soloed" | "Muted" | "Hidden">
  & Pick<typeof import("../../../packages/runtime/src/systems/playback"), "resolveAudioBus" | "playbackSystem">
  & Pick<typeof import("../../../packages/runtime/src/actions/playback"), "setPlayhead" | "togglePlayback">
};
runInThisContext(`(function(module,exports,AudioContext){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, class AudioContext {});
const { createWorld, AudioEngine, Computed, Volume, resolveAudioBus, Playback, Workarea, FrameRate, setPlayhead, togglePlayback, playbackSystem, AudioPlayback, AudioBusHandle, AudioDecoderHandle, AssetId, Audio, Group, Geometry, ChildOf, Root, Mode, Time, Soloed, Muted, Hidden } = module.exports;

class GainParam {
  private current = 1;
  writes = 0;
  get value() { return this.current; }
  set value(value: number) { this.current = Math.fround(value); this.writes++; }
}

const linearGain = (db: number) => Math.fround(Math.pow(10, db / 20));

class Gain {
  gain = new GainParam();
  destination: unknown;
  connect(destination: unknown) { this.destination = destination; }
  disconnect() { this.destination = undefined; }
}

function audioContext() {
  return { destination: {}, createGain: () => new Gain() } as unknown as AudioContext;
}

test("playback output can mute monitoring while the capture world retains the authored mix", () => {
  const monitor = new Gain();
  const context = audioContext();
  const editor = createWorld(AudioEngine({ context, output: monitor as unknown as AudioNode }));
  const scene = editor.spawn(Volume({ value: -6 }), Computed({ volume: -6 }));
  const bus = resolveAudioBus(editor, scene)!;
  bus.sync();

  assert.equal((bus.getOutput() as unknown as Gain).destination, monitor);
  monitor.gain.value = 0.25;
  assert.equal(bus.getGain().gain.value, linearGain(-6));
  monitor.gain.value = 0;
  assert.equal(scene.get(Volume)?.value, -6);
  assert.equal(bus.getGain().gain.value, linearGain(-6));

  const captureContext = audioContext();
  const capture = createWorld(AudioEngine({ context: captureContext }));
  const capturedScene = capture.spawn(Volume({ value: -6 }), Computed({ volume: -6 }));
  const capturedBus = resolveAudioBus(capture, capturedScene)!;
  capturedBus.sync();

  assert.equal(capture.get(AudioEngine)?.output, null);
  assert.equal((capturedBus.getOutput() as unknown as Gain).destination, captureContext.destination);
  assert.equal(capturedBus.getGain().gain.value, linearGain(-6));
  editor.destroy();
  capture.destroy();
});

test("starting outside a marked range plays from its start while starting inside preserves the playhead", () => {
  const world = createWorld(FrameRate({ value: 30 }));
  const scene = world.spawn(Playback, Computed({ duration: 360 }), Workarea({ start: 60, end: 180 }));
  try {
    for (const [frame, expected] of [[0, 60], [100, 100], [180, 60], [240, 60]]) {
      scene.set(Playback, { playing: false });
      setPlayhead(world, scene, frame);
      togglePlayback(world, scene);
      assert.equal(scene.get(Playback)?.playing, true);
      assert.equal(scene.get(Computed)?.localTime, expected);
      assert.deepEqual(scene.get(Workarea), { start: 60, end: 180 });
    }
  } finally { world.destroy(); }
});

test("soloing a group keeps its descendants audible and restores the mix when cleared", () => {
  const world = createWorld(AudioEngine({ context: audioContext() }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Computed, ChildOf(root));
  const group = world.spawn(Group, Computed, Soloed, ChildOf(scene));
  const nested = world.spawn(Group, Computed, ChildOf(group));
  const clip = world.spawn(Geometry, Computed({ volume: -6 }), ChildOf(nested));
  const muted = world.spawn(Geometry, Computed, Muted, ChildOf(group));
  const other = world.spawn(Geometry, Computed, ChildOf(scene));
  const clipBus = resolveAudioBus(world, clip)!;
  const mutedBus = resolveAudioBus(world, muted)!;
  const otherBus = resolveAudioBus(world, other)!;
  try {
    playbackSystem(world);
    assert.equal(clipBus.getGain().gain.value, linearGain(-6), 'solo includes the full nested group');
    assert.equal(mutedBus.getGain().gain.value, 0, 'an explicit mute still applies inside a soloed group');
    assert.equal(otherBus.getGain().gain.value, 0);
    const otherGain = otherBus.getGain() as unknown as Gain;
    const writes = otherGain.gain.writes;
    playbackSystem(world);
    playbackSystem(world);
    assert.equal(otherGain.gain.writes, writes, 'a solo-muted bus cannot write gain twice on every tick');
    other.set(Computed, { volume: -12 });
    playbackSystem(world);
    assert.equal(otherGain.gain.writes, writes, 'changes under solo mute do not touch the audio graph');
    group.remove(Soloed);
    clip.add(Soloed);
    playbackSystem(world);
    assert.equal(resolveAudioBus(world, scene)!.getGain().gain.value, 1, 'soloing a child keeps its ancestor buses open');
    assert.equal(otherBus.getGain().gain.value, 0);
    clip.remove(Soloed);
    playbackSystem(world);
    assert.equal(otherBus.getGain().gain.value, linearGain(-12), 'clearing solo restores the latest authored volume');
  } finally { world.destroy(); }
});

test("soloing an unopened future clip mutes the current mix without creating its audio bus", () => {
  const context = Object.assign(audioContext(), { currentTime: 0 });
  const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context }), Mode({ value: 'realtime' }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 600 }), ChildOf(root));
  const current = world.spawn(Geometry, Computed({ start: 0, end: 120, duration: 120, volume: -6 }), ChildOf(scene));
  const future = world.spawn(Geometry, Audio, Soloed, Computed({ start: 300, end: 420, duration: 120, origin: 300 }), ChildOf(scene));
  const currentBus = resolveAudioBus(world, current)!;
  try {
    playbackSystem(world);
    assert.equal(future.has(AudioBusHandle), false, 'solo does not eagerly create a dormant audio graph');
    assert.equal(currentBus.getGain().gain.value, 0, 'a soloed source is authoritative before its first playback');
    future.remove(Soloed);
    playbackSystem(world);
    assert.equal(currentBus.getGain().gain.value, linearGain(-6));
  } finally { world.destroy(); }
});

test("one buffering scene preserves its preparation while other scenes release outgoing audio", () => {
  const context = Object.assign(audioContext(), { currentTime: 2 });
  const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context }), Mode({ value: 'realtime' }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const loading = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 600 }), ChildOf(root));
  let loadingResets = 0;
  const preparation = new Promise<void>(() => {});
  const loadingDecoder = { assetId: 'loading', stream: 0, ready: true, isPrepared: () => false, prepare: () => preparation, reset: () => { loadingResets++; } };
  world.spawn(Geometry, Audio, AssetId({ value: 'loading' }), AudioDecoderHandle(loadingDecoder as never), Computed({ start: 0, end: 600, duration: 600 }), ChildOf(loading));
  const playing = world.spawn(Group, Playback({ playing: true }), AudioPlayback({ wasPlaying: true }), Computed({ duration: 600, localTime: 60, localTimeInSeconds: 2 }), ChildOf(root));
  const outgoingResets: { stopScheduled?: boolean }[] = [];
  const outgoingDecoder = { assetId: 'outgoing', stream: 0, ready: true, reset: (options: { stopScheduled?: boolean }) => { outgoingResets.push(options); } };
  world.spawn(Geometry, Audio, AssetId({ value: 'outgoing' }), AudioDecoderHandle(outgoingDecoder as never), Computed({ start: 0, end: 30, duration: 30 }), ChildOf(playing));
  try {
    playbackSystem(world);
    assert.equal(loading.get(Playback)?.buffering, true);
    assert.equal(loadingResets, 0, 'startup preparation survives cleanup');
    assert.deepEqual(outgoingResets, [{ stopScheduled: false }], 'another scene still releases PCM without stopping scheduled sound');
  } finally { world.destroy(); }
});

test("hiding a playing clip or group stops its queued sound while ordinary cuts preserve outgoing sound", () => {
  for (const hiddenTarget of ['clip', 'group']) {
    const context = Object.assign(audioContext(), { currentTime: 0 });
    const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context }), Mode({ value: 'realtime' }));
    const root = world.spawn(); world.add(Root); world.set(Root, root);
    const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 600 }), ChildOf(root));
    const group = world.spawn(Group, Computed({ start: 0, end: 600, duration: 600 }), ChildOf(scene));
    const queued = new Set<string>();
    const resets = new Map<string, { stopScheduled?: boolean }>();
    const clips = ['hidden', 'outgoing'].map(id => {
      const decoder = {
        assetId: id, stream: 0, ready: true, isPrepared: () => true,
        playTo: async () => { queued.add(id); },
        reset: (options: { stopScheduled?: boolean } = {}) => {
          resets.set(id, options);
          if (options.stopScheduled !== false) queued.delete(id);
        },
      };
      const duration = id === 'hidden' ? 600 : 30;
      return world.spawn(Geometry, Audio, AssetId({ value: id }), AudioDecoderHandle(decoder as never), Computed({ start: 0, end: duration, duration }), ChildOf(id === 'hidden' ? group : scene));
    });
    try {
      playbackSystem(world);
      assert.deepEqual(queued, new Set(['hidden', 'outgoing']));
      (hiddenTarget === 'clip' ? clips[0] : group).add(Hidden);
      context.currentTime = 1.5;
      playbackSystem(world);
      assert.deepEqual(resets.get('hidden'), { stopScheduled: true }, `${hiddenTarget}: hiding cancels already queued sound`);
      assert.deepEqual(resets.get('outgoing'), { stopScheduled: false });
      assert.deepEqual(queued, new Set(['outgoing']), 'the rendered tail of an ordinary cut may finish');
    } finally { world.destroy(); }
  }
});

test("stable volume and mute state do not write AudioParam on every playback tick", () => {
  const world = createWorld(AudioEngine({ context: audioContext() }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Computed, ChildOf(root));
  const clip = world.spawn(Geometry, Computed({ volume: -6 }), ChildOf(scene));
  const bus = resolveAudioBus(world, clip)!;
  const gain = bus.getGain() as unknown as Gain;
  try {
    const initial = gain.gain.writes;
    for (let tick = 0; tick < 10; tick++) playbackSystem(world);
    assert.equal(gain.gain.writes, initial);
    clip.set(Computed, { volume: -12 });
    playbackSystem(world);
    assert.equal(gain.gain.value, linearGain(-12));
    assert.equal(gain.gain.writes, initial + 1);
    clip.add(Muted);
    playbackSystem(world);
    assert.equal(gain.gain.value, 0);
    const mutedWrites = gain.gain.writes;
    playbackSystem(world);
    assert.equal(gain.gain.writes, mutedWrites);
    clip.remove(Muted);
    playbackSystem(world);
    assert.equal(gain.gain.value, linearGain(-12));
  } finally { world.destroy(); }
});


test("JKL shuttle resets nested scheduled audio and returning to 1x anchors sound at the current playhead", () => {
  const context = Object.assign(audioContext(), { currentTime: 10 });
  const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context }), Mode({ value: 'realtime' }), Time({ delta: 0 }));
  const root = world.spawn();
  world.add(Root);
  world.set(Root, root);
  const scene = world.spawn(Group, Computed({ duration: 600, localTime: 90, localTimeInSeconds: 3 }), Playback({ playing: true }), ChildOf(root));
  const group = world.spawn(Group, Computed({ start: 0, end: 600, duration: 600 }), ChildOf(scene));
  let plays = 0, resets = 0;
  const decoder = { assetId: 'test', stream: 0, ready: true, isPrepared: () => true, playTo: async () => { plays++; }, reset: () => { resets++; } };
  world.spawn(Geometry, Audio, AssetId({ value: 'test' }), AudioDecoderHandle(decoder as never), Computed({ start: 0, end: 600, duration: 600, playbackRate: 1 }), ChildOf(group));
  try {
    playbackSystem(world);
    assert.equal(plays, 1);
    scene.set(Playback, { speed: 2 });
    playbackSystem(world);
    assert.equal(plays, 1);
    assert.ok(resets > 0);
    scene.set(Playback, { speed: -1 });
    playbackSystem(world);
    assert.equal(plays, 1);
    scene.set(Computed, { localTime: 240, localTimeInSeconds: 8 });
    context.currentTime = 15;
    scene.set(Playback, { speed: 1 });
    playbackSystem(world);
    assert.equal(plays, 2);
    assert.ok(scene.get(AudioPlayback)!.contextOffsetInSeconds >= 15 && scene.get(AudioPlayback)!.contextOffsetInSeconds <= 15.1);
    assert.equal(scene.get(AudioPlayback)?.timelineOffsetInSeconds, 8);
  } finally { world.destroy(); }
});


test("reverse playback leaves the end boundary and continues after looping", () => {
  for (const loop of [false, true]) {
    const context = Object.assign(audioContext(), { currentTime: 0 });
    const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context }), Mode({ value: 'realtime' }));
    const root = world.spawn(); world.add(Root); world.set(Root, root);
    const scene = world.spawn(Group, Computed({ duration: 300, localTime: 300, localTimeInSeconds: 10 }), Playback({ playing: true, speed: -1, loop }), ChildOf(root));
    try {
      playbackSystem(world);
      context.currentTime += 0.016;
      playbackSystem(world);
      assert.equal(scene.get(Playback)?.playing, true, 'the initial scheduling lead must not stop reverse playback');
      context.currentTime += 0.1;
      playbackSystem(world);
      assert.ok(scene.get(Computed)!.localTimeInSeconds < 10);
      context.currentTime += 11;
      playbackSystem(world);
      assert.equal(scene.get(Playback)?.playing, loop);
      if (loop) {
        assert.equal(scene.get(Computed)?.localTimeInSeconds, 10);
        playbackSystem(world);
        context.currentTime += 0.1;
        playbackSystem(world);
        assert.ok(scene.get(Computed)!.localTimeInSeconds < 10, 'a wrapped reverse playhead moves away from the end');
      }
    } finally { world.destroy(); }
  }
});

test("playback controls observe preparing, ready and natural completion without per-frame updates", () => {
  const context = Object.assign(audioContext(), { currentTime: 0, state: 'suspended' });
  const world = createWorld(FrameRate({ value: 30 }), AudioEngine({ context }), Mode({ value: 'realtime' }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Computed({ duration: 30 }), Playback({ playing: true }), ChildOf(root));
  const states: [playing: boolean, buffering: boolean][] = [];
  world.onChange(Playback, entity => {
    if (entity !== scene) return;
    const playback = entity.get(Playback)!;
    states.push([playback.playing, playback.buffering]);
  });
  try {
    playbackSystem(world);
    playbackSystem(world);
    assert.deepEqual(states, [[true, true]]);
    context.state = 'running';
    playbackSystem(world);
    context.currentTime = 0.5;
    playbackSystem(world);
    assert.deepEqual(states, [[true, true], [true, false]]);
    context.currentTime = 2;
    playbackSystem(world);
    playbackSystem(world);
    assert.deepEqual(states, [[true, true], [true, false], [false, false]]);
    assert.equal(scene.get(Computed)?.localTime, 30);
  } finally { world.destroy(); }
});
