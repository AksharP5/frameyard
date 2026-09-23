/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const HIGHLIGHT_DEFAULTS = {
  region: [0.25, 0.25, 0.5, 0.5] as [x: number, y: number, width: number, height: number],
  magnification: 1.8,
  destination: [0.5, 0.5] as [x: number, y: number],
  mode: "center" as "center" | "in-place",
  dim: 0.45,
  blur: 8,
  radius: 12,
  shadow: 0.35,
  enter: 0.35,
  exit: 0.35,
};

export type HighlightOptions = typeof HIGHLIGHT_DEFAULTS;

/** Parse effect options at authoring boundaries; other element props are ignored. */
export function parseHighlightOptions(input: unknown): HighlightOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Highlight options must be an object");
  }
  const props = input as Record<string, unknown>;
  const number = (name: keyof HighlightOptions, min: number, max: number): number => {
    const value = props[name] ?? HIGHLIGHT_DEFAULTS[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Highlight ${name} must be a number between ${min} and ${max}`);
    }
    return value;
  };
  const region = props.region ?? HIGHLIGHT_DEFAULTS.region;
  if (!Array.isArray(region) || region.length !== 4 || region.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error("Highlight region must be [x, y, width, height]");
  }
  const [x, y, width, height] = region as HighlightOptions["region"];
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6) {
    throw new Error("Highlight region must fit inside the frame using normalized coordinates");
  }
  const destination = props.destination ?? HIGHLIGHT_DEFAULTS.destination;
  if (!Array.isArray(destination) || destination.length !== 2 || destination.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new Error("Highlight destination must be [x, y] in normalized coordinates");
  }
  const mode = props.mode ?? HIGHLIGHT_DEFAULTS.mode;
  if (mode !== "center" && mode !== "in-place") {
    throw new Error('Highlight mode must be "center" or "in-place"');
  }
  return {
    region: [x, y, Math.min(width, 1 - x), Math.min(height, 1 - y)],
    destination: [destination[0], destination[1]],
    mode,
    magnification: number("magnification", 1, 8),
    dim: number("dim", 0, 1),
    blur: number("blur", 0, 100),
    radius: number("radius", 0, 500),
    shadow: number("shadow", 0, 1),
    enter: number("enter", 0, 10),
    exit: number("exit", 0, 10),
  };
}

/** Seek-safe in/hold/out envelope. Short clips compress both ramps proportionally. */
export function highlightProgress(time: number, duration: number, enter: number, exit: number): number {
  if (time < 0 || time >= duration || duration <= 0) return 0;
  const fit = Math.min(1, duration / (enter + exit || 1));
  const head = enter * fit;
  const tail = exit * fit;
  const value = Math.min(head > 0 ? time / head : 1, tail > 0 ? (duration - time) / tail : 1, 1);
  return value * value * (3 - 2 * value);
}
