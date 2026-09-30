/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool, ProjectPath } from "../tool";

export const workspace = defineTool({
  name: "workspace",
  title: "Project workspaces",
  description:
    "Open independent background project workspaces for parallel agents, list their activity, show one for review, close it, cancel its work, or send its native Codex Assistant a message. Open and send bind this MCP session to that project; other tool calls can override the binding with project. Each project has separate editor state and one active Assistant turn. Heavy jobs are queued to preserve playback and memory.",
  input: z.object({
    action: z.enum(["open", "list", "show", "close", "cancel", "send"]),
    dir: ProjectPath.optional().describe("absolute project directory; defaults to project or this session's bound workspace"),
    message: z.string().trim().min(1).optional().describe("instruction for the project's native Codex Assistant; required for send"),
  }).superRefine((value, ctx) => {
    if (value.action === "send" && !value.message) {
      ctx.addIssue({ code: "custom", path: ["message"], message: "send requires a non-empty message" });
    }
  }),
  output: z.object({
    workspaces: z.array(z.object({
      dir: z.string(),
      name: z.string(),
      visible: z.boolean(),
      status: z.enum(["loading", "idle", "working", "queued", "rendering", "error"]),
      agentActive: z.boolean(),
      jobs: z.array(z.object({ id: z.string(), tool: z.string(), state: z.enum(["queued", "running"]) })),
      error: z.string().optional(),
    })),
    threadId: z.string().optional(),
    turnId: z.string().optional(),
  }),
  environment: "main",
});
