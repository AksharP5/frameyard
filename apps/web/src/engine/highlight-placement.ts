import { Computed, FrameRate, Size, Source, Workarea, getActiveEntity, isScene } from "@diffusionstudio/runtime";
import type { Entity, World } from "koota";
import type { AddHighlightInput } from "@desktop/highlight-contracts";

export const HIGHLIGHT_DRAG_TYPE = "application/x-diffusion-highlight";

/** Canvas drops choose the area; timeline drops choose the start. */
export function highlightPlacement(world: World, options: { scene?: Entity; start?: number; point?: { x: number; y: number } } = {}): AddHighlightInput {
  const scene = options.scene ?? getActiveEntity(world);
  const sceneId = scene?.get(Source)?.value;
  const size = scene?.get(Size);
  if (!scene || !isScene(scene) || !sceneId || !size?.width || !size.height) throw new Error("Open a scene before adding a highlight");
  const fps = world.get(FrameRate)?.value ?? 30;
  const computed = scene.get(Computed)!;
  const range = options.start === undefined ? scene.get(Workarea) : undefined;
  const start = options.start ?? (range?.start ?? computed.localTime) / fps;
  const end = range ? range.end / fps : Math.max(start + 1 / fps, Math.min(start + 3, computed.end / fps));
  const width = 0.3, height = 0.24;
  const center = options.point ? { x: options.point.x / size.width, y: options.point.y / size.height } : { x: 0.5, y: 0.5 };
  return {
    sceneId, sceneSize: { ...size }, frameRate: fps, start, end,
    region: { x: Math.max(0, Math.min(1 - width, center.x - width / 2)), y: Math.max(0, Math.min(1 - height, center.y - height / 2)), width, height },
  };
}
