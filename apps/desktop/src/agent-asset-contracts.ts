/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";

const titleSchema = z.string().trim().min(1).max(160);
const urlSchema = z.url().max(4096);

export const assetSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  kind: z.enum(["logo", "image"]).default("logo"),
  limit: z.number().int().min(1).max(24).default(12),
});

export const assetCandidateSchema = z.object({
  id: z.string(),
  title: titleSchema,
  url: urlSchema,
  previewUrl: urlSchema,
  sourcePageUrl: urlSchema,
  provider: z.enum(["svgl", "iconify", "lobe", "wikimedia"]),
  attribution: z.string().max(2000).optional(),
});

export const assetImportRequestSchema = z.object({
  dir: z.string().min(1),
  url: urlSchema,
  title: titleSchema,
  sourcePageUrl: urlSchema.optional(),
  query: z.string().max(200).optional(),
  attribution: z.string().max(2000).optional(),
});

export const generatedAssetImportSchema = z.object({
  dir: z.string().min(1),
  prompt: z.string().trim().min(1).max(16000),
  title: titleSchema.optional(),
  savedPath: z.string().min(1).optional(),
  result: z.string().min(1).max(28_000_000).optional(),
}).refine((value) => Boolean(value.savedPath) !== Boolean(value.result), {
  message: "Provide exactly one generated image source: savedPath or result.",
});

export type AssetSearchRequest = z.input<typeof assetSearchRequestSchema>;
export type AssetCandidate = z.infer<typeof assetCandidateSchema>;
export type AssetImportRequest = z.infer<typeof assetImportRequestSchema>;
export type GeneratedAssetImport = z.infer<typeof generatedAssetImportSchema>;
export type AssetSearchResult = { assets: AssetCandidate[]; warnings: string[] };
export type ImportedAgentAsset = {
  path: string;
  libraryPath: string;
  mimeType: "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  provenancePath: string;
  deduplicated: boolean;
};
