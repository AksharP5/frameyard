/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { getDocumentEditor } from '@/engine/editor';
import { toast } from 'somoto';

import { writeProject } from './host';
import { formatRecovery, readRecovery, recoveryJson, writeRecovery } from './edit-recovery';
import { openProjectWriters, savingProjects } from './pending-saves';
export { waitForProjectEdits } from './pending-saves';

import type { EntityEdit, InsertEdit, MoveEdit, RemoveEdit, UnrollEdit, VariableEdit } from '@/engine/editor';
import type { SourceEdit, WriteResult } from './host';
import type { World } from 'koota';

/**
 * How long edits pile up before they are written. Long enough that a drag is
 * one write, short enough that letting go of a slider and looking at the file
 * shows the value that is on the canvas.
 */
const DEBOUNCE = 120;
const writers = new WeakMap<World, EditWriter>();

export type ProjectSaveState =
	| { status: 'saved' | 'dirty' | 'saving' }
	| { status: 'failed'; error: string; retryable: boolean };

const listeners = new WeakMap<World, Set<(state: ProjectSaveState) => void>>();

class EditWriter {
	private readonly dir: string;
	private readonly world: World;

	// Unrolls first: everything else addressed to what a loop rendered is
	// addressed to the copies the unroll makes. Then inserts and moves after
	// their parents and placement anchors, then per element, per prop: the last
	// value for a prop is the only one worth writing, an element written twice
	// is written once, and only where
	// an element ended up is worth moving it to. Removes last: nothing else
	// addressed to a removed element is worth writing, and once cut, an
	// unnamed element's neighbours are elsewhere.
	private unrolls = new Map<string, UnrollEdit>();
	private inserts = new Map<string, InsertEdit>();
	private moves = new Map<string, MoveEdit>();
	private pending = new Map<string, InsertEdit['props']>();
	// What a `<text>` says, by element. Its own map rather than a prop: the
	// file spells it between the tags, and the last value is the only one
	// worth writing, same as a prop's.
	private texts = new Map<string, string>();
	private removes = new Set<string>();
	// `@inspect` variables, by file and name. Independent of the elements:
	// nothing else addresses one, and none of them is ever pending.
	private variables = new Map<string, VariableEdit>();
	// Pending sources a write is out for: edits to them wait for the answer.
	private inflight = new Set<string>();
	private retained: SourceEdit[] | undefined;
	private retainedSafe = true;
	private recoveryInvalid = false;
	private recoveryError: string | undefined;
	private lastSaveError: string | undefined;
	private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelay = 1_000;
	private state: ProjectSaveState = { status: 'saved' };
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private writing: Promise<void> | undefined;
	private edited = false;

	public constructor(dir: string, world: World) {
		this.dir = dir;
		this.world = world;
		try {
			const recovery = readRecovery(dir);
			if (recovery?.edits.length) {
				this.retained = recovery.edits;
				this.retainedSafe = recovery.safe;
				// Fresh editor sessions restart their pending counter. Keep the
				// journal's insert identities distinct from newly created clips.
				const ids: Record<string, string> = {};
				const suffix = `-recovery-${crypto.randomUUID()}`;
				for (const edit of this.retained) {
					if (edit.kind === 'insert') ids[edit.source] = edit.source + suffix;
					if (edit.kind === 'unroll') {
						for (const iteration of edit.iterations) {
							for (const value of Object.values(iteration)) {
								if (value.pending) ids[value.pending] = value.pending + suffix;
							}
						}
					}
				}
				this.retained = this.retained.map(edit => remapEdit(edit, ids));
				this.state = {
					status: 'failed', retryable: recovery.safe,
					error: recovery.safe ? 'Recovered unsaved edits. Retry saving to restore them.' : 'An interrupted save has an unknown outcome. Download the recovery edits before reloading the saved project.',
				};
			}
		} catch (error) {
			this.recoveryInvalid = true;
			this.state = { status: 'failed', retryable: false, error: `Could not read recovered edits: ${message(error)}` };
		}
	}

	/** Records an edit; the write follows once edits stop arriving. */
	public push(edit: EntityEdit): void {
		if (this.disposed) return;
		this.edited = true;

		if (edit.kind === 'unroll') {
			this.unrolls.set(edit.source, edit);
		} else if (edit.kind === 'insert') {
			this.inserts.set(edit.source, edit);
		} else if (edit.kind === 'remove') {
			this.remove(edit);
		} else if (edit.kind === 'move') {
			// Siblings placed before this node stay where it was when it moves
			// away. Their saved placement must not follow its new location.
			for (const placement of [...this.inserts.values(), ...this.moves.values()]) {
				if (placement.before !== edit.source || placement.parent !== edit.fromParent) continue;
				const updated = { ...placement };
				if (edit.fromBefore === undefined) delete updated.before;
				else updated.before = edit.fromBefore;
				if (updated.kind === 'insert') this.inserts.set(updated.source, updated);
				else this.moves.set(updated.source, updated);
			}
			// Where an element still waiting to be inserted goes is part of how
			// it is inserted, not a move of it.
			const insert = this.inserts.get(edit.source);

			if (insert) {
				const moved: InsertEdit = { ...insert, parent: edit.parent };
				if (edit.before === undefined) delete moved.before;
				else moved.before = edit.before;
				this.inserts.set(edit.source, moved);
			} else {
				this.moves.set(edit.source, edit);
			}
		} else if (edit.kind === 'variable') {
			// The last value is the only one worth writing, like a prop's.
			this.variables.set(`${edit.file}\n${edit.name}`, edit);
		} else if (edit.kind === 'text') {
			// What an element still waiting to be inserted says is part of how
			// it is inserted, the way a prop of it is.
			const insert = this.inserts.get(edit.source);
			if (insert) insert.text = edit.value;
			else this.texts.set(edit.source, edit.value);
		} else {
			// A prop of an element still waiting to be inserted is part of how
			// it is inserted.
			const insert = this.inserts.get(edit.source);
			if (insert) insert.props = { ...insert.props, [edit.name]: edit.value };
			else this.pending.set(edit.source, { ...this.pending.get(edit.source), [edit.name]: edit.value });
		}

		if (this.state.status !== 'failed' && !this.writing) this.setState({ status: this.hasPending() ? 'dirty' : 'saved' });
		this.schedule();
		if (!this.recoveryTimer) {
			this.recoveryTimer = setTimeout(() => {
				this.recoveryTimer = undefined;
				this.persistRecovery();
			}, DEBOUNCE);
		}
	}

	public recovery(): string | null {
		if (this.recoveryInvalid) return recoveryJson(this.dir);
		const recovery = this.recoverySnapshot();
		return recovery.edits.length ? formatRecovery(recovery) : recoveryJson(this.dir);
	}

	/** Used only after the user explicitly chooses to discard unsaved work. */
	public discardRecovery(): void {
		if (this.disposed) throw new Error('The project editor is no longer open');
		if (this.writing) throw new Error('Wait for the current save before discarding recovered edits');
		writeRecovery(this.dir, { safe: true, edits: [] });
		clearTimeout(this.timer);
		clearTimeout(this.recoveryTimer);
		this.recoveryTimer = undefined;
		for (const pending of [this.unrolls, this.inserts, this.moves, this.pending, this.texts, this.removes, this.variables, this.inflight]) pending.clear();
		this.retained = undefined;
		this.retainedSafe = true;
		this.recoveryInvalid = false;
		this.recoveryError = undefined;
		this.lastSaveError = undefined;
		this.setState({ status: 'saved' });
	}

	public getState(): ProjectSaveState { return this.state; }

	/** Retry only when the host confirmed exactly which edits remain. */
	public retry(): Promise<void> {
		if (this.state.status === 'failed') {
			if (!this.state.retryable) return Promise.reject(new Error(this.state.error));
			this.setState({ status: 'dirty' });
		}
		return this.settle();
	}

	private setState(state: ProjectSaveState): void {
		this.state = state;
		if (writers.get(this.world) === this) {
			for (const listener of listeners.get(this.world) ?? []) listener(state);
		}
	}

	/** Writes what is pending and stops. */
	public dispose(): void {
		clearTimeout(this.timer);
		clearTimeout(this.recoveryTimer);
		if (this.hasPending()) this.persistRecovery();
		// The last edits still belong in the file, even though the entities
		// they came from are on their way out.
		this.flush();
		this.disposed = true;
		if (writers.get(this.world) === this) writers.delete(this.world);
		if (openProjectWriters.get(this.dir) === this) openProjectWriters.delete(this.dir);
	}

	/** Save live changes before replacing the mount, preserving unapplied recovery. */
	public settleForReload(): Promise<void> {
		// Recovered edits have not been applied to this mount. Refreshing saved
		// source can keep their journal, but must never replace live unsaved edits.
		if (!this.disposed && !this.edited && this.state.status === 'failed') return Promise.resolve();
		return this.settle();
	}

	/** Persist the current edits and any edits waiting for inserted source IDs. */
	public async settle(): Promise<void> {
		if (this.disposed) throw new Error('The project editor is no longer open');
		while (true) {
			if (this.state.status === 'failed') throw new Error(this.state.error);
			this.flush();
			const writing = this.writing;
			if (!writing) {
				if (this.hasPending()) throw new Error('Inserted elements could not be resolved in the project source');
				break;
			}
			await writing;
			if (this.disposed) throw new Error('The project changed before its edits finished saving');
		}
	}

	/**
	 * Forgets everything owed to an element that is going, and to whatever
	 * was to be inserted under it: the entities went with it, so those inserts
	 * have no element to become. An element the file never had (an insert
	 * still waiting here) is simply not inserted; one it has, or that a write
	 * out right now is naming, is removed by name.
	 */
	private remove(edit: RemoveEdit): void {
		const doomed = new Set([edit.source]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const insert of this.inserts.values()) {
				if (doomed.has(insert.parent) && !doomed.has(insert.source)) {
					doomed.add(insert.source);
					grew = true;
				}
			}
		}

		// An insert still waiting here never reached the file: dropping it is
		// the whole removal. Anything else the file has, or a write out right
		// now is naming, and it goes from there by name.
		const cancelled = new Map([...this.inserts].filter(([source]) => doomed.has(source)));
		if (!this.inserts.has(edit.source)) this.removes.add(edit.source);
		for (const source of doomed) {
			this.inserts.delete(source);
			this.pending.delete(source);
			this.texts.delete(source);
			this.moves.delete(source);
		}

		// Existing anchors remain in the file until removes run last. A cancelled
		// insert never reaches it, so use the sibling that insert stood before.
		const nextAnchor = (source: string | undefined): string | undefined => {
			while (source !== undefined && cancelled.has(source)) source = cancelled.get(source)!.before;
			return source;
		};
		for (const [source, insert] of this.inserts) {
			if (insert.before !== undefined && cancelled.has(insert.before)) {
				const updated = { ...insert, before: nextAnchor(insert.before) };
				if (updated.before === undefined) delete updated.before;
				this.inserts.set(source, updated);
			}
		}
		for (const [source, move] of [...this.moves]) {
			if (cancelled.has(move.parent)) {
				// The container never reaches disk, but the saved clip moved into it
				// still needs removing from its original parent.
				this.moves.delete(source);
				this.removes.add(source);
			} else if (move.before !== undefined && cancelled.has(move.before)) {
				const updated = { ...move, before: nextAnchor(move.before) };
				if (updated.before === undefined) delete updated.before;
				this.moves.set(source, updated);
			}
		}
	}

	private schedule(): void {
		if (this.disposed || this.state.status === 'failed') return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), DEBOUNCE);
	}

	private flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.state.status === 'failed' || this.writing) return;
		if (this.retained?.length) {
			this.write(this.retained);
			return;
		}
		if (!this.hasPending()) return;

		// Anything addressed through an element whose insert is still out
		// waits for its name: edits to it, and inserts or moves under or
		// beside it.
		const waits = (source: string | undefined): boolean => source !== undefined && this.inflight.has(source);
		// A placement waits for its parent or anchor to be ready. Dependencies
		// come first, so anything held here also holds its dependents.
		const ordered = this.orderedPlacements();
		const heldInserts = new Map<string, InsertEdit>();
		const heldMoves = new Map<string, MoveEdit>();
		const unnamed = (source: string | undefined): boolean => source !== undefined && (waits(source) || heldInserts.has(source) || heldMoves.has(source));
		for (const placement of ordered) {
			if ((placement.kind === 'move' && waits(placement.source)) || unnamed(placement.parent) || unnamed(placement.before)) {
				if (placement.kind === 'insert') heldInserts.set(placement.source, placement);
				else heldMoves.set(placement.source, placement);
			}
		}
		const held = new Map([...this.pending].filter(([source]) => waits(source)));
		const heldTexts = new Map([...this.texts].filter(([source]) => waits(source)));
		const heldRemoves = new Set([...this.removes].filter(waits));
		const edits = this.queuedEdits(ordered).filter(edit => {
			if (edit.kind === 'insert') return !heldInserts.has(edit.source);
			if (edit.kind === 'move') return !heldMoves.has(edit.source);
			if (edit.kind === 'set') return !held.has(edit.source) && !heldTexts.has(edit.source);
			if (edit.kind === 'remove') return !heldRemoves.has(edit.source);
			return true;
		});
		if (!edits.length) return;

		// The names an unroll handed out are out with it.
		const unrolls = [...this.unrolls.values()];
		this.unrolls = new Map();
		this.variables = new Map();
		this.inflight = new Set([
			...[...this.inflight, ...this.inserts.keys()].filter((source) => !heldInserts.has(source)),
			...unrolls.flatMap((unroll) => pendingsOf(unroll)),
		]);
		this.inserts = heldInserts;
		this.moves = heldMoves;
		this.pending = held;
		this.texts = heldTexts;
		this.removes = heldRemoves;

		this.write(edits);
	}

	private queuedEdits(ordered = this.orderedPlacements()): SourceEdit[] {
		return [
			// First: the copies an unroll makes are what the rest is addressed to.
			...[...this.unrolls.values()].map(({ kind, source, iterations }): SourceEdit => ({ kind, source, iterations })),
			...ordered
				.map((edit): SourceEdit => {
					const { source, parent, before } = edit;
					const placement = { source, parent, ...(before === undefined ? {} : { before }) };
					return edit.kind === 'insert'
						? { kind: edit.kind, ...placement, tag: edit.tag, props: edit.props, ...(edit.text === undefined ? {} : { text: edit.text }) }
						: { kind: edit.kind, ...placement };
				}),
			// One `set` per element, whatever it changed: a prop, its text, or both.
			...[...new Set([...this.pending.keys(), ...this.texts.keys()])]
				.map((source): SourceEdit => ({
					kind: 'set',
					source,
					props: this.pending.get(source) ?? {},
					...(this.texts.has(source) ? { text: this.texts.get(source)! } : {}),
				})),
			// Last: cutting an unnamed element moves the positions of everything
			// after it, and nothing above is addressed to what is being removed.
			...[...this.removes]
				.map((source): SourceEdit => ({ kind: 'remove', source })),
			// Variables are addressed by name, so nothing above moves them.
			...[...this.variables.values()]
				.map(({ file, name, value }): SourceEdit => ({ kind: 'variable', file, name, value })),
		];
	}

	private recoverySnapshot() {
		return {
			edits: [...(this.retained ?? []), ...this.queuedEdits()],
			safe: !this.retained?.length || this.retainedSafe,
			...(this.state.status === 'failed' ? { error: this.state.error } : {}),
		};
	}

	private persistRecovery(): void {
		if (this.recoveryInvalid) return;
		try {
			writeRecovery(this.dir, this.recoverySnapshot());
			this.recoveryError = undefined;
		} catch (error) {
			const description = message(error);
			if (this.recoveryError !== description) toast.error('Could not save a recovery copy', { description });
			this.recoveryError = description;
		}
	}

	private write(edits: SourceEdit[]): void {
		this.retained = edits;
		this.retainedSafe = false;
		this.persistRecovery();
		this.setState({ status: 'saving' });
		let retryable = false;
		let automaticRetry = false;
		const writing = writeProject(this.dir, edits).then((result) => {
			retryable = result.remaining !== undefined;
			this.retainedSafe = retryable;
			automaticRetry = retryable && !!result.error;
			this.retained = result.remaining ?? (result.error || result.skipped.length ? edits : undefined);
			this.report(result);
			if (result.error) throw new Error(result.error);
			if (result.skipped.length || this.retained?.length) throw new Error(`Some edits could not be written: ${result.skipped.join(', ')}`);
			this.retained = undefined;
			this.inflight.clear();
		});
		this.writing = writing;
		const completed = writing.then(
			() => {
				this.writing = undefined;
				this.retryDelay = 1_000;
				this.lastSaveError = undefined;
				this.persistRecovery();
				this.setState({ status: this.hasPending() ? 'dirty' : 'saved' });
				if (this.hasPending()) {
					if (this.disposed) this.flush();
					else this.schedule();
				}
			},
			(error: unknown) => {
				this.writing = undefined;
				const reason = retryable ? message(error) : `${message(error)}. Save confirmation was lost. Download the recovery edits before reloading the saved project.`;
				const description = this.recoveryError ? `${reason}. Recovery copy failed: ${this.recoveryError}` : reason;
				this.setState({ status: 'failed', error: description, retryable });
				this.persistRecovery();
				if (this.lastSaveError !== description) toast.error('Could not save the project', { description });
				this.lastSaveError = description;
				if (automaticRetry && !this.disposed) {
					this.timer = setTimeout(() => { void this.retry().catch(() => {}); }, this.retryDelay);
					this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
				}
			},
		);
		const saves = savingProjects.get(this.dir) ?? new Set<Promise<void>>();
		savingProjects.set(this.dir, saves);
		saves.add(completed);
		const finished = () => {
			saves.delete(completed);
			if (!saves.size) savingProjects.delete(this.dir);
		};
		void completed.then(finished, finished);
	}

	private hasPending(): boolean {
		return !!(this.retained?.length || this.unrolls.size || this.inserts.size || this.moves.size || this.pending.size || this.texts.size || this.removes.size || this.variables.size);
	}

	/**
	 * Place parents and anchors before the edits depending on them. A split
	 * may create its wrapper after its copies; a moved anchor must reach the
	 * destination parent before another clip can be placed beside it.
	 */
	private orderedPlacements(): Array<InsertEdit | MoveEdit> {
		const ordered: Array<InsertEdit | MoveEdit> = [];
		const placed = new Set<string>();
		const waiting = [...this.inserts.values(), ...this.moves.values()];
		const owed = (source: string | undefined): boolean => source !== undefined && (this.inserts.has(source) || this.moves.has(source)) && !placed.has(source);

		// A pass that places nothing is the end of it: what is left waits on
		// itself, and goes last rather than being dropped.
		for (let moved = true; moved && waiting.length; ) {
			moved = false;
			for (let index = 0; index < waiting.length; ) {
				const placement = waiting[index]!;
				if (owed(placement.parent) || owed(placement.before)) {
					index++;
					continue;
				}
				ordered.push(placement);
				placed.add(placement.source);
				waiting.splice(index, 1);
				moved = true;
			}
		}

		return [...ordered, ...waiting];
	}

	private report(result: WriteResult): void {
		const ids = result.ids ?? {};
		if (!this.disposed) getDocumentEditor(this.world)?.restamp(ids);
		const rename = (source: string): string => ids[source] ?? source;
		// Unconfirmed inserts keep their pending identity and their dependents.
		// Only the IDs returned by a successful file save can rename them.
		for (const [source, props] of [...this.pending]) {
			const next = rename(source);
			if (next === source) continue;
			this.pending.delete(source);
			this.pending.set(next, { ...this.pending.get(next), ...props });
		}
		for (const [source, text] of [...this.texts]) {
			const next = rename(source);
			if (next === source) continue;
			this.texts.delete(source);
			this.texts.set(next, text);
		}
		for (const [source, insert] of this.inserts) {
			this.inserts.set(source, { ...insert, parent: rename(insert.parent), ...(insert.before === undefined ? {} : { before: rename(insert.before) }) });
		}
		for (const [source, move] of [...this.moves]) {
			this.moves.delete(source);
			const next = rename(source);
			this.moves.set(next, { ...move, source: next, parent: rename(move.parent), ...(move.before === undefined ? {} : { before: rename(move.before) }) });
		}
		for (const source of [...this.removes]) {
			this.removes.delete(source);
			this.removes.add(rename(source));
		}
		for (const source of Object.keys(ids)) this.inflight.delete(source);
	}

}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function remapEdit(edit: SourceEdit, ids: Record<string, string>): SourceEdit {
	if (edit.kind === 'variable') return edit;
	const renamed = { ...edit, source: ids[edit.source] ?? edit.source };
	if (renamed.kind === 'insert' || renamed.kind === 'move') {
		renamed.parent = ids[renamed.parent] ?? renamed.parent;
		if (renamed.before !== undefined) renamed.before = ids[renamed.before] ?? renamed.before;
	}
	if (renamed.kind === 'unroll') {
		renamed.iterations = renamed.iterations.map(iteration => Object.fromEntries(Object.entries(iteration).map(([source, value]) => [
			ids[source] ?? source, { ...value, ...(value.pending ? { pending: ids[value.pending] ?? value.pending } : {}) },
		])));
	}
	return renamed;
}

/** The pending sources an unroll stamped on the iterations it wrote out. */
const pendingsOf = (unroll: UnrollEdit): string[] => {
	return unroll.iterations
		.flatMap((iteration) => Object.values(iteration)
			.flatMap(({ pending }) => (pending ? [pending] : [])));
}

/**
 * Collects edits against the project in `dir` and writes them back.
 *
 * `world` is only read after a write returns, to answer the one thing a write
 * can tell the canvas: an element that had no `id` in the source has one now,
 * and the entity it produced has to be re-stamped with it. Without that, the
 * next edit to the same element would still address it by a position the
 * write itself may have invalidated.
 */
export function createEditWriter(dir: string, world: World): EditWriter {
	if (savingProjects.has(dir)) throw new Error('Wait for the previous project edits to finish saving before opening its editor');
	const writer = new EditWriter(dir, world);
	writers.set(world, writer);
	openProjectWriters.set(dir, writer);
	for (const listener of listeners.get(world) ?? []) listener(writer.getState());
	return writer;
}

/** Agent mutations acknowledge success only after their JSX is saved. */
export function flushProjectEdits(world: World, options: { allowUnloaded?: boolean } = {}): Promise<void> {
	const writer = writers.get(world);
	if (!writer) return options.allowUnloaded ? Promise.resolve() : Promise.reject(new Error('The project writer is not ready'));
	return writer.settle();
}

export function getProjectSaveState(world: World): ProjectSaveState {
	return writers.get(world)?.getState() ?? { status: 'saved' };
}

export function subscribeProjectSaveState(world: World, listener: (state: ProjectSaveState) => void): () => void {
	const subscribers = listeners.get(world) ?? new Set();
	listeners.set(world, subscribers);
	subscribers.add(listener);
	listener(getProjectSaveState(world));
	return () => { subscribers.delete(listener); };
}

export function getProjectRecovery(world: World): string | null {
	return writers.get(world)?.recovery() ?? null;
}

export function discardProjectRecovery(world: World): void {
	const writer = writers.get(world);
	if (!writer) throw new Error('The project writer is not ready');
	writer.discardRecovery();
}

export function retryProjectEdits(world: World): Promise<void> {
	const writer = writers.get(world);
	return writer ? writer.retry() : Promise.reject(new Error('The project writer is not ready'));
}

export type { EditWriter };
