/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Moving and trimming clips. A gesture lives on the entities it touches — the
 * snapshot traits say a drag is in flight and what it started from — rather
 * than in a variable here, so a clip scrolled off screen and back is still
 * being dragged, and so the drag survives the frame it began on.
 *
 * Every write goes through the editor's time props, so dragging a clip in the
 * timeline is the same edit as typing its start into the inspector.
 */

import {
	AdjustmentLayer,
	ChildOf,
	ClipDragOrigin,
	Computed,
	Geometry,
	Group,
	KeyframeDragOrigin,
	Sequential,
	TrimDragOrigin,
	getParentEntity,
	getEntityTree,
	store,
} from '@diffusionstudio/runtime';
import { Or } from 'koota';

import { resolveSequentialOverlaps } from '../overlap';
import { authoredTime, moveEntityTo } from '../timing';
import { editableClipTargets, isClipLocked, selectedClips, trimLinkedClips } from '../clip-links';
import { findSnapDelta, findSnapFrame } from './snapping';
import { timelineEditing, slipClips, rippleTrim, rollOrSlide, type EditMode } from '../timeline-editing';
import { framesToPixels, getResolution, getTimelineScene, pixelsToFrames } from './view';

import type { Entity, World } from 'koota';
import type { TimelineSurfaceState } from './surface';

const NODES = Or(Geometry, Group, AdjustmentLayer);
const gestures = new WeakMap<World, { entity: Entity; mode: EditMode; applied: number }>();

/** Which edge of a clip a trim is holding. */
export type TrimEdge = 'in' | 'out';

/**
 * Opens and closes the gestures in flight, once a frame before anything is
 * drawn.
 *
 * Closing is what has to happen here rather than where the drag was applied:
 * a gesture ends when the pointer is let go, which is not an event any clip
 * receives — the clip only ever hears that it is still being dragged.
 */
export function updateDragGestures(world: World, surface: TimelineSurfaceState): void {
	const position = surface.pointer?.position;
	const dragging = !!position && position.state !== 'idle';

	if (!dragging) {
		endGesture(world, ClipDragOrigin);
		endGesture(world, TrimDragOrigin);
		gestures.delete(world);
		// Keyframes have no sequence to settle: they sit where they are put.
		for (const keyframe of world.query(KeyframeDragOrigin)) keyframe.remove(KeyframeDragOrigin);
		return;
	}

	// Apply the whole move before drawing. Offscreen linked clips still travel.
	const scene = getTimelineScene(world);
	if (scene && world.query(NODES, ClipDragOrigin).length) applyClipDrag(world, surface, getResolution(world, scene));
}

/**
 * Ends whichever gesture `origin` marks: the snapshots come off, and the
 * sequences the clips landed in are settled around them (the clips that moved
 * win, and their neighbours give way).
 */
function endGesture(world: World, origin: typeof ClipDragOrigin | typeof TrimDragOrigin): void {
	const moved = [...world.query(NODES, origin)];
	if (moved.length === 0) return;

	for (const entity of moved) entity.remove(origin);

	const mode = gestures.get(world)?.mode ?? 'trim';
	if (mode === 'trim' || (origin === ClipDragOrigin && mode !== 'slip' && mode !== 'slide')) resolveSequentialOverlaps(world, moved);
}

/** Notes where `entity` is, so the frames of the drag can be measured from it. */
export function beginClipDrag(world: World, entity: Entity): void {
	gestures.set(world, { entity, mode: timelineEditing(world).mode(), applied: 0 });
	const computed = store(world, Computed);
	const targets = editableClipTargets(world, [...selectedClips(world), entity]);
	for (const clip of targets) {
		if (!clip.has(Geometry) && !clip.has(Group) && !clip.has(AdjustmentLayer)) continue;
		const eid = clip.id();
		clip.add(ClipDragOrigin);
		clip.set(ClipDragOrigin, {
			authored: authoredTime(world, clip, 'start') ?? 0,
			start: computed.start[eid] ?? 0,
			end: computed.end[eid] ?? 0,
		});
	}
}

/**
 * Places `entity` at where it started plus how far the pointer has come,
 * pulled to a snap if one is near, and never before the start of the scene.
 */
export function applyClipDrag(
	world: World,
	surface: TimelineSurfaceState,
	resolution: number,
): void {
	const clips = [...world.query(NODES, ClipDragOrigin)];
	if (!clips.length) return;
	const rawOffset = pixelsToFrames(draggedPixels(surface), resolution);
	const gesture = gestures.get(world);
	if (gesture?.mode === 'slip' || gesture?.mode === 'slide') {
		const delta = rawOffset - gesture.applied;
		gesture.applied += gesture.mode === 'slip'
			? slipClips(world, gesture.entity, delta)
			: rollOrSlide(world, gesture.entity, 'slide', 'out', delta);
		return;
	}

	const floor = -earliestDraggedStart(world);
	const offset = Math.max(rawOffset, floor);

	// One snap for the whole drag, found from every clip in it — unless it
	// would pull the drag back past the floor the pointer just hit.
	const snap = findSnapDelta(world, resolution, offset);
	const snapped = snap !== null && offset - snap.delta >= floor;
	const wanted = offset - (snapped ? snap.delta : 0);
	let lower = floor;
	let upper = Number.POSITIVE_INFINITY;
	for (const clip of clips) {
		const parent = getParentEntity(clip);
		if (!parent?.has(Sequential)) continue;
		const origin = clip.get(ClipDragOrigin)!;
		for (const sibling of world.query(NODES, ChildOf(parent))) {
			if (!getEntityTree(world, sibling).some(isClipLocked)) continue;
			const timing = sibling.get(Computed);
			if (!timing) continue;
			if (timing.end <= origin.start) lower = Math.max(lower, timing.end - origin.start);
			else if (timing.start >= origin.end) upper = Math.min(upper, timing.start - origin.end);
			else { lower = Math.max(lower, 0); upper = Math.min(upper, 0); }
		}
	}
	const delta = Math.max(lower, Math.min(upper, wanted));
	if (snapped && delta === wanted) surface.snapX = framesToPixels(snap.frame, resolution);
	for (const clip of clips) moveEntityTo(world, clip, clip.get(ClipDragOrigin)!.start + delta);
}

/** Where the first clip of the drag in flight started, from the snapshots. */
function earliestDraggedStart(world: World): number {
	const origins = store(world, ClipDragOrigin);
	let earliest = Number.POSITIVE_INFINITY;
	for (const entity of world.query(NODES, ClipDragOrigin)) {
		earliest = Math.min(earliest, origins.start[entity.id()] ?? 0);
	}
	return Number.isFinite(earliest) ? earliest : 0;
}

/** Notes where `entity`'s edges are, so a trim can be measured from them. */
export function beginTrim(world: World, entity: Entity): void {
	gestures.set(world, { entity, mode: timelineEditing(world).mode(), applied: 0 });
	const computed = store(world, Computed);
	for (const clip of editableClipTargets(world, [entity])) {
		const eid = clip.id();
		clip.add(TrimDragOrigin);
		clip.set(TrimDragOrigin, { start: computed.start[eid] ?? 0, end: computed.end[eid] ?? 0 });
	}
}

/**
 * Moves the edge being held to where the pointer has taken it, within what
 * the clip can actually do: never past its other edge, and never past the end
 * of what it has to play.
 */
export function applyTrim(
	world: World,
	surface: TimelineSurfaceState,
	entity: Entity,
	edge: TrimEdge,
	resolution: number,
): void {
	const origin = entity.get(TrimDragOrigin)!;
	const offset = pixelsToFrames(draggedPixels(surface), resolution);

	const wanted = (edge === 'in' ? origin.start : origin.end) + offset;

	// Snapped only where the snap is somewhere the edge could have gone
	// anyway; otherwise it would look like it stuck and then slipped.
	const gesture = gestures.get(world);
	const snapped = gesture?.mode === 'trim' ? findSnapFrame(world, resolution, wanted) : null;
	if (gesture?.mode === 'ripple' || gesture?.mode === 'roll') {
		const delta = (snapped ?? wanted) - origin[edge === 'in' ? 'start' : 'end'] - gesture.applied;
		gesture.applied += gesture.mode === 'ripple'
			? rippleTrim(world, entity, edge, delta)
			: rollOrSlide(world, entity, 'roll', edge, delta);
	} else trimLinkedClips(world, entity, edge, snapped ?? wanted);
	const actual = entity.get(Computed)?.[edge === 'in' ? 'start' : 'end'];
	if (snapped !== null && actual === snapped) surface.snapX = framesToPixels(snapped, resolution);
}

/** How far the pointer has come since the press, in pixels. */
function draggedPixels(surface: TimelineSurfaceState): number {
	const position = surface.pointer?.position;
	return position && position.state !== 'idle' ? position.deltaX : 0;
}

/** Whether a gesture is currently moving `entity`. */
export function isDragging(entity: Entity): boolean {
	return entity.has(ClipDragOrigin) || entity.has(TrimDragOrigin);
}
