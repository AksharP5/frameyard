import { afterEach, expect, it, vi } from 'vitest';
import { createPointer } from './pointer';

afterEach(() => vi.unstubAllGlobals());

it('discards a canceled press without producing a click', () => {
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLCanvasElement;
  const ctx = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) } as CanvasRenderingContext2D;
  const pointer = createPointer({ canvas, ctx });
  const event = (x: number, y: number) => ({ button: 0, clientX: x, clientY: y, shiftKey: false, altKey: false }) as PointerEvent;

  pointer.move(event(10, 10));
  pointer.scope('clip').region(0, 0, 100, 100);
  pointer.reset();
  pointer.down(event(10, 10));
  expect(pointer.scope('clip').region(0, 0, 100, 100).pressed).toBe(true);
  pointer.reset();
  pointer.cancel();

  expect(pointer.position?.state).toBe('idle');
  expect(pointer.scope('clip').region(0, 0, 100, 100).clicked).toBe(false);
});
