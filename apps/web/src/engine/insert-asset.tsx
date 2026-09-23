/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { Audio, Captions, ImagePaint, Rect, Video, VideoPaint, authoredTree, renderAuthored } from '@diffusionstudio/reconciler';
import { Audio as AudioNode, ClipLink, Computed, FrameRate, Host, Muted, Name, findGeometryAsset, framesToSeconds, getActiveEntity, getNextName, getParentEntity, getSourceWindow, isSequence, Root, Source, store } from '@diffusionstudio/runtime';
import { assetName } from '@diffusionstudio/assets';

import { getDocumentEditor } from './editor';
import { expandLinkedClips, isClipLocked } from './clip-links';

import type { Asset, VideoAsset } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';

export interface InsertAssetOptions {
	/** The scene (or group) to insert into; the active scene by default. */
	parent?: Entity;
	/** Top-left corner in the parent's space; centered by default. */
	x?: number;
	y?: number;
	/** Where on the timeline the clip starts, in seconds; the playhead by default. */
	start?: number;
	/** Scale visual media to fit inside the parent, preserving its aspect ratio. */
	fit?: 'contain';
	/** Source range in seconds, with an exclusive out point. */
	sourceIn?: number;
	sourceOut?: number;
}

/** The box an audio clip gets on the canvas: it has no size of its own. */
export const AUDIO_SIZE = { width: 500, height: 150 } as const;

/**
 * Inserts `asset` into the project as the element of its type and returns
 * the entity, or null when there is nothing to insert into (no project is
 * mounted, or the target has no source to be written under).
 */
export function insertAsset(world: World, asset: Asset, options: InsertAssetOptions = {}): Entity | null {
	const parent = options.parent ?? getActiveEntity(world) ?? world.get(Root)!;
	if (!parent.get(Source)?.value || isClipLocked(parent)) return null;

	const editor = getDocumentEditor(world);
	const src = asset.path;
	const name = getNextName(world, assetName(asset).replace(/\.[^.]+$/, ''));
	const start = options.start ?? (store(world, Computed).localTimeInSeconds[parent.id()] ?? 0);

	const size = sizeOf(asset);
	if (size && options.fit === 'contain' && asset.type !== 'AUDIO') {
		const bounds = parent.get(Computed);
		if (bounds && bounds.width > 0 && bounds.height > 0) {
			const scale = Math.min(bounds.width / size.width, bounds.height / size.height);
			size.width = Math.round(size.width * scale);
			size.height = Math.round(size.height * scale);
		}
	}
	const position = size ? placement(world, parent, size, options) : {};
	const sourceIn = options.sourceIn ?? 0;
	const sourceOut = options.sourceOut ?? ('duration' in asset ? asset.duration : undefined);
	if (!Number.isFinite(start) || !Number.isFinite(sourceIn) || sourceIn < 0
		|| sourceOut !== undefined && (!Number.isFinite(sourceOut) || sourceOut <= sourceIn || 'duration' in asset && sourceOut > asset.duration + 0.000001)) {
		throw new Error('The source range must be inside the clip');
	}
	const timing = {
		...(start > 0 ? { start } : {}),
		...(sourceIn > 0 ? { sourceIn } : {}),
		...(sourceOut === undefined ? {} : { end: Math.max(0, start) + sourceOut - sourceIn }),
	};

	const [entity] = editor.insertElement(parent, () => {
			switch (asset.type) {
				case 'VIDEO':
					return <Video name={name} src={src} keepAspectRatio {...position} {...size} {...timing} />;
				case 'SEQUENCE':
				return (
					<Rect name={name} keepAspectRatio {...position} {...size} {...timing}>
						<VideoPaint src={src} />
					</Rect>
				);
			case 'IMAGE':
				return (
					<Rect name={name} keepAspectRatio {...position} {...size} {...timing}>
						<ImagePaint src={src} />
					</Rect>
				);
			case 'AUDIO':
				return <Audio name={name} src={src} {...position} {...size} {...timing} />;
			case 'TRANSCRIPT':
				return <Captions src={src} {...timing} />;
			default:
				return null;
		}
		});

	if (entity && asset.type === 'VIDEO' && asset.channels) addLinkedAudio(world, entity, asset);

	if (entity) editor.select(entity);
	return entity ?? null;
}

export function canSeparateAudio(world: World, entity: Entity): boolean {
	if (isClipLocked(entity)) return false;
	if (entity.has(AudioNode)) return false;
	const asset = findGeometryAsset(world, entity);
	if (asset?.type !== 'VIDEO' || !asset.channels) return false;
	return !expandLinkedClips(world, [entity]).some((peer) => peer.has(AudioNode)
		&& findGeometryAsset(world, peer)?.id === asset.id);
}

/** Works on existing intrinsic videos and legacy rectangles with video fills. */
export function separateAudio(world: World, entity: Entity): Entity | null {
	if (!canSeparateAudio(world, entity)) return null;
	const asset = findGeometryAsset(world, entity);
	if (asset?.type !== 'VIDEO') return null;
	const audio = addLinkedAudio(world, entity, asset);
	if (audio) getDocumentEditor(world).select(entity);
	return audio;
}

function addLinkedAudio(world: World, entity: Entity, asset: VideoAsset): Entity | null {
	let parent = getParentEntity(entity);
	let anchor = entity;
	// A sequence shares one row. Audio sits below it in the nearest container
	// that allows both tracks to play at the same time.
	while (parent && isSequence(parent)) {
		anchor = parent;
		parent = getParentEntity(parent);
	}
	if (!parent) return null;
	const editor = getDocumentEditor(world);
	const fps = world.get(FrameRate)?.value ?? 30;
	const computed = entity.get(Computed);
	const source = getSourceWindow(entity);
	const origin = parent.get(Computed)?.origin ?? 0;
	const link = entity.get(ClipLink)?.value || crypto.randomUUID();
	const authored = authoredTree(world, entity);
	const original = entity.get(Host)?.props ?? {};
	const [audio] = editor.insertElement(parent, () => renderAuthored({
		tag: 'audio',
		props: {
			name: `${entity.get(Name)?.value || assetName(asset)} Audio`, src: asset.path, link,
			start: framesToSeconds((computed?.start ?? 0) - origin, fps),
			end: framesToSeconds((computed?.end ?? 0) - origin, fps),
			sourceIn: framesToSeconds(source.in, fps), playbackRate: computed?.playbackRate || 1,
			...(original.volume === undefined ? {} : { volume: original.volume }),
			...(original.audioProcessing === undefined ? {} : { audioProcessing: original.audioProcessing }),
			...(original.audioStream === undefined ? {} : { audioStream: original.audioStream }),
			...(entity.has(Muted) ? { muted: true } : {}),
		},
		children: authored?.children.filter((child) =>
			(child.tag.toLowerCase() === 'keyframetrack' && child.props.property === 'volume')
			|| (child.tag.toLowerCase() === 'animation' && child.props.type === 'gain'),
		) ?? [],
	}), anchor);
	if (!audio) return null;
	editor.editProperty(entity, 'link', link);
	editor.editProperty(entity, 'muted', true);
	return audio;
}

function sizeOf(asset: Asset): { width: number; height: number } | undefined {
	switch (asset.type) {
		case 'VIDEO':
		case 'IMAGE':
		case 'SEQUENCE':
			return { width: Math.round(asset.width), height: Math.round(asset.height) };
		case 'AUDIO':
			return { ...AUDIO_SIZE };
		default:
			return undefined;
	}
}

/** Where a new element of `size` goes: as asked, or centered in its parent. */
function placement(
	world: World,
	parent: Entity,
	size: { width: number; height: number },
	options: InsertAssetOptions,
): { x?: number; y?: number } {
	if (options.x !== undefined && options.y !== undefined) {
		return { x: Math.round(options.x), y: Math.round(options.y) };
	}
	const bounds = store(world, Computed);
	const width = bounds.width[parent.id()] ?? size.width;
	const height = bounds.height[parent.id()] ?? size.height;
	return { x: Math.round((width - size.width) / 2), y: Math.round((height - size.height) / 2) };
}
