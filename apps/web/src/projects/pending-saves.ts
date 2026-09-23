/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Includes recovery-journal updates and follow-up writes after an editor closes. */
export const savingProjects = new Map<string, Set<Promise<void>>>();
export const openProjectWriters = new Map<string, object>();

export async function waitForProjectEdits(dir: string): Promise<void> {
	while (savingProjects.has(dir)) await Promise.all(savingProjects.get(dir)!);
}
