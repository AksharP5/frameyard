import { z } from "zod";
import { PRESET_LIMITS } from "@diffusionstudio/jsx";

const unit = z.number().finite().min(0).max(1);
const region = z.tuple([unit, unit, unit, unit]);
const [minAmount, maxAmount] = PRESET_LIMITS.amount;
export const presetSettingsSchema = z.object({
  amount: z.number().int().min(minAmount).max(maxAmount).optional(),
  region: region.optional(),
}).strict();
const timing = {
  start: z.number().finite().min(0), end: z.number().finite().positive(),
};
export const addPresetSchema = z.object({
  preset: z.string().min(1).max(120), settings: presetSettingsSchema.optional(),
  sceneId: z.string().min(1).optional(), ...timing, name: z.string().min(1).max(200).optional(),
  sceneSize: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().optional(),
  frameRate: z.number().finite().positive().optional(),
}).strict()
  .refine((input) => input.end > input.start, "End must be after start")
  .refine((input) => input.sceneId !== undefined || (input.sceneSize === undefined && input.frameRate === undefined), "A frozen frame or range must identify its scene");
export const updatePresetSchema = z.object({
  id: z.string().min(1), settings: presetSettingsSchema.optional(),
  start: timing.start.optional(), end: timing.end.optional(), name: z.string().min(1).max(200).optional(),
}).strict();
export type AddPresetInput = z.infer<typeof addPresetSchema>;
export type UpdatePresetInput = z.infer<typeof updatePresetSchema>;
