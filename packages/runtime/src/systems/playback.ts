/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Playback system (was systems/playback.ts): advances root playheads, derives
// per-entity local time + visibility, forwards decoders/hosts, keeps the
// audio bus tree in sync, and steps live mounts. In offline modes the encoder
// sets the playhead explicitly and awaits FramePromises.

import { Or } from 'koota';

import { store } from '../world/store';
import { PaintType } from '../constants';
import {
	ChildOf, Hidden, Culled, Dragging,
	Geometry, Group, AdjustmentLayer, Paint, Audio, Caption, Muted, Soloed,
	Sequential, Transition, Playback, Workarea,
	AudioPlayback, AudioStream, Computed,
	AssetId, AudioDecoderHandle, ImageDecoderHandle, VideoDecoderHandle, AudioBusHandle, Host,
	Mode, Silent, FrameRate, Time, AudioEngine, FramePromises, Tickers,
	Root,
} from '../traits';
import { getNodeChildren, getNodePaints, getParentNode } from '../queries/hierarchy';
import { getIntrinsicPaint, getSourceWindow } from '../utils/time';
import { getAsset } from '../actions/assets';
import { clamp } from '../math/common';
import { getTransitionWindow } from '../utils/transition';
import {
	resolveAudioDecoder, resolveCaptionDecoder, resolveImageDecoder,
	resolveShaderHost, resolveVideoDecoder,
} from '../media';
import { whenHtmlReady } from '../media/html';
import { AudioBus } from '../media/audio-bus';
import { preparePhysics } from './physics';

import type { Entity, World } from 'koota';

const WARMUP_SECONDS = 1.5;
const MAX_WARMUP_DECODERS = 2;
const MAX_IMAGE_PREVIEW_BYTES = 256 * 1024 * 1024;
const MAX_WARMUP_IMAGES = 32;
const AUDIO_LOOKAHEAD_SECONDS = 0.5;
const AUDIO_START_LEAD_SECONDS = 0.05;

type VideoForwarding = {
	active: Set<Entity>;
	warmup: { entity: Entity; fill: Entity; distance: number }[];
};

type ImageForwarding = {
	active: Set<Entity>;
	warmup: { fill: Entity; distance: number }[];
};

function framePromises(world: World) {
	return world.get(FramePromises)?.list ?? null;
}

/** Prime the opening playback window, including cuts within it. */
function preparePlayback(world: World, scene: Entity, entity: Entity = scene, parentMuted = false): boolean {
	if (entity.has(Hidden)) return true;
	const computed = entity.get(Computed);
	const frame = scene.get(Computed)!.localTime;
	const fps = world.get(FrameRate)?.value ?? 30;
	if (entity !== scene && computed && (frame + AUDIO_LOOKAHEAD_SECONDS * fps < computed.start || frame >= computed.end)) return true;

	const muted = parentMuted || entity.has(Muted);
	const intrinsic = getIntrinsicPaint(entity);
	const intrinsicVideo = intrinsic === PaintType.VIDEO;
	const videos = intrinsicVideo ? [entity] : [];
	const images = intrinsic === PaintType.IMAGE ? [entity] : [];
	let source: Entity | undefined = entity.has(Audio) || intrinsicVideo ? entity : undefined;
	for (const fill of getNodePaints(world, entity)) {
		if (fill.has(Hidden)) continue;
		const paint = fill.get(Paint)?.value;
		if (paint === PaintType.IMAGE) images.push(fill);
		if (paint === PaintType.VIDEO) {
			videos.push(fill);
			source = fill;
		}
	}

	let ready = true;
	if (computed && frame >= computed.start && !entity.has(Culled)) {
		for (const image of images) {
			const decoder = resolveImageDecoder(world, image)?.decoder;
			if (decoder && !decoder.ready && !decoder.failed) ready = false;
		}
		const window = getSourceWindow(entity);
		const localFrame = Math.round((frame - computed.origin) * (computed.playbackRate || 1));
		for (const video of videos) {
			const decoder = resolveVideoDecoder(world, video);
			if (!decoder || decoder.errored) continue;
			const seekFrame = clamp(localFrame, window.in, window.out);
			const prepared = 'prepareForPlayback' in decoder
				? decoder.prepareForPlayback(seekFrame, fps, window.out)
				: !!decoder.toBitmap();
			if (!prepared) ready = false;
		}
	}
	if (source && computed && !muted) {
		const { decoder } = resolveAudioDecoder(world, source, entity.get(AudioStream)?.value ?? source.get(AudioStream)?.value ?? 0) ?? {};
		if (decoder && !decoder.error) {
			resolveAudioBus(world, entity);
			if (collectAncestors(entity).some(parent => parent.get(AudioBusHandle)?.isReady === false)) ready = false;
			const window = getSourceWindow(entity);
			const rate = computed.playbackRate || 1;
			const localFrame = Math.round((frame - computed.origin) * rate);
			const from = clamp(localFrame, window.in, window.out) / fps;
			if (!decoder.isPrepared(from)) {
				ready = false;
				void decoder.prepare(from, localFrame / fps + AUDIO_LOOKAHEAD_SECONDS * rate, window.out / fps).catch((error: unknown) => {
					if (decoder.error) return;
					decoder.error = error instanceof Error ? error.message : String(error);
					console.error(decoder.error);
				});
			}
		}
	}

	for (const child of getNodeChildren(world, entity)) {
		if (!preparePlayback(world, scene, child, muted)) ready = false;
	}
	return ready;
}

function advancePlayhead(world: World, entity: Entity): void {
	if (world.get(Mode)?.value !== 'realtime') return;

	if (!entity.has(AudioPlayback)) entity.add(AudioPlayback);
	const playback = store(world, Playback);
	const audioPlayback = store(world, AudioPlayback);
	const computed = store(world, Computed);
	const eid = entity.id();
	const fps = world.get(FrameRate)?.value ?? 30;
	const context = world.get(AudioEngine)?.context;
	const playing = playback.playing[eid] ?? false;
	const wasPlaying = audioPlayback.wasPlaying[eid] ?? false;
	const speed = playback.speed[eid] || 1;
	const speedChanged = speed !== (audioPlayback.previousSpeed[eid] ?? 1);

	if (!playing) {
		if (wasPlaying || playback.buffering[eid]) resetDecoders(world, entity);
		if (playback.buffering[eid]) entity.set(Playback, { buffering: false });
		audioPlayback.wasPlaying[eid] = false;
		return;
	}

	if (speedChanged) {
		resetDecoders(world, entity);
		audioPlayback.wasPlaying[eid] = false;
		audioPlayback.previousSpeed[eid] = speed;
	}

	if (context?.state === 'suspended' || context?.state === 'interrupted') {
		if (wasPlaying) resetDecoders(world, entity);
		audioPlayback.wasPlaying[eid] = false;
		if (!playback.buffering[eid]) entity.set(Playback, { buffering: true });
		return;
	}

	if (!audioPlayback.wasPlaying[eid]) {
		if (speed === 1 && !preparePlayback(world, entity)) {
			if (!playback.buffering[eid]) entity.set(Playback, { buffering: true });
			return;
		}
		if (playback.buffering[eid]) entity.set(Playback, { buffering: false });
		// Queue primed audio ahead of the synchronous preview/timeline render.
		audioPlayback.contextOffsetInSeconds[eid] = context ? context.currentTime + AUDIO_START_LEAD_SECONDS : 0;
		audioPlayback.timelineOffsetInSeconds[eid] = computed.localTimeInSeconds[eid]!;
		audioPlayback.previousSpeed[eid] = speed;
		audioPlayback.wasPlaying[eid] = true;
		return;
	}

	// currentTime advances in audio blocks. Interpolate the device's output
	// timestamp so video follows the audible samples at the display's cadence.
	let contextTime = context?.currentTime ?? 0;
	if (context && 'getOutputTimestamp' in context) {
		const { contextTime: outputTime, performanceTime } = context.getOutputTimestamp();
		if (outputTime !== undefined && performanceTime !== undefined && performanceTime > 0
			&& Number.isFinite(performanceTime) && Number.isFinite(outputTime)) {
			const now = world.get(Time)?.now ?? performance.now();
			contextTime = Math.min(contextTime, outputTime + (now - performanceTime) / 1000);
		}
	}
	let time = context
		? audioPlayback.timelineOffsetInSeconds[eid]! + Math.max(0, contextTime - audioPlayback.contextOffsetInSeconds[eid]!) * speed
		: computed.localTimeInSeconds[eid]! + (world.get(Time)?.delta ?? 0) / 1000 * speed;
	// Device timestamp corrections must not briefly reverse the playhead.
	time = speed > 0 ? Math.max(time, computed.localTimeInSeconds[eid]!) : Math.min(time, computed.localTimeInSeconds[eid]!);
	const workarea = entity.has(Workarea) ? entity.get(Workarea) : undefined;
	const duration = computed.duration[eid]!;
	const minSeconds = (workarea?.start ?? 0) / fps;
	const maxSeconds = (workarea?.end ?? duration) / fps;

	if (time >= maxSeconds && speed > 0 || time <= minSeconds && speed < 0) {
		resetDecoders(world, entity);
		audioPlayback.wasPlaying[eid] = false;
		if (playback.loop[eid]) {
			time = speed < 0 ? maxSeconds : minSeconds;
			if (!playback.buffering[eid]) entity.set(Playback, { buffering: true });
		}
		else entity.set(Playback, { playing: false });
	}
	computed.localTimeInSeconds[eid] = clamp(time, minSeconds, maxSeconds);
	computed.localTime[eid] = Math.round(computed.localTimeInSeconds[eid]! * fps);
}

function seekVideoDecoder(world: World, entity: Entity, fill: Entity): void {
	const decoder = resolveVideoDecoder(world, fill);
	if (!decoder) return;

	const fps = world.get(FrameRate)?.value ?? 30;
	const localFrame = store(world, Computed).localTime[entity.id()]!;
	const source = getSourceWindow(entity);
	const seekFrame = clamp(localFrame, source.in, source.out);
	const seekPromise = decoder.seekTo(seekFrame, fps);
	framePromises(world)?.push(seekPromise ?? null);
}

function forwardVideoDecoder(world: World, scene: Entity, entity: Entity, fill: Entity, videos: VideoForwarding): void {
	const computed = store(world, Computed);
	const eid = entity.id();
	if (computed.visibility[eid] === 1) {
		videos.active.add(fill);
		seekVideoDecoder(world, entity, fill);
		return;
	}
	if (world.get(Mode)?.value !== 'realtime') return;

	const distance = warmupDistance(world, scene, entity);
	if (distance !== null) videos.warmup.push({ entity, fill, distance });
}

function warmupDistance(world: World, scene: Entity, entity: Entity): number | null {
	const computed = store(world, Computed);
	const eid = entity.id();
	const globalFrame = computed.localTime[scene.id()]!;
	const start = computed.start[eid]!;
	const end = computed.end[eid]!;
	const warmupFrames = Math.ceil((world.get(FrameRate)?.value ?? 30) * WARMUP_SECONDS);
	if (globalFrame < start - warmupFrames || globalFrame >= end + warmupFrames) return null;

	// Prefer upcoming cuts, then recently passed clips. A time window alone
	// can retain too many decoded frames on a densely cut timeline.
	return globalFrame < start ? start - globalFrame : warmupFrames + globalFrame - end + 1;
}

function forwardCaptionDecoder(world: World, _scene: Entity, entity: Entity): void {
	const localFrame = store(world, Computed).localTime[entity.id()]!;
	const fps = world.get(FrameRate)?.value ?? 30;

	const decoder = resolveCaptionDecoder(world, entity);
	if (!decoder) return;
	if (!decoder.ready) {
		framePromises(world)?.push(decoder.initialized.then(() => {
			if (entity.isAlive()) decoder.seekTo(world, entity, localFrame / fps);
		}));
		return;
	}
	decoder.seekTo(world, entity, localFrame / fps);
}

/**
 * Forward the audio decoder for a child entity. `audioSource` optionally
 * points at the sub-entity carrying the audio (a video fill), while the
 * timing still comes from the clip entity itself.
 */
function forwardAudioDecoder(world: World, scene: Entity, entity: Entity, audioSource?: Entity): void {
	if (world.has(Silent) || entity.has(Muted)
		|| (world.get(Mode)?.value === 'realtime' && (scene.get(Playback)?.speed !== 1 || scene.get(Playback)?.buffering))) return;

	const resolvedDecoder = resolveAudioDecoder(world, audioSource ?? entity, entity.get(AudioStream)?.value ?? audioSource?.get(AudioStream)?.value ?? 0);
	if (!resolvedDecoder) return;

	const { decoder, initPromise } = resolvedDecoder;

	const computed = store(world, Computed);
	const audioPlayback = store(world, AudioPlayback);
	const playback = store(world, Playback);
	const eid = entity.id();
	const sid = scene.id();
	const fps = world.get(FrameRate)?.value ?? 30;

	const source = getSourceWindow(entity);

	const playbackRate = computed.playbackRate[eid] || 1;
	const origin = computed.origin[eid]!;

	const audioOffset = audioPlayback.contextOffsetInSeconds[sid] ?? 0;
	const playbackOffset = audioPlayback.timelineOffsetInSeconds[sid] ?? 0;
	// In offline rendering the encoder pins contextOffset to 0 and playbackOffset
	// to the workarea start, so this term shifts scheduled audio back into the
	// encoded window (and resolves to 0 when there is no workarea).
	const audioDelay = audioOffset - playbackOffset;
	const realtime = world.get(Mode)?.value === 'realtime';
	const context = world.get(AudioEngine)?.context;
	// Schedule from the render clock, independently of the output latency used
	// by the visual playhead, so every device keeps the full decode lookahead.
	const currentTime = realtime && context
		? Math.max(computed.localTime[sid]!, (context.currentTime - audioDelay) * fps)
		: computed.localTime[sid]!;
	const localFrame = realtime ? Math.round((currentTime - origin) * playbackRate) : computed.localTime[eid]!;
	const end = realtime ? Math.min(computed.end[eid]!, scene.get(Workarea)?.end ?? computed.duration[sid]!) : computed.end[eid]!;
	const bus = resolveAudioBus(world, entity);

	if (!decoder.ready) {
		framePromises(world)?.push(initPromise);
	} else if (playback.playing[sid] === true && (realtime
		? computed.start[eid]! < end && currentTime < end && currentTime + AUDIO_LOOKAHEAD_SECONDS * fps >= computed.start[eid]!
		: computed.visibility[eid] === 1)) {
		const playPromise = decoder.playTo(bus, {
			relativeFrom: clamp(localFrame, source.in, source.out) / fps,
			relativeTo: realtime
				? (localFrame / fps) + AUDIO_LOOKAHEAD_SECONDS * playbackRate
				: (localFrame + 15) / fps,
			trimStart: source.in / fps,
			trimEnd: (realtime ? Math.min(source.out, (end - origin) * playbackRate) : source.out) / fps,
			playbackRate,
			currentTime: currentTime / fps,
			relativeDelay: (origin / fps) + audioDelay,
		});
		framePromises(world)?.push(playPromise);
	} else {
		decoder.reset({ stopScheduled: playback.playing[sid] !== true });
	}
}

function forwardHtmlHost(world: World, scene: Entity, entity: Entity, fill: Entity): void {
	const computed = store(world, Computed);
	const root = fill.get(Host)?.element;
	if (world.get(Mode)?.value === 'realtime'
		|| computed.visibility[entity.id()] !== 1
		|| !(root instanceof HTMLElement)) return;
	framePromises(world)?.push(whenHtmlReady(root, computed.localTimeInSeconds[scene.id()] ?? 0));
}

function forwardImageDecoder(world: World, fill: Entity, images: ImageForwarding): void {
	const resolvedDecoder = resolveImageDecoder(world, fill);
	if (!resolvedDecoder) return;
	images.active.add(fill);

	const { decoder, initPromise } = resolvedDecoder;

	if (!decoder.ready) {
		framePromises(world)?.push(initPromise);
	}
}

function queueImageDecoder(world: World, scene: Entity, entity: Entity, fill: Entity, images: ImageForwarding): void {
	if (store(world, Computed).visibility[entity.id()] === 1) {
		forwardImageDecoder(world, fill, images);
		return;
	}
	if (world.get(Mode)?.value !== 'realtime') return;

	const distance = warmupDistance(world, scene, entity);
	if (distance !== null) images.warmup.push({ fill, distance });
}

function imagePreviewBytes(world: World, fill: Entity): { id: string; bytes: number } | null {
	const id = fill.get(AssetId)?.value;
	if (!id) return null;
	const asset = getAsset(world, id);
	return asset?.type === 'IMAGE' ? { id, bytes: asset.width * asset.height * 4 } : null;
}

/**
 * Forward decoders for a child entity and its node descendants.
 */
function forwardDecoders(world: World, scene: Entity, entity: Entity, videos: VideoForwarding, images: ImageForwarding): void {
	if (entity.has(Hidden)) return;
	const paintStore = store(world, Paint);

	const culled = entity.has(Culled);
	const visualsEnabled = !culled && world.get(Mode)?.value !== 'offline-audio';

	let intrinsicVideo = false;
	let paintAudioSource: Entity | undefined;

	if (!culled) {
		const intrinsic = getIntrinsicPaint(entity);
		if (intrinsic === PaintType.VIDEO) {
			if (visualsEnabled) {
				forwardVideoDecoder(world, scene, entity, entity, videos);
			}
			intrinsicVideo = true;
		} else if (intrinsic === PaintType.IMAGE && visualsEnabled) {
			queueImageDecoder(world, scene, entity, entity, images);
		} else if (intrinsic === PaintType.HTML && visualsEnabled) {
			forwardHtmlHost(world, scene, entity, entity);
		}

		for (const fill of getNodePaints(world, entity)) {
			if (fill.has(Hidden)) continue;
			const paint = paintStore.value[fill.id()];

			if (paint === PaintType.VIDEO) {
				if (visualsEnabled) {
					forwardVideoDecoder(world, scene, entity, fill, videos);
				}
				paintAudioSource = fill;
			}

			if (paint === PaintType.IMAGE && visualsEnabled) {
				queueImageDecoder(world, scene, entity, fill, images);
			}

			if (paint === PaintType.HTML && visualsEnabled) {
				forwardHtmlHost(world, scene, entity, fill);
			}

			if (paint === PaintType.SHADER && visualsEnabled) {
				const ready = resolveShaderHost(world, fill)?.whenReady();
				if (ready) framePromises(world)?.push(ready);
			}
		}
	}

	if (entity.has(Caption) && visualsEnabled) {
		forwardCaptionDecoder(world, scene, entity);
	}

	if (intrinsicVideo || entity.has(Audio) || paintAudioSource) {
		forwardAudioDecoder(world, scene, entity, paintAudioSource);
	}

	for (const child of getNodeChildren(world, entity)) {
		forwardDecoders(world, scene, child, videos, images);
	}
}

function updateVisibility(world: World, scene: Entity, entity: Entity): void {
	const computed = store(world, Computed);
	const eid = entity.id();

	// Root or dragging entity is always visible
	if (entity === scene || entity.has(Dragging)) {
		computed.visibility[eid] = 1;
	} else {
		const globalFrame = computed.localTime[scene.id()]!;
		const origin = computed.origin[eid] ?? 0;
		const playbackRate = computed.playbackRate[eid] || 1;

		const start = computed.start[eid]!;
		const end = computed.end[eid]!;

		computed.localTime[eid] = Math.round((globalFrame - origin) * playbackRate);
		computed.visibility[eid] = globalFrame >= start && globalFrame < end ? 1 : 0;
	}

	for (const child of getNodeChildren(world, entity)) {
		updateVisibility(world, scene, child);
	}
}

function resetDecoders(world: World, entity: Entity): void {
	if (entity.has(AudioDecoderHandle)) {
		entity.get(AudioDecoderHandle)?.reset();
	}

	for (const child of world.query(ChildOf(entity))) {
		resetDecoders(world, child);
	}
}


function collectAncestors(entity: Entity): Entity[] {
	const path: Entity[] = [];

	let current: Entity | null = entity;
	while (current) {
		path.push(current);
		current = getParentNode(current);
	}

	return path.toReversed();
}

/**
 * The entity's audio bus, building (and wiring) the ancestor bus chain on
 * first use. Null when the world has no audio context.
 */
export function resolveAudioBus(world: World, entity: Entity): AudioBus | null {
	const existing = entity.has(AudioBusHandle) ? entity.get(AudioBusHandle) : null;
	if (existing) return existing;

	const audio = world.get(AudioEngine);
	const context = audio?.context;
	if (!context) return null;

	const ancestors = collectAncestors(entity);

	// Walk root -> leaf, connecting each bus's gain into its parent's input
	// (root connects into the host output or context destination). Reuse buses that already
	// exist; only newly created ones need wiring.
	let currentInput: AudioNode = audio.output ?? context.destination;

	for (const ancestor of ancestors) {
		let bus = ancestor.has(AudioBusHandle) ? ancestor.get(AudioBusHandle) : null;

		if (!bus) {
			bus = new AudioBus(world, ancestor);
			ancestor.add(AudioBusHandle);
			ancestor.set(AudioBusHandle, bus);
			bus.connect(currentInput);
		}

		currentInput = bus.input;
	}

	return entity.get(AudioBusHandle) ?? null;
}

function getGlobalFrame(world: World, entity: Entity): number {
	const computed = store(world, Computed);

	let current: Entity | null = entity;
	while (current) {
		if (current.has(Playback)) {
			return computed.localTime[current.id()]!;
		}
		current = getParentNode(current);
	}

	return 0;
}

export function playbackSystem(world: World): void {
	preparePhysics(world);
	const computed = store(world, Computed);

	// handle root playback
	for (const entity of world.query(Playback)) {
		advancePlayhead(world, entity);
	}

	for (const entity of world.query(Or(Geometry, Group, AdjustmentLayer), ChildOf(world.get(Root)!))) {
		updateVisibility(world, entity, entity);
	}

	// handle transition visibility
	for (const clip of world.query(Or(Geometry, Group, AdjustmentLayer), Transition)) {
		const parent = getParentNode(clip);

		if (parent == null || !parent.has(Sequential)) {
			console.info('Removing transition due to non-sequential parent', clip);
			// System-driven cleanup of orphaned state — not a user edit.
			clip.remove(Transition);
			continue;
		}

		const children = world.query(ChildOf(parent), Or(Geometry, Group, AdjustmentLayer));
		const partner = children.find(sibling => computed.start[sibling.id()] === computed.end[clip.id()]);
		if (!partner) continue;
		const window = getTransitionWindow(world, clip, partner);
		const globalFrame = getGlobalFrame(world, clip);
		if (globalFrame >= window.start && globalFrame < window.end) {
			computed.visibility[clip.id()] = 1;
			computed.visibility[partner.id()] = 1;
		}
	}

	const videos: VideoForwarding = { active: new Set(), warmup: [] };
	const images: ImageForwarding = { active: new Set(), warmup: [] };
	for (const entity of world.query(Or(Geometry, Group, AdjustmentLayer), ChildOf(world.get(Root)!))) {
		forwardDecoders(world, entity, entity, videos, images);
	}
	images.warmup.sort((a, b) => a.distance - b.distance);
	const imageAssets = new Set<string>();
	let imageBytes = 0;
	for (const fill of images.active) {
		const image = imagePreviewBytes(world, fill);
		if (!image || imageAssets.has(image.id)) continue;
		imageAssets.add(image.id);
		imageBytes += image.bytes;
	}
	let warmedImages = 0;
	for (const { fill } of images.warmup) {
		if (warmedImages >= MAX_WARMUP_IMAGES) break;
		const image = imagePreviewBytes(world, fill);
		if (!image) continue;
		const addedBytes = imageAssets.has(image.id) ? 0 : image.bytes;
		if (warmedImages >= 2 && imageBytes + addedBytes > MAX_IMAGE_PREVIEW_BYTES) continue;
		forwardImageDecoder(world, fill, images);
		warmedImages++;
		if (!imageAssets.has(image.id)) {
			imageAssets.add(image.id);
			imageBytes += image.bytes;
		}
	}
	for (const fill of world.query(ImageDecoderHandle)) {
		if (images.active.has(fill)) continue;
		const decoder = fill.get(ImageDecoderHandle);
		if (!decoder) continue;
		decoder.dispose();
		fill.set(ImageDecoderHandle, null);
	}
	videos.warmup.sort((a, b) => a.distance - b.distance);
	for (const { entity, fill } of videos.warmup.slice(0, MAX_WARMUP_DECODERS)) {
		videos.active.add(fill);
		seekVideoDecoder(world, entity, fill);
	}
	// This also releases sources skipped by traversal, such as hidden groups
	// and hidden fills, while preserving every visible or transition source.
	for (const fill of world.query(VideoDecoderHandle)) {
		if (videos.active.has(fill)) continue;
		const decoder = fill.get(VideoDecoderHandle);
		if (!decoder) continue;
		decoder.dispose();
		fill.set(VideoDecoderHandle, null);
	}

	// Sync audio buses
	let soloed: Set<Entity> | null = null;
	const buses = world.query(AudioBusHandle);
	for (const entity of buses) {
		if (!entity.has(Soloed)) continue;

		if (soloed === null) {
			soloed = new Set();
		}

		for (const ancestor of collectAncestors(entity)) {
			soloed.add(ancestor);
		}
		const descendants = [entity];
		for (const descendant of descendants) {
			soloed.add(descendant);
			descendants.push(...world.query(ChildOf(descendant), AudioBusHandle));
		}
	}

	for (const entity of buses) {
		entity.get(AudioBusHandle)?.sync(soloed !== null && !soloed.has(entity));
	}

	for (const tick of world.get(Tickers) ?? []) tick();
}
