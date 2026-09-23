/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The exact pixel size an export produces, and the scale it draws at. */
export interface OutputSize {
	width: number;
	height: number;
	scale: number;
}

/**
 * A scene size scaled and rounded to even the way the encoders take it —
 * the one rounding the video encoder, the image encoder and the UI share,
 * so what is shown to the user is what is encoded.
 */
export function scaleSize(sceneWidth: number, sceneHeight: number, scale: number): OutputSize {
	return {
		scale,
		width: Math.round(sceneWidth * scale / 2) * 2,
		height: Math.round(sceneHeight * scale / 2) * 2,
	};
}

/**
 * The output size an export at `resolution` produces for a scene. The
 * resolution names the output's shorter side — the "p" number, which for
 * a vertical video is by convention its width: at 1080, a 1920×1080 scene
 * exports as it is, a portrait 1080×1920 one does too, and a 3840×1620
 * ultrawide is scaled down to 2560×1080. Without a resolution the scene
 * exports at its own size.
 */
export function computeOutputSize(
	sceneWidth: number,
	sceneHeight: number,
	resolution?: number,
): OutputSize {
	const shortSide = Math.min(sceneWidth, sceneHeight);
	const scale = Math.round((resolution ?? shortSide) * 1e6 / shortSide) / 1e6;
	return scaleSize(sceneWidth, sceneHeight, scale);
}

/** The exact scene frame range used by video and audio exports. */
export function getExportFrameRange(sceneEnd: number, workarea?: { start: number; end: number } | null) {
	const start = workarea ? Math.max(0, Math.min(sceneEnd, workarea.start)) : 0;
	const end = workarea
		? Math.max(start, Math.min(sceneEnd, workarea.end || sceneEnd))
		: sceneEnd;
	const frames = end - start;
	if (frames <= 0) throw new RangeError('The export range contains no frames');
	return { start, end, frames };
}

/**
 * Helper for creating the render event detail
 */
export function createRenderEventDetail(progress: number, total: number, startTime: number) {
  const duration = performance.now() - startTime;
  const time = (duration / gte1(progress)) * (total - progress);
  const remaining = new Date(time);

  return { remaining, progress, total };
}

/**
 * Helper for making sure a number is greater than 1
 */
function gte1(num: number): number {
  if (num < 1) return 1;
  return num;
}
