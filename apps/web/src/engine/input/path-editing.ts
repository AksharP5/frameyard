/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { multiply2D, parsePathData } from '@diffusionstudio/runtime';
import type { Mat2D } from '@diffusionstudio/runtime';

export type PathPoint = { x: number; y: number };
export type EditableSegment =
	| { command: 'M' | 'L'; end: PathPoint }
	| { command: 'C'; control1: PathPoint; control2: PathPoint; end: PathPoint }
	| { command: 'Q'; control1: PathPoint; end: PathPoint }
	| { command: 'A'; arc: [number, number, number, number, number]; end: PathPoint }
	| { command: 'Z' };
export type PathHandle = 'anchor' | 'control1' | 'control2';

/** Path coordinates to canvas device pixels, including an optional SVG viewBox. */
export function pathCoordinateMatrix(entityMatrix: Mat2D, viewBox: readonly [number, number, number, number] | undefined, width: number, height: number): Mat2D | null {
	const matrix = viewBox ? multiply2D(entityMatrix, {
		a: width / viewBox[2], b: 0, c: 0, d: height / viewBox[3],
		e: -viewBox[0] * width / viewBox[2], f: -viewBox[1] * height / viewBox[3],
	}) : entityMatrix;
	const determinant = matrix.i === undefined ? matrix.a * matrix.d - matrix.b * matrix.c
		: matrix.a * (matrix.d * matrix.i - matrix.f * (matrix.h ?? 0))
			- matrix.c * (matrix.b * matrix.i - matrix.f * (matrix.g ?? 0))
			+ matrix.e * (matrix.b * (matrix.h ?? 0) - matrix.d * (matrix.g ?? 0));
	return !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12 ? null : matrix;
}

const TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
const cache = new Map<string, readonly EditableSegment[]>();

/** Read SVG paths as absolute segments so moving one point never shifts later relative commands. */
export function editablePath(d: string): readonly EditableSegment[] {
	const cached = cache.get(d);
	if (cached) return cached;
	parsePathData(d);
	const tokens = d.match(TOKEN) ?? [];
	const segments: EditableSegment[] = [];
	let index = 0;
	let command = '';
	let current: PathPoint = { x: 0, y: 0 };
	let start = current;
	while (index < tokens.length) {
		if (/^[a-zA-Z]$/.test(tokens[index]!)) {
			command = tokens[index++]!;
			if (command.toUpperCase() === 'Z') {
				segments.push({ command: 'Z' });
				current = start;
				command = '';
				continue;
			}
		}
		const operation = command.toUpperCase();
		const values = tokens.slice(index, index + ARITY[operation]!).map(Number);
		index += values.length;
		const relative = command !== operation;
		const point = (offset: number): PathPoint => ({
			x: values[offset]! + (relative ? current.x : 0),
			y: values[offset + 1]! + (relative ? current.y : 0),
		});
		const previous = segments.at(-1);
		if (operation === 'M') {
			current = point(0);
			start = current;
			segments.push({ command: 'M', end: current });
			command = relative ? 'l' : 'L';
		} else if (operation === 'L' || operation === 'H' || operation === 'V') {
			current = operation === 'H' ? { x: values[0]! + (relative ? current.x : 0), y: current.y }
				: operation === 'V' ? { x: current.x, y: values[0]! + (relative ? current.y : 0) } : point(0);
			segments.push({ command: 'L', end: current });
		} else if (operation === 'C' || operation === 'S') {
			const control1 = operation === 'C' ? point(0)
				: previous?.command === 'C' ? { x: 2 * current.x - previous.control2.x, y: 2 * current.y - previous.control2.y } : current;
			const control2 = point(operation === 'C' ? 2 : 0);
			current = point(operation === 'C' ? 4 : 2);
			segments.push({ command: 'C', control1, control2, end: current });
		} else if (operation === 'Q' || operation === 'T') {
			const control1 = operation === 'Q' ? point(0)
				: previous?.command === 'Q' ? { x: 2 * current.x - previous.control1.x, y: 2 * current.y - previous.control1.y } : current;
			current = point(operation === 'Q' ? 2 : 0);
			segments.push({ command: 'Q', control1, end: current });
		} else if (operation === 'A') {
			current = point(5);
			segments.push({ command: 'A', arc: values.slice(0, 5) as [number, number, number, number, number], end: current });
		}
	}
	if (cache.size >= 64) cache.delete(cache.keys().next().value!);
	cache.set(d, segments);
	return segments;
}

export function movePathHandle(path: readonly EditableSegment[], index: number, handle: PathHandle, dx: number, dy: number): EditableSegment[] {
	const segments = structuredClone([...path]);
	const segment = segments[index];
	if (!segment || segment.command === 'Z') return segments;
	const move = (point: PathPoint) => { point.x += dx; point.y += dy; };
	if (handle === 'anchor') {
		move(segment.end);
		if (segment.command === 'C') move(segment.control2);
		const next = segments[index + 1];
		if (next?.command === 'C') move(next.control1);
	} else if (handle === 'control1' && (segment.command === 'C' || segment.command === 'Q')) {
		move(segment.control1);
	} else if (handle === 'control2' && segment.command === 'C') {
		move(segment.control2);
	}
	return segments;
}

export function serializeEditablePath(segments: readonly EditableSegment[]): string {
	const number = (value: number) => String(Number(value.toFixed(3)));
	const point = ({ x, y }: PathPoint) => `${number(x)} ${number(y)}`;
	return segments.map((segment) => {
		if (segment.command === 'Z') return 'Z';
		if (segment.command === 'C') return `C ${point(segment.control1)} ${point(segment.control2)} ${point(segment.end)}`;
		if (segment.command === 'Q') return `Q ${point(segment.control1)} ${point(segment.end)}`;
		if (segment.command === 'A') return `A ${segment.arc.map(number).join(' ')} ${point(segment.end)}`;
		return `${segment.command} ${point(segment.end)}`;
	}).join(' ');
}
