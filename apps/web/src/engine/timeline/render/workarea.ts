/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Workarea } from '@diffusionstudio/runtime';

import { assert } from '@/utils';
import { editWorkarea } from '../../timing';
import { IN_POINT_PATH, OUT_POINT_PATH } from '../paths';
import { RULER_HEIGHT } from '../config';
import { getSnapFrames, nearestSnap } from '../snapping';
import { framesToPixels, getResolution, getScrollX, pixelsToFrames } from '../view';

import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from '../surface';

const HANDLE_WIDTH = 5;
const BAR_HEIGHT = 10;

// Where the work area was when the drag started: every frame of the drag is
// measured from there, so a slow drag and a fast one land in the same place.
let dragOrigin: [start: number, end: number] = [0, 0];
let snapFrames: number[] = [];

/**
 * The work area — the stretch of the scene that plays and exports — as a bar
 * in the ruler with a handle at each end. Drag the bar to move the window,
 * a handle to move one edge, double-click to drop it altogether.
 */
export function renderWorkarea(world: World, scene: Entity, surface: TimelineSurfaceState): void {
	const { ctx, pointer } = surface;
	if (!ctx || !pointer) return;
	if (!scene.has(Workarea)) return;

	const workarea = scene.get(Workarea)!;
	const scrollX = getScrollX(world, scene);
	const resolution = getResolution(world, scene);

	const inPx = framesToPixels(workarea.start, resolution);
	const outPx = framesToPixels(workarea.end, resolution);
	const y = RULER_HEIGHT - BAR_HEIGHT;

	/** The delta of the drag in flight, in frames. */
	const draggedFrames = (): number => {
		assert(pointer.position, 'Pointer position must be set');
		assert(pointer.position.state !== 'idle', 'Pointer must be pressing');
		return pixelsToFrames(pointer.position.deltaX, resolution);
	};
	const beginDrag = (): void => {
		dragOrigin = [workarea.start, workarea.end];
		snapFrames = getSnapFrames(world, true);
	};

	ctx.save();
	ctx.translate(-(scrollX * resolution), 0);

	// The bar itself: drag to move the window, double-click to remove it.
	{
		const { hovering, dragging, pressed, doubleClicked } = pointer
			.scope('workarea')
			.region(inPx, y, outPx - inPx, BAR_HEIGHT);

		if (hovering) surface.cursor = 'grab';
		if (pressed) beginDrag();

		if (dragging) {
			const delta = Math.max(-dragOrigin[0], draggedFrames());
			const start = dragOrigin[0] + delta;
			const end = dragOrigin[1] + delta;
			const snap = nearestSnap(snapFrames, [start, end], resolution);
			const offset = snap && start - snap.delta >= 0 ? snap.delta : 0;
			if (snap && offset === snap.delta) surface.snapX = framesToPixels(snap.frame, resolution);
			editWorkarea(world, scene, [start - offset, end - offset]);
			surface.cursor = 'grabbing';
		}

		if (doubleClicked) {
			editWorkarea(world, scene, null);
			ctx.restore();
			return;
		}

		// Difference rather than a fill: the bar reads over the ruler's ticks
		// and over the playhead alike, whatever is behind it.
		ctx.globalCompositeOperation = 'difference';
		ctx.fillStyle = 'rgba(100, 100, 100, 1)';
		ctx.fillRect(inPx, y, outPx - inPx, BAR_HEIGHT);
		ctx.globalCompositeOperation = 'source-over';
	}

	ctx.lineWidth = 1;
	ctx.fillStyle = surface.colors.border.ring;
	ctx.strokeStyle = surface.colors.border.darker;

	// The in handle, drawn from its own origin so the path needs no offset.
	{
		ctx.translate(inPx - HANDLE_WIDTH, y);
		ctx.stroke(IN_POINT_PATH);
		ctx.fill(IN_POINT_PATH);

		const { hovering, dragging, pressed } = pointer.region(0, 0, HANDLE_WIDTH, BAR_HEIGHT);

		if (hovering || dragging) surface.cursor = 'ew-resize';
		if (pressed) beginDrag();
		if (dragging) {
			const wanted = Math.max(0, Math.min(dragOrigin[1] - 1, dragOrigin[0] + draggedFrames()));
			const snap = nearestSnap(snapFrames.filter(frame => frame >= 0 && frame < dragOrigin[1]), [wanted], resolution);
			if (snap) surface.snapX = framesToPixels(snap.frame, resolution);
			editWorkarea(world, scene, [snap?.frame ?? wanted, dragOrigin[1]]);
		}
	}

	// The out handle, relative to the in handle the context is now at.
	{
		ctx.translate(outPx - inPx + HANDLE_WIDTH, 0);
		ctx.stroke(OUT_POINT_PATH);
		ctx.fill(OUT_POINT_PATH);

		const { hovering, dragging, pressed } = pointer.region(0, 0, HANDLE_WIDTH, BAR_HEIGHT);

		if (hovering || dragging) surface.cursor = 'ew-resize';
		if (pressed) beginDrag();
		if (dragging) {
			const wanted = Math.max(dragOrigin[0] + 1, dragOrigin[1] + draggedFrames());
			const snap = nearestSnap(snapFrames.filter(frame => frame > dragOrigin[0]), [wanted], resolution);
			if (snap) surface.snapX = framesToPixels(snap.frame, resolution);
			editWorkarea(world, scene, [dragOrigin[0], snap?.frame ?? wanted]);
		}
	}

	ctx.restore();
}
