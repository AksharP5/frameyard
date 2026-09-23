/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The asset library in the app: attached to the world for the project on
// disk and kept in step with the JSX (a rename in the library is a `src`
// edit in the file).

import { AssetId, Host, Library, LoadRequest, OriginalMedia, SourceError, clearAudioTrackCache, clearVideoTrackCache, disposeDecoders } from '@diffusionstudio/runtime';
import { AssetLibrary, MANIFEST_FILE, ASSETS_DIR } from '@diffusionstudio/assets';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { authoredElement } from '@diffusionstudio/reconciler';
import { isAssetRef, mapAssetInputs } from '@diffusionstudio/jsx';
import type { Accessor } from 'solid-js';

import { createOriginalMediaProvider } from '@/projects/original-media';
import { createProjectFS } from '@/projects/fs';
import { ProjectConfig } from './traits';
import { getDocumentEditor } from './editor';
import { forgetAssetMedia } from './timeline/media';
import { forgetAssetPeaks } from './timeline/peaks';

import type { Asset } from '@diffusionstudio/assets';
import type { AssetInput } from '@diffusionstudio/jsx';
import type { World } from 'koota';

/**
 * Creates the library of the project at `dir`, attaches it to the world and
 * starts loading it. Renames in the library are written through to every
 * element whose `src` named the old path. Returns the library and a
 * disposer that flushes the manifest and detaches it.
 */
export function attachLibrary(world: World, dir: string) {
	const library = new AssetLibrary(createProjectFS(dir, () => world.get(ProjectConfig)?.previewScale() ?? 1), {
		onRename: (asset, from) => { if (world.get(Library) === library) followRename(world, asset, from); },
		onRelink: (asset, from) => { if (world.get(Library) === library) followRelink(world, asset, from); },
	});

	world.set(Library, library);
	world.set(OriginalMedia, createOriginalMediaProvider(dir));

	return library;
}

/** Whether a changed project file is the library's business rather than the JSX's. */
export function isLibraryFile(path: string): boolean {
	return path === MANIFEST_FILE || path === ASSETS_DIR || path.startsWith(`${ASSETS_DIR}/`);
}

/**
 * Rewrites `src` on every element that named an asset by its old path —
 * directly, or as an input somewhere inside a declaration: an element
 * showing `transform.upscale("old.png")` is bound to what the transform made,
 * and its `src` still has to follow the rename.
 */
function followRename(world: World, asset: Asset, from: string): void {
	const editor = getDocumentEditor(world);
	const renamed = (input: AssetInput): AssetInput =>
		isAssetRef(input) ? mapAssetInputs(input, renamed) : input === from ? asset.path : input;

	for (const entity of world.query(Host)) {
		const src = authoredElement(entity)?.props.src;
		if (typeof src !== 'string' && !isAssetRef(src)) continue;
		const next = renamed(src);
		if (next !== src) editor.editProperty(entity, 'src', next);
	}
}

/** Refresh failed sources and live decoders, including a moved file with identical bytes. */
function followRelink(world: World, asset: Asset, from: string): void {
	clearAudioTrackCache();
	clearVideoTrackCache();
	forgetAssetMedia(from);
	forgetAssetPeaks(from);
	for (const entity of world.query(AssetId)) {
		if (entity.get(AssetId)?.value !== from) continue;
		disposeDecoders(world, entity);
		entity.set(AssetId, { value: asset.id });
		entity.remove(SourceError);
	}
	for (const entity of world.query(Host)) {
		const src = authoredElement(entity)?.props.src;
		if (src !== asset.path) continue;
		disposeDecoders(world, entity);
		entity.remove(SourceError);
		entity.add(LoadRequest);
		entity.set(LoadRequest, { value: asset.path });
	}
}

/**
 * The world's library, or undefined until a project attaches one. The
 * library's own state is reactive (`assets()`, `folders()`, `childrenOf()`),
 * so readers inside a tracking scope follow it.
 */
export function useLibrary(): Accessor<AssetLibrary | undefined> {
	const world = useWorld();
	const attached = useTrait(world, Library);
	return () => attached() ?? undefined;
}
