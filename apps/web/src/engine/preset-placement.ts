import { Computed, FrameRate, Size, Source, Workarea, getActiveEntity, isScene } from "@diffusionstudio/runtime";
import { parsePresetOptions } from "@diffusionstudio/jsx";
import type { Entity, World } from "koota";
import type { AddPresetInput } from "@desktop/preset-contracts";

export const PRESET_DRAG_TYPE = "application/x-diffusion-preset";

/** Place a pixelated region at the drop point or over the current work area. */
export function presetPlacement(world: World, preset: string, options: { scene?: Entity; start?: number; point?: { x: number; y: number } } = {}): AddPresetInput {
  const region = parsePresetOptions({ preset }).settings.region;
  const scene = options.scene ?? getActiveEntity(world);
  const sceneId = scene?.get(Source)?.value;
  const size = scene?.get(Size);
  if (!scene || !isScene(scene) || !sceneId || !size?.width || !size.height) throw new Error("Open a scene before adding an effect");
  const fps = world.get(FrameRate)?.value ?? 30;
  const computed = scene.get(Computed)!;
  const range = options.start === undefined ? scene.get(Workarea) : undefined;
  const anchor = options.start ?? (range?.start ?? computed.localTime) / fps;
  const start = anchor;
  const end = range ? range.end / fps : Math.max(start + 1 / fps, Math.min(start + 3, computed.end / fps));
  const input: AddPresetInput = { preset, sceneId, sceneSize: { ...size }, frameRate: fps, start, end };
  if (!options.point) return input;
  const center: [number, number] = [Math.max(0, Math.min(1, options.point.x / size.width)), Math.max(0, Math.min(1, options.point.y / size.height))];
  input.settings = { region: [Math.max(0, Math.min(1 - region[2], center[0] - region[2] / 2)), Math.max(0, Math.min(1 - region[3], center[1] - region[3] / 2)), region[2], region[3]] };
  return input;
}
