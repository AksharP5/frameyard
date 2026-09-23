import { z } from "zod";
import { regionSchema } from "./annotation-contracts";

const unit = z.number().finite().min(0).max(1);
export const highlightOptionsSchema = z.object({
  magnification: z.number().finite().min(1).max(8).optional(),
  destination: z.tuple([unit, unit]).optional(),
  mode: z.enum(["center", "in-place"]).optional(),
  dim: unit.optional(),
  blur: z.number().finite().min(0).max(100).optional(),
  radius: z.number().finite().min(0).max(500).optional(),
  shadow: unit.optional(),
  enter: z.number().finite().min(0).max(10).optional(),
  exit: z.number().finite().min(0).max(10).optional(),
});

export const addHighlightSchema = highlightOptionsSchema.extend({
  sceneId: z.string().min(1).optional(),
  start: z.number().finite().min(0),
  end: z.number().finite().positive(),
  region: regionSchema,
  name: z.string().min(1).max(200).optional(),
  sceneSize: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional(),
  frameRate: z.number().finite().positive().optional(),
}).strict()
  .refine((input) => input.end > input.start, "End must be after start")
  .refine((input) => input.sceneId !== undefined || (input.sceneSize === undefined && input.frameRate === undefined), "A frozen frame or range must identify its scene");

export type AddHighlightInput = z.infer<typeof addHighlightSchema>;

export const updateHighlightSchema = z.object({
  id: z.string().min(1),
  props: highlightOptionsSchema.extend({
    region: regionSchema.optional(),
    start: z.number().finite().min(0).optional(),
    end: z.number().finite().positive().optional(),
    name: z.string().min(1).max(200).optional(),
  }).strict(),
}).strict();

export type UpdateHighlightInput = z.infer<typeof updateHighlightSchema>;
