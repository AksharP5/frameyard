/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { logs } from "./logs";
import { fonts } from "./fonts";
import { report } from "./report";
import { agentTool } from "./agent-tool";
import { window } from "./window";

import type { MainHandlers } from "../handler";

/** Every tool main answers itself, keyed by its catalog name. */
export const mainHandlers: MainHandlers = { logs, fonts, report, window, agent_tool: agentTool, workspace: async (args, ctx) => {
  if (!ctx.workspace) throw new Error("Project workspaces are unavailable");
  return ctx.workspace(args);
} };
