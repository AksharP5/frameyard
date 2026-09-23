/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Canvas gradient construction from paint sub-entities (was part of
// systems/render.ts; split out because text rendering needs it before the
// render system moves in).

import { store } from '../world/store';
import { ChildOf, ColorStop, Position, Computed, SpatialParameters } from '../traits';
import { colorToCss } from '../utils/color';

import type { Entity, World } from 'koota';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function addStopsTo(world: World, fill: Entity, gradient: CanvasGradient): void {
	const computed = store(world, Computed);
	const stops = [...world.query(ColorStop, ChildOf(fill))]
		.map(stop => {
			const raw = computed.stopOffset[stop.id()]!;
			return {
				offset: raw <= 1 ? Math.max(0, raw) : raw % 1,
				color: computed.color[stop.id()] ?? 0,
				opacity: computed.opacity[stop.id()] ?? 1,
			};
		})
		.sort((a, b) => a.offset - b.offset);

	for (const { offset, color, opacity } of stops) {
		gradient.addColorStop(offset, colorToCss(color, opacity));
	}
}

/** Create a canvas linear gradient from a gradient paint sub-entity. */
export function createLinearGradient(
	world: World,
	fill: Entity,
	ctx: Ctx2D,
	w: number,
	h: number,
): CanvasGradient {
	const computed = store(world, Computed);
	const fid = fill.id();
	if (fill.has(SpatialParameters)) {
		const gradient = ctx.createLinearGradient(computed.x1[fid]! * w, computed.y1[fid]! * h, computed.x2[fid]! * w, computed.y2[fid]! * h);
		addStopsTo(world, fill, gradient);
		return gradient;
	}

	// (px, py) is the gradient center in normalized shape-local space. Fills
	// without a Position trait (the default for stock gradient fills) get
	// (0.5, 0.5) so the gradient spans the shape. With Position present, the
	// motion-system-sampled Computed values are used (keyframeable).
	const hasPos = fill.has(Position);
	const px = hasPos ? computed.positionX[fid]! : 0.5;
	const py = hasPos ? computed.positionY[fid]! : 0.5;
	const sx = computed.scaleX[fid]!;
	const sy = computed.scaleY[fid]!;
	const angle = (computed.rotation[fid]! * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);

	// Transform normalized start (0, 0.5) and end (1, 0.5) points
	const startLocalX = (0 - 0.5) * sx;
	const startLocalY = (0.5 - 0.5) * sy;
	const x0 = (px + startLocalX * cos - startLocalY * sin) * w;
	const y0 = (py + startLocalX * sin + startLocalY * cos) * h;

	const endLocalX = (1 - 0.5) * sx;
	const endLocalY = (0.5 - 0.5) * sy;
	const x1 = (px + endLocalX * cos - endLocalY * sin) * w;
	const y1 = (py + endLocalX * sin + endLocalY * cos) * h;

	const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

	addStopsTo(world, fill, gradient);
	return gradient;
}

/** Create a canvas radial gradient from a gradient paint sub-entity. */
/** Elliptical radial paint, including an independent focal point. */
export function createRadialGradient(world: World, fill: Entity, ctx: Ctx2D, w: number, h: number): CanvasGradient {
 const c = fill.get(Computed)!;
 const explicit = fill.has(SpatialParameters);
 const cx = (explicit ? c.centerX : fill.has(Position) ? c.positionX : .5) * w;
 const cy = (explicit ? c.centerY : fill.has(Position) ? c.positionY : .5) * h;
 const rx = Math.max(.0001, Math.abs((explicit ? c.radiusX : c.scaleX / 2) * w));
 const ry = Math.max(.0001, Math.abs((explicit ? c.radiusY : c.scaleY / 2) * h));
 const angle = c.rotation * Math.PI / 180;
 const fx = explicit ? c.focalX * w - cx : 0, fy = explicit ? c.focalY * h - cy : 0;
 ctx.save();
 ctx.translate(cx, cy);
 ctx.rotate(angle);
 ctx.scale(rx, ry);
 const gradient = ctx.createRadialGradient((fx * Math.cos(angle) + fy * Math.sin(angle)) / rx, (-fx * Math.sin(angle) + fy * Math.cos(angle)) / ry, 0, 0, 0, 1);
 ctx.restore();
 addStopsTo(world, fill, gradient);
 return gradient;
}
