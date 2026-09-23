/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ColorGradeSettings } from '@diffusionstudio/jsx';

export const COLOR_CURVE_CHANNELS = ['master', 'red', 'green', 'blue'] as const;
export const COLOR_CURVE_LIMIT = 16;
export const COLOR_LUT_SIZE = 1024;
export type ColorCurve = NonNullable<ColorGradeSettings['curves']>['master'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canonical relative white balance and display-referred SDR curves. Neutral values are absent. */
export function parseColorGrade(value: unknown): ColorGradeSettings {
  if (!record(value)) return {};
  const grade: ColorGradeSettings = {};
  for (const key of ['temperature', 'tint'] as const) {
    const number = value[key];
    if (typeof number === 'number' && Number.isFinite(number) && number !== 0) grade[key] = Math.max(-1, Math.min(1, number));
  }
  if (!record(value.curves)) return grade;
  const curves: NonNullable<ColorGradeSettings['curves']> = {};
  for (const channel of COLOR_CURVE_CHANNELS) {
    const raw = value.curves[channel];
    if (!Array.isArray(raw)) continue;
    const points = new Map<number, number>([[0, 0], [1, 1]]);
    for (const point of raw) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every((number) => typeof number === 'number' && Number.isFinite(number))) continue;
      points.set(Math.max(0, Math.min(1, point[0])), Math.max(0, Math.min(1, point[1])));
    }
    const sorted = [...points].sort(([a], [b]) => a - b);
    const bounded = sorted.length <= COLOR_CURVE_LIMIT ? sorted : [...sorted.slice(0, COLOR_CURVE_LIMIT - 1), sorted.at(-1)!];
    if (bounded.some(([x, y]) => x !== y)) curves[channel] = bounded;
  }
  if (Object.keys(curves).length) grade.curves = curves;
  return grade;
}

export function sampleColorCurve(curve: ColorCurve, value: number): number {
  if (!curve?.length) return value;
  if (value <= curve[0]![0]) return curve[0]![1];
  for (let index = 1; index < curve.length; index++) {
    const right = curve[index]!;
    if (value > right[0]) continue;
    const left = curve[index - 1]!;
    const fraction = (value - left[0]) / (right[0] - left[0]);
    return left[1] + fraction * (right[1] - left[1]);
  }
  return curve.at(-1)![1];
}

/** Tiny LUT rebuilt when controls change, never a per-frame CPU pixel transform. */
export function colorCurveLut(settings: ColorGradeSettings): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(COLOR_LUT_SIZE * 4);
  for (let index = 0; index < COLOR_LUT_SIZE; index++) {
    const master = sampleColorCurve(settings.curves?.master, index / (COLOR_LUT_SIZE - 1));
    for (let channel = 0; channel < 3; channel++) {
      result[index * 4 + channel] = Math.round(sampleColorCurve(settings.curves?.[COLOR_CURVE_CHANNELS[channel + 1]!], master) * 255);
    }
    result[index * 4 + 3] = 255;
  }
  return result;
}

/** Relative RGB balance in linear light, normalized to preserve neutral luminance. */
export function colorBalance(settings: ColorGradeSettings): [number, number, number] {
  const temperature = settings.temperature ?? 0, tint = settings.tint ?? 0;
  const red = 2 ** (0.6 * temperature + 0.3 * tint);
  const green = 2 ** (-0.6 * tint);
  const blue = 2 ** (-0.6 * temperature + 0.3 * tint);
  const luminance = .2126 * red + .7152 * green + .0722 * blue;
  return [red / luminance, green / luminance, blue / luminance];
}
