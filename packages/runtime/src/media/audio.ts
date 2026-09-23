/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Input, ALL_FORMATS, BlobSource, AudioBufferSink, type WrappedAudioBuffer, type InputAudioTrack } from 'mediabunny';

import { AssetId, AudioDecoderHandle, AudioStream, OriginalMedia } from '../traits';
import { AsyncMutex } from '../utils/async';
import { assert } from '../utils/assert';
import { getAsset } from '../actions/assets';
import { TimeStretcher } from './time-stretcher';

import type { Entity, World } from 'koota';
import type { AudioAsset, VideoAsset } from '@diffusionstudio/assets';
import type { AudioBus } from './audio-bus';
import type { OriginalMediaProvider } from '../traits';

type CachedAudioTrack = { provider: OriginalMediaProvider | null; promise: Promise<InputAudioTrack | null> };
let audioTrackCache = new WeakMap<AudioAsset['handle'], Map<number, CachedAudioTrack>>();

export function clearAudioTrackCache() {
	audioTrackCache = new WeakMap();
}

/** Original audio only. The native fallback decodes the selected stream to lossless PCM. */
export function getAudioTrack(source: AudioAsset | VideoAsset, stream = 0, provider: OriginalMediaProvider | null = null) {
	let streams = audioTrackCache.get(source.handle);
	const cached = streams?.get(stream);
	if (cached?.provider === provider) return cached.promise;
	if (!streams) {
		streams = new Map();
		audioTrackCache.set(source.handle, streams);
	}
	const promise = (async () => {
		// Finite slices avoid retaining native Blob streams over large source recordings.
		const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await source.handle.getFile(), { useStreamReader: false }) });
		try {
			const track = (await input.getAudioTracks())[stream];
			if (track && await track.canDecode()) return track;
			if (!provider) {
				input.dispose();
				return null;
			}
		} catch (error) {
			if (!provider) {
				input.dispose();
				throw error;
			}
		}
		input.dispose();
		const pcm = new Input({ formats: ALL_FORMATS, source: new BlobSource(await provider!.audioFile(source, stream), { useStreamReader: false }) });
		const track = await pcm.getPrimaryAudioTrack();
		if (track) return track;
		pcm.dispose();
		return null;
	})();
	streams.set(stream, { provider, promise });
	void promise.catch(() => {
		if (streams.get(stream)?.promise === promise) streams.delete(stream);
	});
	return promise;
}

type PlayOptions = {
	relativeFrom: number;
	relativeTo: number;
	trimStart: number;
	trimEnd: number;
	playbackRate: number;
	currentTime: number;
	relativeDelay: number;
}

export class AudioDecoder {
	readonly assetId: string;
	readonly stream: number;

	private readonly asset: AudioAsset | VideoAsset;
	private readonly mutex = new AsyncMutex();
	private readonly audioNodes = new Set<AudioBufferSourceNode>();

	private iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
	private iteratorStart = 0;
	private buffered: IteratorResult<WrappedAudioBuffer, void>[] = [];
	private preparedFrom: number | null = null;
	private preparedTo = 0;
	private preparation: { from: number; to: number; end: number; promise: Promise<void> } | null = null;
	private initialization: Promise<void> | null = null;
	private firstBuffer: WrappedAudioBuffer | null = null;
	private lastBuffer: WrappedAudioBuffer | null = null;
	private exhausted = false;
	private stretcher: TimeStretcher | null = null;
	private nextTimestamp = 0;
	private audioTrack: InputAudioTrack | null = null;
	private sink!: AudioBufferSink;
	private generation = 0;
	private sampleRate = 48000;
	private channels = 2;

	public ready = false;
	public error: string | undefined;

	public constructor(asset: AudioAsset | VideoAsset, stream = 0, private readonly provider: OriginalMediaProvider | null = null) {
		this.stream = stream;
		this.asset = asset;
		this.assetId = asset.id;
	}

	public init(): Promise<void> {
		return this.initialization ??= (async () => {
			this.audioTrack = await getAudioTrack(this.asset, this.stream, this.provider);
			assert(this.audioTrack, `Audio stream ${this.stream + 1} could not be decoded from the original file`);
			this.sampleRate = await this.audioTrack.getSampleRate();
			this.channels = await this.audioTrack.getNumberOfChannels();
			this.sink = new AudioBufferSink(this.audioTrack);
			this.ready = true;
		})();
	}

	public isPrepared(relativeFrom: number): boolean {
		return this.preparedFrom === relativeFrom;
	}

	/** Decode the opening playback window before starting its clock, without scheduling sound. */
	public prepare(relativeFrom: number, relativeTo: number, trimEnd: number): Promise<void> {
		const target = Math.min(relativeTo, trimEnd);
		if (this.isPrepared(relativeFrom) && this.preparedTo >= target) return Promise.resolve();
		if (this.preparation?.from === relativeFrom && this.preparation.to === relativeTo && this.preparation.end === trimEnd) return this.preparation.promise;
		this.preparedFrom = null;
		const generation = this.generation;
		const promise = (async () => {
			await this.init();
			const release = await this.mutex.acquire();
			try {
				if (generation !== this.generation || !await this.openIterator(relativeFrom, trimEnd, generation)) return;
				let last = this.buffered.at(-1);
				while (!last || !last.done && last.value.timestamp + last.value.duration < target) {
					last = await this.iterator!.next();
					if (generation !== this.generation) return;
					this.buffered.push(last);
				}
				this.preparedFrom = relativeFrom;
				this.preparedTo = target;
			} finally {
				release();
			}
		})();
		this.preparation = { from: relativeFrom, to: relativeTo, end: trimEnd, promise };
		void promise.finally(() => {
			if (this.preparation?.promise === promise) this.preparation = null;
		}).catch(() => {});
		return promise;
	}

	private async openIterator(relativeFrom: number, trimEnd: number, generation: number): Promise<boolean> {
		const lastTs = this.lastBuffer?.timestamp ?? this.buffered.at(-1)?.value?.timestamp ?? this.iteratorStart;
		const outOfRange = relativeFrom < this.iteratorStart || (!this.exhausted && lastTs < relativeFrom - 1);
		if (this.iterator && !outOfRange) return true;

		// Closing releases any samples decoded ahead of the requested window.
		await this.iterator?.return();
		if (generation !== this.generation) return false;
		this.iterator = this.sink.buffers(relativeFrom, trimEnd);
		// The requested interval can include silence before its first sample.
		this.iteratorStart = relativeFrom;
		this.buffered = [];
		this.preparedFrom = null;
		this.firstBuffer = null;
		this.lastBuffer = null;
		this.stretcher = null;
		this.exhausted = false;
		return true;
	}

	private renderData(bus: AudioBus, options: PlayOptions, data: Float32Array[] | null, sampleRate: number) {
		if (!data) {
			return;
		}

		const newBuffer = new AudioBuffer({
			length: data[0]!.length,
			sampleRate,
			numberOfChannels: data.length,
		});
		for (let c = 0; c < data.length; c++) {
			newBuffer.copyToChannel(data[c] as Float32Array<ArrayBuffer>, c);
		}
		this.renderBuffer(bus, options, newBuffer);
	}

	private renderBuffer(bus: AudioBus, options: PlayOptions, buffer: AudioBuffer) {
		const { relativeDelay, playbackRate } = options;
		const trimStart = Math.max(options.trimStart, this.iteratorStart) / playbackRate;
		const trimEnd = options.trimEnd / playbackRate;
		const context = bus.context;

		const newBufferTimestamp = this.nextTimestamp;
		this.nextTimestamp += buffer.duration;

		let start = relativeDelay + newBufferTimestamp;
		let offset = 0;
		let duration = buffer.duration;

		// Check if the buffer goes beyond the clip's end, and if so, truncate it
		if (newBufferTimestamp + duration > trimEnd) {
			duration = trimEnd - newBufferTimestamp;
		}

		// Check if the buffer starts before the clip's start, and if so, trim the start
		if (newBufferTimestamp < trimStart) {
			start += trimStart - newBufferTimestamp;
			offset += trimStart - newBufferTimestamp;
		}

		// Check if the start is before the context's current time (which is illegal)
		if (start < context.currentTime) {
			offset += context.currentTime - start;
			start = context.currentTime;
		}

		// Dumb, DIRTY hack. For some reason (probably due to some bug in the Web Audio API), sometimes a clicking noise
		// can be heard on the boundary between two audio clips. By shifting all audio buffers by half a sample, this is
		// typically avoided. My guess is that it forces the renderer into a sub-sample rendering algorithm which doesn't
		// have the buggy behavior.
		start += 0.5 / context.sampleRate;

		duration -= offset;
		duration = Math.max(0, duration);

		const bufferSource = context.createBufferSource();
		bufferSource.buffer = buffer;
		bufferSource.connect(bus.input);
		bufferSource.start(start, offset, duration);

		this.audioNodes.add(bufferSource);
		bufferSource.onended = () => this.audioNodes.delete(bufferSource);
	}

	public async playTo(bus: AudioBus | null, options: PlayOptions) {
		if (!bus) {
			// The world has no audio output.
			return;
		}
		const generation = this.generation;
		await bus.ready.catch((error: unknown) => {
			if (typeof OfflineAudioContext !== 'undefined' && bus.context instanceof OfflineAudioContext) throw error;
		});
		if (bus.error || generation !== this.generation) return;

		const { relativeFrom, relativeTo } = options;

		const release = await this.mutex.acquire();

		try {
			if (generation !== this.generation || !await this.openIterator(relativeFrom, options.trimEnd, generation)) return;

			const target = Math.min(relativeTo, options.trimEnd) / options.playbackRate;
			while (!this.exhausted && (!this.lastBuffer || this.nextTimestamp < target)) {
				const nextBuffer = (this.buffered.shift() ?? await this.iterator!.next()).value;
				if (generation !== this.generation) return;
				// Use the actual decoded sample rate if available
				const sampleRate = nextBuffer?.buffer.sampleRate ?? this.sampleRate;
				const numberOfChannels = nextBuffer?.buffer.numberOfChannels ?? this.channels;
				const playbackRate = 1 / options.playbackRate;

				if (!nextBuffer) {
					this.exhausted = true;
					this.renderData(bus, options, this.stretcher?.finalize() ?? null, sampleRate);
					break;
				}

				if (!this.firstBuffer) {
					this.nextTimestamp = nextBuffer.timestamp / options.playbackRate;
				}

				if (this.lastBuffer) {
					const previousEnd = this.lastBuffer.timestamp + this.lastBuffer.duration;
					const gap = nextBuffer.timestamp - previousEnd;
					if (gap > 1 / sampleRate) {
						// Flush the previous segment before anchoring the next one. The
						// unscheduled interval stays silent without allocating gap buffers.
						this.renderData(bus, { ...options, trimEnd: Math.min(options.trimEnd, previousEnd) }, this.stretcher?.finalize() ?? null, sampleRate);
						this.stretcher = null;
						this.nextTimestamp = nextBuffer.timestamp / options.playbackRate;
					}
				}

				this.firstBuffer ??= nextBuffer;
				this.lastBuffer = nextBuffer;

				if (options.playbackRate === 1) {
					this.renderBuffer(bus, options, nextBuffer.buffer);
					continue;
				}

				this.stretcher ??= new TimeStretcher(numberOfChannels, sampleRate, playbackRate);
				const buffers: Float32Array[] = [];
				for (let c = 0; c < nextBuffer.buffer.numberOfChannels; c++) {
					const channelData = nextBuffer.buffer.getChannelData(c);
					buffers.push(channelData);
				}

				this.renderData(bus, options, this.stretcher.append(buffers), sampleRate);
			}
		} finally {
			release();
		}
	}

	public reset({ stopScheduled = true }: { stopScheduled?: boolean } = {}) {
		this.generation++;

		this.iterator?.return();
		this.iterator = null;
		this.buffered = [];
		this.preparedFrom = null;
		this.preparation = null;
		this.firstBuffer = null;
		this.lastBuffer = null;
		this.stretcher = null;
		this.exhausted = false;

		// A normal cut releases decoding work while the audio clock finishes the
		// buffers already scheduled for this clip. Pause, seek and disposal stop them.
		if (!stopScheduled) return;
		for (const node of this.audioNodes) {
			node.stop();
		}
		this.audioNodes.clear();
	}
}


type ResolvedAudioDecoder = {
	decoder: AudioDecoder;
	initPromise: Promise<void> | null;
};

export function resolveAudioDecoder(world: World, entity: Entity, stream = entity.get(AudioStream)?.value ?? 0): ResolvedAudioDecoder | null {
	const assetId = entity.get(AssetId)?.value;
	if (!assetId) return null;

	const existing = entity.get(AudioDecoderHandle);
	if (existing && existing.assetId === assetId && existing.stream === stream) {
		return {
			decoder: existing,
			initPromise: existing.ready ? null : existing.init(),
		};
	}

	// Asset changed: reset old decoder and create a new one.
	if (existing) existing.reset();

	const asset = getAsset(world, assetId);
	if (!asset || (asset.type !== 'AUDIO' && asset.type !== 'VIDEO')) return null;
	if (asset.type === 'VIDEO' && !asset.channels) return null;

	const decoder = new AudioDecoder(asset, stream, world.get(OriginalMedia));
	entity.add(AudioDecoderHandle);
	entity.set(AudioDecoderHandle, decoder);
	const initPromise = decoder.init();
	void initPromise.catch((error: unknown) => {
		decoder.error = error instanceof Error ? error.message : String(error);
		console.error(decoder.error);
	});
	return { decoder, initPromise };
}
