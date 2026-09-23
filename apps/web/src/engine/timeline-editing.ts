/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal } from 'solid-js';
import {
	Computed, Source, findAssetDuration, getActiveEntity, getEntityChildren, getEntityTree,
	getParentEntity, getSceneAncestor, getSourceFrameAt, isSequence,
} from '@diffusionstudio/runtime';
import { clipRoots, clipTrimBounds, editableClipTargets, expandLinkedClips, isClipLocked, linkedEditTargets } from './clip-links';
import { getDocumentEditor } from './editor';
import { resolveSequentialOverlaps } from './overlap';
import { authoredTime, editTime, moveEntityTo, trimIn, trimOut } from './timing';
import type { Entity, World } from 'koota';

export const EDIT_MODES = ['trim', 'ripple', 'roll', 'slip', 'slide'] as const;
export type EditMode = typeof EDIT_MODES[number];
type Edge = 'in' | 'out';

function createEditingState() {
	const [mode, setMode] = createSignal<EditMode>('trim');
	const [target, setTarget] = createSignal<Entity | null>(null);
	const [syncTracks, setSyncTracks] = createSignal<ReadonlySet<Entity>>(new Set());
	return { mode, setMode, target, setTarget, syncTracks, setSyncTracks, focused: false };
}
const editingStates = new WeakMap<World, ReturnType<typeof createEditingState>>();
export function timelineEditing(world: World) {
	let state = editingStates.get(world);
	if (!state) { state = createEditingState(); editingStates.set(world, state); }
	return state;
}

export function getTargetTrack(world: World): Entity | null {
	const target = timelineEditing(world).target();
	return target?.isAlive() && isSequence(target) && !isClipLocked(target)
		&& getSceneAncestor(target) === getActiveEntity(world) ? target : null;
}

export function toggleSyncTrack(world: World, track: Entity): void {
	const state = timelineEditing(world);
	const tracks = new Set(state.syncTracks());
	if (tracks.has(track)) tracks.delete(track); else tracks.add(track);
	state.setSyncTracks(tracks);
}

export function getSyncTracks(world: World, scene: Entity): Entity[] {
	return [...timelineEditing(world).syncTracks()].filter((track) => track.isAlive()
		&& !isClipLocked(track) && getSceneAncestor(track) === scene);
}

function children(world: World, parent: Entity): Entity[] {
	return getEntityChildren(world, parent).filter((clip) => clip.has(Source) && clip.has(Computed));
}

function protectedClip(world: World, clip: Entity): boolean {
	return getEntityTree(world, clip).some(isClipLocked);
}

/** Common movement limits keep unlocked material from crossing protected cuts. */
function movementBounds(world: World, moving: Entity[], ignored: Entity[] = []): [number, number] {
	const excluded = new Set([...moving, ...ignored]);
	let min = -Math.min(...moving.map((clip) => clip.get(Computed)!.start));
	let max = Number.POSITIVE_INFINITY;
	for (const clip of moving) {
		const parent = getParentEntity(clip);
		if (!parent || !isSequence(parent)) continue;
		const timing = clip.get(Computed)!;
		for (const other of children(world, parent)) {
			if (excluded.has(other) || !protectedClip(world, other)) continue;
			const adjacent = other.get(Computed)!;
			if (adjacent.end <= timing.start) min = Math.max(min, adjacent.end - timing.start);
			else if (adjacent.start >= timing.end) max = Math.min(max, adjacent.start - timing.end);
			else return [0, 0];
		}
	}
	return [min, max];
}

function clamp(delta: number, min: number, max: number): number {
	return min <= max ? Math.max(min, Math.min(max, Math.round(delta))) : 0;
}

function laterClips(world: World, scene: Entity, frame: number, parents: Entity[], excluded: Entity[]): Entity[] {
	const tracks = new Set([...parents, ...getSyncTracks(world, scene)]);
	const candidates = [...tracks].flatMap((parent) => children(world, parent))
		.filter((clip) => !excluded.includes(clip) && clip.get(Computed)!.start >= frame);
	return editableClipTargets(world, candidates).filter((clip) => !excluded.includes(clip));
}

/** Insert space on the chosen tracks; crossing clips split before their tails move. */
export function insertTimelineGap(world: World, scene: Entity, frame: number, duration: number, tracks?: Entity[]): boolean {
	frame = Math.max(0, Math.round(frame));
	duration = Math.round(duration);
	if (duration <= 0) return false;
	const target = getTargetTrack(world);
	const parents = tracks ?? (target ? [target] : [scene]);
	const roots = [...new Set([...parents, ...getSyncTracks(world, scene)])];
	const candidates: Entity[] = [];
	const visit = (parent: Entity) => {
		for (const clip of children(world, parent)) {
			if (isSequence(clip)) visit(clip);
			else if (clip.get(Computed)!.end > frame) candidates.push(clip);
		}
	};
	for (const parent of roots) {
		if (isClipLocked(parent)) return false;
		visit(parent);
	}
	const targets = clipRoots(expandLinkedClips(world, candidates));
	if (targets.some((clip) => protectedClip(world, clip))) return false;
	const later = targets.filter((clip) => clip.get(Computed)!.start >= frame);
	const crossing = targets.filter((clip) => clip.get(Computed)!.start < frame && clip.get(Computed)!.end > frame);
	const editor = getDocumentEditor(world);
	const pairs = editor.duplicateInPlace(crossing);
	for (const { original, copy } of pairs) {
		trimOut(world, original, frame);
		trimIn(world, copy, frame);
		later.push(copy);
	}
	const destinations = later.map((clip) => ({ clip, start: clip.get(Computed)!.start + duration }));
	for (const { clip, start } of destinations) moveEntityTo(world, clip, start);
	return true;
}

/** Rate-aware source slip leaves timeline bounds and clip duration pinned. */
export function slipClips(world: World, entity: Entity, delta: number): number {
	const clips = editableClipTargets(world, [entity]);
	if (!clips.length) return 0;
	const targets = clips.map((clip) => {
		const timing = clip.get(Computed)!;
		return { clip, timing, duration: findAssetDuration(world, clip),
			start: getSourceFrameAt(clip, timing.start), end: getSourceFrameAt(clip, timing.end) };
	});
	if (targets.some((target) => target.duration === null)) return 0;
	const min = Math.max(...targets.map((target) => -target.start / (target.timing.playbackRate || 1)));
	const max = Math.min(...targets.map((target) => (target.duration! - target.end) / (target.timing.playbackRate || 1)));
	const applied = clamp(delta, Math.ceil(min), Math.floor(max));
	if (!applied) return 0;
	for (const { clip, timing, start } of targets) {
		const sourceOut = authoredTime(world, clip, 'sourceOut');
		trimOut(world, clip, timing.end);
		const offset = applied * (timing.playbackRate || 1);
		if (sourceOut !== undefined) editTime(world, clip, 'sourceOut', sourceOut + offset);
		editTime(world, clip, 'sourceIn', start + offset);
	}
	return applied;
}

/** Ripple preserves the leading position when trimming in, and shifts later clips. */
export function rippleTrim(world: World, entity: Entity, edge: Edge, delta: number): number {
	const clips = editableClipTargets(world, [entity]);
	const scene = getSceneAncestor(entity);
	if (!clips.length || !scene) return 0;
	const targets = clips.map((clip) => ({ clip, start: clip.get(Computed)!.start, end: clip.get(Computed)!.end }));
	const parents = clips.map(getParentEntity).filter((parent): parent is Entity => parent !== null);
	const cut = Math.min(...targets.map((target) => target.end));
	if (parents.some((parent) => children(world, parent).some((clip) => !clips.includes(clip)
		&& clip.get(Computed)!.start >= cut && protectedClip(world, clip)))) return 0;
	const later = laterClips(world, scene, cut, parents, clips);
	const sign = edge === 'out' ? 1 : -1;
	let min = Number.NEGATIVE_INFINITY;
	let max = Number.POSITIVE_INFINITY;
	for (const target of targets) {
		const [lower, upper] = clipTrimBounds(world, target.clip, edge);
		const current = edge === 'in' ? target.start : target.end;
		min = Math.max(min, lower - current);
		max = Math.min(max, upper - current);
	}
	if (later.length) {
		const [lower, upper] = movementBounds(world, later, clips);
		min = Math.max(min, sign === 1 ? lower : -upper);
		max = Math.min(max, sign === 1 ? upper : -lower);
	}
	const applied = clamp(delta, min, max);
	if (!applied) return 0;
	const destinations = later.map((clip) => ({ clip, start: clip.get(Computed)!.start + sign * applied }));
	for (const target of targets) {
		if (edge === 'out') trimOut(world, target.clip, target.end + applied);
		else { trimIn(world, target.clip, target.start + applied); moveEntityTo(world, target.clip, target.start); }
	}
	for (const { clip, start } of destinations) moveEntityTo(world, clip, start);
	return applied;
}

/** Roll and slide require touching neighbours in a sequence; all affected edges share a clamp. */
export function rollOrSlide(world: World, entity: Entity, mode: 'roll' | 'slide', edge: Edge, delta: number): number {
	const clips = editableClipTargets(world, [entity]);
	if (!clips.length) return 0;
	const edits = new Map<Entity, Edge>();
	const addEdge = (clip: Entity, next: Edge): boolean => {
		const peers = clipRoots(linkedEditTargets(world, [clip]));
		if (peers.some((peer) => protectedClip(world, peer))) return false;
		for (const peer of peers) {
			if (edits.has(peer) && edits.get(peer) !== next) return false;
			edits.set(peer, next);
		}
		return true;
	};
	for (const clip of clips) {
		const parent = getParentEntity(clip);
		if (!parent || !isSequence(parent)) return 0;
		const timing = clip.get(Computed)!;
		const siblings = children(world, parent).filter((other) => !clips.includes(other));
		if (mode === 'slide' || edge === 'in') {
			const previous = siblings.find((other) => other.get(Computed)!.end === timing.start);
			if (!previous || !addEdge(previous, 'out')) return 0;
		}
		if (mode === 'slide' || edge === 'out') {
			const next = siblings.find((other) => other.get(Computed)!.start === timing.end);
			if (!next || !addEdge(next, 'in')) return 0;
		}
		if (mode === 'roll' && !addEdge(clip, edge)) return 0;
	}
	if (mode === 'slide' && clips.some((clip) => edits.has(clip))) return 0;
	let min = mode === 'slide' ? -Math.min(...clips.map((clip) => clip.get(Computed)!.start)) : Number.NEGATIVE_INFINITY;
	let max = Number.POSITIVE_INFINITY;
	const targets = [...edits].map(([clip, edge]) => ({ clip, edge, frame: clip.get(Computed)![edge === 'in' ? 'start' : 'end'] }));
	for (const target of targets) {
		const [lower, upper] = clipTrimBounds(world, target.clip, target.edge);
		min = Math.max(min, lower - target.frame); max = Math.min(max, upper - target.frame);
	}
	const applied = clamp(delta, min, max);
	if (!applied) return 0;
	const destinations = clips.map((clip) => ({ clip, start: clip.get(Computed)!.start + applied }));
	for (const target of targets) {
		if (target.edge === 'in') trimIn(world, target.clip, target.frame + applied);
		else trimOut(world, target.clip, target.frame + applied);
	}
	if (mode === 'slide') for (const { clip, start } of destinations) moveEntityTo(world, clip, start);
	return applied;
}

/** Moving a row to another track preserves its scene time and rejects protected overlaps. */
export function reparentTimelineClip(world: World, entity: Entity, parent: Entity, anchor?: Entity): boolean {
	if (isClipLocked(parent) || !editableClipTargets(world, [entity]).includes(entity)) return false;
	const timing = entity.get(Computed);
	if (!timing) return false;
	const { start, end } = timing;
	if (isSequence(parent)) {
		const covered = children(world, parent).filter((clip) => clip !== entity
			&& clip.get(Computed)!.start < end && clip.get(Computed)!.end > start);
		if (covered.some((clip) => !editableClipTargets(world, [clip]).includes(clip))) return false;
	}
	if (!getDocumentEditor(world).reparent(entity, parent, anchor)) return false;
	moveEntityTo(world, entity, start);
	if (isSequence(parent)) resolveSequentialOverlaps(world, [entity]);
	return true;
}
