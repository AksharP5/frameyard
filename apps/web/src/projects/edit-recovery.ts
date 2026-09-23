/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod';
import { openProjectWriters } from './pending-saves';
import type { SourceEdit } from './host';

const source = z.string().min(1);
const props = z.record(z.string(), z.json());
const editSchema: z.ZodType<SourceEdit> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('set'), source, props, text: z.string().optional() }),
	z.object({ kind: z.literal('insert'), source, parent: source, tag: source, props, before: source.optional(), text: z.string().optional() }),
	z.object({ kind: z.literal('move'), source, parent: source, before: source.optional() }),
	z.object({ kind: z.literal('remove'), source }),
	z.object({ kind: z.literal('unroll'), source, iterations: z.array(z.record(source, z.object({ props, text: z.string().optional(), pending: source.optional() }))) }),
	z.object({ kind: z.literal('variable'), file: source, name: source, value: z.union([z.string(), z.number(), z.boolean()]) }),
]);
const recoverySchema = z.object({
	version: z.literal(1), updatedAt: z.string(), safe: z.boolean(), edits: z.array(editSchema), error: z.string().optional(),
});
const key = (dir: string): string => `diffusion-studio:edit-recovery:${dir}`;

export function recoveryJson(dir: string): string | null {
	return typeof localStorage === 'undefined' ? null : localStorage.getItem(key(dir));
}

export function readRecovery(dir: string) {
	const json = recoveryJson(dir);
	if (!json) return;
	return recoverySchema.parse(JSON.parse(json));
}

/** Preserve even malformed journals when a remembered folder resolves through a symlink. */
export function moveProjectRecovery(from: string, to: string): void {
	if (from === to) return;
	const previous = recoveryJson(from);
	if (previous === null) return;
	if (openProjectWriters.has(to)) {
		throw new Error(`Close the current project "${to}", then retry opening "${from}" to restore its recovered edits. Recovery copies were kept.`);
	}
	const current = recoveryJson(to);
	if (current !== null && current !== previous) {
		throw new Error(`Unsaved recovery edits exist for both "${from}" and "${to}". Open "${to}" directly and save or discard its recovered edits, then retry "${from}". Both copies were kept.`);
	}
	if (current === null) localStorage.setItem(key(to), previous);
	localStorage.removeItem(key(from));
}

/** Persist before starting a source write, then replace with its confirmed remainder. */
type Recovery = Pick<z.infer<typeof recoverySchema>, 'safe' | 'edits' | 'error'>;

export function formatRecovery(recovery: Recovery): string {
	return JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), ...recovery });
}

export function writeRecovery(dir: string, recovery: Recovery): void {
	if (typeof localStorage === 'undefined') return;
	if (!recovery.edits.length) {
		localStorage.removeItem(key(dir));
		return;
	}
	localStorage.setItem(key(dir), formatRecovery(recovery));
}
