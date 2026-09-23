import { z } from "zod";

export const videoFramesSchema = z.array(z.object({
  sceneId: z.string().min(1),
  time: z.number().finite().min(0),
  path: z.string().min(1),
})).min(1).max(12);

export type VideoFrames = z.infer<typeof videoFramesSchema>;
