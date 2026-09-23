/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type DynamicsParameters = Record<'threshold' | 'ratio' | 'attack' | 'release', Float32Array>;

/** Stereo-linked gain reduction. No look-ahead delay, allocations, or messages in the sample loop. */
export function createDynamicsProcessor(sampleRate: number, limiter: boolean) {
	let gain = 1;
	return (input: Float32Array[], output: Float32Array[], parameters: DynamicsParameters): void => {
		if (!input.length) {
			gain = 1;
			for (const channel of output) channel.fill(0);
			return;
		}
		const length = output[0]?.length ?? 0;
		const threshold = parameters.threshold[0]!;
		const ceiling = 10 ** (threshold / 20);
		const ratio = parameters.ratio[0]!;
		const attack = parameters.attack[0]!;
		const release = parameters.release[0]!;
		const attackCoefficient = attack > 0 ? Math.exp(-1 / (sampleRate * attack)) : 0;
		const releaseCoefficient = Math.exp(-1 / (sampleRate * release));

		for (let frame = 0; frame < length; frame++) {
			let peak = 0;
			for (const channel of input) peak = Math.max(peak, Math.abs(channel[frame] ?? 0));
			const desired = peak > ceiling
				? limiter ? ceiling / peak : (peak / ceiling) ** (1 / ratio - 1)
				: 1;
			const coefficient = desired < gain ? (limiter ? 0 : attackCoefficient) : releaseCoefficient;
			gain = desired + coefficient * (gain - desired);
			for (let channel = 0; channel < output.length; channel++) {
				output[channel]![frame] = (input[channel]?.[frame] ?? input[0]?.[frame] ?? 0) * gain;
			}
		}
	};
}

const registrations = new WeakMap<BaseAudioContext, Promise<void>>();

/** Register once per context, shared by every clip and the offline export graph. */
export async function createAudioDynamics(context: BaseAudioContext, limiter: boolean): Promise<AudioWorkletNode> {
	let registered = registrations.get(context);
	if (!registered) {
		const source = `
const createDynamicsProcessor = ${createDynamicsProcessor.toString()};
class StudioDynamics extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -18, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.01, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.005, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    this.processSamples = createDynamicsProcessor(sampleRate, options.processorOptions.limiter);
  }
  process(inputs, outputs, parameters) {
    this.processSamples(inputs[0] ?? [], outputs[0] ?? [], parameters);
    return true;
  }
}
registerProcessor('studio-dynamics', StudioDynamics);`;
		const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		registered = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
		registrations.set(context, registered);
		registered.catch(() => registrations.delete(context));
	}
	await registered;
	return new AudioWorkletNode(context, 'studio-dynamics', {
		channelCount: 2,
		channelCountMode: 'clamped-max',
		outputChannelCount: [2],
		processorOptions: { limiter },
	});
}
