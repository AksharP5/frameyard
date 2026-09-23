/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AudioProcessingSettings } from '@diffusionstudio/jsx';

export const AUDIO_COMPRESSOR_DEFAULTS = { threshold: -18, ratio: 4, attack: 0.01, release: 0.1 };
export const AUDIO_EQ_FREQUENCIES = [120, 1000, 6000] as const;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return;
	return Math.max(min, Math.min(max, value));
}

/** Canonical, finite settings for the shared preview/export audio graph. */
export function parseAudioProcessing(value: unknown): AudioProcessingSettings {
	if (!record(value)) return {};
	const settings: AudioProcessingSettings = {};
	const pan = bounded(value.pan, -1, 1);
	if (pan) settings.pan = pan;
	if (Array.isArray(value.eq) && value.eq.length === 3) {
		const eq: NonNullable<AudioProcessingSettings['eq']> = [
			bounded(value.eq[0], -24, 24) ?? 0,
			bounded(value.eq[1], -24, 24) ?? 0,
			bounded(value.eq[2], -24, 24) ?? 0,
		];
		if (eq.some((gain) => gain !== 0)) settings.eq = eq;
	}
	if (record(value.compressor)) {
		const compressor: NonNullable<AudioProcessingSettings['compressor']> = {};
		const threshold = bounded(value.compressor.threshold, -100, 0);
		const ratio = bounded(value.compressor.ratio, 1, 20);
		const attack = bounded(value.compressor.attack, 0, 1);
		const release = bounded(value.compressor.release, 0.005, 1);
		if (threshold !== undefined) compressor.threshold = threshold;
		if (ratio !== undefined) compressor.ratio = ratio;
		if (attack !== undefined) compressor.attack = attack;
		if (release !== undefined) compressor.release = release;
		settings.compressor = compressor;
	}
	const limiter = bounded(value.limiter, -24, 0);
	if (limiter !== undefined) settings.limiter = limiter;
	return settings;
}

/** Gain normalization preserves dynamics and reserves headroom for intersample peaks. */
export function loudnessGain(integratedLufs: number | null, truePeakDbtp: number | null, volume: number, target: number) {
  if (integratedLufs === null || truePeakDbtp === null || !Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDbtp)) {
    throw new Error('The scene has no measurable audio.');
  }
  const desired = target - integratedLufs;
  const maximum = -1 - truePeakDbtp;
  const nextVolume = Math.floor(Math.min(12, volume + Math.min(desired, maximum)) * 10) / 10;
  if (nextVolume < -60) throw new Error('The mix needs more than 60 dB of attenuation. Reduce clip levels before normalizing.');
  const gain = nextVolume - volume;
  return { volume: nextVolume, gain, peakLimited: maximum < desired, estimatedLufs: integratedLufs + gain };
}

