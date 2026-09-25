import { describe, expect, it } from 'vitest';
import { transformPoint } from '@diffusionstudio/runtime';
import { editablePath, movePathHandle, pathCoordinateMatrix, serializeEditablePath } from './path-editing';

describe('canvas path editing', () => {
	it('normalizes relative and smooth curves, then moves an anchor with its adjoining handles', () => {
		const path = editablePath('m 10 20 c 10 0 20 10 30 0 s 10 -10 20 0 z');
		expect(path).toEqual([
			{ command: 'M', end: { x: 10, y: 20 } },
			{ command: 'C', control1: { x: 20, y: 20 }, control2: { x: 30, y: 30 }, end: { x: 40, y: 20 } },
			{ command: 'C', control1: { x: 50, y: 10 }, control2: { x: 50, y: 10 }, end: { x: 60, y: 20 } },
			{ command: 'Z' },
		]);
		const changed = movePathHandle(path, 1, 'anchor', 5, -2);
		expect(serializeEditablePath(changed)).toBe('M 10 20 C 20 20 35 28 45 18 C 55 8 50 10 60 20 Z');
		expect(serializeEditablePath(path)).toBe('M 10 20 C 20 20 30 30 40 20 C 50 10 50 10 60 20 Z');
	});

	it('keeps line, quadratic, and arc geometry editable without changing the source path first', () => {
		const path = editablePath('M0 0 H10 v10 q5 5 10 0 t10 0 A5 6 0 0 1 40 50 Z');
		expect(serializeEditablePath(path)).toBe('M 0 0 L 10 0 L 10 10 Q 15 15 20 10 Q 25 5 30 10 A 5 6 0 0 1 40 50 Z');
		expect(serializeEditablePath(movePathHandle(path, 5, 'anchor', -4, 3))).toContain('A 5 6 0 0 1 36 53');
	});

	it('maps path coordinates through the SVG view box', () => {
		const matrix = pathCoordinateMatrix({ a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 }, [10, 20, 100, 50], 200, 100);
		expect(matrix).not.toBeNull();
		expect(transformPoint(matrix!, 10, 20)).toEqual({ x: 30, y: 40 });
		expect(transformPoint(matrix!, 110, 70)).toEqual({ x: 230, y: 140 });
	});
});
