/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
	AdjustmentLayer, ClipLink, Computed, Geometry, Group, Locked, Selected, Source,
	findAssetDuration, getActiveEntity, getEntityChildren, getEntityTree, getParentEntity, getSceneAncestor, isScene, isSequence,
} from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { trimIn, trimOut } from './timing';

import type { Entity, World } from 'koota';

/** Descendants travel with their selected parent, never a second time. */
export function clipRoots(entities: Entity[]): Entity[] {
	const selected = new Set(entities.filter((entity) => entity.isAlive()));
	return [...selected].filter((entity) => {
		for (let parent = getParentEntity(entity); parent; parent = getParentEntity(parent)) {
			if (selected.has(parent)) return false;
		}
		return true;
	});
}

/** Link tokens are local to a scene. A container also carries its children's links. */
export function expandLinkedClips(world: World, entities: Entity[]): Entity[] {
	const result = new Set(entities.filter((entity) => entity.isAlive()));
	const candidates = [...world.query(ClipLink, Source)];
	if (!candidates.length) return [...result];
	const visited = new Set<Entity>();
	for (const entity of result) {
		for (const child of getEntityTree(world, entity)) {
			if (visited.has(child)) continue;
			visited.add(child);
			const link = child.get(ClipLink)?.value;
			const scene = getSceneAncestor(child);
			if (!link || !scene) continue;
			for (const peer of candidates) {
				if (peer.get(ClipLink)?.value === link && getSceneAncestor(peer) === scene) result.add(peer);
			}
		}
	}
	return [...result];
}

/** Whether a multi-selection is one linked unit, including linked children of containers. */
export function isLinkedSelection(world: World, entities: Entity[]): boolean {
	const roots = clipRoots(entities);
	if (roots.length < 2) return false;
	const linked = new Set(expandLinkedClips(world, [roots[0]!]));
	const connected = new Set<Entity>([roots[0]!]);
	for (let size = -1; size !== connected.size;) {
		size = connected.size;
		for (const root of roots) {
			if (connected.has(root) || !getEntityTree(world, root).some((child) => linked.has(child))) continue;
			connected.add(root);
			for (const peer of expandLinkedClips(world, [root])) linked.add(peer);
		}
	}
	return connected.size === roots.length;
}

/** Alt-selection intentionally leaves linked partners out of subsequent edits. */
export function linkedEditTargets(world: World, entities: Entity[]): Entity[] {
	return getDocumentEditor(world).linkedSelection ? expandLinkedClips(world, entities) : entities;
}

export function isClipLocked(entity: Entity): boolean {
	for (let node: Entity | null = entity; node; node = getParentEntity(node)) {
		if (node.has(Locked)) return true;
	}
	return false;
}

/** A locked partner protects the entire linked edit; locked descendants protect their container. */
export function editableClipTargets(world: World, entities: Entity[]): Entity[] {
	const result = new Set<Entity>();
	for (const entity of clipRoots(entities)) {
		const peers = clipRoots(linkedEditTargets(world, [entity]));
		if (peers.some((peer) => getEntityTree(world, peer).some(isClipLocked))) continue;
		for (const peer of peers) result.add(peer);
	}
	return clipRoots([...result]);
}

export function selectedClips(world: World): Entity[] {
	return editableClipTargets(world, [...world.query(Selected)]);
}

function linkedGroupLocked(world: World, entity: Entity): boolean {
	return expandLinkedClips(world, [entity]).some((peer) => getEntityTree(world, peer).some(isClipLocked));
}

export function linkableSelection(world: World): Entity[] {
	const scene = getActiveEntity(world);
	if (!scene) return [];
	return clipRoots(expandLinkedClips(world, [...world.query(Selected)])).filter((entity) =>
		!isScene(entity) && !linkedGroupLocked(world, entity) && getSceneAncestor(entity) === scene && entity.has(Source)
		&& (entity.has(Geometry) || entity.has(Group) || entity.has(AdjustmentLayer)),
	);
}

export function linkSelection(world: World): void {
	const clips = linkableSelection(world);
	if (clips.length < 2) return;
	const existing = clips[0]!.get(ClipLink)?.value;
	if (existing && clips.every((clip) => clip.get(ClipLink)?.value === existing)) return;
	const editor = getDocumentEditor(world);
	const link = crypto.randomUUID();
	for (const clip of clips) editor.editProperty(clip, 'link', link);
	editor.select(clips);
}

export function unlinkSelection(world: World): void {
	const editor = getDocumentEditor(world);
	for (const clip of expandLinkedClips(world, [...world.query(Selected)])) {
		if (clip.has(ClipLink) && !linkedGroupLocked(world, clip)) editor.editProperty(clip, 'link', false);
	}
}

/** Scene-frame limits shared by drag handles, keyboard trims, and the inspector. */
export function clipTrimBounds(world: World, entity: Entity, edge: 'in' | 'out'): [number, number] {
	const computed = entity.get(Computed);
	const start = computed?.start ?? 0;
	const end = computed?.end ?? 0;
	let min = edge === 'in' ? 0 : start + 1;
	let max = edge === 'in' ? end - 1 : Number.POSITIVE_INFINITY;
	const parent = getParentEntity(entity);
	if (parent && isSequence(parent)) {
		for (const sibling of getEntityChildren(world, parent)) {
			if (sibling === entity || !getEntityTree(world, sibling).some(isClipLocked)) continue;
			const timing = sibling.get(Computed);
			if (!timing) continue;
			if (edge === 'in' && timing.end <= start) min = Math.max(min, timing.end);
			if (edge === 'out' && timing.start >= end) max = Math.min(max, timing.start);
		}
	}
	const duration = findAssetDuration(world, entity);
	if (duration !== null) {
		const rate = computed?.playbackRate || 1;
		const sourceStart = computed?.origin ?? 0;
		if (edge === 'in') min = Math.max(min, Math.ceil(sourceStart));
		else max = Math.min(max, Math.floor(sourceStart + duration / rate));
	}
	return [min, max];
}

/** Moves linked edges by the same amount, preserving existing A/V offsets. */
export function trimLinkedClips(world: World, entity: Entity, edge: 'in' | 'out', frame: number): Entity[] {
	const clips = editableClipTargets(world, [entity]);
	if (!clips.length) return [];
	const key = edge === 'in' ? 'start' : 'end';
	const targets = clips.map((clip) => ({ clip, edge: clip.get(Computed)?.[key] ?? 0 }));
	const wanted = Math.round(frame) - (entity.get(Computed)?.[key] ?? 0);
	let min = Number.NEGATIVE_INFINITY;
	let max = Number.POSITIVE_INFINITY;
	for (const target of targets) {
		const [lower, upper] = clipTrimBounds(world, target.clip, edge);
		min = Math.max(min, lower - target.edge);
		max = Math.min(max, upper - target.edge);
	}
	if (min > max) return clips;
	const delta = Math.max(min, Math.min(max, wanted));
	if (delta === 0) return clips;
	for (const target of targets) {
		if (edge === 'in') trimIn(world, target.clip, target.edge + delta);
		else trimOut(world, target.clip, target.edge + delta);
	}
	return clips;
}
