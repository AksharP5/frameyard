/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Time } from "./types";

/** Default project frame rate when none is configured. */
export const TIME_FPS = 30;
export const FRAME_RATE_PRESETS = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120] as const;

export function isFrameRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 240;
}

/**
 * Parses a `Time` value into seconds: plain numbers are seconds, "30f" is
 * frames at the project frame rate. Four-part timecodes use non-drop frame
 * numbering; "MM:SS" / "HH:MM:SS" are clock strings. Values may be
 * negative. Returns undefined for anything unparsable.
 */
export function parseTime(value: Time | string | null | undefined, frameRate = TIME_FPS): number | undefined {
  if (!isFrameRate(frameRate)) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const str = value?.trim();
  if (typeof str !== "string" || str.length === 0) {
    return undefined;
  }

  // Frames, e.g. "-30f".
  if (/^-?\d+(?:\.\d+)?f$/i.test(str)) {
    return parseFloat(str) / frameRate;
  }

  // MM:SS or HH:MM:SS.
  if (str.includes(":")) {
    const negative = str.startsWith("-");
    const parts = str.replace(/^-/, "").split(":").map(Number);

    if (str.replace(/^-/, "").split(":").some((part) => !part.trim()) || parts.some((n) => !Number.isFinite(n) || n < 0)) {
      return undefined;
    }

    let seconds: number;
    if (parts.length === 2) {
      seconds = parts[0]! * 60 + parts[1]!;
    } else if (parts.length === 3) {
      seconds = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    } else if (parts.length === 4) {
      const [hours, minutes, secs, frames] = parts;
      const nominal = Math.round(frameRate);
      if (parts.some((part) => !Number.isInteger(part)) || minutes! >= 60 || secs! >= 60 || frames! >= nominal) return undefined;
      seconds = ((hours! * 3600 + minutes! * 60 + secs!) * nominal + frames!) / frameRate;
    } else {
      return undefined;
    }

    return negative ? -seconds : seconds;
  }

  // Plain seconds (may be fractional).
  const seconds = Number(str);
  return Number.isFinite(seconds) ? seconds : undefined;
}
