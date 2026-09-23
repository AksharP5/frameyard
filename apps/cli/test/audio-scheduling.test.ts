import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';
import type { AudioAsset } from '../../../packages/assets/src/types.ts';
import type { AudioBus } from '../../../packages/runtime/src/media/audio-bus.ts';

class BufferData {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(options: AudioBufferOptions) {
    this.sampleRate = options.sampleRate;
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels ?? 1;
    this.duration = this.length / this.sampleRate;
    this.channels = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
  }
  copyToChannel(data: Float32Array, channel: number) { this.channels[channel].set(data); }
  getChannelData(channel: number) { return this.channels[channel]; }
}

const built = await build({
  stdin: { contents: `
    export { createWorld } from 'koota';
    export { AudioDecoder } from './media/audio';
    export { AudioBufferSink } from 'mediabunny';
    export { playbackSystem } from './systems/playback';
    export { setPlayhead } from './actions/playback';
    export * from './traits';
  `, resolveDir: fileURLToPath(new URL('../../../packages/runtime/src/', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  logOverride: { 'empty-import-meta': 'silent' },
});
const module = { exports: {} as
  typeof import('../../../packages/runtime/src/traits/index.ts')
  & Pick<typeof import('koota'), 'createWorld'>
  & Pick<typeof import('mediabunny'), 'AudioBufferSink'>
  & Pick<typeof import('../../../packages/runtime/src/media/audio.ts'), 'AudioDecoder'>
  & Pick<typeof import('../../../packages/runtime/src/systems/playback.ts'), 'playbackSystem'>
  & Pick<typeof import('../../../packages/runtime/src/actions/playback.ts'), 'setPlayhead'>
};
runInThisContext(`(function(module,exports,AudioBuffer){"use strict";${built.outputFiles[0].text}\n})`)(module, module.exports, BufferData);
const { AudioDecoder, AudioBufferSink, createWorld, AudioEngine, AudioPlayback, AudioDecoderHandle, AudioBusHandle, Audio, AssetId, ChildOf, Computed, FrameRate, Geometry, Group, Mode, Playback, Root, Time, Trim, playbackSystem, setPlayhead } = module.exports;

function recording(): AudioAsset {
  const pcm = Buffer.alloc(44 + 48000 * 2 * 4);
  pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(48000, 24); pcm.writeUInt32LE(96000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
  for (let index = 44; index < pcm.length; index += 2) pcm.writeInt16LE(16384, index);
  const file = new File([pcm], 'tone.wav');
  return { id: 'tone', path: file.name, source: file.name, createdAt: '', mimeType: 'audio/wav', type: 'AUDIO', duration: 4, channels: 1, sampleRate: 48000, handle: { getFile: async () => file } };
}

class SourceNode {
  buffer: BufferData | null = null;
  stopped = false;
  when = 0;
  duration = 0;
  onended: (() => void) | null = null;
  connect() {}
  start(when: number, _offset: number, duration: number) { this.when = when; this.duration = duration; }
  stop() { this.stopped = true; }
}

function output() {
  const nodes: SourceNode[] = [];
  const context = { currentTime: 0, sampleRate: 48000, createBufferSource: () => { const node = new SourceNode(); nodes.push(node); return node; } };
  const bus = { context, input: {}, ready: Promise.resolve(), sync() {} } as unknown as AudioBus;
  return { nodes, context, bus };
}

const options = { relativeFrom: 1, relativeTo: 1.25, trimStart: 1, trimEnd: 1.25, playbackRate: 1, currentTime: 0, relativeDelay: -1 };

test('repeated scheduling only decodes the requested audio window and preserves its samples', async () => {
  const decoder = new AudioDecoder(recording());
  const { bus, nodes } = output();
  try {
    await decoder.init();
    await decoder.playTo(bus, options);
    const scheduled = nodes.length;
    assert.ok(scheduled > 0);
    assert.ok(Math.abs(nodes.reduce((sum, node) => sum + node.duration, 0) - 0.25) < 1 / 48000);
    assert.ok(nodes.every(node => node.buffer!.getChannelData(0)[0] === 0.5));
    for (let tick = 0; tick < 30; tick++) await decoder.playTo(bus, options);
    assert.equal(nodes.length, scheduled, 'already covered playback time must not consume more buffers');
  } finally { decoder.reset(); }
});

test('normal-speed playback reuses decoded PCM buffers without copying each channel', async () => {
  const original = AudioBufferSink.prototype.buffers;
  const buffers = [0, 0.1, 0.2].map(() => new BufferData({ length: 4800, sampleRate: 48000, numberOfChannels: 2 }));
  AudioBufferSink.prototype.buffers = async function* () {
    for (const [index, buffer] of buffers.entries()) {
      buffer.getChannelData(0).fill(0.5);
      buffer.getChannelData(1).fill(-0.25);
      yield { buffer: buffer as unknown as AudioBuffer, timestamp: index / 10, duration: buffer.duration };
    }
  };
  const decoder = new AudioDecoder(recording());
  const { bus, nodes } = output();
  try {
    await decoder.init();
    await decoder.playTo(bus, { relativeFrom: 0.04, relativeTo: 0.3, trimStart: 0.04, trimEnd: 0.26, playbackRate: 1, currentTime: 0, relativeDelay: -0.04 });
    assert.equal(nodes.length, 3);
    for (const [index, node] of nodes.entries()) assert.equal(node.buffer, buffers[index], 'already decoded PCM can be scheduled directly');
    assert.ok(Math.abs(nodes.reduce((sum, node) => sum + node.duration, 0) - 0.22) < 1 / 48000, 'both trim boundaries still apply');
  } finally { decoder.reset(); AudioBufferSink.prototype.buffers = original; }
});

test('a cut releases decoding but keeps outgoing sound until rendered; pause still stops it', async () => {
  const decoder = new AudioDecoder(recording());
  const { bus, nodes, context } = output();
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: 'offline-audio' }), AudioEngine({ context: context as unknown as AudioContext }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Playback({ playing: true }), Computed({ localTime: 15 }), ChildOf(root));
  world.spawn(Geometry, Audio, AssetId({ value: 'tone' }), AudioDecoderHandle(decoder), AudioBusHandle(bus), Computed({ start: 0, end: 15, duration: 15 }), ChildOf(scene));
  try {
    await decoder.init();
    await decoder.playTo(bus, options);
    playbackSystem(world);
    assert.ok(nodes.some(node => node.duration > 0));
    assert.ok(nodes.every(node => !node.stopped), 'audio clock is behind the cut; scheduled samples must finish');
    scene.set(Playback, { playing: false });
    playbackSystem(world);
    assert.ok(nodes.every(node => node.stopped), 'pause must stop outgoing sound, including previous clips');
  } finally { decoder.reset(); world.destroy(); }
});

test('seeking during playback stops old buffers and anchors new audio to the seek position', () => {
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: 'realtime' }), Time({ delta: 0 }), AudioEngine({ context: { currentTime: 20 } as AudioContext }));
  const scene = world.spawn(Playback({ playing: true }), Computed({ localTime: 600, localTimeInSeconds: 10 }), AudioPlayback({ contextOffsetInSeconds: 10, timelineOffsetInSeconds: 0, wasPlaying: true }));
  const group = world.spawn(Group, ChildOf(scene));
  let stopped = 0;
  world.spawn(AudioDecoderHandle({ reset: () => { stopped++; } } as never), ChildOf(group));
  try {
    setPlayhead(world, scene, 180);
    assert.equal(stopped, 1);
    assert.equal(scene.get(Playback)?.playing, true);
    assert.equal(scene.get(AudioPlayback)?.contextOffsetInSeconds, 20);
    assert.equal(scene.get(AudioPlayback)?.timelineOffsetInSeconds, 3);
    assert.equal(scene.get(Computed)?.localTime, 180);
  } finally { world.destroy(); }
});

test('timestamp gaps preserve the following audio position at normal and accelerated speed', async () => {
  const original = AudioBufferSink.prototype.buffers;
  AudioBufferSink.prototype.buffers = async function* () {
    for (const timestamp of [0, 0.102, 0.302]) {
      const buffer = new BufferData({ length: 4800, sampleRate: 48000, numberOfChannels: 1 });
      buffer.getChannelData(0).fill(0.5);
      yield { buffer: buffer as unknown as AudioBuffer, timestamp, duration: buffer.duration };
    }
  };
  try {
    for (const playbackRate of [1, 2]) {
      const decoder = new AudioDecoder(recording());
      const { bus, nodes } = output();
      try {
        await decoder.init();
        await decoder.playTo(bus, { relativeFrom: 0, relativeTo: 0.5, trimStart: 0, trimEnd: 0.5, playbackRate, currentTime: 0, relativeDelay: 0 });
        const halfSample = 0.5 / 48000;
        for (const timestamp of [0.102, 0.302]) {
          const followingStart = timestamp / playbackRate + halfSample;
          assert.ok(nodes.some(node => node.duration > 0 && Math.abs(node.when - followingStart) < 1 / 48000), `${playbackRate}x: following speech must start at its source timestamp`);
          assert.ok(nodes.every(node => node.when + node.duration <= followingStart + 1 / 48000 || node.when >= followingStart - 1 / 48000), 'audio buffers must not span the missing source interval');
        }
      } finally { decoder.reset(); }
    }
  } finally { AudioBufferSink.prototype.buffers = original; }
});


test('playback starting in a source timestamp gap schedules upcoming sound only once', async () => {
  const original = AudioBufferSink.prototype.buffers;
  try {
    for (const timestamps of [[0.2, 0.3], []]) {
      let reads = 0;
      AudioBufferSink.prototype.buffers = async function* () {
        reads++;
        for (const timestamp of timestamps) {
          const buffer = new BufferData({ length: 4800, sampleRate: 48000, numberOfChannels: 1 });
          buffer.getChannelData(0).fill(0.5);
          yield { buffer: buffer as unknown as AudioBuffer, timestamp, duration: buffer.duration };
        }
      };
      const decoder = new AudioDecoder(recording());
      const { bus, nodes } = output();
      try {
        await decoder.init();
        for (const relativeFrom of [0, 0.01, 0.05, 0.15]) {
          await decoder.playTo(bus, { relativeFrom, relativeTo: 0.4, trimStart: 0, trimEnd: 0.4, playbackRate: 1, currentTime: relativeFrom, relativeDelay: 0 });
        }
        assert.equal(nodes.length, timestamps.length, 'the initial silent interval must not layer duplicate sound');
        assert.equal(reads, 1, 'a silent source interval must not restart decoding on every tick');
      } finally { decoder.reset(); }
    }
  } finally { AudioBufferSink.prototype.buffers = original; }
});


test('startup waits for prepared audio and follows device time through render stalls', async () => {
  const fileReady = Promise.withResolvers<void>();
  const asset = recording();
  const getFile = asset.handle.getFile.bind(asset.handle);
  asset.handle.getFile = async () => { await fileReady.promise; return getFile(); };
  const decoder = new AudioDecoder(asset);
  const { bus, nodes, context } = output();
  const device = Object.assign(context, { state: 'suspended' });
  const processing = { ...bus, isReady: false };
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: 'realtime' }), Time({ delta: 5000 }), AudioEngine({ context: device as unknown as AudioContext }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 240, localTime: 60, localTimeInSeconds: 1 }), ChildOf(root));
  scene.add(AudioBusHandle(processing));
  world.spawn(Geometry, Audio, AssetId({ value: asset.id }), AudioDecoderHandle(decoder), AudioBusHandle(bus), Computed({ start: 0, end: 240, duration: 240, localTime: 60 }), ChildOf(scene));
  try {
    playbackSystem(world);
    assert.equal(scene.get(Playback)?.buffering, true);
    assert.equal(scene.get(Computed)?.localTime, 60);
    device.state = 'running';
    playbackSystem(world);
    context.currentTime = 2;
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 60, 'loading time must not skip the opening audio');
    assert.equal(nodes.length, 0, 'preparation is silent');
    scene.set(Playback, { playing: false });
    playbackSystem(world);
    assert.equal(scene.get(Playback)?.buffering, false, 'pause cancels a pending start');
    scene.set(Playback, { playing: true });
    playbackSystem(world);
    fileReady.resolve();
    await decoder.prepare(1, 1.5, 4);
    playbackSystem(world);
    assert.equal(scene.get(Playback)?.buffering, true, 'ancestor audio processing must also be ready');
    assert.equal(scene.get(Computed)?.localTime, 60);
    processing.isReady = true;
    playbackSystem(world);
    const clockStart = scene.get(AudioPlayback)!.contextOffsetInSeconds;
    assert.ok(clockStart > context.currentTime && clockStart <= context.currentTime + 0.1);
    await decoder.playTo(bus, { ...options, relativeFrom: 1, relativeTo: 1.5, trimStart: 0, trimEnd: 4, relativeDelay: clockStart - 1 });
    assert.equal(scene.get(Playback)?.buffering, false);
    assert.ok(nodes.some(node => node.duration > 0));
    assert.ok(Math.abs(nodes[0].when - clockStart) < 1 / 48000, 'the first sample starts after loading, on the new clock origin');
    context.currentTime = 2.25;
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTimeInSeconds, 1 + 2.25 - clockStart);
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTimeInSeconds, 1 + 2.25 - clockStart, 'another render or resize cannot advance time twice');
    scene.set(Playback, { playing: false });
    playbackSystem(world);
    assert.ok(nodes.every(node => node.stopped));
  } finally { fileReady.resolve(); decoder.reset(); world.destroy(); }
});

test('upcoming audio uses the same time lookahead at every FPS and source playback rate', async () => {
  for (const fps of [30, 60, 120]) {
    for (const rate of [1, 2]) {
      const { bus, context } = output();
      const decoder = new AudioDecoder(recording());
      const scheduled: Parameters<typeof decoder.playTo>[1][] = [];
      decoder.playTo = async (_bus, options) => { scheduled.push(options); };
      const world = createWorld(FrameRate({ value: fps }), Mode({ value: 'realtime' }), Time({ delta: 0 }), AudioEngine({ context: context as unknown as AudioContext }));
      const root = world.spawn(); world.add(Root); world.set(Root, root);
      const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 4 * fps }), ChildOf(root));
      world.spawn(Geometry, Audio, AssetId({ value: 'tone' }), AudioDecoderHandle(decoder), AudioBusHandle(bus), Trim({ start: 2 * fps }), Computed({ start: fps, end: 2 * fps, origin: fps - 2 * fps / rate, duration: fps, playbackRate: rate }), ChildOf(scene));
      try {
        await decoder.init();
        playbackSystem(world);
        assert.equal(scheduled.length, 0);
        context.currentTime = scene.get(AudioPlayback)!.contextOffsetInSeconds + 0.6;
        playbackSystem(world);
        assert.equal(scheduled.length, 1, `${fps} FPS, ${rate}x: the incoming clip schedules before its cut`);
        assert.equal(scheduled[0].relativeFrom, 2, 'decoding starts at the source trim');
        assert.ok(Math.abs(scheduled[0].relativeTo - (2 + 0.1 * rate)) < 1e-10);
        assert.ok(Math.abs(scheduled[0].relativeDelay - scene.get(AudioPlayback)!.contextOffsetInSeconds + 2 / rate - 1) < 1e-10, 'the first source sample lands exactly at the future cut');
      } finally { decoder.reset(); world.destroy(); }
    }
  }
});

test('the visual clock presents every 60 fps frame between coarse audio blocks', () => {
  const device = { currentTime: 1.1, state: 'running', getOutputTimestamp: () => timestamp };
  let timestamp = { contextTime: 1, performanceTime: 1000 };
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: 'realtime' }), Time({ now: 1000 }), AudioEngine({ context: device as AudioContext }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 1200, localTime: 60, localTimeInSeconds: 1 }), AudioPlayback({ wasPlaying: true }), ChildOf(root));
  try {
    const block = 1024 / 48000;
    for (let frame = 61; frame <= 660; frame++) {
      const now = frame / 60;
      const lastBlock = Math.floor(now / block) * block;
      device.currentTime = Math.ceil((now + 0.1) / block) * block;
      timestamp = { contextTime: lastBlock, performanceTime: lastBlock * 1000 };
      world.set(Time, { now: now * 1000 });
      playbackSystem(world);
      assert.equal(scene.get(Computed)?.localTime, frame, 'output timestamps interpolate across 21 ms device blocks');
      playbackSystem(world);
      assert.equal(scene.get(Computed)?.localTime, frame, 'a resize at the same frame time cannot advance playback');
    }
    timestamp.contextTime -= 0.01;
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 660, 'a device timestamp correction cannot reverse playback');
  } finally { world.destroy(); }
});

test('output latency holds opening video until sound is audible and resets after a seek or suspension', () => {
  const device = { currentTime: 10, state: 'running', getOutputTimestamp: () => timestamp };
  let timestamp = { contextTime: 9.9, performanceTime: 1000 };
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: 'realtime' }), Time({ now: 1000 }), AudioEngine({ context: device as AudioContext }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 1200, localTime: 180, localTimeInSeconds: 3 }), ChildOf(root));
  try {
    playbackSystem(world);
    assert.equal(scene.get(AudioPlayback)?.contextOffsetInSeconds, 10.05, 'audio scheduling keeps its raw device origin');
    device.currentTime = 10.1;
    world.set(Time, { now: 1100 });
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 180, 'already scheduled audio has not reached the output device yet');
    world.set(Time, { now: 1200 }); device.currentTime = 10.2;
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 183);
    setPlayhead(world, scene, 60);
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 60);
    device.state = 'suspended'; world.set(Time, { now: 5000 });
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 60, 'wall time cannot run ahead of a suspended device');
    device.state = 'running'; timestamp = { contextTime: 10.1, performanceTime: 5000 };
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 60, 'resuming starts a fresh output-clock mapping');
    timestamp = { contextTime: 0, performanceTime: 0 }; device.currentTime = 10.3;
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 63, 'an unavailable output timestamp uses the device clock');
  } finally { world.destroy(); }
});

test('high output latency preserves audio lookahead across cuts and stops at the workarea', async () => {
  const { bus, context } = output();
  const device = Object.assign(context, { currentTime: 1, state: 'running', getOutputTimestamp: () => ({ contextTime: 0.25, performanceTime: 1000 }) });
  const world = createWorld(FrameRate({ value: 60 }), Mode({ value: 'realtime' }), Time({ now: 1000 }), AudioEngine({ context: device as unknown as AudioContext }));
  const root = world.spawn(); world.add(Root); world.set(Root, root);
  const { Workarea } = module.exports;
  const scene = world.spawn(Group, Playback({ playing: true }), Computed({ duration: 240, localTime: 15, localTimeInSeconds: 0.25 }), AudioPlayback({ wasPlaying: true }), Workarea({ start: 0, end: 90 }), ChildOf(root));
  const decoders: InstanceType<typeof AudioDecoder>[] = [];
  const calls: Parameters<InstanceType<typeof AudioDecoder>['playTo']>[1][][] = [];
  const resets: { stopScheduled?: boolean }[][] = [];
  for (const [start, end, sourceStart] of [[0, 72, 0], [72, 120, 120], [120, 180, 0]]) {
    const decoder = new AudioDecoder(recording()), scheduled: Parameters<InstanceType<typeof AudioDecoder>['playTo']>[1][] = [], stopped: { stopScheduled?: boolean }[] = [];
    await decoder.init();
    decoder.playTo = async (_bus, options) => { scheduled.push(options); };
    const reset = decoder.reset.bind(decoder);
    decoder.reset = (options = {}) => { stopped.push(options); reset(options); };
    decoders.push(decoder); calls.push(scheduled); resets.push(stopped);
    world.spawn(Geometry, Audio, AssetId({ value: 'tone' }), AudioDecoderHandle(decoder), AudioBusHandle(bus), Trim({ start: sourceStart }), Computed({ start, end, origin: start - sourceStart, duration: end - start }), ChildOf(scene));
  }
  try {
    playbackSystem(world);
    assert.equal(scene.get(Computed)?.localTime, 15, 'picture follows audible output');
    assert.equal(calls[0][0].relativeFrom, 1, 'audio reads from the device render position');
    assert.equal(calls[1][0].relativeFrom, 2);
    assert.equal(calls[1][0].relativeTo, 2.3, 'the incoming cut receives the full 500 ms lookahead');
    assert.equal(calls[1][0].trimEnd, 2.3, 'a workarea endpoint inside the incoming clip truncates its source window');
    assert.equal(calls[2].length, 0, 'clips beyond the workarea cannot schedule audio');
    device.currentTime = 1.3;
    playbackSystem(world);
    assert.equal(resets[0].at(-1)?.stopScheduled, false, 'outgoing buffered audio survives the cut');
    device.currentTime = 1.6;
    playbackSystem(world);
    assert.equal(resets[1].at(-1)?.stopScheduled, false, 'audio ends while the visual playhead catches up to the audible endpoint');
    assert.equal(calls[2].length, 0);
  } finally { decoders.forEach(d => d.reset()); world.destroy(); }
});
