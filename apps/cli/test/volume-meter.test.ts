import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const solid: typeof import('solid-js') = require(require.resolve('solid-js').replace('server.cjs', 'solid.cjs'));
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/hooks/use-volume-meter.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['solid-js'],
});

function fixture() {
  const nodes: Worklet[] = [];
  const loads: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const blobs: Blob[] = [];
  class Worklet {
    stopped = false;
    port = {
      onmessage: null as ((event: { data: Float32Array }) => void) | null,
      postMessage: (message: string) => { this.stopped = message === 'stop'; },
      close() {},
    };
    constructor() { nodes.push(this); }
    disconnect() {}
    send(rms: number) { this.port.onmessage?.({ data: new Float32Array([rms, rms]) }); }
  }
  const context = { audioWorklet: { addModule() {
    const load = Promise.withResolvers<void>();
    loads.push(load);
    return load.promise;
  } } };
  function gain() {
    const monitor = {};
    const outputs = new Set<object>([monitor]);
    return {
      context, monitor, outputs,
      connect(node: object) { outputs.add(node); },
      disconnect(node: object) { outputs.delete(node); },
    };
  }
  const module = { exports: {} as typeof import('../../web/src/hooks/use-volume-meter.ts') };
  runInNewContext(built.outputFiles[0].text, {
    module, exports: module.exports, require: () => solid, AudioWorkletNode: Worklet,
    Blob, URL: { createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:meter'; } },
  });
  function mount() {
    return solid.createRoot((dispose) => ({ ...module.exports.useVolumeMeter(), dispose }));
  }
  return { nodes, loads, blobs, gain, mount };
}

test('concurrent meters load one module and releasing the last listener removes only its audio tap', async () => {
  const f = fixture();
  const a = f.gain(), b = f.gain();
  const first = f.mount(), second = f.mount(), third = f.mount();
  const pending = [first.connect(a as unknown as GainNode), second.connect(a as unknown as GainNode), third.connect(b as unknown as GainNode)];
  const moduleLoads = f.loads.length;
  f.loads.forEach((load) => load.resolve());
  await Promise.all(pending);
  assert.equal(moduleLoads, 1);
  assert.equal(f.nodes.length, 2);
  f.nodes[0].send(0.5);
  assert.equal(first.levels()[0].rms, 0.5);
  assert.equal(second.levels()[0].rms, 0.5);
  first.dispose();
  assert.equal(a.outputs.size, 2, 'the remaining listener keeps the shared tap');
  second.dispose();
  assert.deepEqual([...a.outputs], [a.monitor], 'meter teardown preserves the monitor connection');
  assert.equal(f.nodes[0].stopped, true, 'unused worklets must stop processing audio');
  third.dispose();
  assert.deepEqual([...b.outputs], [b.monitor]);
});

test('reconnecting to the same gain while its module loads keeps the newest subscription', async () => {
  const f = fixture();
  const gain = f.gain();
  const meter = f.mount();
  const first = meter.connect(gain as unknown as GainNode);
  meter.disconnect();
  const second = meter.connect(gain as unknown as GainNode);
  f.loads.forEach((load) => load.resolve());
  await Promise.all([first, second]);
  f.nodes.at(-1)!.send(0.25);
  assert.equal(meter.levels()[0].rms, 0.25);
  assert.equal(gain.outputs.size, 2);
  meter.dispose();
  assert.deepEqual([...gain.outputs], [gain.monitor]);
});

test('a failed worklet load can be retried and an unmounted pending meter leaves no tap', async () => {
  const f = fixture();
  const gain = f.gain();
  const meter = f.mount();
  const first = meter.connect(gain as unknown as GainNode);
  const failure = assert.rejects(first, /module unavailable/);
  f.loads[0].reject(new Error('module unavailable'));
  await failure;
  const retry = meter.connect(gain as unknown as GainNode);
  assert.equal(f.loads.length, 2);
  meter.dispose();
  f.loads[1].resolve();
  await retry;
  assert.deepEqual([...gain.outputs], [gain.monitor]);
  assert.equal(f.nodes[0].stopped, true);
});

test('a meter survives silent input and stops processing only when released', async () => {
  const f = fixture();
  const meter = f.mount();
  const connected = meter.connect(f.gain() as unknown as GainNode);
  f.loads[0].resolve();
  await connected;
  const port = { onmessage: null as ((event: { data: string }) => void) | null, postMessage() {}, close() {} };
  let Processor!: new (options: object) => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
  runInNewContext(await f.blobs[0].text(), {
    AudioWorkletProcessor: class { port = port; },
    sampleRate: 48000,
    registerProcessor: (_name: string, value: typeof Processor) => { Processor = value; },
  });
  const processor = new Processor({});
  assert.equal(processor.process([[]], [[]]), true, 'silence must not permanently disable the meter');
  assert.equal(processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]), true);
  port.onmessage!({ data: 'stop' });
  assert.equal(processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]), false);
  meter.dispose();
});
