/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { Markers } from '@diffusionstudio/runtime';
import { editMarker, seekTimeline } from '../../timeline-navigation';
import { RULER_HEIGHT } from '../config';
import { framesToPixels, getResolution, getScrollX, pixelsToFrames } from '../view';
import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from '../surface';

const dragOrigins = new WeakMap<World, { id: string; time: number }>();
export function renderMarkers(world: World, scene: Entity, surface: TimelineSurfaceState): void {
	const { ctx, pointer, canvas } = surface;
	if (!ctx || !pointer || !canvas) return;
	const markers = scene.get(Markers)?.value;
	if (!markers?.length) return;
	const resolution = getResolution(world, scene);
	const scroll = getScrollX(world, scene) * resolution;
	for (const marker of markers) {
		const x = framesToPixels(marker.time, resolution) - scroll;
		if (x < -8 || x > canvas.width) continue;
		const hit = pointer.scope(`marker-${marker.id}`).region(x - 5, RULER_HEIGHT - 10, 10, 10);
		if (hit.pressed) dragOrigins.set(world, { id: marker.id, time: marker.time });
		const origin = dragOrigins.get(world);
		const position = pointer.position;
		if (hit.dragging && origin?.id === marker.id && position && position.state !== 'idle') {
			editMarker(world, scene, marker.id, { time: origin.time + pixelsToFrames(position.deltaX, resolution) });
		}
		if (hit.clicked) seekTimeline(world, marker.time);
		if (hit.hovering || hit.dragging) surface.cursor = 'ew-resize';
		ctx.fillStyle = '#e8b75d';
		ctx.beginPath();
		ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x - 5, RULER_HEIGHT - 5);
		ctx.lineTo(x, RULER_HEIGHT - 10); ctx.lineTo(x + 5, RULER_HEIGHT - 5);
		ctx.closePath(); ctx.fill();
		if (hit.hovering) {
			ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
			ctx.fillText(marker.name, x + 7, RULER_HEIGHT - 10);
		}
	}
}
