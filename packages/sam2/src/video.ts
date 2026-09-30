/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { VideoSampleSink } from 'mediabunny';

import type { InputVideoTrack, VideoSample } from 'mediabunny';
import type { Sam2Mask } from './mask';
import type { Sam2Correction, Sam2Point, Sam2Video } from './tracker';

export type FrameRequest = {
	track: InputVideoTrack;
	timestamp: number;
};

export type TrackRequest = {
	track: InputVideoTrack;
	/** Where each frame to segment is in the file, in seconds, ascending. */
	timestamps: number[];
	/** Which of `timestamps` the points were placed on. */
	seedIndex: number;
	points: Sam2Point[];
	/** The seed's mask as the user corrected it: what the object is tracked from. */
	correct?: Sam2Correction;
	signal?: AbortSignal;
	/** Called as each frame's mask is ready, in tracking order: the seed, then forward, then backward. */
	onMask: (index: number, mask: Sam2Mask) => void;
};

/**
 * Frames decoded in reverse are read a batch at a time, in file order, and
 * walked backward: seeking to every frame on its own would decode from its
 * keyframe each time.
 */
const REVERSE_BATCH = 12;

/**
 * Decodes one frame and holds it in the model, encoded, so prompts on it
 * (`model.preview`, `model.seedHeld`) cost the mask decoder alone.
 */
export async function holdFrame(model: Sam2Video, request: FrameRequest): Promise<void> {
	const { track, timestamp } = request;
	const sample = await new VideoSampleSink(track).getSample(timestamp);
	if (!sample) throw new Error('The frame could not be decoded');
	await withVideoFrame(sample, (frame) => model.hold(frame, track.rotation));
}

/**
 * Segments the object at the seed and follows it through every frame of the
 * request, away from the seed in both directions. Frames that decode to the
 * same picture as the one before (a source slower than the timestamps) share
 * its mask instead of being run again.
 */
export async function trackObject(model: Sam2Video, request: TrackRequest): Promise<void> {
	const { track, timestamps, seedIndex, points, correct, signal, onMask } = request;
	const sink = new VideoSampleSink(track);
	const rotation = track.rotation;
	const total = timestamps.length;

	const seed = await sink.getSample(timestamps[seedIndex]!);
	if (!seed) throw new Error('The prompted frame could not be decoded');

	const seedTimestamp = seed.timestamp;
	const seedMask = await withVideoFrame(seed, (frame) => model.seed(frame, rotation, points, seedIndex, correct));
	onMask(seedIndex, seedMask);

	let previous = { timestamp: seedTimestamp, mask: seedMask };

	const process = async (sample: VideoSample, index: number) => {
		if (sample.timestamp === previous.timestamp) {
			sample.close();
			onMask(index, previous.mask);
			return;
		}
		const timestamp = sample.timestamp;
		const mask = await withVideoFrame(sample, (frame) => model.track(frame, rotation, index, total));
		previous = { timestamp, mask };
		onMask(index, mask);
	};

	const forward = sink.samplesAtTimestamps(timestamps.slice(seedIndex + 1));
	let index = seedIndex + 1;
	let failure: { cause: unknown } | undefined;
	const fail = (cause: unknown) => { failure ??= { cause }; };
	const closeSample = (sample: VideoSample | null) => {
		try { sample?.close(); } catch (cause) { fail(cause); }
	};
	// Own the rejection immediately while inference is working on the previous frame.
	const readNext = () => forward.next().then(
		(result) => ({ ok: true as const, result }),
		(cause: unknown) => ({ ok: false as const, cause }),
	);
	// The next decode is requested before the current frame is processed, so
	// decoding and inference overlap.
	let pending = readNext();
	try {
		for (;;) {
			const decoded = await pending;
			if (!decoded.ok) throw decoded.cause;
			const { done, value: sample } = decoded.result;
			if (done) break;
			pending = readNext();

			if (signal?.aborted) {
				closeSample(sample);
				break;
			}
			if (sample) await process(sample, index);
			index++;
		}
	} catch (cause) {
		fail(cause);
	} finally {
		const decoded = await pending;
		if (!decoded.ok) fail(decoded.cause);
		else if (!decoded.result.done) closeSample(decoded.result.value);
		await forward.return().catch(fail);
	}
	if (failure) throw failure.cause;
	if (signal?.aborted) return;

	model.rewind();
	previous = { timestamp: seedTimestamp, mask: seedMask };

	for (let end = seedIndex; end > 0; end -= REVERSE_BATCH) {
		const start = Math.max(0, end - REVERSE_BATCH);
		const samples: (VideoSample | null)[] = [];
		try {
			for await (const sample of sink.samplesAtTimestamps(timestamps.slice(start, end))) samples.push(sample);
			for (let i = samples.length - 1; i >= 0; i--) {
				if (signal?.aborted) break;
				const sample = samples[i];
				if (!sample) continue;
				// Transfer ownership to process, which closes it even if inference fails.
				samples[i] = null;
				await process(sample, start + i);
			}
		} catch (cause) {
			failure = { cause };
		} finally {
			for (const sample of samples) closeSample(sample);
		}
		if (failure) throw failure.cause;
		if (signal?.aborted) return;
	}
}

async function withVideoFrame<T>(sample: VideoSample, run: (frame: VideoFrame) => Promise<T>): Promise<T> {
	let frame: VideoFrame | undefined;
	let failed = false;
	try {
		frame = sample.toVideoFrame();
		return await run(frame);
	} catch (cause) {
		failed = true;
		throw cause;
	} finally {
		let failure: { cause: unknown } | undefined;
		try { frame?.close(); } catch (cause) { failure = { cause }; }
		try { sample.close(); } catch (cause) { failure ??= { cause }; }
		if (!failed && failure) throw failure.cause;
	}
}
