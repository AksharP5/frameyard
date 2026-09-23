import { z } from "zod";

const unit = z.number().min(0).max(1);
export const regionSchema = z.object({ x: unit, y: unit, width: unit.positive(), height: unit.positive() })
  .refine((region) => region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001, "Area must fit inside the frame");

export const annotationSchema = z.object({
  sceneId: z.string().min(1),
  sceneName: z.string(),
  time: z.number().min(0),
  frame: z.number().int().min(0),
  sceneSize: z.object({ width: z.number().positive(), height: z.number().positive() }),
  region: regionSchema,
  note: z.string().max(4000),
  imageUrl: z.string().max(12_000_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, "Expected a PNG frame"),
});

export type Annotation = z.infer<typeof annotationSchema>;
export type Region = z.infer<typeof regionSchema>;

export const timeRangeSchema = z.object({
  sceneId: z.string().min(1),
  sceneName: z.string(),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  frameRate: z.number().finite().positive(),
}).refine((range) => range.end > range.start, "End must be after start");

export type TimeRange = z.infer<typeof timeRangeSchema>;

/** Both points are fractions of the displayed image, independent of editor zoom or DPI. */
export function regionBetween(start: { x: number; y: number }, end: { x: number; y: number }): Region {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x1 = clamp(start.x), y1 = clamp(start.y), x2 = clamp(end.x), y2 = clamp(end.y);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
