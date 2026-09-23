/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { store } from '../world/store';
import { Muted, Computed, AudioEngine, AudioProcessing, FramePromises } from '../traits';
import { attempt } from '../utils/async';
import { assert } from '../utils/assert';
import { AUDIO_COMPRESSOR_DEFAULTS, AUDIO_EQ_FREQUENCIES } from './audio-processing';
import { createAudioDynamics } from './audio-dynamics';

import type { Entity, World } from 'koota';
import type { AudioProcessingSettings } from '@diffusionstudio/jsx';

/**
 * Per-entity audio bus. Each clip and each scene gets its own gain node.
 * Child buses connect directly into the parent bus's input; there is no
 * per-track sub-mix anymore (each clip is its own layer).
 */
export class AudioBus {
	public context: BaseAudioContext;
	public ready: Promise<void> = Promise.resolve();
	public error: string | undefined;

	private gain: GainNode;
	private inputNode: GainNode;
	private outputNode: GainNode;
	private entity: Entity;
	private world: World;
	private settings: AudioProcessingSettings | undefined;
	private filters: BiquadFilterNode[] | undefined;
	private panner: StereoPannerNode | undefined;
	private dynamics: { compressor: AudioWorkletNode; limiter: AudioWorkletNode } | undefined;
	private loadingDynamics = false;
	private chain: AudioNode[];
	private disposed = false;

	public constructor(world: World, entity: Entity) {
		const context = world.get(AudioEngine)?.context;
		assert(context, 'World has no audio context');
		this.context = context;
		this.gain = context.createGain();
		this.inputNode = context.createGain();
		this.outputNode = context.createGain();
		this.chain = [this.inputNode, this.gain, this.outputNode];
		this.inputNode.connect(this.gain);
		this.gain.connect(this.outputNode);
		this.entity = entity;
		this.world = world;
		this.sync();
	}

	public get input(): AudioNode {
		return this.inputNode;
	}

	public get isReady(): boolean {
		return !this.loadingDynamics;
	}

	public getGain(): GainNode {
		return this.gain;
	}

	/** Meter after EQ, dynamics, pan, volume and the sample-peak limiter. */
	public getOutput(): GainNode {
		return this.outputNode;
	}

	public sync(): void {
		this.gain.gain.value = this.getVolume();
		const settings = this.entity.get(AudioProcessing)?.value;
		if (settings === this.settings) return;
		this.settings = settings;
		this.updateProcessing();
	}

	public connect(node: AudioNode) {
		this.outputNode.connect(node);
	}

	public mute(): void {
		this.gain.gain.value = 0;
	}

	public disconnect() {
		this.disposed = true;
		for (const node of this.chain) attempt(() => node.disconnect());
		this.dynamics?.compressor.port.close();
		this.dynamics?.limiter.port.close();
	}

	private updateProcessing(): void {
		if (this.disposed) return;
		const settings = this.settings ?? {};
		const needsDynamics = settings.compressor !== undefined || settings.limiter !== undefined;
		if (needsDynamics && !this.dynamics && !this.loadingDynamics) {
			this.loadingDynamics = true;
			this.inputNode.gain.value = 0;
			this.ready = Promise.allSettled([createAudioDynamics(this.context, false), createAudioDynamics(this.context, true)])
				.then(([compressorResult, limiterResult]) => {
					this.loadingDynamics = false;
					if (compressorResult.status === 'rejected' || limiterResult.status === 'rejected') {
						if (compressorResult.status === 'fulfilled') compressorResult.value.port.close();
						if (limiterResult.status === 'fulfilled') limiterResult.value.port.close();
						throw compressorResult.status === 'rejected' ? compressorResult.reason : limiterResult.status === 'rejected' ? limiterResult.reason : undefined;
					}
					const compressor = compressorResult.value;
					const limiter = limiterResult.value;
					this.dynamics = { compressor, limiter };
					if (this.disposed) {
						compressor.port.close();
						limiter.port.close();
						return;
					}
					this.error = undefined;
					this.updateProcessing();
				});
			this.world.get(FramePromises)?.list?.push(this.ready);
			void this.ready.catch((error: unknown) => {
				this.error = `Could not initialize audio processing: ${error instanceof Error ? error.message : String(error)}`;
				console.error(this.error);
			});
		}
		if (needsDynamics && !this.dynamics) return;
		if (!needsDynamics) {
			this.error = undefined;
			this.ready = Promise.resolve();
		}
		this.inputNode.gain.value = 1;

		const next: AudioNode[] = [this.inputNode];
		if (settings.eq) {
			this.filters ??= AUDIO_EQ_FREQUENCIES.map((frequency, index) => {
				const filter = this.context.createBiquadFilter();
				filter.type = index === 0 ? 'lowshelf' : index === 2 ? 'highshelf' : 'peaking';
				filter.frequency.value = frequency;
				filter.Q.value = 0.7;
				return filter;
			});
			this.filters.forEach((filter, index) => { filter.gain.value = settings.eq![index]!; });
			next.push(...this.filters);
		}
		if (settings.compressor && this.dynamics) {
			for (const [name, fallback] of Object.entries(AUDIO_COMPRESSOR_DEFAULTS)) {
				const value = settings.compressor[name as keyof typeof AUDIO_COMPRESSOR_DEFAULTS] ?? fallback;
				this.dynamics.compressor.parameters.get(name)!.value = value;
			}
			next.push(this.dynamics.compressor);
		}
		if (settings.pan !== undefined) {
			this.panner ??= this.context.createStereoPanner();
			this.panner.pan.value = settings.pan;
			next.push(this.panner);
		}
		next.push(this.gain);
		if (settings.limiter !== undefined && this.dynamics) {
			this.dynamics.limiter.parameters.get('threshold')!.value = settings.limiter;
			this.dynamics.limiter.parameters.get('release')!.value = 0.1;
			next.push(this.dynamics.limiter);
		}
		next.push(this.outputNode);
		if (next.length === this.chain.length && next.every((node, index) => node === this.chain[index])) return;
		for (const node of this.chain.slice(0, -1)) node.disconnect();
		for (let index = 0; index < next.length - 1; index++) next[index]!.connect(next[index + 1]!);
		this.chain = next;
	}

	private getVolume(): number {
		const volumeDb = store(this.world, Computed).volume[this.entity.id()] ?? 0;
		const muted = this.entity.has(Muted);

		/** Minimum dB value: treated as silence (maps to linear gain 0). */
		if (muted || volumeDb === -Infinity) {
			return 0;
		}

		return Math.pow(10, volumeDb / 20);
	}
}
