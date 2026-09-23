/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PRESET_CATALOG } from "./preset-catalog";

export const PRESET_DEFAULTS = {
  region: [0.25, 0.25, 0.5, 0.5] as [number, number, number, number],
  amount: 24,
};
export type PresetSettings = typeof PRESET_DEFAULTS;
export type PresetOptions = { preset: string; settings: PresetSettings };
export type PresetDefinition = {
  id: string;
  title: string;
  category: "effect";
  collection: string;
  description: string;
  controls: readonly (keyof PresetSettings)[];
  labels?: Partial<Record<keyof PresetSettings, string>>;
  defaults: Partial<PresetSettings>;
  notes?: string;
};

export { PRESET_CATALOG };
const definitions = new Map(PRESET_CATALOG.map((preset) => [preset.id, preset]));

export function getPresetDefinition(id: string): PresetDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error(`Unknown effect preset: ${id}`);
  return definition;
}

export const PRESET_LIMITS = { amount: [1, 256] as const };

/** Validate authored settings once; renderers receive independent, complete values. */
export function parsePresetOptions(input: unknown): PresetOptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Preset options must be an object");
  const props = input as Record<string, unknown>;
  const preset = props.preset === undefined ? PRESET_CATALOG[0]!.id : props.preset;
  if (typeof preset !== "string") throw new Error("Preset must identify an effect");
  const definition = getPresetDefinition(preset);
  const overrides = props.settings === undefined ? {} : props.settings;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Preset settings must be an object");
  const authored = overrides as Record<string, unknown>;
  for (const key of Object.keys(authored)) {
    if (key !== "region" && key !== "amount") throw new Error(`Unknown preset setting: ${key}`);
  }

  const region = Object.hasOwn(authored, "region") ? authored.region : definition.defaults.region ?? PRESET_DEFAULTS.region;
  if (!Array.isArray(region) || region.length !== 4 || region.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Preset region requires four normalized coordinates");
  }
  const [x, y, width, height] = region as [number, number, number, number];
  if (width <= 0 || height <= 0 || x + width > 1.0000001 || y + height > 1.0000001) {
    throw new Error("Preset region must fit inside the frame");
  }
  const amount = Object.hasOwn(authored, "amount") ? authored.amount : definition.defaults.amount ?? PRESET_DEFAULTS.amount;
  const [min, max] = PRESET_LIMITS.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < min || amount > max) {
    throw new Error(`Invalid preset amount; expected an integer from ${min} to ${max}`);
  }

  return {
    preset,
    settings: { region: [x, y, Math.min(width, 1 - x), Math.min(height, 1 - y)], amount },
  };
}
