import { expect, it } from 'vitest';
import { nearestSnap } from './snapping';

it('finds the closest edge among a large multi-clip drag', () => {
	const frames = Array.from({ length: 1_000 }, (_, index) => index * 100);
	const edges = new Set(frames.map((frame) => frame + 40));
	edges.add(43_203);

	expect(nearestSnap(frames, edges, 1)).toEqual({ frame: 43_200, delta: 3 });
});

it('keeps the pixel snap threshold at fractional zoom', () => {
	expect(nearestSnap([100], [119], 0.5)).toEqual({ frame: 100, delta: 19 });
	expect(nearestSnap([100], [120], 0.5)).toBeNull();
});
