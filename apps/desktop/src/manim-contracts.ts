import { z } from "zod";
import type { listAnimations } from "../../cli/src/animation";

export const manimRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), dir: z.string().min(1) }),
  z.object({ action: z.literal("render"), dir: z.string().min(1), id: z.string().min(1) }),
]);

export type ManimRequest = z.infer<typeof manimRequestSchema>;
export type ManimEntry = Awaited<ReturnType<typeof listAnimations>>[number];
export type ManimAnimation = Extract<ManimEntry, { engine: string }>;
