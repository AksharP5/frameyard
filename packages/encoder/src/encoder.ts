/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
	CanvasSource,
	Output,
	AudioSample,
	AudioSampleSource,
	canEncodeVideo,
	canEncodeAudio,
} from 'mediabunny';
import { Not } from 'koota';
import {
	setActive,
	assert, store, isScene,
	assetSystem, playbackSystem, motionSystem, transformSystem, renderSystem,
	AudioBus, AudioBusHandle,
	ChildOf, Geometry, Paint, Workarea, Playback,
	AudioPlayback, Computed,
	Position, Offset, Rotation, Scale, Skew,
	Time, FrameRate, RenderSurface, AudioEngine, Root,
	FramePromises,
} from '@diffusionstudio/runtime';

import { TargetBuffer } from './buffer';
import { createOutputFormat } from './format';
import { computeOutputSize, createRenderEventDetail, getExportFrameRange } from './utils';

import type { Entity, World } from 'koota';
import type { EncoderConfig } from './interfaces';
import type { ExportResult } from './types';

let aacFallback: Promise<void> | undefined;

/**
 * The scene a capture world holds. An encoder takes the world as it is —
 * what to encode is the whole of what is in it — so a stage with anything
 * else under it is a caller that has not finished preparing the world.
 */
export function captureScene(world: World): Entity {
	const roots = [...world.query(ChildOf(world.get(Root)!))];
	assert(roots.length === 1, `A capture world holds one scene, this one holds ${roots.length}`);

	const scene = roots[0]!;
	assert(isScene(scene), 'What the capture world holds is not a scene');
	return scene;
}

/**
 * Encodes the scene a capture world holds into a file.
 *
 * `world` is not the editor's: it is a world built for this encode, holding
 * the composition as it is to be written and nothing else — see the app's
 * capture builder, which renders the project into a fresh world and reduces
 * its stage to the one scene. Everything the encode needs is read from there:
 * the scene is the stage's only child, the frame rate is the world's, the
 * camera is the view it is drawn with, and the canvas the DOM-backed paints
 * attached themselves to is the one drawn into.
 *
 * The world stays the caller's — it built it, it disposes it. What is created
 * here is the audio context, the output, and the frames.
 */
export async function createEncoder(world: World, config: EncoderConfig) {
	const scene = captureScene(world);
	const sceneId = scene.id();
	const computed = store(world, Computed);
	const playback = store(world, Playback);

	await warmupAssets(world);

	const frameRate = world.get(FrameRate)?.value ?? 30;
	const sceneWidth = computed.width[sceneId]!;
	const sceneHeight = computed.height[sceneId]!;
	const sceneEnd = computed.end[sceneId]!;

	// Honor the scene's Workarea trait: render only the frames between
	// Workarea.start and Workarea.end instead of the full scene duration.
	const workarea = scene.get(Workarea);
	const { start: workareaStart, frames: totalFrames } = getExportFrameRange(sceneEnd, workarea);
	// Keep the frame count exact: rounded seconds can discard the last frame
	// when converted back, and shift audio at nonzero workarea starts.
	const playheadStartSeconds = workareaStart / frameRate;
	const duration = totalFrames / frameRate;

	// Before the two below read them: ogg is an audio container, so asking for
	// one is asking for the audio alone — and with `videoEnabled` derived
	// first, it would still have gone looking for pictures to put in it.
	if (config.format === 'ogg') {
		config.audio = { ...config.audio, enabled: true };
		config.video = { ...config.video, enabled: false };
	}

	const audioEnabled = config.audio?.enabled ?? true;
	const videoEnabled = config.video?.enabled ?? true;
	const numberOfChannels = config.audio?.numberOfChannels ?? 2;
	const sampleRate = config.audio?.sampleRate ?? 48000;
	const audioBitrate = config.audio?.bitrate ?? 128e3;
	const videoBitrate = config.video?.bitrate ?? 10e6;
	const audioCodec = config.audio?.codec ?? 'aac';
	const videoCodec = config.video?.codec ?? 'avc';
	const containerFormat = config.format ?? 'mp4';
	const resolution = config.video?.resolution ?? 1080;
	const { scale, width, height } = computeOutputSize(sceneWidth, sceneHeight, resolution);
	const frameDuration = 1 / frameRate;

	// Linux Chromium has no native AAC encoder. Load the bundled WASM codec
	// only when this export needs it; the video path keeps native acceleration.
	if (audioEnabled && audioCodec === 'aac' && !(await canEncodeAudio('aac', { numberOfChannels, sampleRate, bitrate: audioBitrate }))) {
		await (aacFallback ??= import('@mediabunny/aac-encoder').then(({ registerAacEncoder }) => registerAacEncoder()));
	}

	// Fail before anything is written: mediabunny would reject the config on
	// the first frame anyway, with a message in codec strings; this one names
	// the size the resolution setting worked out to, which is what the user
	// can change.
	if (videoEnabled) {
		const encodable = await canEncodeVideo(videoCodec, { width, height, bitrate: videoBitrate });
		assert(
			encodable,
			`This browser cannot encode ${videoCodec.toUpperCase()} at ${width}×${height}. ` +
			'Choose a lower resolution, a lower bitrate, or another codec.',
		);
	}

	const canvas = world.get(RenderSurface)?.canvas;
	assert(canvas instanceof HTMLCanvasElement, 'The capture world has no canvas to draw into');
	canvas.width = width;
	canvas.height = height;
	world.set(RenderSurface, { resolution: scale });

	const offlineAudioCtx = new OfflineAudioContext(
		numberOfChannels,
		Math.ceil(duration * sampleRate),
		sampleRate,
	);
	world.set(AudioEngine, { context: offlineAudioCtx });

	setActive(world, scene);

	computed.localTimeInSeconds[sceneId] = playheadStartSeconds;
	computed.localTime[sceneId] = workareaStart;
	playback.playing[sceneId] = true;
	playback.loop[sceneId] = false;
	playback.speed[sceneId] = 1;
	// Anchor audio scheduling: context starts at t=0 but the playhead starts at
	// playheadStartSeconds, so audioDelay = -playheadStartSeconds shifts each
	// entity's scheduled audio back into the encoded window.
	if (!scene.has(AudioPlayback)) scene.add(AudioPlayback);
	const audioPlayback = store(world, AudioPlayback);
	audioPlayback.contextOffsetInSeconds[sceneId] = 0;
	audioPlayback.timelineOffsetInSeconds[sceneId] = playheadStartSeconds;

	// Set up mediabunny output
	const buffer = await TargetBuffer.create(config.target);
	let committed = false;
	let cancelOutput: (() => Promise<void>) | undefined;
	let releaseWorklet: (() => void) | undefined;
	const cleanups: Array<() => void> = [];
	const dispose = async (failure?: unknown) => {
		const errors: unknown[] = [];
		const attempt = async (cleanup: () => void | Promise<void>) => {
			try { await cleanup(); }
			catch (error) { errors.push(error); }
		};
		await attempt(() => releaseWorklet?.());
		if (!committed) {
			await attempt(() => cancelOutput?.());
			await attempt(() => buffer.abort());
		}
		for (const cleanup of cleanups.splice(0).reverse()) await attempt(cleanup);
		if (errors.length) {
			throw new AggregateError(
				failure === undefined ? errors : [failure, ...errors],
				failure instanceof Error ? failure.message : 'Failed to release export resources',
				{ cause: failure },
			);
		}
	};
	try {
		const format = await createOutputFormat(buffer, config.format);
		const output = new Output({ format, target: buffer.target });
		cancelOutput = () => output.state === 'finalized' ? Promise.resolve() : output.cancel();

		if (config.comment) {
			output.setMetadataTags({ comment: config.comment });
		}

		const audioSource = new AudioSampleSource({
			codec: audioCodec,
			bitrate: audioBitrate,
			// The WASM AAC patch preserves priming PTS for MP4/MOV edit lists.
			onEncoderConfig: containerFormat === 'mp4' || containerFormat === 'mov'
				? (config) => { Object.assign(config, { frameyardPreservePacketTimestamps: true }); }
				: undefined,
		});

		const sceneFills = [...world.query(Paint, Not(Geometry), ChildOf(scene))];

		const videoSource = new CanvasSource(canvas, {
			codec: videoCodec,
			bitrate: videoBitrate,
			latencyMode: 'quality',
			alpha: containerFormat === 'webm' && !sceneFills.length
				? 'keep'
				: 'discard',
		});

		if (audioEnabled) {
			output.addAudioTrack(audioSource);
		}

		if (videoEnabled) {
			output.addVideoTrack(videoSource);
		}

		// Audio worklet streams render-quantum chunks back to the main thread so
		// we can hand them to mediabunny in step with the visual frame loop.
		const audioWorkletUrl = createAudioWorkletUrl();
		cleanups.push(() => URL.revokeObjectURL(audioWorkletUrl));
		await offlineAudioCtx.audioWorklet.addModule(audioWorkletUrl);

		const sharedBuffer = new SharedArrayBuffer(4);
		const sharedUint32Array = new Uint32Array(sharedBuffer);
		releaseWorklet = () => Atomics.store(sharedUint32Array, 0, 2 ** 31 - 1);
		const mixNode = offlineAudioCtx.createGain();
		cleanups.push(() => mixNode.disconnect());

		const sinkNode = new AudioWorkletNode(offlineAudioCtx, 'sink', {
			channelCount: numberOfChannels,
			channelCountMode: 'explicit',
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [numberOfChannels],
			processorOptions: {
				buffer: sharedUint32Array,
			},
		});

		cleanups.push(() => {
			sinkNode.port.onmessage = null;
			sinkNode.port.close();
			sinkNode.disconnect();
		});

		mixNode.connect(sinkNode);
		sinkNode.connect(offlineAudioCtx.destination);

		// connect the scene bus to the mix node
		const sceneBus = new AudioBus(world, scene);
		cleanups.push(() => sceneBus.disconnect());
		scene.add(AudioBusHandle);
		scene.set(AudioBusHandle, sceneBus);
		sceneBus.connect(mixNode);

		let sampleIndex = 0;
		let audioQueue = Promise.resolve();
		let audioFailure: { error: unknown } | undefined;

		const allAudioReceived = Promise.withResolvers<void>();

		sinkNode.port.onmessage = event => {
			if (output?.state === 'canceled') {
				return;
			}

			const planarBuffer = event.data as Float32Array;

			if (planarBuffer.length === 0) {
				allAudioReceived.resolve();
				return;
			}
			if (audioFailure) return;

			const sampleCount = planarBuffer.length / numberOfChannels;

			const audioSample = new AudioSample({
				data: planarBuffer,
				format: 'f32-planar',
				numberOfChannels,
				sampleRate,
				timestamp: sampleIndex / sampleRate,
			});
			audioQueue = audioQueue
				.then(() => audioFailure ? undefined : audioSource.add(audioSample))
				.catch(error => { audioFailure ??= { error }; })
				.finally(() => audioSample.close());

			sampleIndex += sampleCount;
		};

		const emitProgress = createThrottledCallback(config.onProgress, 1000 / 3); // 3 times per second

		let canceled = false;
		const cancellation = Promise.withResolvers<void>();
		const cancel = () => {
			canceled = true;
			releaseWorklet?.();
			cancellation.resolve();
		};

		const render = async (): Promise<ExportResult> => {
			let failure: Error | undefined;
			try {
				if (canceled) return { type: 'canceled' };
				await output.start();
				if (canceled) return { type: 'canceled' };
				const start = performance.now();
				const startTime = start;

				let audioRenderingDone = false;
				let audioRenderingCompleted: Promise<AudioBuffer> | null = null;
				if (audioEnabled) {
					audioRenderingCompleted = offlineAudioCtx.startRendering();
					audioRenderingCompleted.then(() => { audioRenderingDone = true; }, () => { audioRenderingDone = true; });
				}

				let lastAudioSampleCount = 0;

				for (let frame = 0; frame < totalFrames; frame++) {
					if (canceled) return { type: 'canceled' };

					const timestamp = frame * frameDuration;
					const playheadSeconds = playheadStartSeconds + timestamp;

					// advancePlayhead is a no-op in offline mode; the encoder owns the
					// playhead and writes both seconds + frames before each tick.
					computed.localTimeInSeconds[sceneId] = playheadSeconds;
					computed.localTime[sceneId] = Math.round(playheadSeconds * frameRate);
					const time = world.get(Time)!;
					world.set(Time, { delta: frameDuration * 1000, now: time.now + frameDuration * 1000 });

					{
						assetSystem(world);
						playbackSystem(world);
						await resolverSystem(world);
						if (canceled) return { type: 'canceled' };
						motionSystem(world);
						// May be changed by a system
						normalizeSceneTransform(world, sceneId);
					}

					if (videoEnabled) {
						// only visual systems
						transformSystem(world);
						renderSystem(world);
					}

					if (videoEnabled) {
						await videoSource.add(timestamp, frameDuration);
						if (canceled) return { type: 'canceled' };
					}

					if (audioEnabled) {
						await audioQueue;
						if (audioFailure) throw audioFailure.error;
						if (canceled) return { type: 'canceled' };

						while (Atomics.load(sharedUint32Array, 0) > sampleRate && !audioRenderingDone && !canceled) {
							await new Promise(resolve => setTimeout(resolve, 0));
						}

						if (canceled) return { type: 'canceled' };

						const totalAudioSampleCount = Math.floor(timestamp * sampleRate);
						const diff = totalAudioSampleCount - lastAudioSampleCount;
						Atomics.add(sharedUint32Array, 0, diff);
						lastAudioSampleCount = totalAudioSampleCount;
					}

					emitProgress(createRenderEventDetail(frame, totalFrames, startTime));
				}

				console.info(
					`Encoded frames at ${((totalFrames * 1000) / (performance.now() - start)).toFixed(2)}FPS`
				);

				if (audioEnabled) {
					assert(audioRenderingCompleted !== null, 'Audio rendering was not started');

					Atomics.add(
						sharedUint32Array,
						0,
						Math.ceil(duration * sampleRate) + sampleRate - lastAudioSampleCount,
					);

					await Promise.race([audioRenderingCompleted, cancellation.promise]);
					if (canceled) return { type: 'canceled' };

					sinkNode.port.postMessage(null);
					await Promise.race([allAudioReceived.promise, cancellation.promise]);
					if (canceled) return { type: 'canceled' };
					await audioQueue;
					if (audioFailure) throw audioFailure.error;
				}

				if (canceled) return { type: 'canceled' };
				console.info('Finalizing file');

				await output.finalize();
				if (canceled) return { type: 'canceled' };
				const data = await buffer.close(containerFormat);
				committed = true;

				console.info('Export complete');

				return {
					type: 'success',
					data,
				};
			} catch (e) {
				if (canceled) return { type: 'canceled' };
				failure = e instanceof Error ? e : new Error(String(e));
				return {
					type: 'error',
					error: failure,
				};
			} finally {
				await dispose(failure);
			}
		};

		return {
			render,
			cancel,
		};
	} catch (error) {
		await dispose(error);
		throw error;
	}
}


function audioWorkletCode() {
	// eslint-disable-next-line no-undef
	class SinkProcessor extends AudioWorkletProcessor {
		buffer: Uint32Array;

		constructor(options: {
			processorOptions: {
				buffer: Uint32Array;
			};
		}) {
			super();

			this.buffer = options.processorOptions.buffer;

			this.port.onmessage = () => {
				this.port.postMessage(new Float32Array(0));
			};
		}

		process(inputs: Float32Array[][], outputs: Float32Array[][]) {
			const input = inputs[0];
			const output = outputs[0];
			const renderQuantum = output[0].length;

			while (Atomics.load(this.buffer, 0) < renderQuantum);

			const planarBuffer = new Float32Array(output.length * output[0].length);
			for (let channel = 0; channel < Math.min(input.length, output.length); channel++) {
				planarBuffer.set(input[channel], channel * output[0].length);
			}

			this.port.postMessage(planarBuffer, [planarBuffer.buffer]);

			Atomics.sub(this.buffer, 0, renderQuantum);

			return true;
		}
	}

	// eslint-disable-next-line no-undef
	registerProcessor('sink', SinkProcessor);
}

function createAudioWorkletUrl(): string {
	const blob = new Blob([`(${audioWorkletCode.toString()})()`], { type: 'application/javascript' });
	return URL.createObjectURL(blob);
}

function createThrottledCallback<T>(callback: ((value: T) => void) | undefined, intervalMs: number): (value: T) => void {
	let lastCalledAt = -Infinity;

	return (value: T) => {
		const now = performance.now();
		if (now - lastCalledAt < intervalMs) {
			return;
		}

		lastCalledAt = now;
		callback?.(value);
	};
}

export function normalizeSceneTransform(world: World, sceneId: number): void {
	const position = store(world, Position);
	const offset = store(world, Offset);
	const rotation = store(world, Rotation);
	const scaleStore = store(world, Scale);
	const skew = store(world, Skew);
	position.x[sceneId] = 0;
	position.y[sceneId] = 0;
	offset.x[sceneId] = 0;
	offset.y[sceneId] = 0;
	rotation.value[sceneId] = 0;
	scaleStore.x[sceneId] = 1;
	scaleStore.y[sceneId] = 1;
	skew.x[sceneId] = 0;
	skew.y[sceneId] = 0;
	const computed = store(world, Computed);
	computed.positionX[sceneId] = 0;
	computed.positionY[sceneId] = 0;
	computed.offsetX[sceneId] = 0;
	computed.offsetY[sceneId] = 0;
	computed.rotation[sceneId] = 0;
	computed.scaleX[sceneId] = 1;
	computed.scaleY[sceneId] = 1;
	computed.skewX[sceneId] = 0;
	computed.skewY[sceneId] = 0;
}

/**
 * Runs the asset system until it has nothing left in flight: each pass can
 * start resolutions the previous one's answers asked for (a modifier chain,
 * a transcript that waits for the scene's own sources to land). Bounded, so
 * a source that keeps re-requesting cannot hold an export open forever.
 */
export async function warmupAssets(world: World): Promise<void> {
	for (let pass = 0; pass < 16; pass++) {
		assetSystem(world);
		if (!world.get(FramePromises)?.list?.length) return;
		await resolverSystem(world);
	}
}

export async function resolverSystem(world: World) {
	const promises = world.get(FramePromises)?.list;
	if (promises?.length) {
		await Promise.all(promises.filter(promise => promise !== null));
		world.set(FramePromises, { list: [] });
	}
}
