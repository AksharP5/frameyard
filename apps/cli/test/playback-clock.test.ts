import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../../web/src/engine/create-engine.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
  plugins: [{ name: 'engine-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => args.kind === 'entry-point' ? undefined : { path: args.path, external: true });
  } }],
});

function fixture() {
  let now = 0, nextId = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const time = Symbol('Time'), keys = Symbol('Keys'), audio = Symbol('AudioEngine');
  const values = new Map<symbol, unknown>([[keys, { pressed: new Set(), held: new Set(), lifted: new Set() }]]);
  const ticks: { now: number; delta: number }[] = [];
  const world = {
    add() {}, onAdd: () => () => {}, onRemove: () => () => {},
    get: (key: symbol) => values.get(key), set: (key: symbol, value: unknown) => values.set(key, value),
  };
  const noop = () => {};
  const runtime = {
    Time: time, AudioEngine: audio, ChildOf: () => {}, createRuntimeWorld: () => world,
    syncInteractiveState: noop, inputSystem: noop, assetSystem: noop, renderSystem: noop,
    motionSystem: noop, transformSystem: noop,
    playbackSystem: () => ticks.push(values.get(time) as { now: number; delta: number }),
  };
  const dependencies = {
    '@diffusionstudio/runtime': runtime,
    'solid-js': { createSignal<T>(initial: T) {
      let value = initial;
      return [() => value, (next: T | ((previous: T) => T)) => { value = typeof next === 'function' ? (next as (previous: T) => T)(value) : next; }];
    } },
    './traits': { Keys: keys },
    './input/input-system': { inputSystem: noop },
    './input/shortcuts': { shortcutSystem: noop },
    './source-errors': { sourceErrorSystem: noop },
    './hud': { hudSystem: noop },
    './timeline': { timelineSystem: noop },
  };
  const module = { exports: {} as typeof import('../../web/src/engine/create-engine.ts') };
  runInNewContext(built.outputFiles[0].text, {
    module, require: (name: keyof typeof dependencies) => dependencies[name],
    ResizeObserver: class {},
    performance: { now: () => now },
    requestAnimationFrame: (callback: () => void) => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const context = { createGain: () => ({ connect() {} }), destination: {} } as unknown as AudioContext;
  const engine = module.exports.createEngine('clock-test', { audioContext: context });
  const advance = (target: number) => {
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = target;
  };
  const frame = (at: number) => {
    advance(at);
    const next = frames.entries().next().value;
    assert.ok(next); frames.delete(next[0]); next[1]();
  };
  return { engine, ticks, advance, frame, pending: () => frames.size + timers.size, pendingFrame: () => frames.keys().next().value };
}

test('playback ticks continue within the audio lookahead when display frames stop', () => {
  const f = fixture();
  f.engine.start();
  f.frame(16);
  f.advance(1016);
  assert.equal(f.ticks.length, 11);
  const elapsed = f.ticks.reduce((sum, tick) => sum + tick.delta, 0);
  assert.ok(elapsed >= 980 && elapsed <= 1000);
  assert.ok(f.ticks.slice(1).every(tick => tick.delta > 0 && tick.delta <= 100));
  const count = f.ticks.length;
  f.engine.stop();
  assert.equal(f.pending(), 0);
  f.advance(2016);
  assert.equal(f.ticks.length, count, 'stopping cancels the display callback and the fallback');
});

test('the fallback preserves a waiting display frame and resumes without double-counting elapsed time', () => {
  const f = fixture();
  f.engine.start();
  for (const at of [16, 32, 48, 64]) f.frame(at);
  assert.deepEqual(f.ticks.map(tick => tick.delta), [0, 16, 16, 16]);
  const waitingFrame = f.pendingFrame();
  f.advance(164);
  assert.equal(f.pendingFrame(), waitingFrame, 'the audio fallback must not cancel a queued display frame');
  f.frame(165);
  f.advance(263);
  assert.equal(f.ticks.length, 6, 'the fallback canceled by the resumed display frame cannot run');
  assert.ok(f.ticks.at(-1)!.delta > 0 && f.ticks.at(-1)!.delta < 5);
  f.engine.stop();
  f.engine.start();
  f.frame(280);
  assert.equal(f.ticks.at(-1)?.delta, 0, 'restarting excludes paused time');
  f.engine.stop();
});
