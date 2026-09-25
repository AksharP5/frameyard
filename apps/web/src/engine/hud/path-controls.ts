/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
	Computed, Geometry, GeometryType, HitRegions, RenderSurface, Tool, ToolType,
	getMaskSelection, rectToQuad, transformPoint, translate2D,
} from '@diffusionstudio/runtime';
import { COLORS } from '../timeline/constants';
import { editablePath } from '../input/path-editing';
import { handlePathInteraction, pathMatrix } from '../input/path-interactions';

import type { PathPoint, PathHandle } from '../input/path-editing';
import type { World } from 'koota';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draw and hit-test selected vector anchors and Bézier handles over the canvas. */
export function drawPathControls(world: World, ctx: Ctx2D, resolution: number): void {
	if (world.get(Tool)?.value !== ToolType.MOVE) return;
	const selection = getMaskSelection(world);
	if (selection.length !== 1) return;
	const entity = selection[0]!;
	if (entity.get(Geometry)?.value !== GeometryType.PATH) return;
	const d = entity.get(Computed)?.pathData;
	const matrix = pathMatrix(world, entity);
	if (!d || !matrix) return;
	const segments = editablePath(d);
	const canvas = world.get(RenderSurface)?.canvas;
	const regions = world.get(HitRegions)?.list;
	if (!canvas || !regions) return;
	const toDevice = ({ x, y }: PathPoint) => transformPoint(matrix, x, y);
	const accent = COLORS.border.ring;
	const hitSize = 14 * resolution;
	const radius = 3.5 * resolution;
	const drawHandle = (point: PathPoint, index: number, handle: PathHandle) => {
		const { x, y } = toDevice(point);
		if (x < -hitSize || y < -hitSize || x > canvas.width + hitSize || y > canvas.height + hitSize) return;
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fillStyle = handle === 'anchor' ? '#FFFFFF' : accent;
		ctx.fill();
		ctx.strokeStyle = accent;
		ctx.lineWidth = resolution;
		ctx.stroke();
		regions.push({
			target: { kind: 'hud', id: `path:${index}:${handle}`, entity, quad: rectToQuad(translate2D(x - hitSize / 2, y - hitSize / 2), hitSize, hitSize) },
			callback: handlePathInteraction,
		});
	};

	ctx.save();
	ctx.resetTransform();
	ctx.lineWidth = resolution;
	ctx.strokeStyle = accent;
	let current: PathPoint = { x: 0, y: 0 };
	let start = current;
	ctx.beginPath();
	for (const segment of segments) {
		if (segment.command === 'M') { current = segment.end; start = current; continue; }
		if (segment.command === 'Z') { current = start; continue; }
		const guides = segment.command === 'C'
			? [[current, segment.control1], [segment.end, segment.control2]]
			: segment.command === 'Q' ? [[current, segment.control1], [segment.end, segment.control1]] : [];
		for (const [from, to] of guides) {
			const a = toDevice(from!), b = toDevice(to!);
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
		}
		current = segment.end;
	}
	ctx.stroke();
	for (const [index, segment] of segments.entries()) {
		if (segment.command === 'Z') continue;
		if (segment.command === 'C' || segment.command === 'Q') drawHandle(segment.control1, index, 'control1');
		if (segment.command === 'C') drawHandle(segment.control2, index, 'control2');
		drawHandle(segment.end, index, 'anchor');
	}
	ctx.restore();
}
