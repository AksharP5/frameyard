/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BlobSource, ALL_FORMATS, Input, InputVideoTrack, EncodedPacketSink, EncodedPacket, CanvasSink, type WrappedCanvas } from 'mediabunny';

import { AssetId, VideoDecoderHandle, Mode, OriginalMedia } from '../traits';
import { assert } from '../utils/assert';
import { getAsset, getAssetFile, getSequenceFrameRate } from '../actions/assets';
import { FrameCache } from './frame-cache';
import { getKeyframeIndex } from './keyframe-index';
import { SequenceDecoder } from './sequence';

import type { Entity, World } from 'koota';
import type { KeyframeIndex } from './keyframe-index';
import type { OriginalMediaProvider, OriginalVideoFrames } from '../traits/world';
import type { VideoAsset } from '@diffusionstudio/assets';


export type VideoBufferMode = 'discarded' | 'idle' | 'alive';
type SampleTiming = Pick<EncodedPacket, 'timestamp' | 'duration'>;

/**
 * Inactivity window after which an `alive` buffer automatically drops to
 * `idle`, freeing its decoder and frame cache while keeping the display canvas.
 */
const IDLE_TIMEOUT_MS = 10_000;

/**
 * Max extra frames we are willing to decode forward from the live cursor in
 * order to avoid a keyframe lookup + decoder reseed. Higher = stronger bias.
 */
const FORWARD_BIAS_FRAMES = 24;

/**
 * Frames used to drain the decoder in case of a backward seek to
 * ensure the target frame is surfaced.
 */
const DRAIN_FRAMES = 8;

/**
 * How far the preview may drift from the requested frame. A neighbour this close
 * beats holding the last drawn frame while the exact one is still decoding.
 */
const DISPLAY_TOLERANCE_FRAMES = 4;

/**
 * Total pixel budget of the preview frame cache
 */
const CACHE_PIXEL_BUDGET = 768 * 432 * 81; // 81 tiles at 768x432

/**
 * Per-tile pixel cap (~720p) — enough detail for the preview canvas.
 */
const MAX_TILE_PIXELS = 1280 * 720;

/**
 * Two seeks arriving closer together than this are treated as one continuous drag.
 */
const SCRUB_EVENT_WINDOW_MS = 250;

/**
 * Quiet period after the last scrub seek before the exact frame is resolved.
 */
const SCRUB_SETTLE_MS = 120;

const MIN_CACHE_COUNT = 30;
const MAX_CACHE_COUNT = 81;

export class VideoBuffer {
	public renderedFrame = -1;
	public get pendingFrame(): number { return this.currentFrame; }
	public errored = false;
	public asset: VideoAsset;
	public firstPacketTimestamp = 0;
	public packetSink: EncodedPacketSink | null = null;
	public mode: VideoBufferMode = 'alive';
	public initialized: Promise<void>;

	public readonly cache: FrameCache;
	public readonly queue = new VideoDecoderQueue(this.frameCallback.bind(this), () => { this.errored = true; });

	// user facing display canvas
	public readonly canvas = new OffscreenCanvas(0, 0);
	public readonly ctx = this.canvas.getContext('2d')!;

	private currentFrame: number = -1;
	private frameRate: number;
	private isDirty: boolean = true;
	private keyframes: KeyframeIndex | null = null;

	/**
	 * Frame the preview is aiming to show. Tracks `currentFrame` except while scrubbing,
	 * where it points at the covering keyframe instead of the requested frame.
	 */
	private displayFrame: number = -1;

	/**
	 * Keyframes a scrub is waiting on. The preview keeps showing the last one that landed
	 * until the next arrives, so a drag never blanks out for the length of a decode.
	 * Holds several at once: decoder output trails submission by a handful of packets.
	 */
	private readonly pendingScrub = new Set<number>();

	private lastFrameIndex: number = 0;
	private seekGeneration = 0;
	private filling: { generation: number; range: [number, number] } | null = null;
	private seekLock: Promise<void> = Promise.resolve();
	private iterator: AsyncGenerator<EncodedPacket, void, unknown> | null = null;
	private endOfStream = false;
	private decodedEndFrame = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSeekAt: number = -Infinity;

	public constructor(asset: VideoAsset) {
		this.asset = asset;
		this.frameRate = asset.frameRate;

		const pixels = Math.min(asset.width * asset.height, MAX_TILE_PIXELS);
		const count = Math.min(MAX_CACHE_COUNT, Math.max(MIN_CACHE_COUNT, Math.floor(CACHE_PIXEL_BUDGET / pixels)));
		this.cache = new FrameCache({ pixels, count });

		this.initialized = this.initialize();
	}

	private async initialize() {
		try {
			const videoTrack = await getVideoTrack(this.asset);
			if (this.isDiscarded()) return;

			assert(videoTrack, 'Video track not found');

			this.keyframes = getKeyframeIndex(videoTrack);

			await this.queue.init(videoTrack);
			const firstTimestamp = await videoTrack.getFirstTimestamp();
			if (this.isDiscarded()) return;

			this.cache.rotation = videoTrack.rotation;
			this.packetSink = new EncodedPacketSink(videoTrack);
			this.firstPacketTimestamp = Math.max(0, firstTimestamp ?? 0);
			this.lastFrameIndex = Math.max(0, Math.ceil(this.asset.duration * this.frameRate) - 1);
			this.isDirty = true;
		} catch (e) {
			if (this.isDiscarded()) return;
			console.error('Error initializing video decoder', e);
			this.errored = true;
		}
	}

	private isDiscarded() { return this.mode === 'discarded'; }

	private frameCallback(frame: VideoFrame, timing?: SampleTiming) {
		if (this.mode !== 'alive') return;
		const timestampSeconds = timing?.timestamp ?? frame.timestamp / 1e6;
		const frameIndex = this.secondsToFrames(timestampSeconds);
		const duration = timing?.duration || (frame.duration ? frame.duration / 1e6 : 1 / this.asset.frameRate);
		const endFrame = this.secondsToFrames(timestampSeconds + duration);
		this.decodedEndFrame = Math.max(this.decodedEndFrame, endFrame);
		// Cache only samples visible at a requested project tick. Average source
		// FPS can merge distinct VFR pictures; dense samples between ticks need no tile.
		if (endFrame <= frameIndex) return;
		// GOP preroll is needed by the codec, but uploading off-window frames
		// wastes the time the incoming clip has to prepare its first picture.
		if ((frameIndex < this.cache.leftFrameIndex || frameIndex > this.cache.rightFrameIndex)
			&& !(frameIndex <= this.currentFrame && this.currentFrame < endFrame)
			&& !this.pendingScrub.has(frameIndex)) return;
		this.cache.insert(frame, frameIndex, endFrame);
		this.isDirty = true;

		// A scrub keyframe takes over the preview the moment it lands, and only then:
		// matching on the index keeps frames from an abandoned fill out of the display.
		if (this.pendingScrub.delete(frameIndex)) {
			this.displayFrame = frameIndex;
		}
	}

	public seekTo(frame: number, frameRate: number): undefined {
		if (this.isDiscarded()) return;
		this.setFrameRate(frameRate);
		const targetFrame = Math.round(frame);

		const isEmpty = !this.packetSink;
		const isCurrentFrame = targetFrame === this.currentFrame
			&& (this.mode === 'alive' || this.renderedFrame === targetFrame);
		const errored = this.errored;

		if (isEmpty || isCurrentFrame || errored) {
			return;
		}

		const previousFrame = this.currentFrame;
		const consecutive = performance.now() - this.lastSeekAt < SCRUB_EVENT_WINDOW_MS;
		this.lastSeekAt = performance.now();

		this.currentFrame = targetFrame;
		this.isDirty = true;

		this.touch();

		// A run of large jumps is a drag, not a playback step. Walking each GOP to the
		// exact frame costs more than the gap between pointer events, so every walk gets
		// cancelled by the next one and nothing ever paints.
		const jumped = Math.abs(targetFrame - previousFrame) > FORWARD_BIAS_FRAMES;

		if (consecutive && jumped && this.scrubTo(targetFrame)) {
			return;
		}

		this.exactSeekTo(targetFrame, previousFrame);
	}

	/** Rehydrate an idle preview and prime its opening three frames before the clock starts. */
	public prepareForPlayback(frame: number, frameRate: number, end: number): boolean {
		if (this.isDiscarded() || this.errored || !this.packetSink) return false;
		this.setFrameRate(frameRate);
		const last = Math.max(0, Math.min(this.lastFrameIndex, Math.ceil(end) - 1));
		const target = Math.max(0, Math.min(last, Math.round(frame)));
		if (this.settleTimer !== null) {
			clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}
		this.touch();
		this.currentFrame = target;
		this.isDirty = true;
		this.lastSeekAt = -Infinity;
		this.exactSeekTo(target, target, true);
		// Packet timestamps may skip nominal frame indices in variable-rate footage.
		const through = Math.min(target + 2, last);
		return this.findDisplayFrame() !== undefined
			&& (this.cache.findCovering(through) !== undefined || this.cache.hasAtOrAfter(through) || this.endOfStream);
	}

	/**
	 * Paints the first project-visible picture at the preceding keyframe, without
	 * walking the entire GOP. Returns false when the keyframe index cannot place the
	 * target yet, leaving the caller to fall back to an exact seek.
	 */
	private scrubTo(targetFrame: number): boolean {
		const keyTimestamp = this.keyframes?.floor(this.framesToSeconds(targetFrame)) ?? null;

		if (keyTimestamp === null) {
			return false;
		}

		const keyFrame = this.secondsToFrames(keyTimestamp);
		this.scheduleSettle();

		// Supersedes any fill still running for a position we have already left.
		const generation = ++this.seekGeneration;

		// Consecutive positions inside one GOP resolve to a keyframe we already hold.
		if (this.cache.has(keyFrame)) {
			this.pendingScrub.clear();
			this.displayFrame = keyFrame;
			return true;
		}

		this.pendingScrub.add(keyFrame);

		this.seekLock = this.seekLock
			.then(() => this.decodeKeyframe(keyTimestamp, generation))
			.catch(error => {
				if (generation !== this.seekGeneration || this.isDiscarded()) return;
				this.errored = true;
				console.error('Could not decode video preview', error);
			});

		return true;
	}

	private async decodeKeyframe(keyTimestamp: number, generation: number): Promise<void> {
		if (generation !== this.seekGeneration) return;

		const keyPacket = await this.packetSink?.getKeyPacket(keyTimestamp);
		if (!keyPacket || generation !== this.seekGeneration) return;

		// Seed the iterator here as well, so the settle pass continues forward from this
		// keyframe instead of reseeding the decoder a second time.
		await this.iterator?.return();
		if (generation !== this.seekGeneration) return;
		const iterator = this.packetSink?.packets(keyPacket) ?? null;
		this.iterator = iterator;
		this.endOfStream = false;
		this.decodedEndFrame = 0;
		if (!iterator) return;

		if (!this.queue.isAlive) {
			this.queue.reseed();
		}

		const until = this.framesToSeconds(this.secondsToFrames(keyTimestamp));
		while (true) {
			const { value: packet } = await iterator.next();
			if (this.iterator !== iterator) return;
			if (!packet) {
				await this.queue.finish();
				return;
			}
			await this.queue.decode(packet);
			if (generation !== this.seekGeneration || packet.timestamp >= until) return;
		}
	}

	/**
	 * Re-runs the seek for real once the drag stops.
	 */
	private scheduleSettle() {
		if (this.settleTimer !== null) {
			clearTimeout(this.settleTimer);
		}

		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			if (this.mode !== 'alive' || this.errored) return;
			this.exactSeekTo(this.currentFrame, this.currentFrame);
		}, SCRUB_SETTLE_MS);
	}

	private exactSeekTo(targetFrame: number, previousFrame: number, preparingPlayback = false) {
		this.displayFrame = targetFrame;
		this.pendingScrub.clear();

		// Playback can advance while a keyframe lookup or packet read is pending.
		// Keep that useful prefetch instead of canceling it on every display frame.
		if (this.filling?.generation === this.seekGeneration
			&& targetFrame >= previousFrame
			&& targetFrame <= this.filling.range[1]
			&& (targetFrame >= this.filling.range[0] || this.isBlockedFrame(targetFrame))) return;

		const forward = this.isBlockedFrame(targetFrame)
			? targetFrame >= previousFrame
			: true;

		const generation = ++this.seekGeneration;

		const [left, right] = this.computeWindow(targetFrame, forward);
		this.cache.leftFrameIndex = left;
		this.cache.rightFrameIndex = right;

		let seed = targetFrame;
		let run: Promise<void>
		if (forward) {
			while (this.isBlockedFrame(seed) && seed <= this.cache.rightFrameIndex) {
				seed++;
			}

			run = this.seekLock.then(() => this.fillCache([seed, this.cache.rightFrameIndex], generation, preparingPlayback));
		} else {
			while (this.cache.findCovering(seed) !== undefined && seed >= this.cache.leftFrameIndex) {
				seed--;
			}
			if (seed < this.cache.leftFrameIndex) return;

			// TODO: Find a better solution for DRAIN_FRAMES
			run = this.seekLock.then(() => this.fillCache([this.cache.leftFrameIndex, seed + DRAIN_FRAMES], generation, preparingPlayback));
		}

		// Run after the previous seek finishes — never concurrently.
		this.seekLock = run.finally(() => {
			if (this.filling?.generation === generation) this.filling = null;
		}).catch(error => {
			if (generation !== this.seekGeneration || this.isDiscarded()) return;
			this.errored = true;
			console.error('Could not decode video preview', error);
		});
	}

	private setFrameRate(frameRate: number) {
		if (this.frameRate === frameRate) return;
		this.idle();
		this.frameRate = frameRate;
		this.lastFrameIndex = Math.max(0, Math.ceil(this.asset.duration * frameRate) - 1);
		this.currentFrame = this.displayFrame = this.renderedFrame = -1;
		this.lastSeekAt = -Infinity;
	}

	private framesToSeconds(frames: number) {
		return Math.max(this.firstPacketTimestamp, (frames / this.frameRate) + this.firstPacketTimestamp);
	}

	private secondsToFrames(seconds: number) {
		// The first project tick at or after the packet timestamp. Keep its
		// precision; WebCodecs truncates timestamps and durations to microseconds.
		return Math.max(0, Math.ceil((seconds - this.firstPacketTimestamp) * this.frameRate - 1e-7));
	}

	/**
	 * Whether `frame` is already taken care of — decoded into the cache, or still in-flight.
	 */
	private isBlockedFrame(frame: number) {
		if (this.cache.findCovering(frame) !== undefined) return true;

		for (const timing of this.queue.inFlight.values()) {
			if (this.secondsToFrames(timing.timestamp) <= frame
				&& frame < this.secondsToFrames(timing.timestamp + timing.duration)) {
				return true;
			}
		}

		return false;
	}

	private computeWindow(targetFrame: number, forward: boolean): [number, number] {
		const span = this.cache.config.count - 2;

		// Whole video fits in the cache — keep all of it.
		if (this.lastFrameIndex <= span) {
			return [0, this.lastFrameIndex];
		}

		const ahead = Math.round((span * 2) / 3);
		const behind = span - ahead;

		let left = targetFrame - (forward ? behind : ahead);
		let right = targetFrame + (forward ? ahead : behind);

		// Push budget that falls outside the boundaries onto the other side.
		if (left < 0) {
			right -= left;
			left = 0;
		}
		if (right > this.lastFrameIndex) {
			left -= right - this.lastFrameIndex;
			right = this.lastFrameIndex;
		}

		return [Math.max(0, left), Math.min(this.lastFrameIndex, right)];
	}

	private async fillCache(range: [number, number], generation: number, preparingPlayback: boolean): Promise<void> {
		if (generation !== this.seekGeneration || range[0] > range[1]) return;
		// Batch small refills when the requested frame is already available.
		if (!preparingPlayback && range[1] < this.lastFrameIndex && range[1] - range[0] <= 3
			&& this.cache.findCovering(this.currentFrame) !== undefined) return;
		this.filling = { generation, range };

		const fromSecs = this.framesToSeconds(range[0]);
		const untilSecs = this.framesToSeconds(range[1]);
		const cursor = this.queue.lastSubmitted;
		const live = !!(this.iterator && this.queue.isAlive && cursor);

		let reuse = live && cursor!.timestamp < untilSecs;
		let keyTimestamp = this.keyframes?.floor(fromSecs) ?? null;

		// If the cursor lags far behind the range start, skip forward to the nearest
		// keyframe rather than decoding through the whole gap.
		const biasSecs = FORWARD_BIAS_FRAMES / this.frameRate;
		if (reuse && cursor!.timestamp < fromSecs - biasSecs) {
			keyTimestamp ??= (await this.packetSink?.getKeyPacket(fromSecs))?.timestamp ?? null;
			if (generation !== this.seekGeneration) return;
			if (keyTimestamp !== null && keyTimestamp - cursor!.timestamp > biasSecs) {
				reuse = false; // jumping to the keyframe
			}
		}

		// we cant reuse the iterator, so we need to reseed the decoder
		// and get create a new iterator
		if (!reuse) {
			const keyPacket = (await this.packetSink?.getKeyPacket(keyTimestamp ?? fromSecs)) ?? null;
			if (!keyPacket || generation !== this.seekGeneration) return;
			await this.iterator?.return();
			if (generation !== this.seekGeneration) return;
			this.iterator = this.packetSink?.packets(keyPacket) ?? null;
			this.endOfStream = false;
			this.decodedEndFrame = 0;
		}

		if (!this.queue.isAlive) {
			this.queue.reseed();
		}

		if (generation !== this.seekGeneration || !this.iterator) return;
		const iterator = this.iterator;

		while (true) {
			const { value: packet, done } = await iterator.next();
			// The iterator has consumed this packet; dropping it breaks dependent
			// frames if the next seek reuses the same stream. Idle/dispose detach it.
			if (this.iterator !== iterator) break;
			if (done || !packet) {
				await this.queue.finish();
				if (this.iterator === iterator) {
					this.endOfStream = true;
					if (this.decodedEndFrame > 0) this.lastFrameIndex = Math.min(this.lastFrameIndex, this.decodedEndFrame - 1);
				}
				break;
			}

			await this.queue.decode(packet);

			if (generation !== this.seekGeneration || (range[1] < this.lastFrameIndex && packet.timestamp >= untilSecs)) break;
		}
	}

	private findDisplayFrame() {
		return this.cache.findCovering(this.displayFrame)
			?? (this.endOfStream && this.displayFrame >= this.lastFrameIndex
				? this.cache.findAtOrBefore(this.lastFrameIndex)
				: this.cache.findNearest(this.displayFrame, DISPLAY_TOLERANCE_FRAMES));
	}

	public toBitmap() {
		if (this.isDirty && this.displayFrame >= 0) {

			const nearest = this.findDisplayFrame();
			const tile = nearest === undefined ? undefined : this.cache.findTile(nearest);
			const ctx = this.ctx;

			if (tile && (this.canvas.width !== tile.width || this.canvas.height !== tile.height)) {
				this.canvas.width = tile.width;
				this.canvas.height = tile.height;
				this.ctx.imageSmoothingEnabled = false;
			}

			if (tile) {
				this.renderedFrame = nearest!;
				ctx.drawImage(
					this.cache.atlas,
					tile.x,
					tile.y,
					tile.width,
					tile.height,
					0,
					0,
					tile.width,
					tile.height,
				);
				this.isDirty = false;
			}
		}

		if (this.canvas.width === 0 || this.canvas.height === 0) {
			return null;
		}

		return this.canvas;
	}

	private touch() {
		this.mode = 'alive';
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
		}
		this.idleTimer = setTimeout(() => this.idle(), IDLE_TIMEOUT_MS);
	}

	public idle() {
		if (this.mode !== 'alive') return;
		this.mode = 'idle';
		this.seekGeneration++;

		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		if (this.settleTimer !== null) {
			clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}

		this.pendingScrub.clear();
		this.endOfStream = false;
		this.cache.dispose();
		this.queue.dispose();
		this.iterator?.return();
		this.iterator = null;
	}

	public dispose() {
		if (this.mode === 'discarded') return;
		this.mode = 'discarded';
		this.seekGeneration++;
		this.packetSink = null;

		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		if (this.settleTimer !== null) {
			clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}

		this.pendingScrub.clear();
		this.cache.dispose();
		this.queue.dispose();
		this.iterator?.return();
		this.iterator = null;

		// Release the display canvas backing store.
		this.canvas.width = 0;
		this.canvas.height = 0;
	}
}

class VideoDecoderQueue {
	private config: VideoDecoderConfig | null = null;
	private decoder: VideoDecoder | null = null;
	private resolver: ReturnType<typeof Promise.withResolvers> | null = null;
	private callback: (frame: VideoFrame, timing?: SampleTiming) => void;
	public lastSubmitted: EncodedPacket | null = null;
	public readonly inFlight = new Map<number, SampleTiming>();

	public constructor(callback: (frame: VideoFrame, timing?: SampleTiming) => void, private readonly onError: () => void) {
		this.callback = callback;
	}

	public get isAlive() {
		return this.decoder?.state === 'configured';
	}

	/**
	 * Synchronously discard all in-flight work and re-arm the decoder for a fresh keyframe
	 */
	public reseed() {
		if (!this.decoder) return;
		this.decoder.reset();
		assert(this.config, 'Decoder config not available');
		this.decoder.configure(this.config);
		this.resolver?.resolve(null);
		this.resolver = null;
		this.lastSubmitted = null;
		this.inFlight.clear();
	}

	private handleOutput(frame: VideoFrame) {
		this.resolver?.resolve(null);
		const timing = this.inFlight.get(frame.timestamp);
		this.inFlight.delete(frame.timestamp);

		for (const micros of this.inFlight.keys()) {
			if (micros < frame.timestamp) {
				this.inFlight.delete(micros);
			}
		}

		try {
			this.callback(frame, timing);
		} finally {
			frame.close();
		}
	}

	private handleDequeue() {
		this.resolver?.resolve(null);
		this.resolver = null;
	};

	private handleError(e?: DOMException) {
		console.error(e?.message);
		this.onError();
		this.dispose();
	}

	public async init(track: InputVideoTrack) {
		this.config = await track.getDecoderConfig();
		assert(this.config, 'Failed to get decoder config from track');
		const support = await VideoDecoder.isConfigSupported(this.config);
		assert(support.supported, 'Decoder config not supported');
	}

	private ensureDecoder(packet: EncodedPacket) {
		if (this.decoder || packet.type === 'delta') return;

		assert(this.config, 'Decoder config not available');

		this.decoder = new VideoDecoder({
			error: this.handleError.bind(this),
			output: this.handleOutput.bind(this),
		});

		this.decoder.addEventListener('dequeue', this.handleDequeue.bind(this));
		this.decoder.configure(this.config);
	}

	public async decode(packet: EncodedPacket) {
		this.ensureDecoder(packet);

		if (this.decoder?.state !== 'configured') {
			this.lastSubmitted = null;
			this.resolver?.resolve(null);
			this.resolver = null;
			this.inFlight.clear();
			return;
		}

		if (this.decoder.decodeQueueSize > 2) {
			this.resolver = Promise.withResolvers();
		}

		this.inFlight.set(packet.microsecondTimestamp, { timestamp: packet.timestamp, duration: packet.duration });
		this.decoder.decode(packet.toEncodedVideoChunk());
		this.lastSubmitted = packet;

		await this.resolver?.promise;
	}

	public async finish() {
		const decoder = this.decoder;
		if (decoder?.state !== 'configured') return;
		try {
			// End-of-stream can still hold reordered frames, including an entire tiny clip.
			await decoder.flush();
		} catch (error) {
			if (this.decoder === decoder) throw error;
		} finally {
			if (this.decoder === decoder) this.dispose();
		}
	}

	public dispose() {
		try {
			this.decoder?.close();
		} catch { /* ignore */ }
		this.resolver?.resolve(null);
		this.decoder = null;
		this.lastSubmitted = null;
		this.resolver = null;
		this.inFlight.clear();
	}
}

/**
 * Dedicated, full-resolution video decoder for export.
 */
export class VideoExporter {
	private readonly originals: OriginalMediaProvider | null;
	private native: OriginalVideoFrames | null = null;
	private nativeCanvas: OffscreenCanvas | null = null;
	private nativeFrame = -1;
	private disposed = false;
	public errored = false;
	public asset: VideoAsset;
	public initialized: Promise<void>;

	private input: Input | null = null;
	private canvasSink: CanvasSink | null = null;
	private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
	private currentCanvas: WrappedCanvas | null = null;
	private nextCanvas: WrappedCanvas | null = null;
	private firstTimestamp: number = 0;

	public constructor(asset: VideoAsset, originals: OriginalMediaProvider | null = null) {
		this.asset = asset;
		this.originals = originals;
		this.initialized = this.initialize();
	}

	private async initialize() {
		try {
			const blob = await this.asset.handle.getFile();
			if (this.disposed) return;
			const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob, { useStreamReader: false }) });
			this.input = input;
			const track = await input.getPrimaryVideoTrack();
			if (this.disposed) return;
			const decodable = track && await track.canDecode();
			if (this.disposed) return;
			if (!track || !decodable) {
				const stream = track ? (await input.getVideoTracks()).indexOf(track) : undefined;
				if (this.disposed) return;
				input.dispose();
				this.input = null;
				if (!this.originals) throw new Error('This source needs the desktop decoder to export at original quality');
				const native = await this.originals.openVideo(this.asset, stream);
				if (this.disposed) { await native.close(); return; }
				this.native = native;
				return;
			}
			// See VideoBuffer.initialize: clamp so an edit-list head trim (negative first
			// timestamp) doesn't offset every exported frame relative to the audio.
			this.firstTimestamp = Math.max(0, await track.getFirstTimestamp() ?? 0);
			if (this.disposed) return;
			this.canvasSink = new CanvasSink(track, { poolSize: 2 });
		} catch (e) {
			if (this.disposed) return;
			this.input?.dispose();
			this.input = null;
			console.error('Error initializing video exporter', e);
			this.errored = true;
			throw e;
		}
	}

	public async seekTo(frame: number, frameRate: number): Promise<void> {
		try {
			await this.initialized;

			if (this.disposed) return;
			if (this.native) {
				const target = Math.min(Math.max(0, Math.ceil(this.asset.duration * this.native.frameRate - 1e-3) - 1), Math.max(0, Math.round(frame / frameRate * this.native.frameRate)));
				if (target === this.nativeFrame) return;
				const { data, width, height } = await this.native.read(target);
				if (this.disposed) return;
				this.nativeCanvas ??= new OffscreenCanvas(width, height);
				const pixels = data.buffer instanceof ArrayBuffer
					? new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) : new Uint8ClampedArray(data);
				this.nativeCanvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
				this.nativeFrame = target;
				return;
			}
			if (this.errored || !this.canvasSink) return;

			const timestamp = this.firstTimestamp + Math.max(0, frame / frameRate);
			// WebCodecs timestamps have microsecond precision; nominal FPS cannot
			// identify which sample covers a variable-rate source timestamp.
			const target = Math.round(timestamp * 1e6);
			const current = this.currentCanvas;
			if (current && target >= Math.round(current.timestamp * 1e6)
				&& target < Math.round((current.timestamp + current.duration) * 1e6)) return;

			if (!this.iterator || current && target < Math.round(current.timestamp * 1e6)) {
				await this.iterator?.return();
				if (this.disposed) return;
				this.currentCanvas = null;
				this.nextCanvas = null;
				this.iterator = this.canvasSink.canvases(timestamp);
			}
			if (!this.iterator) return;

			// Keep one future canvas across source gaps; the two-canvas pool leaves
			// the preceding picture intact until that future timestamp is reached.
			while (true) {
				const value = this.nextCanvas ?? (await this.iterator.next()).value;
				if (this.disposed) {
					if (value) { value.canvas.width = 0; value.canvas.height = 0; }
					return;
				}
				if (!value) break;
				if (this.currentCanvas && Math.round(value.timestamp * 1e6) > target) {
					this.nextCanvas = value;
					break;
				}

				this.nextCanvas = null;
				this.currentCanvas = value;

				if (Math.round((value.timestamp + value.duration) * 1e6) > target) {
					break;
				}
			}
		} catch (error) {
			if (!this.disposed) throw error;
		}
	}

	public toBitmap(): HTMLCanvasElement | OffscreenCanvas | null {
		if (this.nativeCanvas) return this.nativeCanvas;
		if (!this.currentCanvas) {
			return null;
		}

		return this.currentCanvas.canvas;
	}

	public idle(): void { }

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.native) void this.native.close().catch((error: unknown) => console.error('Could not close original video decoder', error));
		this.native = null;
		if (this.nativeCanvas) { this.nativeCanvas.width = 0; this.nativeCanvas.height = 0; this.nativeCanvas = null; }
		void this.iterator?.return().catch((error: unknown) => console.error('Could not close video export decoder', error));
		this.iterator = null;
		this.input?.dispose();
		this.input = null;
		this.canvasSink = null;
		if (this.currentCanvas) { this.currentCanvas.canvas.width = 0; this.currentCanvas.canvas.height = 0; }
		this.currentCanvas = null;
		if (this.nextCanvas) { this.nextCanvas.canvas.width = 0; this.nextCanvas.canvas.height = 0; }
		this.nextCanvas = null;
	}
}

/**
 * What a video paint decodes through. Three implementations of one interface
 * — `seekTo`, `toBitmap`, `idle`, `dispose` — picked by what the source turns
 * out to be and what the world is doing with it: a demuxed buffer for playing
 * a file, an exact-seeking reader for encoding one, and a frames directory
 * read off disk. Realtime buffers also prepare their opening frames before
 * playback starts its clock.
 */
export type VideoDecoderInstance = VideoBuffer | VideoExporter | SequenceDecoder;

// A project may use a different preview copy of the same original asset.
// Weak handles also let closed projects release their tracks and source files.
let videoTrackCache = new WeakMap<VideoAsset['handle'], Promise<InputVideoTrack | null>>();

export function clearVideoTrackCache() {
	videoTrackCache = new WeakMap();
}

export function getVideoTrack(source: VideoAsset) {
	const cache = videoTrackCache;
	let promise = cache.get(source.handle);
	if (promise) {
		return promise;
	}

	promise = (async () => {
		try {
			const blob = await getAssetFile(source);
			const input = new Input({
				formats: ALL_FORMATS,
				source: new BlobSource(blob, { useStreamReader: false })
			});
			return await input.getPrimaryVideoTrack();
		} catch {
			cache.delete(source.handle);
			return null;
		}
	})();

	cache.set(source.handle, promise);
	return promise;
}

/**
 * The decoder `entity`'s video paint draws from, built on first use and kept
 * until the asset it was built for is no longer the one asked for.
 *
 * A sequence's rate is the element's to set, so it is pushed on every call
 * rather than fixed at construction — re-reading a folder to play it slower
 * would be a rebuild for nothing.
 */
export function resolveVideoDecoder(world: World, entity: Entity): VideoDecoderInstance | null {
	const assetId = entity.get(AssetId)?.value;
	if (!assetId) return null;

	// Only a live preview keeps frames around it; an export reads each frame
	// once, in order, and a cache would be a window it never looks back into.
	const hasCache = world.get(Mode)?.value === 'realtime';

	// The id is the only thing that can go stale: a library edit assigns onto
	// the asset in place, so the object a live decoder holds is the library's.
	const existing = entity.get(VideoDecoderHandle);
	if (existing && existing.asset.id === assetId) {
		if (existing instanceof SequenceDecoder) {
			existing.hasCache = hasCache;
			existing.frameRate = getSequenceFrameRate(entity, existing.asset);
		}
		return existing;
	}

	// Asset changed — dispose old decoder and create a new one.
	existing?.dispose();

	const asset = getAsset(world, assetId);
	if (!asset) return null;

	let decoder: VideoDecoderInstance;
	if (asset.type === 'SEQUENCE') {
		decoder = new SequenceDecoder(asset, hasCache);
		decoder.frameRate = getSequenceFrameRate(entity, asset);
	} else if (asset.type === 'VIDEO') {
		decoder = hasCache ? new VideoBuffer(asset) : new VideoExporter(asset, world.get(OriginalMedia) ?? null);
	} else {
		return null;
	}

	entity.add(VideoDecoderHandle);
	entity.set(VideoDecoderHandle, decoder);
	return decoder;
}
