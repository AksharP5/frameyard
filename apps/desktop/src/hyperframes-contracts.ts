import { z } from "zod";

export type CatalogSource = "hyperframes" | "hyfrme";

export const catalogTypeSchema = z.enum(["template", "example", "block", "component"]);
const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);
const mediaUrl = z.url().refine((value) => ["https://static.heygen.ai", "https://hyfrme.vercel.app"].includes(new URL(value).origin), "Unsupported preview host");
const dimensionsSchema = z.object({ width: z.number().positive(), height: z.number().positive() });

export const catalogEntrySchema = z.object({
  name: nameSchema,
  type: catalogTypeSchema,
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  poster: mediaUrl.optional(),
  video: mediaUrl.optional(),
  dimensions: dimensionsSchema.optional(),
  duration: z.number().positive().optional(),
});

const itemFields = catalogEntrySchema.extend({
  files: z.array(z.object({ path: z.string(), target: z.string(), type: z.string() })).min(1),
  preview: z.object({ poster: mediaUrl.optional(), video: mediaUrl.optional() }).optional(),
  variables: z.array(z.object({ id: z.string(), type: z.string() }).catchall(z.json())).optional(),
  minCliVersion: z.string().optional(),
  deprecated: z.string().optional(),
}).catchall(z.json());

export const catalogItemSchema = z.discriminatedUnion("type", [
  itemFields.extend({
    type: z.literal("template"), dimensions: dimensionsSchema, duration: z.number().positive(),
    templateSource: z.object({
      website: z.url(), repository: z.url(), revision: z.string().regex(/^[0-9a-f]{40}$/),
      packageUrl: mediaUrl, license: z.string(), instructions: z.string(),
    }),
  }),
  itemFields.extend({ type: z.literal("example"), dimensions: dimensionsSchema, duration: z.number().positive() }),
  itemFields.extend({ type: z.literal("block"), dimensions: dimensionsSchema, duration: z.number().positive() }),
  itemFields.extend({ type: z.literal("component") }),
]);

export const catalogPreviewSchema = z.object({
  html: z.string().min(1).max(8_000_000),
  dimensions: dimensionsSchema.optional(),
  duration: z.number().positive().optional(),
});

export const catalogRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), refresh: z.boolean().optional() }),
  z.object({ action: z.literal("detail"), name: nameSchema, type: catalogTypeSchema }),
  z.object({ action: z.literal("preview"), name: nameSchema, type: z.enum(["block", "component"]) }),
  z.object({ action: z.literal("install"), dir: z.string().min(1), name: nameSchema, type: catalogTypeSchema }),
  z.object({ action: z.literal("render"), dir: z.string().min(1), id: nameSchema }),
]);

export const catalogResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), items: z.array(catalogEntrySchema), cached: z.boolean() }),
  z.object({ action: z.literal("detail"), item: catalogItemSchema }),
  catalogPreviewSchema.extend({ action: z.literal("preview") }),
  z.object({ action: z.literal("install"), id: nameSchema, type: catalogTypeSchema, source: z.string(), output: z.string().optional(), snippet: z.string() }),
  z.object({ action: z.literal("render"), id: nameSchema, output: z.string(), libraryPath: z.string().nullable() }),
]);

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export type CatalogRequest = z.infer<typeof catalogRequestSchema>;
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;
