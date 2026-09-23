/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import {
	AudioEngine, Computed, FrameRate, Markers, Playback, Source, Workarea, framesToSeconds,
	getActiveEntity, getEntityTree, isSequence, setPlayhead,
} from '@diffusionstudio/runtime';
import { getDocumentEditor } from './editor';
import { editWorkarea } from './timing';
import type { Entity, World } from 'koota';
import type { TimelineMarker } from '@diffusionstudio/runtime';

export function seekTimeline(world: World, frame: number): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	scene.set(Playback, { playing: false, speed: 1 });
	setPlayhead(world, scene, Math.max(0, Math.min(Math.max(0, (scene.get(Computed)?.end ?? 1) - 1), Math.round(frame))));
}

export function seekTimelineFrames(world: World, delta: number): void {
	const scene = getActiveEntity(world);
	if (scene) seekTimeline(world, (scene.get(Computed)?.localTime ?? 0) + delta);
}

export function seekBoundary(world: World, direction: -1 | 1, kind: 'cut' | 'marker' | 'scene'): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	const timing = scene.get(Computed)!;
	if (kind === 'scene') { seekTimeline(world, direction === -1 ? 0 : timing.end - 1); return; }
	const positions = kind === 'marker' ? (scene.get(Markers)?.value ?? []).map((marker) => marker.time)
		: getEntityTree(world, scene).filter((clip) => clip !== scene && clip.has(Source) && !isSequence(clip))
			.flatMap((clip) => { const time = clip.get(Computed); return time ? [time.start, time.end] : []; });
	const next = positions.filter((frame) => direction === -1 ? frame < timing.localTime : frame > timing.localTime)
		.sort((a, b) => direction * (a - b))[0];
	if (next !== undefined) seekTimeline(world, next);
}

export function shuttle(world: World, direction: -1 | 0 | 1): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	if (direction === 0) { scene.set(Playback, { playing: false, speed: 1 }); return; }
	const playback = scene.get(Playback);
	const previous = playback?.playing ? playback.speed : 0;
	const speed = Math.sign(previous) === direction ? direction * Math.min(4, Math.abs(previous) * 2) : direction;
	const time = scene.get(Computed);
	const range = scene.get(Workarea);
	const start = range?.start ?? 0;
	const end = range?.end ?? time?.end ?? 0;
	const frame = time?.localTime ?? 0;
	if (end > start && (frame < start || frame >= end || (direction === -1 && frame === start))) {
		setPlayhead(world, scene, direction === 1 ? start : end - 1);
	}
	scene.set(Playback, { playing: true, speed });
	const context = world.get(AudioEngine)?.context;
	if (context && context instanceof AudioContext) void context.resume();
}

export function markRange(world: World, edge: 'in' | 'out' | 'clear'): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	if (edge === 'clear') { editWorkarea(world, scene, null); return; }
	const frame = Math.max(0, Math.round(scene.get(Computed)?.localTime ?? 0));
	const current = scene.get(Workarea);
	const range: [number, number] = edge === 'in'
		? [frame, Math.max(frame + 1, current?.end ?? scene.get(Computed)?.end ?? frame + 1)]
		: [Math.min(current?.start ?? 0, frame), frame + 1];
	editWorkarea(world, scene, range);
}

function writeMarkers(world: World, scene: Entity, markers: TimelineMarker[]): void {
	const fps = world.get(FrameRate)?.value ?? 30;
	getDocumentEditor(world).editProperty(scene, 'markers', markers.length
		? markers.sort((a, b) => a.time - b.time).map((marker) => ({ ...marker, time: framesToSeconds(marker.time, fps) })) : false);
}

export function addMarker(world: World): void {
	const scene = getActiveEntity(world);
	if (!scene) return;
	const markers = scene.get(Markers)?.value ?? [];
	const time = Math.max(0, Math.round(scene.get(Computed)?.localTime ?? 0));
	if (markers.some((marker) => marker.time === time)) return;
	writeMarkers(world, scene, [...markers, { id: crypto.randomUUID(), time, name: `Marker ${markers.length + 1}` }]);
}

export function editMarker(world: World, scene: Entity, id: string, change: { time?: number; name?: string } | null): void {
	const markers = scene.get(Markers)?.value ?? [];
	writeMarkers(world, scene, change === null ? markers.filter((marker) => marker.id !== id)
		: markers.map((marker) => marker.id === id ? { ...marker,
			name: change.name?.trim() || marker.name,
			time: change.time === undefined ? marker.time : Math.max(0, Math.round(change.time)),
		} : marker));
}
