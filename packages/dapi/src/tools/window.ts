/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

export const appWindow = defineTool({
  name: "window",
  title: "App window",
  description:
    "Show or hide Frameyard's review window, or report whether it is showing. Project agents keep working while the window is hidden. Use workspace show to review a specific project. Closing the window hides it without stopping background work.",
  input: z.object({
    visible: z.boolean().optional().describe("true to show and focus the window, false to hide it (default: leave it as it is)"),
  }),
  output: z.object({
    visible: z.boolean().describe("whether the window is showing now"),
  }),
  environment: "main",
});
