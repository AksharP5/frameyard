import { z } from 'zod';
import type { convertAnimation, listAnimations } from '../../cli/src/animation';

const target = { dir: z.string().min(1), id: z.string().min(1) };
export const animationRequestSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('list'), dir: target.dir }),
	z.object({ action: z.literal('render'), ...target }),
	z.object({ action: z.literal('editable'), ...target, allowPartial: z.boolean().optional() }),
	z.object({ action: z.literal('cancel'), ...target }),
	z.object({ action: z.literal('export'), ...target, output: z.string().min(1).optional(), overwrite: z.boolean().optional() }),
]);
export const animationToolSchema = z.union(animationRequestSchema.options.map((option) => z.object(option.shape).omit({ dir: true })));

export type AnimationRequest = z.infer<typeof animationRequestSchema>;
export type AnimationEntry = Awaited<ReturnType<typeof listAnimations>>[number];
export type Animation = Extract<AnimationEntry, { engine: string }>;
export type AnimationResponse = { items: AnimationEntry[] } | { path: string | null } | { cancelled: boolean } | Awaited<ReturnType<typeof convertAnimation>>;
