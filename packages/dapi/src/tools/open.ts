/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

export const open = defineTool({
  name: "open",
  title: "Open project",
  description:
    "Open a folder in an independent project workspace, creating the project files if the folder is not one yet. Show it for review unless background is true. This MCP session stays bound to that project while other agents work on different videos. Returns the project's id, display name, and folder. Tools can also target a workspace explicitly with project.",
  input: z.object({
    dir: z.string().min(1).describe("absolute path of the project folder to open or create"),
    background: z.boolean().optional().describe("keep the workspace hidden instead of showing its editor"),
  }),
  output: z.object({
    id: z.string().describe("package.json projectId; empty for a folder that predates ids"),
    name: z.string().describe("display name"),
    dir: z.string().describe("absolute path of the project folder"),
  }),
  environment: "renderer",
});
