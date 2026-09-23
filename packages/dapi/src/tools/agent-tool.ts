/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

export const AgentToolContentItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
]);

export const agentTool = defineTool({
  name: "agent_tool",
  title: "Editor agent tool",
  description:
    "Call one of the editor agent tools registered by the open project, passing its JSON arguments through and returning the text or image content produced by that tool.",
  input: z.object({
    name: z.string().min(1).describe("registered editor agent tool name"),
    args: z.record(z.string(), z.json()).default({}).describe("tool arguments as a JSON object"),
  }),
  output: z.object({
    success: z.boolean(),
    contentItems: z.array(AgentToolContentItem),
  }),
  environment: "main",
});
