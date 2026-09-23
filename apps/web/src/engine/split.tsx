/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Cutting a clip in two at the playhead. The clip is copied where it stands,
 * then the original is trimmed to end at the playhead and the copy to start
 * there, so the two halves play exactly what the one clip did. Everything
 * goes through the editor, so the file ends up saying the same thing the
 * canvas shows: an element beside the one it came from, with its own times.
 */

import { Sequence } from '@diffusionstudio/reconciler';
import {
	AdjustmentLayer,
	ChildOf,
	Computed,
	Geometry,
	Group,
	Selected,
	getActiveEntity,
	getNextName,
	getParentEntity,
	handOffDecoders,
	isGroup,
	store,
} from '@diffusionstudio/runtime';
import { Or } from 'koota';

import { getDocumentEditor } from './editor';
import { clipsAtFrame, timelineSelection } from './clip-edits';
import { editableClipTargets } from './clip-links';
import { cloneFramesForSplit, clonePeaksForSplit } from './timeline';
import { trimIn, trimOut } from './timing';

import type { Entity, World } from 'koota';

/** The node kinds that sit on a timeline, and so are the ones a cut is about. */
const NODES = Or(Geometry, Group, AdjustmentLayer);

/**
 * What the cut applies to: the selection, or — with nothing selected — every
 * clip directly under the active scene. The scene is the editing context, so
 * it is never a target, even when it is what is selected.
 */
function splitTargets(world: World, scene: Entity): Entity[] {
	const selection = timelineSelection(world, scene);
	if (selection.length > 0 || world.query(Selected).length > 0) return selection;

	return [...world.query(NODES, ChildOf(scene))];
}

/**
 * Cuts every clip the playhead is over in two. Returns the tail halves, which
 * are what the selection is left on: they are the new elements, and carrying
 * on from the cut is the usual next thing to do to them.
 */
export function splitAtPlayhead(world: World): Entity[] {
	const scene = getActiveEntity(world);
	if (scene === null) return [];

	const frame = store(world, Computed).localTime[scene.id()] ?? 0;
	const units = clipsAtFrame(world, editableClipTargets(world, splitTargets(world, scene)), frame);
	if (units.length === 0) return [];

	const editor = getDocumentEditor(world);
	// Copied before anything is trimmed, so each copy is spelled from the
	// whole clip and still runs to the end the whole clip ran to.
	const pairs = editor.duplicateInPlace(units);

	for (const { original, copy } of pairs) {
		trimOut(world, original, frame);
		trimIn(world, copy, frame);
		handOffDecoders(world, original, copy);
		// The two halves play the same source at the same zoom, so the copy
		// starts with the waveform and thumbnails the whole clip had rather
		// than decoding them all over again.
		clonePeaksForSplit(original.id(), copy.id());
		cloneFramesForSplit(original.id(), copy.id());
	}

	// Two clips side by side under a scene are two layers of the timeline,
	// where a sequence's children are one row: the halves are wrapped so a
	// clip that was cut still reads as the one clip it was. A parent that
	// already groups its children (a group, or a sequence — every sequence is
	// a group) does that for them.
	for (const { original, copy } of pairs) {
		const parent = getParentEntity(original);
		if (parent === null || isGroup(parent)) continue;

		editor.wrap([original, copy], () => <Sequence name={getNextName(world, 'Sequence')} />);
	}

	const copies = pairs.map(({ copy }) => copy);
	if (copies.length > 0) editor.select(copies);

	return copies;
}
