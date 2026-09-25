/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Interaction reads: the device-pixel geometry an editor points at (was
// utils/interaction.ts + parts of utils/coordinates.ts). Everything here is in
// canvas device pixels, the space the transform system leaves WorldTransform
// and WorldBounds in, so a pointer position can be compared against it without
// converting anything. Derived transforms are read from the SoA stores by
// entity id: the transform system writes them there without ever adding the
// traits.

import { Not, Or } from 'koota';

import {
	Anchor, Audio, Computed, Geometry, Group, LocalTransform, Offset, Selected,
	Sequential, WorldBounds, WorldTransform, Hidden, Locked, IsMask, Culled, Scene3D,
} from '../traits';
import { store } from '../world/store';
import { isStage } from './predicates';
import { getViewMatrix } from './camera';
import { getParentEntity } from './hierarchy';
import { pickScene3D } from '../systems/scene3d-render';
import { GeometryType } from '../constants';
import { spatialNode } from '../systems/spatial';
import {
	decompose2D, identity2D, invert2D, multiply2D, rectToQuad, rotate2D,
	scale2D, skew2D, transformPoint, translate2D,
} from '../math';

import type { Entity, World } from 'koota';
import type { Mat2D, Point, Quad } from '../math';

/**
 * World matrix of `entity`, or the view matrix for the stage (and for null,
 * which is what `getParentNode` answers for a top-level node). Parent-space
 * math over a root therefore works without a special case at the call site.
 */
export function entityWorldMat(world: World, entity: Entity | null): Mat2D {
	if (entity === null || isStage(entity)) return getViewMatrix(world);
	const projected = spatialNode(world, entity);
	if (projected) return projected.world;

	const transform = store(world, WorldTransform);
	const eid = entity.id();

	return {
		a: transform.a[eid] ?? 1, b: transform.b[eid] ?? 0,
		c: transform.c[eid] ?? 0, d: transform.d[eid] ?? 1,
		e: transform.e[eid] ?? 0, f: transform.f[eid] ?? 0,
	};
}

export function entityLocalMat(world: World, entity: Entity): Mat2D {
	const local = store(world, LocalTransform);
	const eid = entity.id();

	return {
		a: local.a[eid] ?? 1, b: local.b[eid] ?? 0,
		c: local.c[eid] ?? 0, d: local.d[eid] ?? 1,
		e: local.e[eid] ?? 0, f: local.f[eid] ?? 0,
	};
}

export function entityOffset(world: World, entity: Entity): Point {
	const offset = store(world, Offset);
	const eid = entity.id();

	return { x: offset.x[eid] ?? 0, y: offset.y[eid] ?? 0 };
}

export function entityAnchor(world: World, entity: Entity): Point {
	const anchor = store(world, Anchor);
	const eid = entity.id();

	return { x: anchor.x[eid] ?? 0.5, y: anchor.y[eid] ?? 0.5 };
}

/** The entity's box in device pixels, as [TL, TR, BR, BL]. */
export function entityQuad(world: World, entity: Entity): Quad {
	const computed = store(world, Computed);
	const eid = entity.id();
	const mat = multiply2D(
		entityWorldMat(world, entity),
		translate2D(computed.originX[eid] ?? 0, computed.originY[eid] ?? 0),
	);

	return rectToQuad(mat, computed.width[eid] ?? 0, computed.height[eid] ?? 0);
}

/** Whether a device-pixel point is inside the entity's box. */
export function isPointerInEntity(world: World, entity: Entity, point: Point): boolean {
	if (!isEntitySelectable(world, entity)) return false;
  const projected = spatialNode(world, entity);
  if (projected?.scene.has(Scene3D) && entity.has(Geometry)) return pickScene3D(world, projected.scene, point) === entity;
	const bounds = store(world, WorldBounds);
	const eid = entity.id();

	if (
		point.x < bounds.minX[eid] || point.x > bounds.maxX[eid] ||
		point.y < bounds.minY[eid] || point.y > bounds.maxY[eid]
	) {
		return false;
	}

	// Precise test: map the pointer into entity-local space so rotation/skew
	// don't produce false positives along the AABB's outer slack.
	const local = transformPoint(invert2D(entityWorldMat(world, entity)), point.x, point.y);
	const computed = store(world, Computed);
	const originX = computed.originX[eid] ?? 0;
	const originY = computed.originY[eid] ?? 0;

	return local.x >= originX && local.x <= originX + (computed.width[eid] ?? 0)
		&& local.y >= originY && local.y <= originY + (computed.height[eid] ?? 0);
}

/** Canvas picking excludes invisible content and respects inherited locks. */
export function isEntitySelectable(world: World, entity: Entity, includeMask = false): boolean {
	if (!entity.isAlive() || entity.has(Sequential) || entity.has(Audio) || entity.has(Culled)
		|| store(world, Computed).visibility[entity.id()] === 0 || spatialNode(world, entity)?.visible === false) return false;
	for (let node: Entity | null = entity; node; node = getParentEntity(node)) {
		if (node.has(Hidden) || node.has(Locked) || (node.has(IsMask) && (!includeMask || node !== entity))) return false;
	}
	return true;
}

/** Visible selection bounds exclude audio and non-spatial sequences. */
export function getMaskSelection(world: World): Entity[] {
	return [...world.query(Selected, Or(Geometry, Group), Not(Sequential), Not(Audio))].filter((entity) => isEntitySelectable(world, entity, true));
}

/** Nodes moved by a canvas transform, including sequences but excluding audio. */
export function getSelection(world: World): Entity[] {
	return [...world.query(Selected, Or(Geometry, Group), Not(Audio))];
}

/**
 * The box the selection is manipulated through, in device pixels: for one
 * node its own rotated/skewed frame, for several the upright AABB of them
 * all. Null when nothing selectable is selected.
 */
export type SelectionMask = {
	width: number;
	height: number;
	mat: Mat2D;
};

export function getSelectionMask(world: World): SelectionMask | null {
	const selection = getMaskSelection(world);
	if (selection.length === 0) return null;

	const computed = store(world, Computed);

	if (selection.length === 1 && (selection[0]!.get(Geometry)?.value ?? -1) >= GeometryType.MESH) {
    const bounds = store(world, WorldBounds), id = selection[0]!.id();
    return { width: bounds.maxX[id]! - bounds.minX[id]!, height: bounds.maxY[id]! - bounds.minY[id]!, mat: translate2D(bounds.minX[id]!, bounds.minY[id]!) };
  }
  if (selection.length === 1 && spatialNode(world, selection[0]!)) {
		const entity = selection[0]!, id = entity.id();
		return {
			width: computed.width[id] ?? 0, height: computed.height[id] ?? 0,
			mat: multiply2D(entityWorldMat(world, entity), translate2D(computed.originX[id] ?? 0, computed.originY[id] ?? 0)),
		};
	}
	if (selection.length === 1 && !spatialNode(world, selection[0]!)) {
		const entity = selection[0]!;
		const eid = entity.id();
		const worldMat = multiply2D(
			entityWorldMat(world, entity),
			translate2D(computed.originX[eid] ?? 0, computed.originY[eid] ?? 0),
		);
		const decomposed = decompose2D(worldMat);

		let mat = identity2D();
		mat = multiply2D(mat, translate2D(decomposed.x, decomposed.y));
		mat = multiply2D(mat, rotate2D(decomposed.rotation));
		mat = multiply2D(mat, scale2D(Math.sign(decomposed.scaleX) || 1, Math.sign(decomposed.scaleY) || 1));
		mat = multiply2D(mat, skew2D(decomposed.skewX, decomposed.skewY));

		return {
			width: (computed.width[eid] ?? 0) * Math.abs(decomposed.scaleX),
			height: (computed.height[eid] ?? 0) * Math.abs(decomposed.scaleY),
			mat,
		};
	}

	let minX = Infinity, minY = Infinity;
	let maxX = -Infinity, maxY = -Infinity;

	for (const entity of selection) {
		for (const point of entityQuad(world, entity)) {
			if (point.x < minX) minX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.x > maxX) maxX = point.x;
			if (point.y > maxY) maxY = point.y;
		}
	}

	return { width: maxX - minX, height: maxY - minY, mat: translate2D(minX, minY) };
}
