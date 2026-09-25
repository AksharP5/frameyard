/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Computed, PathData, entityWorldMat, invert2D, transformPoint } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '../editor';
import { syncKeyframe } from '../keyframes';
import { getToolCursor, updateCursor } from './cursor';
import { editablePath, movePathHandle, pathCoordinateMatrix, serializeEditablePath } from './path-editing';

import type { DispatchedPointerEvent, Mat2D, Point } from '@diffusionstudio/runtime';
import type { EditableSegment, PathHandle } from './path-editing';
import type { Entity, World } from 'koota';

type Gesture = {
	entity: Entity;
	segments: readonly EditableSegment[];
	index: number;
	handle: PathHandle;
	start: Point;
	inverse: Mat2D;
	original: string;
	last: string;
};

const gestures = new WeakMap<World, Gesture>();

export function pathMatrix(world: World, entity: Entity): Mat2D | null {
	const size = entity.get(Computed);
	if (!size) return null;
	return pathCoordinateMatrix(entityWorldMat(world, entity), entity.get(PathData)?.viewBox, size.width, size.height);
}

/** Canvas path handles write the same `d` prop as the inspector, in one undo gesture. */
export function handlePathInteraction(world: World, event: DispatchedPointerEvent): void {
	if (event.target.kind !== 'hud') return;
	if (event.type === 'dragend') {
		gestures.delete(world);
		updateCursor(world, getToolCursor(world));
		return;
	}
	const entity = event.target.entity;
	if (!entity?.isAlive()) return;

	if (event.type === 'pointerenter') updateCursor(world, 'cross');
	if (event.type === 'pointerleave') updateCursor(world, getToolCursor(world));

	if (event.type === 'dragstart') {
		const match = /^path:(\d+):(anchor|control1|control2)$/.exec(event.target.id);
		const matrix = pathMatrix(world, entity);
		const d = entity.get(Computed)?.pathData;
		if (!match || !matrix || !d) return;
		const inverse = invert2D(matrix);
		gestures.set(world, {
			entity, segments: editablePath(d), index: Number(match[1]), handle: match[2] as PathHandle,
			start: transformPoint(inverse, event.clientX, event.clientY), inverse, original: d, last: d,
		});
		updateCursor(world, 'move');
		return;
	}

	const gesture = gestures.get(world);
	if (event.type !== 'drag' || !gesture || gesture.entity !== entity) return;
	const point = transformPoint(gesture.inverse, event.clientX, event.clientY);
	const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
	const d = Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005 ? gesture.original
		: serializeEditablePath(movePathHandle(gesture.segments, gesture.index, gesture.handle, dx, dy));
	if (d === gesture.last) return;
	const editor = getDocumentEditor(world);
	editor.editProperty(entity, 'd', d);
	syncKeyframe(world, editor, entity, 'd', d);
	gesture.last = d;
	updateCursor(world, 'move');
}
