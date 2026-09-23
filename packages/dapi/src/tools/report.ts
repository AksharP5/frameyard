/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

/** Logs stay local unless the caller explicitly requests them. */
export const ISSUE_LOG_TAIL = 0;

export const report = defineTool({
  name: "report",
  title: "Report a bug",
  description:
    "File a public Frameyard issue immediately through the authenticated gh CLI. Includes the app version and platform; app logs are included only when requested. Returns the issue URL. Review the title, body, and any requested logs before calling.",
  input: z.object({
    title: z.string().min(1).describe("one-line summary of the problem"),
    body: z.string().optional().describe("what happened, in markdown: expected vs actual, and anything the diagnostics won't show"),
    commands: z.array(z.string()).optional().describe("the dapi commands or tool calls that reproduce it, in order"),
    logs: z.int().min(0).optional().describe(`trailing app log entries to attach (0 to omit; default: ${ISSUE_LOG_TAIL})`),
  }),
  output: z.object({ url: z.string() }),
  environment: "main",
});
