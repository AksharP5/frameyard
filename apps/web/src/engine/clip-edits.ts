/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AdjustmentLayer, ChildOf, Computed, Geometry, Group, Source, getActiveEntity, getParentEntity, isSequence, store } from '@diffusionstudio/runtime';
import { Or } from 'koota';
import { getDocumentEditor } from './editor';
import { moveEntityTo } from './timing';
import { getSyncTracks } from './timeline-editing';
import { clipRoots, editableClipTargets, isClipLocked, selectedClips, trimLinkedClips } from './clip-links';
import type { Entity, World } from 'koota';

const NODES = Or(Geometry, Group, AdjustmentLayer);

/** Only the selected subtree roots inside the active timeline are edited. */
export function timelineSelection(world: World, scene: Entity): Entity[] {
	const selected = new Set(selectedClips(world).filter((entity) => entity.has(Source)
		&& (entity.has(Geometry) || entity.has(Group) || entity.has(AdjustmentLayer))));
	return [...selected].filter((entity) => {
		if (entity === scene) return false;
		for (let parent = getParentEntity(entity); parent; parent = getParentEntity(parent)) {
			if (parent === scene) return true;
			if (selected.has(parent)) return false;
		}
		return false;
	});
}

/** Sequences expose their clips; a cut at an existing edge changes nothing. */
export function clipsAtFrame(world: World, targets: Entity[], frame: number): Entity[] {
	const computed = store(world, Computed);
	const clips = new Set<Entity>();
	const visit = (entity: Entity): void => {
		if (isClipLocked(entity)) return;
		if (computed.visibility[entity.id()] !== 1) return;
		if (isSequence(entity)) {
			for (const child of world.query(NODES, ChildOf(entity))) visit(child);
			return;
		}
		const start = computed.start[entity.id()] ?? 0;
		const end = computed.end[entity.id()] ?? 0;
		if (frame > start && frame < end) clips.add(entity);
	};
	for (const entity of targets) visit(entity);
	return [...clips];
}

export function trimSelectionAtPlayhead(world: World, edge: 'in' | 'out'): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	const frame = store(world, Computed).localTime[scene.id()] ?? 0;
	const edited = new Set<Entity>();
	for (const entity of clipsAtFrame(world, timelineSelection(world, scene), frame)) {
		if (edited.has(entity)) continue;
		for (const clip of trimLinkedClips(world, entity, edge, frame)) edited.add(clip);
	}
}

/** Delete selected clips and close their time spans in each affected container. */
export function rippleDeleteSelection(world: World): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	const selected = new Set(timelineSelection(world, scene));
	if (!selected.size) return;
	const computed = store(world, Computed);
	const affectedParents = new Set([...selected].map(getParentEntity));
	const parents = new Set([...affectedParents, ...getSyncTracks(world, scene)]);
	const moves: { entity: Entity; frame: number }[] = [];

	// Snapshot first: deleting or moving a child recomputes its container's bounds.
	for (const parent of parents) {
		if (!parent) continue;
		const siblings = [...world.query(NODES, Source, ChildOf(parent))];
		const removedClips = affectedParents.has(parent) ? siblings.filter((entity) => selected.has(entity)) : [...selected];
		const spans = removedClips.map((entity) => ({
			start: computed.start[entity.id()] ?? 0,
			end: computed.end[entity.id()] ?? 0,
		})).filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
			.sort((a, b) => a.start - b.start);
		const ranges: typeof spans = [];
		for (const span of spans) {
			const last = ranges.at(-1);
			if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
			else ranges.push({ ...span });
		}
		for (const entity of siblings) {
			if (selected.has(entity)) continue;
			const start = computed.start[entity.id()] ?? 0;
			const removed = ranges.reduce((total, range) => total + (range.end <= start ? range.end - range.start : 0), 0);
			if (removed > 0) moves.push({ entity, frame: start - removed });
		}
	}

	const editor = getDocumentEditor(world);
	// Later linked clips must shift together even when only one of their tracks
	// contains a deleted span. Snapshot all destinations before removing anything.
	const shifts = new Map<Entity, number>();
	for (const move of moves) {
		const delta = move.frame - (computed.start[move.entity.id()] ?? 0);
		const clips = editableClipTargets(world, [move.entity]).filter((clip) => !selected.has(clip));
		const wanted = Math.min(delta, ...clips.map((clip) => shifts.get(clip) ?? 0));
		const earliest = Math.min(...clips.map((clip) => computed.start[clip.id()] ?? 0));
		for (const clip of clips) shifts.set(clip, Math.max(-earliest, wanted));
	}
	const destinations = clipRoots([...shifts.keys()]).map((entity) => ({ entity, frame: (computed.start[entity.id()] ?? 0) + shifts.get(entity)! }));
	editor.remove([...selected]);
	for (const { entity, frame } of destinations) if (entity.isAlive()) moveEntityTo(world, entity, frame);
}
