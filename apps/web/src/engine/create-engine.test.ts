import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const traits = new Map<unknown, unknown>();
  const world = { isInitialized: true, add: vi.fn(), onAdd: vi.fn(() => () => {}), onRemove: vi.fn(() => () => {}), query: vi.fn(() => []), get: vi.fn((trait: unknown) => traits.get(trait)), set: vi.fn((trait: unknown, value: unknown) => traits.set(trait, value)), destroy: vi.fn() };
  return { world, traits, render: vi.fn(), handle: vi.fn(() => () => {}) };
});
vi.mock('@diffusionstudio/runtime', () => ({
  createRuntimeWorld: () => mocks.world, ChildOf: () => 'child', Geometry: 'geometry', Playback: 'playback', Mode: 'mode', RenderSurface: 'surface', Time: 'time', AudioEngine: 'audio',
  assetSystem: vi.fn(), renderSystem: mocks.render, transformSystem: vi.fn(), playbackSystem: vi.fn(), motionSystem: vi.fn(), syncInteractiveState: vi.fn(),
}));
vi.mock('./hud', () => ({ hudSystem: vi.fn() }));
vi.mock('./traits', () => ({ AssetSelection: 'asset', Hud: 'hud', Keys: 'keys', MODIFIER_KEYS: new Set(), ObjectMaskTool: 'mask', Pointer: 'pointer', PointerEvents: 'events', ProjectConfig: 'config', SnapLines: 'snap' }));
vi.mock('./input/input-system', () => ({ inputSystem: vi.fn() }));
vi.mock('./input/shortcuts', () => ({ shortcutSystem: vi.fn() }));
vi.mock('./timeline', () => ({ clearClipFrames: vi.fn(), clearClipPeaks: vi.fn(), clearMedia: vi.fn(), clearPeaks: vi.fn(), timelineSystem: vi.fn(), TimelineSurface: 'timeline' }));
vi.mock('./object-mask', () => ({ clearObjectTrackOf: vi.fn(), clearObjectTracks: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ mainBridge: { handle: mocks.handle } }));

import { createEngine } from './create-engine';

describe('background project engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.traits.clear();
    vi.stubGlobal('window', { location: { search: '?workspace=background' }, removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('AudioContext', class {
      destination = {};
      createGain() { return { connect: vi.fn(), disconnect: vi.fn() }; }
      close() {}
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('computes requested frames without leaving idle scheduling work', () => {
    const engine = createEngine('background');
    engine.start();
    expect(engine.frame()).toBe(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    engine.requestFrame();
    expect(engine.frame()).toBe(2);
    engine.stop();
    engine.requestFrame();
    expect(engine.frame()).toBe(2);
    engine.dispose();
  });

  it('resumes presentation when shown and cancels it when hidden again', () => {
    const engine = createEngine('background');
    engine.start();
    engine.setVisible(true);
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    engine.setVisible(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.frame()).toBe(2);
    engine.dispose();
  });
});
