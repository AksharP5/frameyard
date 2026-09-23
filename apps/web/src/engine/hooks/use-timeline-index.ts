/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { buildTimelineLayers, getActiveEntity } from '@diffusionstudio/runtime';
import { useWorld } from '@diffusionstudio/koota-solid';
import { createRoot, onCleanup } from 'solid-js';

import { useDerived } from './use-derived';

import type { TimelineIndexValue, TimelineNode } from '@diffusionstudio/runtime';
import type { Accessor } from 'solid-js';

type SharedIndex = {
	value: Accessor<TimelineIndexValue>;
	dispose: () => void;
	consumers: number;
};

const sharedIndexes = new WeakMap<ReturnType<typeof useWorld>, SharedIndex>();

/**
 * The rows of the scene on show, for the DOM column that labels them. The
 * canvas and DOM share the runtime's cached tree. Sample once per engine tick
 * and report only changes to the row structure.
 * All DOM consumers share this sample until the last one unmounts.
 */
export function useTimelineIndex(): Accessor<TimelineIndexValue> {
	const world = useWorld();

	let shared = sharedIndexes.get(world);
	if (!shared) {
		shared = createRoot((dispose): SharedIndex => ({
			value: useDerived<TimelineIndexValue>(
				() => {
					const root = getActiveEntity(world);
					return { root, layers: root === null ? [] : buildTimelineLayers(world, root) };
				},
				(prev, next) => prev.root === next.root && sameLayers(prev.layers, next.layers),
			),
			dispose,
			consumers: 0,
		}));
		sharedIndexes.set(world, shared);
	}

	const index = shared;
	index.consumers++;
	onCleanup(() => {
		if (--index.consumers > 0) return;
		index.dispose();
		sharedIndexes.delete(world);
	});
	return index.value;
}

/**
 * Whether two builds describe the same rows. Compared field by field rather
 * than by a serialized key: no allocation, and it stops at the first row that
 * differs, which is what usually happens when anything changed at all.
 */
function sameLayers(a: TimelineNode[], b: TimelineNode[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const left = a[i]!;
		const right = b[i]!;

		if (
			left.entity !== right.entity
			|| left.kind !== right.kind
			|| left.expanded !== right.expanded
			|| left.expandable !== right.expandable
			|| !sameLayers(left.children, right.children)
		) return false;
	}

	return true;
}
