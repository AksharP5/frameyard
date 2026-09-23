import { z } from "zod";

export const checkpointIdSchema = z.string().uuid();
export const checkpointLabelSchema = z.string().trim().min(1).max(160);
export const checkpointSchema = z.object({
  id: checkpointIdSchema,
  automatic: z.boolean().optional(),
  label: checkpointLabelSchema,
  createdAt: z.string().datetime(),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

// The journal is opaque so even a malformed recovery copy remains recoverable.
export const editorRecoverySchema = z.object({
  journal: z.string().nullable(),
  saveErrors: z.array(z.string()),
});
export type EditorRecovery = z.infer<typeof editorRecoverySchema>;
