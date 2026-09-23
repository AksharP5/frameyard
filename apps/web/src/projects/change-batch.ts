/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Preserve every changed path so cache or media events cannot hide a source edit. */
export function batchProjectChanges(onChange: (paths: string[]) => void, delayMs: number, maxDelayMs = delayMs * 5) {
	const paths = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started: number | undefined;
	return {
		add(path: string): void {
			started ??= Date.now();
			paths.add(path);
			clearTimeout(timer);
			timer = setTimeout(() => {
				const batch = [...paths];
				paths.clear();
				started = undefined;
				onChange(batch);
			}, Math.min(delayMs, Math.max(0, maxDelayMs - (Date.now() - started))));
		},
		dispose(): void {
			clearTimeout(timer);
			paths.clear();
			started = undefined;
		},
	};
}

/** Editable components can live beside the rendered media they produce. */
export const isProjectSourceFile = (path: string): boolean => /\.(?:[cm]?[jt]sx?)$/i.test(path);
