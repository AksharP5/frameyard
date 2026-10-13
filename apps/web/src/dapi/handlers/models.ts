/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MODEL_OPTIONS } from "@/components/genai/config";
import { localMode } from "@/lib/local-mode";

import type { ModelInfo } from "@diffusionstudio/dapi";
import type { ToolHandler } from "../handler";

export const models: ToolHandler<"models"> = async ({ type }) => {
  const out: ModelInfo[] = [];
  if (localMode) return { models: out };
  for (const option of MODEL_OPTIONS) {
    const mode = option.mode === "VOICE" ? "voice" : option.mode.toLowerCase();
    if (mode !== "image" && mode !== "video" && mode !== "audio") continue;
    if (type && mode !== type) continue;
    out.push({ type: mode, id: option.id, name: option.name, durations: option.durations?.map(String), aspectRatios: option.aspectRatios });
  }
  return { models: out };
};
