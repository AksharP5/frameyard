/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { track } from "@/lib/analytics";

/** Where a download was started from, so the promos can be compared. */
export type DesktopAppDownloadSource = "canvas_banner" | "dashboard_footer" | "main_menu" | "chat_panel";

export function downloadDesktopApp(source: DesktopAppDownloadSource) {
  track("desktop_app_download", { source });
  window.open("https://github.com/AksharP5/frameyard#install", "_blank", "noopener,noreferrer");
}
